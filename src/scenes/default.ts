import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Ray } from "@babylonjs/core/Culling/ray";
import { CreateSceneClass } from "../createScene";
import { clamp, toTileXY, tileEdgeMeters, JAPAN_BOUNDS } from "../terrain/gsiTile";
import { createControlPanel, snapScale, formatScale, showToast } from "../terrain/controlPanel";
import { attachResizeRefresh } from "../terrain/resizeRefresh";
import { createTileManager } from "../terrain/tileManager";
import { createSkybox } from "../terrain/skybox";
import { computeSunPosition } from "../terrain/sunPosition";
import { deriveSunState } from "../terrain/sunState";
import { resolveTiltCollision, TILT_MAX_RADIUS_INCREASE_RATIO } from "../terrain/cameraCollision";
import { computePoseForNewTarget } from "../terrain/cameraRetarget";

import { createUiVisibilityController } from "../terrain/uiVisibility";
import { SUN_FALLBACK_DATETIME_ISO } from "../lib/types";

const TERRAIN_SUBDIVISIONS = 128;
const MAX_ZOOM = 18;
const MAX_ELEVATION_ZOOM = 17;
const MIN_ELEVATION_ZOOM = 10;
const HEIGHT_SCALE = 1.0;
// Quadtree 探索の最低ズーム。低すぎると傾斜視点時に地平線方向で極端な低解像度タイルが
// 採用され「多数 × 低解像度」状態になる一方、高すぎると最大チルト時に遠景タイルが root 候補
// から外れて表示されない。zoom 8（タイル辺 ≒ 128km）が遠方の山まで表示できる下限。
const MIN_ZOOM = 8;
// Quadtree root 探索範囲（minZoom タイル単位の ±N 格子）。
// 最大 tilt（beta ≈ 75°）の水平視野は遠クリッピング（400km）近くまで達するため、zoom8 で ±4
// （9×9、概ね ±512km カバー）を既定とする。視錐台外の root は AABB カリングで即除外される。
const ROOT_SEARCH_RADIUS = 4;

/** カメラ最小距離（メートル） */
const CAMERA_LOWER_RADIUS = 50;
/** カメラ最大距離（メートル） */
const CAMERA_UPPER_RADIUS = 75000;
/** 遠クリッピング面（メートル） */
const CAMERA_FAR_CLIP = 400000;

/** Phase 2（垂直移動）に切り替えるカメラ高度の閾値（メートル） */
const SKY_ZOOM_ALTITUDE_THRESHOLD = 1000;

/** 1度の緯度あたりのメートル数（概算） */
const METERS_PER_DEGREE_LAT = 111320;

/**
 * `DefaultScene` 経由で外部からカメラ・位置を操作するためのコントローラ (T5 / Issue #119)。
 *
 * `JpmapTerrain` (パッケージ層) から get/set/flyTo を呼び出す際の境界となる。
 * シーン内部のクロージャ (`currentLat` / `camera` / `refreshTerrain`) を直接公開せず、
 * 必要な操作のみ関数として提供する。
 */
export interface DefaultSceneController {
    getLat(): number;
    getLon(): number;
    /** 高度（メートル）= ArcRotateCamera.radius */
    getAltitude(): number;
    /** 方位角（度）= camera.alpha を北基準・度に変換した値 */
    getAzimuth(): number;
    /** チルト角（度）= camera.beta を度に変換した値 */
    getTilt(): number;

    /** 緯度を即時反映する。Japan bounds でクランプされる */
    setLat(value: number): void;
    /** 経度を即時反映する。Japan bounds でクランプされる */
    setLon(value: number): void;
    setAltitude(value: number): void;
    setAzimuth(value: number): void;
    setTilt(value: number): void;

    /**
     * 複数のカメラ/位置パラメータをまとめて適用する (T5)。
     *
     * `flyTo` のような高頻度更新では `options.refreshTerrain` を `false` にして
     * タイル中心更新（`tileManager.setCenter` 経由の fetch）を抑制し、
     * 遷移完了時など必要なタイミングで `true` を渡してまとめて反映する。
     * 既定値は `true`（単体 setter と同じ挙動）。
     */
    setView(
        values: {
            lat?: number;
            lon?: number;
            altitude?: number;
            azimuth?: number;
            tilt?: number;
        },
        options?: { refreshTerrain?: boolean },
    ): void;

    // ---- UI / mapType (T6 / Issue #120) ----

    /** 現在の地図種類を spec 表記 (`standard` / `photo`) で返す */
    getMapType(): "standard" | "photo";
    /** 地図種類を切り替える。ボタン表示も一緒に追従させる */
    setMapType(value: "standard" | "photo"): void;
    /**
     * コントロールパネル要素の表示・非表示を切り替える (spec §3.3.2)。
     */
    setUiVisibility(
        target:
            | "compass"
            | "zoomButtons"
            | "scaleBar"
            | "mapToggle"
            | "attribution",
        visible: boolean,
    ): void;

    /**
     * 太陽位置計算に使う日時を設定し、太陽位置（時間による明るさ・方向）の状態を即時 1 回反映する (Issue #35)。
     *
     * `dateTime` が `null` の場合は内部の決定的フォールバック時刻
     * （{@link SUN_FALLBACK_DATETIME_ISO}）を使用する。
     * 自動更新タイマーは `JpmapTerrain` 側で管理されるため、本メソッドは時刻保存と反映のみを行い、
     * `computeSunPosition` → `deriveSunState` → 各 Babylon 要素への適用までを 1 回で完了する。
     */
    setSunState(dateTime: Date | null): void;

    /**
     * 太陽 DirectionalLight による地形への影描画を有効/無効化する (Issue #39)。
     *
     * - `true`: `ShadowGenerator` を生成し、`tileManager` 経由でアクティブな全タイルおよび
     *   以後 `meshPool.acquire` されるメッシュを caster / receiver として登録する。
     *   既定 OFF のため、有効化はこのメソッド経由でのみ行う。
     * - `false`: 登録済みフックを解除し、現在アクティブなメッシュから caster/receiver 設定を
     *   外したうえで `ShadowGenerator` を `dispose` する（GPU リソースを保持し続けない）。
     * - 同値再呼び出しは no-op（idempotent）。
     */
    setSunShadows(enabled: boolean): void;

    /**
     * `JpmapTerrain.dispose()` から呼ばれる UI クリーンアップ (T7 / Issue #121)。
     *
     * `controlPanel` が `document.body` に追加した UI 要素 (コンパス / ズームボタンコンテナ / 地図切替) を
     * 親要素から除去する。複数インスタンス共存および再マウント時に UI が残留するのを防ぐ。
     * Scene/Engine の dispose は `JpmapTerrain` 側で行う（このメソッドはあくまで UI 限定）。
     */
    dispose(): void;
}

/**
 * `DefaultScene.createScene` の初期化オプション (T4 / Issue #118)。
 *
 * パッケージ利用 (`JpmapTerrain.create`) で初期パラメータを指定するために導入。
 * URL からの初期位置解決はデモ層 (`src/index.ts`) に移管されており (Issue #136)、
 * このシーン側では「options で指定された値 > デフォルト値」の順で解決する。
 */
export interface DefaultSceneInitOptions {
    /** 初期緯度（度）。未指定時はデフォルト値（東京駅付近）を用いる */
    lat?: number;
    /** 初期経度（度）。未指定時はデフォルト値（東京駅付近）を用いる */
    lon?: number;
    /** カメラ高度＝ArcRotateCamera radius（メートル） */
    altitude?: number;
    /** カメラ方位角（度）。0 で北向き */
    azimuth?: number;
    /** カメラチルト角（度）。0 で真下、90 で水平 */
    tilt?: number;
    /** 地図種類（T6 で配線） */
    mapType?: "standard" | "photo";
    /**
     * `mapType` が実際に変化した際に呼ばれるコールバック (Issue #149)。
     *
     * - `controller.setMapType` 経由・UI ボタンクリック経由のいずれの変化でも発火する。
     * - 起動時の初期値設定では発火しない（呼び出し側との重複通知防止）。
     * - 同値再 set では発火しない。
     */
    onMapTypeChange?: (mapType: "standard" | "photo") => void;
    /**
     * シーン構築完了時に外部操作用コントローラを受け取るコールバック (T5)。
     * `JpmapTerrain` の get/set/flyTo はこのコントローラ経由でカメラ・位置を更新する。
     */
    onReady?: (controller: DefaultSceneController) => void;
}

export class DefaultScene implements CreateSceneClass {
    createScene = async (
        engine: AbstractEngine,
        canvas: HTMLCanvasElement,
        options?: DefaultSceneInitOptions,
    ): Promise<Scene> => {
        const azimuthDeg = options?.azimuth ?? 0;
        const tiltDeg = options?.tilt ?? 45;
        const altitude = options?.altitude ?? 2000;

        const scene = new Scene(engine);
        scene.clearColor.set(0.75, 0.86, 0.95, 1);

        // カメラ
        const camera = new ArcRotateCamera(
            "terrain-camera",
            -Math.PI / 2 + (azimuthDeg * Math.PI) / 180,
            (tiltDeg * Math.PI) / 180,
            altitude,
            Vector3.Zero(),
            scene,
        );
        camera.lowerRadiusLimit = CAMERA_LOWER_RADIUS;
        camera.upperRadiusLimit = CAMERA_UPPER_RADIUS;
        camera.minZ = 1;
        camera.maxZ = CAMERA_FAR_CLIP;

        // チルト制限（地面から15° = beta上限 5π/12）
        camera.upperBetaLimit = Math.PI / 2 - Math.PI / 12;
        // beta=0（真下視点）はArcRotateCameraのジンバルロック・数値不安定を招くため最小値を設定
        camera.lowerBetaLimit = 0.1;

        // デフォルト入力をすべて無効化（カスタムハンドラで制御）
        camera.inputs.removeByType("ArcRotateCameraPointersInput");
        camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
        camera.inputs.removeByType("ArcRotateCameraMouseWheelInput");
        camera.attachControl(canvas, true);

        // ライト: 環境光（ベース）+ 太陽方向の指向性ライト（時間連動）
        const hemiLight = new HemisphericLight(
            "sky-light",
            new Vector3(0, 1, 0),
            scene
        );
        hemiLight.intensity = 1.0;

        const sunLight = new DirectionalLight(
            "sun-light",
            new Vector3(0, -1, 0),
            scene
        );
        sunLight.intensity = 0;

        // スカイボックス
        const skyboxHandle = createSkybox(scene);

        // 太陽メッシュ（地平線下では非表示）。
        // サイズはカメラ最大遠と独立に小さく作り、`infiniteDistance` で常に同距離感に見せる。
        const sunMesh = CreateSphere(
            "sun-mesh",
            { diameter: 1, segments: 12 },
            scene
        );
        const sunMaterial = new StandardMaterial("sun-mesh-mat", scene);
        sunMaterial.emissiveColor = new Color3(1, 0.95, 0.8);
        sunMaterial.disableLighting = true;
        sunMesh.material = sunMaterial;
        sunMesh.isPickable = false;
        sunMesh.infiniteDistance = true;
        // `infiniteDistance` はビュー変換のみカメラ追従させるため、
        // フラスタムカリングは元の world 座標で行われる。遠方にある太陽メッシュが
        // カリングされて描画されないのを防ぐため、常時アクティブ化する。
        sunMesh.alwaysSelectAsActiveMesh = true;
        sunMesh.setEnabled(false);

        // 初期位置（options > デフォルト 東京駅付近）
        const initialLat = options?.lat ?? 35.681236;
        const initialLon = options?.lon ?? 139.767125;

        // UIパネル
        const ui = createControlPanel();

        let currentLat = initialLat;
        let currentLon = initialLon;

        // TileManager 生成
        const tileManager = createTileManager({
            scene,
            camera,
            zoom: MAX_ZOOM,
            subdivisions: TERRAIN_SUBDIVISIONS,
            heightScale: HEIGHT_SCALE,
            minZoom: MIN_ZOOM,
            maxElevationZoom: MAX_ELEVATION_ZOOM,
            minElevationZoom: MIN_ELEVATION_ZOOM,
            maxTiles: 160,
            cacheCapacity: 256,
            rootSearchRadius: ROOT_SEARCH_RADIUS,
        });

        let gridResidualX = 0;
        let gridResidualZ = 0;

        const refreshTerrain = async (): Promise<void> => {
            currentLat = clamp(
                currentLat,
                JAPAN_BOUNDS.minLat,
                JAPAN_BOUNDS.maxLat
            );
            currentLon = clamp(
                currentLon,
                JAPAN_BOUNDS.minLon,
                JAPAN_BOUNDS.maxLon
            );
            await tileManager.setCenter(currentLat, currentLon, 0);
        };

        // ---------- カメラターゲットオフセット → 緯度経度変換 ----------
        //
        // 不変条件 (Issue #151):
        //   - camera.target.x = gridResidualX
        //   - camera.target.z = gridResidualZ
        //   - currentLat/Lon は target.x/z と同期
        //   - 通常時 camera.target.y = 0
        //   - Ctrl+drag 中のみ target.y を実標高に置くことを許容するが、リリース直後に
        //     restoreTargetYZero でカメラ姿勢を保ったまま y=0 平面に戻す。
        const commitPanOffset = (): void => {
            const tx = camera.target.x;
            const tz = camera.target.z;
            // 新規オフセット = 全体 - 既知のグリッド残差
            const newOffsetX = tx - gridResidualX;
            const newOffsetZ = tz - gridResidualZ;
            if (
                Math.abs(newOffsetX) < 0.01 &&
                Math.abs(newOffsetZ) < 0.01
            ) {
                return;
            }

            const oldLat = currentLat;
            const oldLon = currentLon;
            const metersPerDegreeLon =
                METERS_PER_DEGREE_LAT *
                Math.cos((oldLat * Math.PI) / 180);

            const newLat = clamp(
                oldLat + newOffsetZ / METERS_PER_DEGREE_LAT,
                JAPAN_BOUNDS.minLat,
                JAPAN_BOUNDS.maxLat
            );
            const newLon = clamp(
                oldLon + newOffsetX / metersPerDegreeLon,
                JAPAN_BOUNDS.minLon,
                JAPAN_BOUNDS.maxLon
            );

            const oldTile = toTileXY(oldLat, oldLon, MAX_ZOOM);
            const newTile = toTileXY(newLat, newLon, MAX_ZOOM);
            const tileSize = tileEdgeMeters(newLat, MAX_ZOOM);
            const gridShiftX = (newTile.x - oldTile.x) * tileSize;
            const gridShiftZ = -((newTile.y - oldTile.y) * tileSize);

            // 残差更新: 旧残差 + 新規オフセット - グリッドシフト
            gridResidualX = gridResidualX + newOffsetX - gridShiftX;
            gridResidualZ = gridResidualZ + newOffsetZ - gridShiftZ;

            // target を残差基準にスナップ。target.y は Ctrl+drag で山頂中心の回転を
            // 許容するため触らない（lat/lon 対応は x/z のみを使用）。
            camera.target.x = gridResidualX;
            camera.target.z = gridResidualZ;

            currentLat = newLat;
            currentLon = newLon;
            void refreshTerrain();
        };

        // ---------- レイ-平面交差ユーティリティ ----------
        const intersectPlane = (
            screenX: number,
            screenY: number,
            planeY: number
        ): { x: number; z: number } | null => {
            const renderW = engine.getRenderWidth();
            const renderH = engine.getRenderHeight();
            const scaleX = renderW / canvas.clientWidth;
            const scaleY = renderH / canvas.clientHeight;
            const view = camera.getViewMatrix();
            const proj = camera.getProjectionMatrix();
            const identity = Matrix.Identity();
            const near = Vector3.Unproject(
                new Vector3(screenX * scaleX, screenY * scaleY, 0),
                renderW, renderH, identity, view, proj
            );
            const far = Vector3.Unproject(
                new Vector3(screenX * scaleX, screenY * scaleY, 1),
                renderW, renderH, identity, view, proj
            );
            const dirY = far.y - near.y;
            if (Math.abs(dirY) < 1e-6) return null;
            const t = (planeY - near.y) / dirY;
            if (t <= 0) return null;
            return {
                x: near.x + (far.x - near.x) * t,
                z: near.z + (far.z - near.z) * t,
            };
        };

        /** 現在のカメラ位置直下の地形高さから、衝突回避に必要な最小 radius を返す */
        let cachedMinRadius = CAMERA_LOWER_RADIUS;
        let prevAlpha = NaN;
        let prevBeta = NaN;
        let prevRadius = NaN;
        let prevTargetX = NaN;
        let prevTargetY = NaN;
        let prevTargetZ = NaN;

        const terrainMinRadius = (): number => {
            const { alpha, beta, radius } = camera;
            const { x: tx, y: ty, z: tz } = camera.target;
            // 入力 (alpha/beta/radius/target) に NaN/Infinity が混入している場合は
            // 算出が破綻するため、早期に lowerRadiusLimit を返す (Issue #151)。
            // ここでは prev* を NaN に倒してキャッシュキーを無効化する。
            // そうしないと、後続で正常値（直前の prev と同じ値）に戻ったとき
            // キャッシュヒットして下限値のまま再計算されない可能性がある。
            if (
                !Number.isFinite(alpha) ||
                !Number.isFinite(beta) ||
                !Number.isFinite(radius) ||
                !Number.isFinite(tx) ||
                !Number.isFinite(ty) ||
                !Number.isFinite(tz)
            ) {
                prevAlpha = NaN;
                prevBeta = NaN;
                prevRadius = NaN;
                prevTargetX = NaN;
                prevTargetY = NaN;
                prevTargetZ = NaN;
                cachedMinRadius = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                return cachedMinRadius;
            }
            if (
                alpha === prevAlpha &&
                beta === prevBeta &&
                radius === prevRadius &&
                tx === prevTargetX &&
                ty === prevTargetY &&
                tz === prevTargetZ
            ) {
                return cachedMinRadius;
            }
            prevAlpha = alpha;
            prevBeta = beta;
            prevRadius = radius;
            prevTargetX = tx;
            prevTargetY = ty;
            prevTargetZ = tz;

            const cosB = Math.cos(beta);
            if (Math.abs(cosB) < 1e-6) {
                cachedMinRadius = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                return cachedMinRadius;
            }
            const sinB = Math.sin(beta);
            const camX = tx + radius * sinB * Math.cos(alpha);
            const camY = ty + radius * cosB;
            const camZ = tz + radius * sinB * Math.sin(alpha);

            const ray = new Ray(
                new Vector3(camX, camY, camZ),
                Vector3.Down(),
                Math.max(camY + 1000, CAMERA_LOWER_RADIUS + 1000)
            );
            const pick = scene.pickWithRay(ray, (m) => m.name.startsWith("tile-ground-"));

            // レイキャストによる地形高さ
            let terrainY: number | null =
                pick?.hit && pick.pickedPoint ? pick.pickedPoint.y : null;

            // キャッシュ済み標高データから高精度な値を補完
            const cacheElev = tileManager.queryElevationAtWorld(camX, camZ);
            if (cacheElev !== null && Number.isFinite(cacheElev)) {
                terrainY = terrainY !== null ? Math.max(terrainY, cacheElev) : cacheElev;
            }

            if (terrainY === null) {
                cachedMinRadius = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                return cachedMinRadius;
            }

            const minCamY = terrainY + CAMERA_LOWER_RADIUS;
            const computed = (minCamY - ty) / cosB;
            // 非有限値・下限未満は lowerRadiusLimit にクランプ (Issue #151)
            const lowerLimit = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
            if (!Number.isFinite(computed) || computed < lowerLimit) {
                cachedMinRadius = lowerLimit;
                return cachedMinRadius;
            }
            cachedMinRadius = computed;
            return cachedMinRadius;
        };

        // ---------- カスタムマウスハンドラ ----------
        let pointerDown = false;
        let lastPointerX = 0;
        let lastPointerY = 0;
        let activePointerId = -1;
        let dragAnchor: { x: number; z: number } | null = null;
        let dragPlaneY = 0;

        /**
         * ターゲットを付け替えカメラのワールド位置を保つよう alpha/beta/radius を再計算。
         * limit 逸脱や退化ケースで apply されないときは false を返す。
         */
        const retargetPreservingPose = (newTarget: {
            x: number;
            y: number;
            z: number;
        }): boolean => {
            const { alpha, beta, radius } = camera;
            const sinB = Math.sin(beta);
            const cosB = Math.cos(beta);
            const camPos = {
                x: camera.target.x + radius * sinB * Math.cos(alpha),
                y: camera.target.y + radius * cosB,
                z: camera.target.z + radius * sinB * Math.sin(alpha),
            };
            const result = computePoseForNewTarget(camPos, newTarget, alpha, {
                lowerBeta: camera.lowerBetaLimit ?? 0,
                upperBeta: camera.upperBetaLimit ?? Math.PI,
                lowerRadius: camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS,
                upperRadius: camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS,
            });
            if (result.action !== "apply") return false;
            camera.target.copyFromFloats(newTarget.x, newTarget.y, newTarget.z);
            camera.alpha = result.alpha;
            camera.beta = result.beta;
            camera.radius = result.radius;
            return true;
        };

        canvas.addEventListener("contextmenu", (e) => e.preventDefault());

        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            pointerDown = true;
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
            activePointerId = e.pointerId;
            canvas.setPointerCapture(e.pointerId);

            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            // Ctrl/Cmd 押下開始時: 画面中央でヒットしたメッシュ点（例: 富士山山頂）を
            // 回転中心にするため target をその点に付け替える (Issue #151)。
            // target.y はヒットした高度を採用し、リリース時に y=0 にポーズ保持で戻す。
            if (e.ctrlKey || e.metaKey) {
                commitPanOffset();
                const cx = canvas.clientWidth / 2;
                const cy = canvas.clientHeight / 2;
                const centerPick = scene.pick(cx, cy, (m) => m.name.startsWith("tile-ground-"));
                if (centerPick?.hit && centerPick.pickedPoint) {
                    const p = centerPick.pickedPoint;
                    if (retargetPreservingPose({ x: p.x, y: p.y, z: p.z })) {
                        gridResidualX = camera.target.x;
                        gridResidualZ = camera.target.z;
                    }
                }
            }

            // 通常ドラッグの可否判定 (Issue #151 仕様再定義):
            //   1. メッシュにヒットすること
            //   2. ピック点 Y がカメラ Y より低いこと（カメラ高度以上はドラッグ不可）
            // 距離制限は実用上の不利益（画面隅の遠景がドラッグ不可になる）が大きく
            // ユーザー指示で撤廃。
            const camWY = camera.target.y + camera.radius * Math.cos(camera.beta);
            const pick = scene.pick(sx, sy, (m) => m.name.startsWith("tile-ground-"));
            dragAnchor = null;
            if (pick?.hit && pick.pickedPoint && pick.pickedPoint.y < camWY) {
                dragPlaneY = pick.pickedPoint.y;
                dragAnchor = intersectPlane(sx, sy, dragPlaneY);
            }
        });

        canvas.addEventListener("pointermove", (e: PointerEvent) => {
            if (!pointerDown || e.pointerId !== activePointerId) return;

            if (e.ctrlKey || e.metaKey) {
                // Ctrl/Cmd + ドラッグ: 水平=パン(alpha)、垂直=チルト(beta)
                const dx = e.clientX - lastPointerX;
                const dy = e.clientY - lastPointerY;
                lastPointerX = e.clientX;
                lastPointerY = e.clientY;
                camera.alpha -= dx * 0.003;
                const prevBeta = camera.beta;
                camera.beta -= dy * 0.003;
                camera.beta = clamp(
                    camera.beta,
                    camera.lowerBetaLimit ?? 0,
                    camera.upperBetaLimit ?? Math.PI
                );
                // チルト変更で地形に衝突するなら自動ズームアウトで回避
                const radiusBeforeTilt = camera.radius;
                const tiltResult = resolveTiltCollision(
                    camera.radius,
                    terrainMinRadius(),
                    camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS,
                    TILT_MAX_RADIUS_INCREASE_RATIO,
                );
                if (tiltResult.action === "revert") {
                    camera.beta = prevBeta;
                } else if (tiltResult.action === "zoomOut") {
                    camera.radius = tiltResult.radius;
                    // radius 変更でカメラ位置が移動するため再検証
                    // 新位置でまだ衝突するなら beta・radius 両方を復元
                    if (camera.radius < terrainMinRadius()) {
                        camera.beta = prevBeta;
                        camera.radius = radiusBeforeTilt;
                    }
                }
            } else if (dragAnchor) {
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;

                // ドラッグ開始時に決定した水平面 (dragPlaneY) でカーソル直下を
                // アンカーする標準的な grab パン。
                const current = intersectPlane(sx, sy, dragPlaneY);
                if (current) {
                    let dx = dragAnchor.x - current.x;
                    let dz = dragAnchor.z - current.z;
                    // 遠景・水平線付近のドラッグでレイ交点が大きく動き、1フレームの移動量が
                    // 際限なく膨らむのを抑制する (Issue #151)。
                    // 1フレームあたりの最大移動距離をカメラの radius に比例した値に制限。
                    const maxStep = camera.radius * 0.5;
                    const stepLen = Math.hypot(dx, dz);
                    if (stepLen > maxStep && stepLen > 0) {
                        const k = maxStep / stepLen;
                        dx *= k;
                        dz *= k;
                    }
                    camera.target.x += dx;
                    camera.target.z += dz;

                    // パン後にカメラがメッシュを突き抜けないよう radius を下限まで持ち上げる。
                    const cosB = Math.cos(camera.beta);
                    const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
                    let minR = terrainMinRadius();
                    if (cosB > 1e-6) {
                        const requiredFromPick = (dragPlaneY + CAMERA_LOWER_RADIUS - camera.target.y) / cosB;
                        if (Number.isFinite(requiredFromPick) && requiredFromPick > minR) {
                            minR = requiredFromPick;
                        }
                    }
                    if (camera.radius < minR) {
                        camera.radius = Math.min(minR, upper);
                    }
                    dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                }
            }
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
        });

        /**
         * Ctrl+drag 中に target.y を実標高に置いた場合、リリース時に target.y=0 へ戻す。
         * カメラのワールド位置・alpha・beta は維持し、視線レイと y=0 平面の交点を新 target に
         * して radius を再計算する。target.x/z の変位は gridResidual と lat/lon に反映する。
         */
        const restoreTargetYZero = (): void => {
            if (Math.abs(camera.target.y) < 1e-3) return;
            const { alpha, beta } = camera;
            const sinB = Math.sin(beta);
            const cosB = Math.cos(beta);
            const camX = camera.target.x + camera.radius * sinB * Math.cos(alpha);
            const camY = camera.target.y + camera.radius * cosB;
            const camZ = camera.target.z + camera.radius * sinB * Math.sin(alpha);
            // ターゲット方向 (camera -> target): -(sinβcosα, cosβ, sinβsinα)
            const dirX = -sinB * Math.cos(alpha);
            const dirY = -cosB;
            const dirZ = -sinB * Math.sin(alpha);
            if (Math.abs(dirY) < 1e-6 || dirY > 0) {
                // 真横/見上げ姿勢では y=0 と前方交点なし→ y のみリセット
                camera.target.y = 0;
                return;
            }
            const t = -camY / dirY;
            const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
            const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
            if (!Number.isFinite(t) || t < lower || t > upper) {
                camera.target.y = 0;
                return;
            }
            const newTx = camX + t * dirX;
            const newTz = camZ + t * dirZ;
            // target.x/z 変位を lat/lon に確定反映してから新位置にスナップ。
            // 下記順序で gridResidual を確定させ、その後 target を新位置に置く。
            camera.target.x = newTx;
            camera.target.y = 0;
            camera.target.z = newTz;
            camera.radius = t;
            commitPanOffset();
        };

        canvas.addEventListener("pointerup", (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            pointerDown = false;
            canvas.releasePointerCapture(e.pointerId);
            commitPanOffset();
            restoreTargetYZero();
        });

        const resetPointerState = (): void => {
            pointerDown = false;
            activePointerId = -1;
            dragAnchor = null;
            commitPanOffset();
            restoreTargetYZero();
        };

        canvas.addEventListener("pointercancel", resetPointerState);
        canvas.addEventListener("lostpointercapture", resetPointerState);

        // ホイール / ダブルクリック: ポインタ方向にズーム

        /** カメラ→ターゲット方向のレイで地形メッシュとの交差距離を返す（ミス時は null） */
        const queryViewRayDistance = (): number | null => {
            const { alpha, beta, radius } = camera;
            const { x: tx, y: ty, z: tz } = camera.target;
            const sinB = Math.sin(beta);
            const cosB = Math.cos(beta);
            const camX = tx + radius * sinB * Math.cos(alpha);
            const camY = ty + radius * cosB;
            const camZ = tz + radius * sinB * Math.sin(alpha);

            const origin = new Vector3(camX, camY, camZ);

            // ターゲット直下の地形標高でレイ目標点を補正
            const terrainY = tileManager.queryElevationAtWorld(tx, tz);
            const aimY = terrainY !== null ? Math.max(ty, terrainY) : ty;
            const aim = new Vector3(tx, aimY, tz);

            const direction = aim.subtract(origin);
            const length = direction.length();
            if (length < 1e-6) return null;
            direction.scaleInPlace(1 / length);

            const ray = new Ray(origin, direction, length * 2);
            const pick = scene.pickWithRay(ray, (m) => m.name.startsWith("tile-ground-"));
            if (pick?.hit && pick.distance > 0) {
                return pick.distance;
            }
            return null;
        };

        /** レイキャスト距離の一定割合を1ステップとするホイールfactorを返す */
        const WHEEL_STEP = 0.05;
        const computeWheelFactor = (zoomIn: boolean): number => {
            const rayDist = queryViewRayDistance();
            const dist = rayDist ?? camera.radius;
            const delta = dist * WHEEL_STEP;
            return zoomIn
                ? (camera.radius - delta) / camera.radius
                : (camera.radius + delta) / camera.radius;
        };

        const zoomTowardPoint = (
            worldX: number,
            worldZ: number,
            factor: number
        ): void => {
            const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
            const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
            if (factor > 1 && camera.radius >= upper) return;
            if (factor < 1 && camera.radius <= lower) return;

            // 衝突制限を考慮した実効 lower を算出
            const effectiveLower = Math.max(lower, terrainMinRadius());
            const newRadius = clamp(camera.radius * factor, effectiveLower, upper);
            // 非有限値ガード (Issue #151): factor/radius が NaN/Infinity だった場合は何もしない
            if (!Number.isFinite(newRadius)) return;
            if (Math.abs(newRadius - camera.radius) < 0.01) return;

            // ズームイン操作なのに半径が増える場合はターゲット移動せず半径だけ補正
            if (factor < 1 && newRadius > camera.radius) {
                camera.radius = newRadius;
                commitPanOffset();
                return;
            }

            const actualFactor = newRadius / camera.radius;
            camera.target.x += (worldX - camera.target.x) * (1 - actualFactor);
            camera.target.z += (worldZ - camera.target.z) * (1 - actualFactor);
            camera.radius = newRadius;
            commitPanOffset();
        };

        /** メッシュまたは y=0 平面との交点を返す。空なら null */
        const pickOrPlane = (
            sx: number,
            sy: number
        ): { worldX: number; worldZ: number } | null => {
            // scene.pick() は内部で DPR スケーリングを行うため CSS 座標をそのまま渡す
            const pick = scene.pick(sx, sy);
            if (pick?.hit && pick.pickedPoint) {
                return {
                    worldX: pick.pickedPoint.x,
                    worldZ: pick.pickedPoint.z,
                };
            }
            const plane = intersectPlane(sx, sy, 0);
            return plane ? { worldX: plane.x, worldZ: plane.z } : null;
        };

        /** ピック結果がカメラターゲットから近いかどうか */
        const isPickNearTarget = (
            hit: { worldX: number; worldZ: number }
        ): boolean => {
            const dx = hit.worldX - camera.target.x;
            const dz = hit.worldZ - camera.target.z;
            const dist2 = dx * dx + dz * dz;
            const threshold = camera.radius * 3;
            return dist2 < threshold * threshold;
        };

        canvas.addEventListener(
            "wheel",
            (e: WheelEvent) => {
                if (e.deltaY === 0) return;
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                const hit = pickOrPlane(e.clientX - rect.left, e.clientY - rect.top);
                if (hit && isPickNearTarget(hit)) {
                    const factor = computeWheelFactor(e.deltaY < 0);
                    zoomTowardPoint(hit.worldX, hit.worldZ, factor);
                } else {
                    // 空のホイール操作: カメラ高度ベースの2段階ズーム
                    const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
                    const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                    const zoomIn = e.deltaY < 0;
                    const factor = computeWheelFactor(zoomIn);
                    const cameraHeight = camera.radius * Math.cos(camera.beta);
                    const useVertical = zoomIn
                        ? cameraHeight <= SKY_ZOOM_ALTITUDE_THRESHOLD
                        : cameraHeight < SKY_ZOOM_ALTITUDE_THRESHOLD;

                    if (useVertical) {
                        // Phase 2: 垂直移動（カメラの緯度経度固定）
                        const effectiveLower2 = Math.max(lower, terrainMinRadius());
                        if (zoomIn && camera.radius <= effectiveLower2) return;
                        if (!zoomIn && camera.radius >= upper) return;
                        const sinB = Math.sin(camera.beta);
                        const camX = camera.target.x + camera.radius * sinB * Math.cos(camera.alpha);
                        const camZ = camera.target.z + camera.radius * sinB * Math.sin(camera.alpha);
                        const newRadius = clamp(camera.radius * factor, effectiveLower2, upper);
                        if (!Number.isFinite(newRadius)) return;
                        camera.target.x = camX - newRadius * sinB * Math.cos(camera.alpha);
                        camera.target.z = camZ - newRadius * sinB * Math.sin(camera.alpha);
                        camera.radius = newRadius;
                        commitPanOffset();
                    } else {
                        // Phase 1: ターゲットに向かってズーム（target は不変）
                        const effectiveLower1 = Math.max(lower, terrainMinRadius());
                        if (zoomIn && camera.radius <= effectiveLower1) return;
                        if (!zoomIn && camera.radius >= upper) return;
                        const next = clamp(camera.radius * factor, effectiveLower1, upper);
                        if (!Number.isFinite(next)) return;
                        camera.radius = next;
                    }
                }
            },
            { passive: false }
        );

        canvas.addEventListener("dblclick", (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            const hit = pickOrPlane(e.clientX - rect.left, e.clientY - rect.top);
            if (hit && isPickNearTarget(hit)) {
                zoomTowardPoint(hit.worldX, hit.worldZ, 0.7);
            } else {
                // 空のダブルクリック: ターゲットに向かってズーム
                const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                if (camera.radius <= lower) return;
                camera.radius = clamp(
                    camera.radius * 0.7,
                    lower,
                    camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS
                );
            }
        });

        // 方位磁針の回転同期
        const syncCompass = (): void => {
            const degrees = (camera.alpha * 180) / Math.PI + 90;
            ui.compass.style.transform = `rotate(${degrees}deg)`;
        };
        camera.onViewMatrixChangedObservable.add(syncCompass);

        // スケールバー更新
        const SCALE_BAR_BASE_PX = 100;
        let prevScaleText = "";
        const updateScaleBar = (): void => {
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const center = intersectPlane(cx, cy, 0);
            const offset = intersectPlane(cx + SCALE_BAR_BASE_PX, cy, 0);
            if (!center || !offset) return;
            const dx = offset.x - center.x;
            const dz = offset.z - center.z;
            const rawMeters = Math.sqrt(dx * dx + dz * dz);
            const metersPerPx = rawMeters / SCALE_BAR_BASE_PX;
            const snapped = snapScale(rawMeters);
            const barPx = Math.round(snapped / metersPerPx);
            const text = formatScale(snapped);
            if (text !== prevScaleText) {
                ui.scaleBar.label.textContent = text;
                prevScaleText = text;
            }
            ui.scaleBar.bar.style.width = `${barPx}px`;
        };
        camera.onViewMatrixChangedObservable.add(updateScaleBar);
        engine.onResizeObservable.add(updateScaleBar);
        updateScaleBar();

        // ウィンドウ/canvas のリサイズ時に可視タイル集合を再計算する (Issue #150)。
        // 可視タイル更新は通常 camera.onViewMatrixChangedObservable をトリガに走るが、
        // リサイズ単独ではビュー行列が変わらないため発火せず、新たに視野へ入った領域の
        // タイルが取得・描画されない。`tileManager.applyVisibleTiles` は不要解放と
        // 新規ロードの差分処理のみ行うため、ここから refreshTerrain を呼んでも
        // 既存タイルは保持され、ちらつきは発生しない。
        // 購読解除・保留中タイマーのクリアは attachResizeRefresh が
        // scene.onDisposeObservable 経由で自動的に行う (PR #153 レビュー指摘対応)。
        attachResizeRefresh(engine, scene, () => refreshTerrain());

        // 方位磁針: 北向き・真下にスムーズアニメーション
        ui.compass.style.cursor = "pointer";
        const resetCompassView = (): void => {
            // カメラ光軸と地形メッシュの交点を新しい中心座標にする
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const centerHit = pickOrPlane(cx, cy);
            if (centerHit) {
                camera.target.x = centerHit.worldX;
                camera.target.z = centerHit.worldZ;
                commitPanOffset();
            }

            const targetAlpha = -Math.PI / 2; // 北向き
            const targetBeta = camera.lowerBetaLimit ?? 0.1; // ほぼ真下
            const duration = 400;             // ms
            const startAlpha = camera.alpha;
            const startBeta = camera.beta;
            const startTime = performance.now();

            const animate = (now: number): void => {
                const elapsed = now - startTime;
                const t = Math.min(elapsed / duration, 1);
                // ease-out cubic
                const ease = 1 - Math.pow(1 - t, 3);
                camera.alpha = startAlpha + (targetAlpha - startAlpha) * ease;
                camera.beta = startBeta + (targetBeta - startBeta) * ease;
                if (t < 1) {
                    requestAnimationFrame(animate);
                }
            };
            requestAnimationFrame(animate);
        };
        ui.compass.addEventListener("click", resetCompassView);
        ui.compass.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                resetCompassView();
            }
        });

        // ズームボタン: 画面中央に向かってズーム
        const zoomFromCenter = (factor: number): void => {
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const hit = pickOrPlane(cx, cy);
            if (hit && isPickNearTarget(hit)) {
                zoomTowardPoint(hit.worldX, hit.worldZ, factor);
            }
        };
        ui.zoomIn.addEventListener("click", () => zoomFromCenter(0.7));
        ui.zoomOut.addEventListener("click", () => zoomFromCenter(1 / 0.7));

        // 現在地を表示ボタン
        ui.locateMe.addEventListener("click", () => {
            if (!navigator.geolocation) {
                console.warn("Geolocation API is not supported by this browser.");
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lon = position.coords.longitude;
                    if (
                        lat < JAPAN_BOUNDS.minLat ||
                        lat > JAPAN_BOUNDS.maxLat ||
                        lon < JAPAN_BOUNDS.minLon ||
                        lon > JAPAN_BOUNDS.maxLon
                    ) {
                        showToast("現在地は対応エリア外のため、最も近い地点を表示します");
                    }
                    currentLat = lat;
                    currentLon = lon;
                    camera.target.x = 0;
                    camera.target.y = 0;
                    camera.target.z = 0;
                    gridResidualX = 0;
                    gridResidualZ = 0;
                    void refreshTerrain();
                },
                (error) => {
                    console.warn("Geolocation error:", error.message);
                },
            );
        });

        // 地図切替ボタン
        // クリック時 / controller.setMapType の双方からラベル更新を共通化する (T6)。
        const updateMapToggleLabel = (current: "std" | "photo"): void => {
            ui.mapToggle.textContent = current === "std" ? "写真" : "標準";
            ui.mapToggle.setAttribute(
                "aria-label",
                current === "std"
                    ? "地図切替: 写真地図に変更"
                    : "地図切替: 標準地図に変更",
            );
        };
        // 初期 mapType がオプション指定されていれば反映する (T6)。
        // 初期反映は onMapTypeChange を発火させない（呼び出し側との重複通知防止 / Issue #149）。
        if (options?.mapType) {
            const initialInternal =
                options.mapType === "standard" ? "std" : "photo";
            tileManager.setMapType(initialInternal);
            updateMapToggleLabel(initialInternal);
        }
        // mapType の値が実際に変化した場合のみ onMapTypeChange を発火する共通ヘルパ (Issue #149)。
        const applyMapTypeChange = (next: "std" | "photo"): void => {
            const prev = tileManager.mapType;
            if (prev === next) return;
            tileManager.setMapType(next);
            updateMapToggleLabel(next);
            options?.onMapTypeChange?.(next === "std" ? "standard" : "photo");
        };
        ui.mapToggle.addEventListener("click", () => {
            const next = tileManager.mapType === "std" ? "photo" : "std";
            applyMapTypeChange(next);
        });

        // カメラ-地形衝突回避: 地面にめり込まないよう radius を補正してストップ
        const clampCameraAboveTerrain = (): void => {
            const minR = terrainMinRadius();
            if (camera.radius >= minR) return;
            camera.radius = minR;
        };
        scene.onBeforeRenderObservable.add(clampCameraAboveTerrain);

        // メッシュ標高更新時にキャッシュを無効化して即座に再チェック
        tileManager.onTerrainUpdated = () => {
            prevAlpha = NaN; // terrainMinRadius のキャッシュを無効化
        };

        // カメラ移動時の自動タイル更新
        tileManager.attachCamera();

        // ---- T5: 外部操作用コントローラ ----
        // JpmapTerrain から get/set/flyTo で呼び出される。
        // 度数法 ⇄ ラジアン変換、alpha の北基準オフセット (-π/2) を吸収する。
        const azimuthDegFromAlpha = (alpha: number): number =>
            ((alpha + Math.PI / 2) * 180) / Math.PI;
        const alphaFromAzimuthDeg = (deg: number): number =>
            -Math.PI / 2 + (deg * Math.PI) / 180;

        // 中心座標の適用と、（必要なら）タイル refresh をまとめて行う共通実装。
        const applyView = (
            values: {
                lat?: number;
                lon?: number;
                altitude?: number;
                azimuth?: number;
                tilt?: number;
            },
            shouldRefresh: boolean,
        ): void => {
            let centerChanged = false;
            if (values.lat !== undefined) {
                currentLat = clamp(
                    values.lat,
                    JAPAN_BOUNDS.minLat,
                    JAPAN_BOUNDS.maxLat,
                );
                centerChanged = true;
            }
            if (values.lon !== undefined) {
                currentLon = clamp(
                    values.lon,
                    JAPAN_BOUNDS.minLon,
                    JAPAN_BOUNDS.maxLon,
                );
                centerChanged = true;
            }
            if (values.altitude !== undefined) {
                const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
                camera.radius = clamp(values.altitude, lower, upper);
            }
            if (values.azimuth !== undefined) {
                camera.alpha = alphaFromAzimuthDeg(values.azimuth);
            }
            if (values.tilt !== undefined) {
                const lower = camera.lowerBetaLimit ?? 0;
                const upper = camera.upperBetaLimit ?? Math.PI;
                camera.beta = clamp(
                    (values.tilt * Math.PI) / 180,
                    lower,
                    upper,
                );
            }
            // 中心座標が変わったときのみ refresh する。
            // altitude/azimuth/tilt はタイル中心に影響しないため refresh 不要。
            if (shouldRefresh && centerChanged) {
                void refreshTerrain();
            }
            // 緯度・経度が変わったら太陽位置を再計算（Issue #35）。
            // ただし `flyTo` の中間フレーム（`shouldRefresh=false`）では skip し、
            // 最終フレームで一度だけ反映する（毎フレーム Color3.Lerp / 行列計算を避ける）。
            // altitude/azimuth/tilt は太陽位置に影響しないので再計算不要。
            if (shouldRefresh && centerChanged) {
                applySunStateForCurrent();
            }
        };

        // ---- 太陽位置適用 (Issue #35) ----
        // タイマー（auto モード）は JpmapTerrain 側で管理し、本シーンは「現時点で
        // 適用すべき日時」を都度受け取って描画反映する役割に閉じる。
        let currentSunDateTime: Date | null = null;
        const fallbackSunDate = new Date(SUN_FALLBACK_DATETIME_ISO);

        // ---- 太陽影 (Issue #39) ----
        // 既定 OFF。ON 化されたときのみ ShadowGenerator を生成し、`tileManager` 経由で
        // 既存タイル / 以後追加されるタイルメッシュへ caster/receiver を反映する。
        let shadowGenerator: ShadowGenerator | null = null;
        // ShadowGenerator の DirectionalLight orthographic frustum 範囲。
        // camera.upperRadiusLimit (= CAMERA_UPPER_RADIUS, 75km) を基準に固定し、
        // autoCalcShadowZBounds の毎フレームコストと WebGPU 不安定要因を避ける。
        const SHADOW_FRUSTUM_RADIUS = CAMERA_UPPER_RADIUS;
        const updateShadowFrustum = (sunDir: Vector3): void => {
            if (!shadowGenerator) return;
            // light.position = camera.target - sunDir * D（光源を地表上空へ移動）
            sunLight.position.set(
                camera.target.x - sunDir.x * SHADOW_FRUSTUM_RADIUS,
                camera.target.y - sunDir.y * SHADOW_FRUSTUM_RADIUS,
                camera.target.z - sunDir.z * SHADOW_FRUSTUM_RADIUS,
            );
            sunLight.shadowMinZ = 1;
            sunLight.shadowMaxZ = SHADOW_FRUSTUM_RADIUS * 2;
            sunLight.orthoLeft = -SHADOW_FRUSTUM_RADIUS;
            sunLight.orthoRight = SHADOW_FRUSTUM_RADIUS;
            sunLight.orthoTop = SHADOW_FRUSTUM_RADIUS;
            sunLight.orthoBottom = -SHADOW_FRUSTUM_RADIUS;
            sunLight.autoCalcShadowZBounds = false;
        };
        const shadowHooks = {
            onAcquire: (mesh: Mesh): void => {
                if (!shadowGenerator) return;
                shadowGenerator.addShadowCaster(mesh);
                mesh.receiveShadows = true;
            },
            onRelease: (mesh: Mesh): void => {
                if (!shadowGenerator) return;
                shadowGenerator.removeShadowCaster(mesh);
                mesh.receiveShadows = false;
            },
        };
        const enableSunShadows = (): void => {
            if (shadowGenerator) return;
            // 構築後の設定で例外が発生しても catch で確実に dispose できるよう、
            // ローカル変数 `sg` を生成直後に `shadowGenerator` へ代入する。
            const sg = new ShadowGenerator(1024, sunLight);
            shadowGenerator = sg;
            try {
                // フィルタ選定: `useBlurExponentialShadowMap` は内部で BlurPostProcess を
                // 利用するが、WebGPU 経路で `infiniteDistance` のメッシュ（太陽メッシュ等）
                // と相互作用して表示が破綻するケースが確認されたため、PostProcess を伴わない
                // PCF (Percentage Closer Filtering) を採用する。WebGL2/WebGPU 双方で安定。
                sg.usePercentageCloserFiltering = true;
                sg.bias = 0.0001;
                sg.setDarkness(0.4);
                tileManager.setShadowHooks(shadowHooks);
                tileManager.forEachActiveMesh((mesh) => {
                    sg.addShadowCaster(mesh);
                    mesh.receiveShadows = true;
                });
            } catch (err) {
                console.warn(
                    "[JpmapTerrain] failed to enable sun shadows:",
                    err,
                );
                shadowGenerator = null;
                sg.dispose();
                tileManager.setShadowHooks(null);
            }
        };
        const disableSunShadows = (): void => {
            if (!shadowGenerator) return;
            tileManager.setShadowHooks(null);
            const sg = shadowGenerator;
            tileManager.forEachActiveMesh((mesh) => {
                sg.removeShadowCaster(mesh);
                mesh.receiveShadows = false;
            });
            sg.dispose();
            shadowGenerator = null;
        };

        const applySunStateForCurrent = (): void => {
            const dateForCalc = currentSunDateTime ?? fallbackSunDate;
            // 念のため Invalid Date のセーフガード（呼び出し側で `null` 同等に倒す）
            if (Number.isNaN(dateForCalc.getTime())) {
                console.warn(
                    "[JpmapTerrain] sun position computation skipped (invalid dateTime)",
                );
                return;
            }
            const { altitudeDeg, azimuthDeg } = computeSunPosition(
                currentLat,
                currentLon,
                dateForCalc,
            );
            if (
                !Number.isFinite(altitudeDeg) ||
                !Number.isFinite(azimuthDeg)
            ) {
                console.warn(
                    `[JpmapTerrain] sun position computation failed (lat=${currentLat}, lon=${currentLon}, date=${dateForCalc.toISOString()}); skipping update`,
                );
                return;
            }
            const state = deriveSunState(altitudeDeg, azimuthDeg);
            // SkyMaterial 更新
            skyboxHandle.applySunToSky(state);
            // 夜は SkyMaterial の物理モデルが破綻するため Skybox を消し、`clearColor`（夜色）を背景に出す。
            skyboxHandle.mesh.setEnabled(state.skyVisible);
            scene.clearColor.set(
                state.clearColor.r,
                state.clearColor.g,
                state.clearColor.b,
                1,
            );
            // 指向性ライト方向 = 太陽から地表向き = -sunDir
            sunLight.direction = state.sunDir.scale(-1);
            sunLight.intensity = state.dayFactor;
            // 影フラスタムは光源方向に追従して更新する (Issue #39)。
            // ShadowGenerator 未生成（OFF）時は no-op。
            if (shadowGenerator) {
                updateShadowFrustum(state.sunDir);
            }
            // 環境光は夜でも完全な暗黒にならないようベース値 + 昼比例
            hemiLight.intensity = 0.2 + 0.8 * state.dayFactor;
            // 太陽メッシュ位置: カメラターゲット + sunDir * (camera.maxZ * 0.5)
            sunMesh.setEnabled(state.visibleAboveHorizon);
            if (state.visibleAboveHorizon) {
                const dist = (camera.maxZ ?? 100000) * 0.5;
                sunMesh.position.set(
                    camera.target.x + state.sunDir.x * dist,
                    camera.target.y + state.sunDir.y * dist,
                    camera.target.z + state.sunDir.z * dist,
                );
                // 距離に比例してメッシュサイズも拡大（一定の見かけ大きさを保つ）
                const scale = dist * 0.04;
                sunMesh.scaling.set(scale, scale, scale);
            }
        };

        // 初期化時に基準時刻で 1 回呼ぶ（auto/false 共通の初期反映）。
        applySunStateForCurrent();

        const controller: DefaultSceneController = {
            getLat: () => currentLat,
            getLon: () => currentLon,
            getAltitude: () => camera.radius,
            getAzimuth: () => azimuthDegFromAlpha(camera.alpha),
            getTilt: () => (camera.beta * 180) / Math.PI,
            setLat: (value) => applyView({ lat: value }, true),
            setLon: (value) => applyView({ lon: value }, true),
            setAltitude: (value) => applyView({ altitude: value }, true),
            setAzimuth: (value) => applyView({ azimuth: value }, true),
            setTilt: (value) => applyView({ tilt: value }, true),
            setView: (values, opts) =>
                applyView(values, opts?.refreshTerrain ?? true),
            // ---- T6 (Issue #120) ----
            getMapType: () =>
                tileManager.mapType === "std" ? "standard" : "photo",
            setMapType: (value) => {
                const internal = value === "standard" ? "std" : "photo";
                applyMapTypeChange(internal);
            },
            setUiVisibility: createUiVisibilityController({
                compass: ui.compass,
                locateMe: ui.locateMe,
                zoomIn: ui.zoomIn,
                zoomOut: ui.zoomOut,
                scaleBarBar: ui.scaleBar.bar,
                scaleBarLabel: ui.scaleBar.label,
                mapToggle: ui.mapToggle,
                attribution: ui.scaleBar.attribution,
            }),
            setSunState: (dateTime) => {
                // タイマーは JpmapTerrain 側に閉じるため、本メソッドは
                // 「現在使うべき日時」を保存して即時 1 回適用するだけで完結する。
                currentSunDateTime = dateTime;
                applySunStateForCurrent();
            },
            setSunShadows: (enabled) => {
                // 同値再呼び出しは no-op
                if (enabled === (shadowGenerator !== null)) return;
                if (enabled) {
                    enableSunShadows();
                    // フラスタムを現在の太陽方向で 1 回再センタリング
                    applySunStateForCurrent();
                } else {
                    disableSunShadows();
                }
            },
            dispose: () => {
                // ShadowGenerator が残っていれば確実に解放する (Issue #39)。
                disableSunShadows();
                // controlPanel は document.body に各 UI を直接 append しているため、
                // ここで親要素から取り除く (T7 / Issue #121)。
                // - compass / mapToggle は単独要素
                // - locateMe / zoomIn / zoomOut / scaleBar.* は共通の親 container 配下
                const removeFromParent = (el: HTMLElement | null): void => {
                    if (el && el.parentElement) {
                        el.parentElement.removeChild(el);
                    }
                };
                removeFromParent(ui.compass);
                removeFromParent(ui.mapToggle);
                // ズームボタン等は同一の親 container にまとまっているため、
                // 親をまとめて remove することで全要素を除去する。
                const zoomContainer = ui.zoomIn.parentElement;
                if (zoomContainer) {
                    removeFromParent(zoomContainer);
                } else {
                    removeFromParent(ui.locateMe);
                    removeFromParent(ui.zoomIn);
                    removeFromParent(ui.zoomOut);
                    removeFromParent(ui.scaleBar.bar);
                    removeFromParent(ui.scaleBar.label);
                    removeFromParent(ui.scaleBar.attribution);
                }
            },
        };
        options?.onReady?.(controller);

        // 初回ロード
        await refreshTerrain();

        return scene;
    };
}

export default new DefaultScene();
