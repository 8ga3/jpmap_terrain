/**
 * グローブ地形シーン (Issue #275 Phase 1)。
 *
 * 平面ワールドの `scenes/default.ts` に対する **並行構築** のグローブ（ECEF 楕円体 +
 * Large World Rendering の floating origin）シーン。`GeospatialCamera` を中核に、
 * `geo/globeTileManager` で動的 LOD タイルを描画し、注視点を地形表面へ追従させる。
 *
 * Phase 1 のスコープは「座標系・メッシュ生成・カメラ基盤・配置・LOD」の地形エンジン。
 * 注視点ズーム・seat-on-terrain・地心距離 LOD までを含む。picking 非依存パン / WASD /
 * zoom-to-cursor 再構成 / URL 等価性などのリッチなカメラ UX は Phase 2 で追加する。
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
import { DEG2RAD, geodeticToEcef, geodeticToEcefToRef, ecefToGeodetic } from "../terrain/geo/ecef";
import { createGlobeTileManager, type GlobeTileManager, type GlobeTileSyncStats } from "../terrain/geo/globeTileManager";

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
        camera.movement.zoomToCursor = false;

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

        // 注視点を地形表面へ追従させる（高標高地でカメラが地形下へ潜るのを防ぐ）。毎フレーム
        // 実行する。zoom 中は zoom-to-point 側が 3D で地形追従するため seat を止める
        // （ラスタ標高と pick 点の食い違いで引っ張り合うのを避ける）。
        const seatCenterOnTerrain = (): void => {
            if (camera.movement.computedPerFrameZoomPickPoint) return;
            const g = ecefToGeodetic(camera.center);
            const elev = tileManager.terrainElevAt(g.latDeg, g.lonDeg);
            if (elev === null) return;
            centerElevation = elev; // SSE 距離評価の基準標高
            geodeticToEcefToRef(g.latDeg, g.lonDeg, elev, seatCenter);
            // 同 lat/lon のまま高度だけ地形標高へ。残差を lerp で滑らかに（LOD 切替時の段差緩和）。
            // 毎フレーム呼ばれるため、LerpToRef で再利用バッファに書き割り当てを避ける。
            Vector3.LerpToRef(camera.center, seatCenter, SEAT_LERP, seatLerp);
            camera.center = seatLerp;
        };

        engine.runRenderLoop(() => scene.render());

        // 初回同期はレンダーループ（= 本メソッド return 後）へ遅延させる。構築中に
        // 同期実行すると、呼び出し側の onSyncStats が「createSceneWithController の
        // 戻り値から代入される controller」をまだ初期化前に参照し TDZ エラーになるため。
        // frame=0 の最初のフレームで即同期し、以降は syncIntervalFrames ごとに再評価する。
        let frame = 0;
        const observer = scene.onBeforeRenderObservable.add(() => {
            seatCenterOnTerrain();
            if (frame % GLOBE_SCENE_DEFAULTS.syncIntervalFrames === 0) syncTiles();
            frame++;
        });

        const dispose = (): void => {
            scene.onBeforeRenderObservable.remove(observer);
            tileManager.dispose();
            scene.dispose();
        };

        return { scene, camera, tileManager, dispose };
    }
}
