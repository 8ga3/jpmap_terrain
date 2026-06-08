/**
 * グローブ地形シーン (Issue #275 Phase 1 + Phase 2)。
 *
 * 平面ワールドの `scenes/default.ts` に対する **並行構築** のグローブ（ECEF 楕円体 +
 * Large World Rendering の floating origin）シーン。`GeospatialCamera` を中核に、
 * `geo/globeTileManager` で動的 LOD タイルを描画し、注視点を地形表面へ追従させる。
 *
 * Phase 1: 「座標系・メッシュ生成・カメラ基盤・配置・LOD」の地形エンジン（注視点ズーム・
 * seat-on-terrain・地心距離 LOD）。
 * Phase 2: picking 非依存パン（左ドラッグ / WASD）・カメラ地形衝突・seat の対地クリアランス
 * フェードを追加。zoom-to-cursor は seat との鉛直結合で揺れるため無効維持（中心ズーム。
 * 再実装は Issue #327）。URL 等価性はデモ（`demos/geospatial/index.ts`）側で実装。
 */
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import {
    GeospatialCamera,
    ComputeLookAtFromYawPitchToRef,
} from "@babylonjs/core/Cameras/geospatialCamera";
import { GeospatialClippingBehavior } from "@babylonjs/core/Behaviors/Cameras/geospatialClippingBehavior";
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

import type { MapType } from "../terrain/gsiTile";
import { DEG2RAD, geodeticToEcef, geodeticToEcefToRef, ecefToGeodetic, type Geodetic } from "../terrain/geo/ecef";
import {
    cameraTangentBasisToRef,
    panCenterOnSphereToRef,
    clampRadiusForGroundClearance,
} from "../terrain/geo/cameraMapping";
import { createGlobeTileManager, type GlobeTileManager, type GlobeTileSyncStats } from "../terrain/geo/globeTileManager";
import { createGlobeMarkerManager, type GlobeMarkerManager } from "../terrain/geo/globeMarkerManager";
import { createGlobePolygonManager, type GlobePolygonManager } from "../terrain/geo/globePolygonManager";
import { createGlobeCircleManager, type GlobeCircleManager } from "../terrain/geo/globeCircleManager";

/** グローブシーンの既定パラメータ（富士山周辺）。 */
export const GLOBE_SCENE_DEFAULTS = {
    lat: 35.3606,
    lon: 138.7274,
    /** root（最低）ズーム。 */
    minZoom: 11,
    /** 最高ズーム（分割上限）。テクスチャ（std/photo）は z18 まで対応。 */
    maxZoom: 18,
    /** ジオメトリ（標高）の最高ズーム。GSI DEM(dem5a/5b) は z15 まで。 */
    geomMaxZoom: 15,
    /** カメラ中心（地表）からの距離 [m]。 */
    radius: 60000,
    /** 方位[deg]（0=北, +=東回り）→ yaw。 */
    azimuth: 0,
    /** チルト[deg]（0=直下, 90=水平）→ pitch。 */
    tilt: 60,
    /** SSE 採用しきい値 [px]。 */
    sseThreshold: 256 * 2.5,
    /** 同時保持タイル数の上限。 */
    maxTiles: 140,
    /** root 探索半径（±N 格子）。 */
    rootSearchRadius: 2,
    /** 地平線カリングの内積しきい値。 */
    horizonDotThreshold: 0.1,
    /** タイルあたりの分割数（頂点は (seg+1)^2）。 */
    segments: 32,
    /** LOD 再評価の間隔（フレーム）。 */
    syncIntervalFrames: 15,
} as const;

/** seat-on-terrain の追従残差 lerp 係数（LOD 切替時の段差緩和）。 */
const SEAT_LERP = 0.5;

/**
 * seat-on-terrain（注視点の地形追従）を効かせるカメラ対地クリアランス[m]の範囲。
 * カメラが地形から十分高い位置にあるときは追従させない（高高度のパンで地形の起伏に沿って
 * カメラ高度がばたつくのを防ぐ）。`FULL` 以下で完全追従、`ZERO` 以上で追従停止、その間は線形に
 * フェード（しきい値で急に切り替えるとズーム時に段差が出るため）。
 */
const SEAT_FULL_CLEARANCE = 3000;
const SEAT_ZERO_CLEARANCE = 10000;

/** 1 秒あたりの WASD パン距離 = radius（高度相当）× この係数。高度比例で自然な速度。 */
const PAN_RATE_PER_SEC = 0.6;

/** カメラ地形衝突: 地表からの最小クリアランス[m]（URL altitude 下限と整合）。 */
const MIN_GROUND_CLEARANCE = 50;

/** WASD パン対象キー。 */
const PAN_KEYS = new Set(["w", "a", "s", "d"]);

export interface GlobeSceneInitOptions {
    /** 初期注視点の緯度 [deg]。 */
    lat?: number;
    /** 初期注視点の経度 [deg]。 */
    lon?: number;
    /** root（最低）ズーム。 */
    minZoom?: number;
    /** カメラ距離 [m]（高度相当）。 */
    radius?: number;
    /** 初期方位 [deg]。 */
    azimuth?: number;
    /** 初期チルト [deg]。 */
    tilt?: number;
    /** 地図種別。 */
    mapType?: MapType;
    /** クロスレベル標高スナップを有効化するか（既定 true）。 */
    snapEnabled?: boolean;
    /** 同期統計のコールバック（情報表示・テスト用）。 */
    onSyncStats?: (stats: GlobeSceneSyncInfo) => void;
}

/** 同期統計 + カメラ状態。 */
export interface GlobeSceneSyncInfo extends GlobeTileSyncStats {
    /** 注視点の緯度 [deg]。 */
    latDeg: number;
    /** 注視点の経度 [deg]。 */
    lonDeg: number;
    /** カメラ距離 [m]。 */
    radius: number;
    /** yaw [rad]。 */
    yaw: number;
    /** pitch [rad]。 */
    pitch: number;
}

export interface GlobeSceneController {
    scene: Scene;
    camera: GeospatialCamera;
    tileManager: GlobeTileManager;
    /** グローブ用マーカー（Phase 3）。接地・地心 up ポール・カメラ正対ラベル。 */
    markerManager: GlobeMarkerManager;
    /** グローブ用ポリゴン（Phase 3）。接地アウトライン・地心 up カーテン壁。 */
    polygonManager: GlobePolygonManager;
    /** グローブ用サークル（Phase 3）。中心+半径の円を閉ポリゴンとして描画。 */
    circleManager: GlobeCircleManager;
    dispose: () => void;
}

/**
 * グローブ地形シーンを生成する。
 */
export class GlobeScene {
    async createScene(
        engine: AbstractEngine,
        canvas: HTMLCanvasElement,
        options: GlobeSceneInitOptions = {},
    ): Promise<Scene> {
        const { scene } = this.createSceneWithController(engine, canvas, options);
        return scene;
    }

    /**
     * シーンとコントローラ（dispose 等）を返す。デモ・テストから内部へアクセスする用途。
     */
    createSceneWithController(
        engine: AbstractEngine,
        canvas: HTMLCanvasElement,
        options: GlobeSceneInitOptions = {},
    ): GlobeSceneController {
        const lat = options.lat ?? GLOBE_SCENE_DEFAULTS.lat;
        const lon = options.lon ?? GLOBE_SCENE_DEFAULTS.lon;
        const minZoom = options.minZoom ?? GLOBE_SCENE_DEFAULTS.minZoom;
        const radius = options.radius ?? GLOBE_SCENE_DEFAULTS.radius;
        const azimuth = options.azimuth ?? GLOBE_SCENE_DEFAULTS.azimuth;
        const tilt = options.tilt ?? GLOBE_SCENE_DEFAULTS.tilt;
        const mapType: MapType = options.mapType ?? "std";
        const snapEnabled = options.snapEnabled ?? true;

        // Large World Rendering: 真の ECEF（百万 m オーダー）でも精度を保つため floating origin を有効化。
        const scene = new Scene(engine, { useFloatingOrigin: true });
        scene.clearColor = new Color4(0.75, 0.86, 0.95, 1);
        // EcefFromLatLonAltToRef は常に右手系 ECEF（X→経度0, Y→東経90°, Z→北極）を出力し、
        // GeospatialCamera も scene.useRightHandedSystem を前提に視点を組む。既定の左手系の
        // ままだと右手系データを鏡像で見るため東西が反転する。右手系に揃える。
        scene.useRightHandedSystem = true;

        // GeospatialCamera: world 原点中心の球体惑星を周回する。
        const camera = new GeospatialCamera("globe-camera", scene, {
            planetRadius: Wgs84Ellipsoid.semiMajorAxis,
        });

        // 初期注視点（地表上の lat/lon）を真の ECEF として center に設定する。
        const centerEcef = geodeticToEcef(lat, lon, 0);
        camera.center = centerEcef;
        camera.radius = radius;
        // 既存 UI の azimuth/tilt[deg] を yaw/pitch[rad] にマッピングして初期化。
        camera.yaw = azimuth * DEG2RAD;
        camera.pitch = tilt * DEG2RAD;

        // near/far の自動調整（高度に応じた depth 精度最適化）。
        camera.addBehavior(new GeospatialClippingBehavior());
        camera.attachControl(true);

        // ズームは注視点(画面中心)へ寄る半径のみのズームにする。zoom-to-cursor は毎フレーム
        // 中心をカーソル方向へ動かすため、floating origin 下のピック誤差と相まってガタつく。
        // zoom-to-cursor のレイ再構成は floating origin 維持と両立が難しく、Phase 2 では無効維持
        // とする（PoC の判断踏襲）。
        camera.movement.zoomToCursor = false;

        // ---- picking 非依存パン（左ドラッグ / WASD） ----
        // 既定の pan（左ドラッグ/キーボード）は scene.pick でグローブをヒットしてドラッグ平面を
        // 作るが、useFloatingOrigin 下ではレンダリング座標と真の ECEF メッシュ位置がずれて
        // ピックが外れ機能しない。floating origin（#275 の精度要件）を維持するため、
        // camera.center を地表接線方向へ動かす独自パンを実装する。
        const pressed = new Set<string>();
        const onKeyDown = (e: KeyboardEvent): void => {
            const k = e.key.toLowerCase();
            if (PAN_KEYS.has(k)) {
                pressed.add(k);
                e.preventDefault();
            }
        };
        const onKeyUp = (e: KeyboardEvent): void => {
            pressed.delete(e.key.toLowerCase());
        };
        // 押下状態のリセット。フォーカス喪失/タブ切替中は keyup が届かず押下が残り続け、
        // 復帰後に意図せずパンし続けるのを防ぐ（blur / 非表示で全解除）。
        const clearPressed = (): void => pressed.clear();
        const onVisibilityChange = (): void => {
            if (document.hidden) pressed.clear();
        };
        // keydown/keyup は canvas に付ける（グローバルなキー入力の横取りを避ける）。canvas が
        // フォーカス可能でない/未フォーカスだとキーを拾えないため、tabIndex を確保し pointerdown
        // 時にフォーカスする（呼び出し側の設定に依存せずシーン単体でも WASD が機能する）。
        if (canvas.tabIndex < 0) canvas.tabIndex = 0;
        canvas.addEventListener("keydown", onKeyDown);
        canvas.addEventListener("keyup", onKeyUp);
        canvas.addEventListener("blur", clearPressed);
        window.addEventListener("blur", clearPressed);
        document.addEventListener("visibilitychange", onVisibilityChange);

        // 左ドラッグ状態。
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        const onPointerDown = (e: PointerEvent): void => {
            canvas.focus(); // WASD のためにフォーカスを確保（右/左/中ボタンいずれでも）
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            canvas.setPointerCapture?.(e.pointerId);
        };
        const endDrag = (): void => {
            dragging = false;
        };
        const onPointerUp = (e: PointerEvent): void => {
            if (e.button === 0) endDrag();
        };
        // パン用の再利用バッファ（毎フレーム/毎 move 呼び出しでの割当を避ける）。
        const dragRight = new Vector3();
        const dragFwd = new Vector3();
        const dragLookAt = new Vector3();
        const tangent = new Vector3();
        const panned = new Vector3();

        const onPointerMove = (e: PointerEvent): void => {
            if (!dragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            if (dx === 0 && dy === 0) return;

            // カメラ→center 方向(lookAt)から地表接線の右・前方向を作る。
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                dragLookAt,
            );
            if (!cameraTangentBasisToRef(camera.center, dragLookAt, dragRight, dragFwd)) {
                return; // 真下視点の特異点
            }
            // 注視点距離での地表 m/px（掴んだ点がほぼカーソル追従する縮尺）。
            const fovHeightM = 2 * camera.radius * Math.tan(camera.fov / 2);
            const mpp = fovHeightM / Math.max(1, canvas.clientHeight);
            // マップを掴んで引く挙動: 右ドラッグ→center 西（content 右へ）、下ドラッグ→center 北（前方）。
            tangent.copyFrom(dragRight).scaleInPlace(-dx * mpp);
            tangent.addInPlace(dragFwd.scaleInPlace(dy * mpp));
            camera.center = panCenterOnSphereToRef(camera.center, tangent, panned);
        };
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", endDrag);
        canvas.addEventListener("pointermove", onPointerMove);

        /**
         * 押下中の WASD に応じて center を **カメラの向き（前/右）基準** で高度比例移動する。
         * 視点を回転（yaw 変更）すると前方向も追従し、左ドラッグパンと一貫した操作になる
         * （北固定ではなく「画面で奥が W」）。真下視点では前後左右が定義できないためスキップ。
         */
        const applyKeyboardPan = (): void => {
            if (pressed.size === 0) return;
            let fwd = 0;
            let side = 0;
            if (pressed.has("w")) fwd += 1;
            if (pressed.has("s")) fwd -= 1;
            if (pressed.has("d")) side += 1;
            if (pressed.has("a")) side -= 1;
            if (fwd === 0 && side === 0) return;
            // カメラ→center 方向(lookAt)から地表接線の右・前を作り、視点回転に追従させる。
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                dragLookAt,
            );
            if (!cameraTangentBasisToRef(camera.center, dragLookAt, dragRight, dragFwd)) {
                return; // 真下視点の特異点
            }

            const dtSec = Math.min(0.05, engine.getDeltaTime() / 1000);
            const step = camera.radius * PAN_RATE_PER_SEC * dtSec;
            tangent.copyFrom(dragFwd).scaleInPlace(fwd);
            tangent.addInPlace(dragRight.scaleInPlace(side));
            if (tangent.lengthSquared() < 1e-12) return;
            tangent.normalize().scaleInPlace(step);
            camera.center = panCenterOnSphereToRef(camera.center, tangent, panned);
        };

        // ライト: 地表の up（地心法線）を基準に環境光 + 斜め方向の指向性ライト。
        const up = centerEcef.clone().normalize();
        const hemi = new HemisphericLight("globe-hemi", up, scene);
        hemi.intensity = 0.55;
        hemi.groundColor = new Color3(0.3, 0.32, 0.3);
        const ref = Math.abs(up.y) < 0.99 ? Vector3.Up() : Vector3.Right();
        const east = Vector3.Cross(ref, up).normalize();
        const sunDir = up.scale(-0.85).add(east.scale(0.5)).normalize();
        const sun = new DirectionalLight("globe-sun", sunDir, scene);
        sun.intensity = 0.7;

        // ---- 地形タイルマネージャ ----
        const tileManager = createGlobeTileManager({
            scene,
            mapType,
            minZoom,
            geomMaxZoom: GLOBE_SCENE_DEFAULTS.geomMaxZoom,
            segments: GLOBE_SCENE_DEFAULTS.segments,
            snapEnabled,
        });

        // ---- グローブマーカー（Phase 3） ----
        const markerManager = createGlobeMarkerManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });
        // ---- グローブポリゴン（Phase 3） ----
        const polygonManager = createGlobePolygonManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });
        // ---- グローブサークル（Phase 3） ----
        const circleManager = createGlobeCircleManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });

        const lookAt = new Vector3();
        const cameraEcef = new Vector3();
        const seatCenter = new Vector3();
        const seatLerp = new Vector3();
        // SSE 距離評価の基準標高（中心付近の地形標高）。前 sync の値を次 sync で使う。
        let centerElevation = 0;

        /** GeospatialCamera の center/yaw/pitch/radius から真の ECEF 位置を復元する。 */
        const computeCameraEcef = (): Vector3 => {
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                lookAt,
            );
            // lookAt はカメラ→center 方向。カメラ位置 = center - lookAt * radius。
            // lookAt は本関数で都度再計算する一時バッファなので scaleInPlace で割り当てを避ける。
            cameraEcef
                .copyFrom(camera.center)
                .subtractInPlace(lookAt.scaleInPlace(camera.radius));
            return cameraEcef;
        };

        const syncTiles = (): void => {
            const stats = tileManager.sync({
                cameraEcef: computeCameraEcef(),
                centerEcef: camera.center,
                maxZoom: GLOBE_SCENE_DEFAULTS.maxZoom,
                viewportHeight: engine.getRenderHeight(),
                verticalFov: camera.fov,
                sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
                maxTiles: GLOBE_SCENE_DEFAULTS.maxTiles,
                rootSearchRadius: GLOBE_SCENE_DEFAULTS.rootSearchRadius,
                horizonDotThreshold: GLOBE_SCENE_DEFAULTS.horizonDotThreshold,
                referenceAltitude: centerElevation,
            });
            if (options.onSyncStats) {
                const geo = ecefToGeodetic(camera.center);
                options.onSyncStats({
                    ...stats,
                    latDeg: geo.latDeg,
                    lonDeg: geo.lonDeg,
                    radius: camera.radius,
                    yaw: camera.yaw,
                    pitch: camera.pitch,
                });
            }
        };

        // 注視点を地形表面へ追従させる（地表付近でカメラが地形下へ潜るのを防ぐ）。毎フレーム実行。
        // 追従強度はカメラの対地クリアランスでフェードし、十分高い位置では追従しない（高高度の
        // パンで地形の起伏に沿ってカメラ高度がばたつくのを防ぐ）。`zoomToCursor=false` のため
        // ズームは radius のみを変え center を動かさず、seat と競合しないので zoom 中もそのまま動く。
        // camAltMeters はカメラの楕円体高度（observer で 1 回だけ計算した値を共有）。
        const seatCenterOnTerrain = (camAltMeters: number): void => {
            const g = ecefToGeodetic(camera.center);
            const elev = tileManager.terrainElevAt(g.latDeg, g.lonDeg);
            if (elev === null) return;
            centerElevation = elev; // SSE 距離評価の基準標高（追従の有無に関わらず最新化）
            // カメラの対地クリアランスで追従強度をフェード（FULL 以下で完全追従、ZERO 以上で停止）。
            const clearance = camAltMeters - elev;
            const seatFactor = Math.max(
                0,
                Math.min(
                    1,
                    (SEAT_ZERO_CLEARANCE - clearance) / (SEAT_ZERO_CLEARANCE - SEAT_FULL_CLEARANCE),
                ),
            );
            if (seatFactor <= 0) return; // 十分高い → 地形に追従せず高度一定でパン
            geodeticToEcefToRef(g.latDeg, g.lonDeg, elev, seatCenter);
            // 同 lat/lon のまま高度だけ地形標高へ。残差を lerp で滑らかに（高度依存で強度を絞る）。
            // 毎フレーム呼ばれるため、LerpToRef で再利用バッファに書き割り当てを避ける。
            Vector3.LerpToRef(camera.center, seatCenter, SEAT_LERP * seatFactor, seatLerp);
            camera.center = seatLerp;
        };

        // カメラ地形衝突: カメラ位置が地形 + 最小クリアランスより低くなったら radius を増やして
        // 潜り込みを防ぐ。seat は注視点を地表へ載せるだけでカメラ自身の潜りは防がないため、
        // 近接ズーム/低高度パンの保険として明示実装する（PoC は seat による実用回避のみ）。
        // camEcef / camGeo / lookAt は observer で 1 回だけ計算したものを共有する
        // （seat → 衝突で computeCameraEcef / ecefToGeodetic を二重実行しないため）。
        const enforceGroundClearance = (camEcef: Vector3, camGeo: Geodetic): void => {
            const terrain = tileManager.terrainElevAt(camGeo.latDeg, camGeo.lonDeg);
            if (terrain === null) return;
            // radius あたりのカメラ高度増加率 = カメラ地心 up・(center→camera 単位方向)。
            // center→camera 単位方向は -lookAt/|lookAt|。computeCameraEcef は lookAt を
            // radius 倍にスケール済み（|lookAt|=radius）なので、内積を |camEcef|·radius で割って
            // 単位ベクトル同士の内積へ正規化する。
            const denom = Math.max(1, camEcef.length()) * Math.max(1, camera.radius);
            const dAltPerRadius =
                -(camEcef.x * lookAt.x + camEcef.y * lookAt.y + camEcef.z * lookAt.z) / denom;
            const newRadius = clampRadiusForGroundClearance(
                camera.radius,
                camGeo.altMeters,
                terrain,
                MIN_GROUND_CLEARANCE,
                dAltPerRadius,
            );
            if (newRadius !== camera.radius) camera.radius = newRadius;
        };

        // render ループは開始しない。DefaultScene と同じく、シーン生成と render ループ管理の
        // 責務を分離し、ループ開始は呼び出し側（デモ / 将来の JpmapTerrain 等）に委ねる
        // （二重起動・上書きを防ぐ）。本シーンのタイル同期は onBeforeRenderObservable で動く。
        //
        // 初回同期は構築中ではなく onBeforeRender（= 呼び出し側がループ開始した後）に遅延する。
        // 構築中に同期実行すると、呼び出し側の onSyncStats が「createSceneWithController の
        // 戻り値から代入される controller」をまだ初期化前に参照し TDZ エラーになるため。
        // frame=0 の最初のフレームで即同期し、以降は syncIntervalFrames ごとに再評価する。
        let frame = 0;
        const observer = scene.onBeforeRenderObservable.add(() => {
            applyKeyboardPan();
            // カメラ ECEF と測地座標・lookAt を 1 フレーム 1 回だけ計算し、seat と衝突で共有する
            // （ComputeLookAtFromYawPitchToRef と測地変換の二重実行を避ける）。seat は center を
            // わずかに動かすため衝突はその直前のスナップショットを使うが、毎フレーム補正のため実用上問題ない。
            const camEcef = computeCameraEcef(); // lookAt バッファも更新される
            const camGeo = ecefToGeodetic(camEcef);
            seatCenterOnTerrain(camGeo.altMeters);
            enforceGroundClearance(camEcef, camGeo);
            // マーカーの接地・距離スケール更新（フレーム共有の camEcef を渡す）。
            markerManager.update(camEcef);
            // ポリゴン・サークルの地形再ドレープ（アウトライン・壁）。
            polygonManager.update();
            circleManager.update();
            if (frame % GLOBE_SCENE_DEFAULTS.syncIntervalFrames === 0) syncTiles();
            frame++;
        });

        const dispose = (): void => {
            // render ループは呼び出し側の所有なので停止しない（呼び出し側が停止する）。
            scene.onBeforeRenderObservable.remove(observer);
            canvas.removeEventListener("keydown", onKeyDown);
            canvas.removeEventListener("keyup", onKeyUp);
            canvas.removeEventListener("blur", clearPressed);
            window.removeEventListener("blur", clearPressed);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", endDrag);
            canvas.removeEventListener("pointermove", onPointerMove);
            markerManager.dispose();
            polygonManager.dispose();
            circleManager.dispose();
            tileManager.dispose();
            scene.dispose();
        };

        return { scene, camera, tileManager, markerManager, polygonManager, circleManager, dispose };
    }
}
