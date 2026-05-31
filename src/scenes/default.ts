import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
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
import { clamp, toTileXY, tileEdgeMeters, tileCenterLatLon, JAPAN_BOUNDS, TILE_MAX_ZOOM } from "../terrain/gsiTile";
import { clampZoomLevel, radiusToZoomLevel, zoomLevelToRadius } from "../terrain/urlState";
import { createControlPanel, snapScale, formatScale, showToast } from "../terrain/controlPanel";
import { attachResizeRefresh } from "../terrain/resizeRefresh";
import { createTileManager } from "../terrain/tileManager";
import type { FrustumPlane } from "../terrain/visibleTiles";
import { createSkybox } from "../terrain/skybox";
import { computeSunPosition } from "../terrain/sunPosition";
import { deriveSunState } from "../terrain/sunState";
import { resolveTiltCollision, TILT_MAX_RADIUS_INCREASE_RATIO } from "../terrain/cameraCollision";
import { createUiVisibilityController } from "../terrain/uiVisibility";
import {
    SUN_FALLBACK_DATETIME_ISO,
    TERRAIN_CLICK_DRAG_THRESHOLD_PX,
    POLYGON_POINT_DRAG_THRESHOLD_PX,
    type TerrainClickEvent,
    type TerrainClickListener,
    type PolygonPointPointerEvent,
    type PolygonPointDragEvent,
    type PolygonPointHoverListener,
    type PolygonPointClickListener,
    type PolygonPointDragListener,
    type ViewMode,
} from "../lib/types";

const TERRAIN_SUBDIVISIONS = 128;
const MAX_ZOOM = TILE_MAX_ZOOM;
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

/**
 * 2D (orthographic) モードでのカメラ最低高度（メートル）。
 * 平行投影では position.y は表示範囲に影響しないが、near clip (minZ=1) より
 * 高い地形頂点が「カメラの背後」に来ると描画されない。
 * 日本最高点（富士山 3776m）を十分に下回る位置に near plane が来るよう、
 * カメラを常にこの高度以上に保つ。
 */
const ORTHO_MIN_CAM_Y = 10000;

/**
 * 2D モード時の camera.beta 固定値（ラジアン）。
 * beta=0 だとジンバルロックで alpha（方位）変化がカメラ位置に反映されず、
 * かつ camera.lowerBetaLimit によるクランプで意図通りにならないため、
 * 実質 0 の極小値を使用する。論理 tilt は 0 として扱う。
 */
const BETA_2D = 1e-7;

/** Phase 2（垂直移動）に切り替えるカメラ高度の閾値（メートル） */
const SKY_ZOOM_ALTITUDE_THRESHOLD = 1000;

/** 1度の緯度あたりのメートル数（概算） */
export const METERS_PER_DEGREE_LAT = 111320;

/**
 * MarkerManager 構築用の境界コンテキスト (Issue #167)。
 *
 * `JpmapTerrain` から `getMarkerContext()` で取得し、`createMarkerManager` に渡す。
 * `DefaultScene` 内部のクロージャ（カメラ位置・grid 残差）を直接参照させず、
 * 必要な値・関数のみを露出する。
 */
export interface MarkerContext {
    scene: Scene;
    tileManager: {
        queryElevationAtWorld(wx: number, wz: number): number | null;
        /** @returns 既存 onTerrainUpdated を chain で保持しつつ、追加 listener を register する unsubscribe 関数 */
        subscribeTerrainUpdated(listener: () => void): () => void;
    };
    getOrigin(): {
        lat: number;
        lon: number;
        gridResidualX: number;
        gridResidualZ: number;
    };
    /**
     * 現在のカメラ状態。
     * - position: ワールド位置 (distScale 計算用)
     * - radius / beta: ArcRotateCamera のレディアスと仰角。
     *   マーカー高さをカメラ距離・仰角に応じて動的に決めるために使用される。
     */
    getCameraPosition(): {
        x: number;
        y: number;
        z: number;
        radius: number;
        beta: number;
    };
}

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
    /**
     * 2D モード時の Google Maps 互換ズームレベル (#254)。
     * 3D モードでは `undefined` を返す。
     */
    getZoomLevel(): number | undefined;

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

    /**
     * 外部カメラの frustum を使ってタイルの可視判定・LOD 更新を行う (C案 / Issue #245)。
     *
     * terrain 用 ArcRotateCamera とは異なるカメラ（Follow カメラ等）で
     * 地形を描画している場合に、そのカメラの frustum と位置から
     * 可視タイルを再計算してロードする。
     * `setCenter` と異なりタイルの reposition は行わない。
     */
    refreshTerrainWithExternalFrustum(
        lat: number,
        lon: number,
        frustumPlanes: FrustumPlane[],
        cameraPosition: { x: number; y: number; z: number },
        lodBias?: number,
    ): Promise<void>;

    /**
     * terrain camera の onViewMatrixChanged 監視を停止する。
     * Follow モードなど外部カメラ使用中に、terrain camera の
     * frustum による不要なタイル再計算を防ぐ。
     */
    detachTileCamera(): void;
    /** terrain camera の onViewMatrixChanged 監視を再開する */
    attachTileCamera(): void;

    /**
     * コンパスの回転角を外部から上書きする (Issue #245)。
     *
     * `degrees` が `number` の場合、コンパスの回転を外部指定値に固定し、
     * terrain camera の alpha による自動更新とクリック時のリセット動作を抑制する。
     * `null` を渡すと通常の camera.alpha 連動に戻る。
     */
    setExternalCompassDegrees(degrees: number | null): void;

    // ---- UI / mapType (T6 / Issue #120) ----

    /** 現在の地図種類を spec 表記 (`standard` / `photo`) で返す */
    getMapType(): "standard" | "photo";
    /** 地図種類を切り替える。ボタン表示も一緒に追従させる */
    setMapType(value: "standard" | "photo"): void;

    // ---- 視点モード (Issue #193) ----

    /** 現在のカメラ視点モードを返す */
    getViewMode(): ViewMode;
    /**
     * 視点モードを切り替える。
     * - `"2d"`: `camera.beta` を極小値（BETA_2D）に固定し、`Camera.ORTHOGRAPHIC_CAMERA` に切替。
     *   現在の `tilt` を保存し、3D 復帰時に復元する。
     * - `"3d"`: 透視投影に戻し、保存していた `tilt` を復元する。
     * - 同値再呼び出しは no-op。
     */
    setViewMode(value: ViewMode): void;

    /**
     * コントロールパネル要素の表示・非表示を切り替える (spec §3.3.2)。
     */
    setUiVisibility(
        target:
            | "compass"
            | "zoomButtons"
            | "locateMe"
            | "scaleBar"
            | "mapToggle"
            | "viewModeButton"
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

    /** テスト用: タイルロード完了かつ debounce 待機なし かつ テクスチャ適用完了 かつ 再ステッチ完了 */
    isTerrainIdle(): boolean;

    /**
     * `JpmapTerrain.dispose()` から呼ばれる UI クリーンアップ (T7 / Issue #121)。
     *
     * `controlPanel` が `document.body` に追加した UI 要素 (コンパス / ズームボタンコンテナ / 地図切替) を
     * 親要素から除去する。複数インスタンス共存および再マウント時に UI が残留するのを防ぐ。
     * Scene/Engine の dispose は `JpmapTerrain` 側で行う（このメソッドはあくまで UI 限定）。
     */
    dispose(): void;

    /** @internal MarkerManager 構築用コンテキスト (Issue #167) */
    getMarkerContext(): MarkerContext;

    /**
     * 地形タイルへのクリック通知を購読する (Issue #183)。
     *
     * - `pointerdown` から `pointerup` までの移動量が
     *   {@link TERRAIN_CLICK_DRAG_THRESHOLD_PX} 以下の場合にのみ発火する。
     * - 主ボタン (`button === 0`) のみが対象。
     * - 修飾キー (`Ctrl`/`Cmd`) 押下時はカメラ操作のため発火しない。
     * - クリック地点が `tile-ground-*` メッシュにヒットしなかった場合は発火しない。
     *
     * @returns 登録解除関数
     */
    subscribeTerrainClick(listener: TerrainClickListener): () => void;

    /**
     * ポリゴン頂点上の hover 通知を購読する (Issue #184)。
     * リスナーは hover 開始/対象切替時にイベントを、hover 解除時に `null` を受け取る。
     */
    subscribePolygonPointHover(
        listener: PolygonPointHoverListener,
    ): () => void;
    /**
     * ポリゴン頂点上の click 通知を購読する (Issue #184)。
     * `pointerdown` → `pointerup` の移動量が
     * {@link POLYGON_POINT_DRAG_THRESHOLD_PX} 未満のときのみ発火する。
     */
    subscribePolygonPointClick(
        listener: PolygonPointClickListener,
    ): () => void;
    /** 頂点ドラッグ開始 (Issue #184) */
    subscribePolygonPointDragStart(
        listener: PolygonPointDragListener,
    ): () => void;
    /** 頂点ドラッグ中（移動毎） (Issue #184) */
    subscribePolygonPointDrag(
        listener: PolygonPointDragListener,
    ): () => void;
    /** 頂点ドラッグ終了 (Issue #184) */
    subscribePolygonPointDragEnd(
        listener: PolygonPointDragListener,
    ): () => void;
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
    /**
     * 2D モード時の初期ズームレベル (Google Maps 互換, #254)。
     * 定義時は `altitude` より優先して `camera.radius` を設定する。
     */
    zoomLevel?: number;
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
    /** 初期視点モード (Issue #193)。未指定時は `"3d"`。 */
    viewMode?: ViewMode;
    /**
     * `viewMode` が実際に変化した際に呼ばれるコールバック (Issue #193)。
     *
     * - `controller.setViewMode` 経由・UI ボタンクリック経由のいずれの変化でも発火する。
     * - 起動時の初期値設定では発火しない（呼び出し側との重複通知防止）。
     * - 同値再 set では発火しない。
     */
    onViewModeChange?: (viewMode: ViewMode) => void;
    /**
     * カメラのドラッグ操作終了時に呼ばれるコールバック (#225)。
     *
     * pointerup の `commitPanOffset` 後に発火する。`_notifyIfChanged` が
     * 「変化なし」と判定して URL 更新を取りこぼすケースを救済する。
     */
    onCameraInteractionEnd?: () => void;
    /**
     * ドラッグによるマップのパン（平行移動）操作を有効にするかどうか (Issue #259)。
     * 既定 `true`。`false` の場合、単純ドラッグでのパンを無効化する
     * （Ctrl/Cmd+ドラッグの回転・チルト、ホイールズームは有効のまま）。
     */
    enablePan?: boolean;
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
        // Issue #259: 既定はパン有効。false 指定時は単純ドラッグのパンを無効化する。
        const panEnabled = options?.enablePan !== false;

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

        // ---- 視点モード切替 (Issue #193) ----
        // 「カメラの本当の状態」は ArcRotateCamera.mode / beta、
        // 「論理 viewMode」と「3D 復帰時に戻す tilt」は本クロージャに閉じる。
        // 宣言だけ camera 直後に hoist し、操作ロジック（UI 連携・初期反映）は
        // tileManager / mapToggle 構築後に行う。
        let currentViewMode: ViewMode = options?.viewMode ?? "3d";
        let savedTiltDeg: number = tiltDeg;
        // 2D モード中は lowerBetaLimit を 0 に変更するため、3D 復帰用に元の値を保持する。
        const lowerBetaLimit3d = 0.1;

        // チルト制限（地面から15° = beta上限 5π/12）
        camera.upperBetaLimit = Math.PI / 2 - Math.PI / 12;
        // beta=0（真下視点）はArcRotateCameraのジンバルロック・数値不安定を招くため最小値を設定
        camera.lowerBetaLimit = lowerBetaLimit3d;

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
            maxTiles: 250,
            cacheCapacity: 384,
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

            // センタータイルの地理的中心と currentLat/currentLon のメートル差を
            // gridResidual に反映し、オーバーレイ座標系とタイルメッシュ配置を一致させる。
            // setCenter より前に更新することで、可視タイル計算が正しい camera.target を参照し、
            // target 変更による二重リフレッシュを防ぐ。
            const centerTile = toTileXY(currentLat, currentLon, MAX_ZOOM);
            const { lat: tileCenterLat, lon: tileCenterLon } = tileCenterLatLon(
                centerTile.x,
                centerTile.y,
                MAX_ZOOM
            );
            const metersPerDegLon =
                METERS_PER_DEGREE_LAT *
                Math.cos((currentLat * Math.PI) / 180);
            gridResidualX = (currentLon - tileCenterLon) * metersPerDegLon;
            gridResidualZ = (currentLat - tileCenterLat) * METERS_PER_DEGREE_LAT;
            camera.target.x = gridResidualX;
            camera.target.z = gridResidualZ;

            await tileManager.setCenter(currentLat, currentLon, 0);
        };

        // ---------- カメラターゲットオフセット → 緯度経度変換 ----------
        const commitPanOffset = (): void => {
            const tx = camera.target.x;
            const tz = camera.target.z;

            // 新規オフセット = 全体 - 既知のグリッド残差
            const newOffsetX = tx - gridResidualX;
            const newOffsetZ = tz - gridResidualZ;
            if (Math.abs(newOffsetX) < 0.01 && Math.abs(newOffsetZ) < 0.01) {
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

            // target.y は retarget で地形高さに設定されている場合があるため保持する
            // （0 代入するとリリース時に上下ジャンプが発生する）
            camera.target.x = gridResidualX;
            camera.target.z = gridResidualZ;

            currentLat = newLat;
            currentLon = newLon;
            void refreshTerrain();
        };

        /**
         * camera.target と gridResidual の差分を加味して「カメラが実際に
         * 見ている地理座標」を返すヘルパー。
         * retargetAtCameraPosition が camera.target を動かしても
         * currentLat/currentLon は更新されないため、URL 等の外部報告用に
         * 常に最新のカメラ注視点座標を導出する (#225)。
         */
        const derivedLat = (): number => {
            const dz = camera.target.z - gridResidualZ;
            if (Math.abs(dz) < 0.001) return currentLat;
            return clamp(
                currentLat + dz / METERS_PER_DEGREE_LAT,
                JAPAN_BOUNDS.minLat,
                JAPAN_BOUNDS.maxLat,
            );
        };
        const derivedLon = (): number => {
            const dx = camera.target.x - gridResidualX;
            if (Math.abs(dx) < 0.001) return currentLon;
            const metersPerDegreeLon =
                METERS_PER_DEGREE_LAT *
                Math.cos((currentLat * Math.PI) / 180);
            return clamp(
                currentLon + dx / metersPerDegreeLon,
                JAPAN_BOUNDS.minLon,
                JAPAN_BOUNDS.maxLon,
            );
        };

        // ---------- レイ-平面交差ユーティリティ ----------
        // Unproject 用のスクラッチバッファ。pointermove のホットパスで毎フレーム
        // `Matrix.Identity()` / `new Vector3` を確保すると GC 圧が増えるため、
        // 使い回し可能なバッファに `UnprojectFloatsToRef` で書き込む (#191)。
        const unprojectIdentity = Matrix.IdentityReadOnly;
        const unprojectNear = new Vector3();
        const unprojectFar = new Vector3();
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
            Vector3.UnprojectFloatsToRef(
                screenX * scaleX, screenY * scaleY, 0,
                renderW, renderH, unprojectIdentity, view, proj,
                unprojectNear,
            );
            Vector3.UnprojectFloatsToRef(
                screenX * scaleX, screenY * scaleY, 1,
                renderW, renderH, unprojectIdentity, view, proj,
                unprojectFar,
            );
            const dirY = unprojectFar.y - unprojectNear.y;
            if (Math.abs(dirY) < 1e-6) return null;
            const t = (planeY - unprojectNear.y) / dirY;
            if (t <= 0) return null;
            return {
                x: unprojectNear.x + (unprojectFar.x - unprojectNear.x) * t,
                z: unprojectNear.z + (unprojectFar.z - unprojectNear.z) * t,
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
            // 2D モード: カメラは常にターゲット直上 (beta ≈ 0) にあり、
            // position.y は ORTHO_MIN_CAM_Y 固定、target.y = ORTHO_MIN_CAM_Y - radius。
            // 角度補正やキャッシュ標高の参照は不要。固定値で十分 (#254)。
            if (currentViewMode === "2d") {
                return camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
            }

            const { alpha, beta, radius } = camera;
            const { x: tx, y: ty, z: tz } = camera.target;
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
                Math.max(camY, CAMERA_LOWER_RADIUS) + 1000
            );
            const pick = scene.pickWithRay(ray, (m) => m.name.startsWith("tile-ground-"));

            // レイキャストによる地形高さ
            let terrainY: number | null =
                pick?.hit && pick.pickedPoint ? pick.pickedPoint.y : null;

            // キャッシュ済み標高データから高精度な値を補完
            const cacheElev = tileManager.queryElevationAtWorld(camX, camZ);
            if (cacheElev !== null) {
                terrainY = terrainY !== null ? Math.max(terrainY, cacheElev) : cacheElev;
            }

            if (terrainY === null) {
                cachedMinRadius = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                return cachedMinRadius;
            }

            const minCamY = terrainY + CAMERA_LOWER_RADIUS;
            cachedMinRadius = (minCamY - ty) / cosB;
            return cachedMinRadius;
        };

        /**
         * 新しいカメラワールド座標を起点に、現在の視線方向で Ray を飛ばし、
         * 地形メッシュ（無ければ y=0 平面）との交点を新しいターゲットとして
         * `camera.setTarget()` に渡す。`setTarget()` が radius / alpha / beta を再計算する。
         *
         * 垂直ズーム後など、カメラ位置だけを動かしたあとに target を地形上へ
         * 再投影するために使用する。
         */
        const retargetAtCameraPosition = (
            camX: number,
            camY: number,
            camZ: number
        ): void => {
            // 2D モード: カメラはターゲット直上 (beta ≈ 0)。
            // stale な camera.position.x/z ではなく camera.target.x/z を基準にすることで、
            // commitPanOffset 後に target.x/z が新しい gridResidual にリセットされた後でも
            // x/z を上書きせず、リロード時の位置ずれを防ぐ (#225)。
            if (currentViewMode === "2d") {
                const anchorX = camera.target.x;
                const anchorZ = camera.target.z;
                const prevAlpha = camera.alpha;
                // 2D は平行投影のため camera.position.y は表示範囲に影響しない。
                // ズームは camera.radius → applyOrthoFrustum のみで決まる。
                // したがって radius は一切変更しない (#254)。
                // ズーム操作は retarget 呼出し前に camera.radius を更新済み。
                const savedRadius = camera.radius;
                // 2D ortho: position.y は表示範囲に影響しない。
                // 全地形が near clip 内に収まるよう ORTHO_MIN_CAM_Y 固定とする (#254)。
                const newCamY = ORTHO_MIN_CAM_Y;
                const newTargetY = newCamY - savedRadius;
                camera.setPosition(new Vector3(anchorX, newCamY, anchorZ));
                camera.setTarget(new Vector3(anchorX, newTargetY, anchorZ));
                camera.radius = savedRadius;
                camera.alpha = prevAlpha;
                camera.beta = BETA_2D;
                return;
            }

            const sinB = Math.sin(camera.beta);
            const cosB = Math.cos(camera.beta);
            // カメラ → ターゲット方向（球面座標から導出した単位ベクトル）
            const dirX = -sinB * Math.cos(camera.alpha);
            const dirY = -cosB;
            const dirZ = -sinB * Math.sin(camera.alpha);

            const origin = new Vector3(camX, camY, camZ);
            const direction = new Vector3(dirX, dirY, dirZ);
            const ray = new Ray(origin, direction, CAMERA_FAR_CLIP);
            const pick = scene.pickWithRay(ray, (m) => m.name.startsWith("tile-ground-"));

            let targetX: number;
            let targetY: number;
            let targetZ: number;
            if (pick?.hit && pick.pickedPoint) {
                targetX = pick.pickedPoint.x;
                targetY = pick.pickedPoint.y;
                targetZ = pick.pickedPoint.z;
            } else if (Math.abs(dirY) > 1e-6) {
                // フォールバック: y=0 平面との交点
                const t = (0 - camY) / dirY;
                if (t <= 0) return;
                targetX = camX + dirX * t;
                targetY = 0;
                targetZ = camZ + dirZ * t;
            } else {
                return;
            }

            camera.setPosition(new Vector3(camX, camY, camZ));
            camera.setTarget(new Vector3(targetX, targetY, targetZ));
        };

        // ---------- カスタムマウスハンドラ ----------
        let pointerDown = false;
        let lastPointerX = 0;
        let lastPointerY = 0;
        let activePointerId = -1;
        let dragAnchor: { x: number; z: number } | null = null;
        let dragPlaneY = 0;
        let dragMeshMode = false;
        let dragAnchorLat = 0;
        let dragAnchorLon = 0;
        // pointerup 直後に releasePointerCapture が発火させる lostpointercapture
        // による resetPointerState の二重実行を一度だけ抑止する (#254)。
        let suppressNextResetPointerState = false;

        // ---- ポリゴン頂点インタラクション (Issue #184) ----
        const polygonPointHoverListeners: PolygonPointHoverListener[] = [];
        const polygonPointClickListeners: PolygonPointClickListener[] = [];
        const polygonPointDragStartListeners: PolygonPointDragListener[] = [];
        const polygonPointDragListeners: PolygonPointDragListener[] = [];
        const polygonPointDragEndListeners: PolygonPointDragListener[] = [];
        const POLYGON_POINT_NAME_RE = /^polygon-(.+)-point-(\d+)$/;
        const pickPolygonPoint = (
            sx: number,
            sy: number,
        ): {
            polygonId: string;
            index: number;
            worldX: number;
            worldY: number;
            worldZ: number;
        } | null => {
            const pick = scene.pick(
                sx,
                sy,
                (m) => POLYGON_POINT_NAME_RE.test(m.name),
            );
            if (!pick?.hit || !pick.pickedMesh) return null;
            const match = POLYGON_POINT_NAME_RE.exec(pick.pickedMesh.name);
            if (!match) return null;
            const pos = pick.pickedMesh.getAbsolutePosition();
            return {
                polygonId: match[1],
                index: parseInt(match[2], 10),
                worldX: pos.x,
                worldY: pos.y,
                worldZ: pos.z,
            };
        };
        /** 頂点ドラッグ中のカーソル位置から地形交点を解決する */
        const computeDragGroundHit = (
            sx: number,
            sy: number,
        ): {
            lat: number | null;
            lon: number | null;
            groundAltitude: number | null;
        } => {
            const pick = scene.pick(sx, sy, (m) =>
                m.name.startsWith("tile-ground-"),
            );
            if (!pick?.hit || !pick.pickedPoint) {
                return { lat: null, lon: null, groundAltitude: null };
            }
            const { lat, lon } = worldToLatLon(
                pick.pickedPoint.x,
                pick.pickedPoint.z,
            );
            return { lat, lon, groundAltitude: pick.pickedPoint.y };
        };
        /**
         * 頂点ドラッグ中、ドラッグ開始時の頂点 world Y を保つ
         * 水平面とカーソルレイの交点を緯度経度として返す (#186)。
         */
        const computeDragPlaneHit = (
            sx: number,
            sy: number,
            planeY: number,
        ): { planeLat: number | null; planeLon: number | null } => {
            const hit = intersectPlane(sx, sy, planeY);
            if (!hit) return { planeLat: null, planeLon: null };
            const { lat, lon } = worldToLatLon(hit.x, hit.z);
            return { planeLat: lat, planeLon: lon };
        };
        /**
         * 頂点ドラッグ中、ドラッグ開始時の頂点 (x, z) を通る垂直線と
         * カーソルレイの最近接点の world Y を返す (#186)。
         * カメラがほぼ真上 / 真下を向いているときは null。
         */
        const computeDragVerticalHit = (
            screenX: number,
            screenY: number,
            startX: number,
            startZ: number,
        ): number | null => {
            const renderW = engine.getRenderWidth();
            const renderH = engine.getRenderHeight();
            const scaleX = renderW / canvas.clientWidth;
            const scaleY = renderH / canvas.clientHeight;
            const view = camera.getViewMatrix();
            const proj = camera.getProjectionMatrix();
            // 共有スクラッチに書き込み、毎回の new を避ける (#191)。
            Vector3.UnprojectFloatsToRef(
                screenX * scaleX, screenY * scaleY, 0,
                renderW, renderH, unprojectIdentity, view, proj,
                unprojectNear,
            );
            Vector3.UnprojectFloatsToRef(
                screenX * scaleX, screenY * scaleY, 1,
                renderW, renderH, unprojectIdentity, view, proj,
                unprojectFar,
            );
            let dxr = unprojectFar.x - unprojectNear.x;
            let dyr = unprojectFar.y - unprojectNear.y;
            let dzr = unprojectFar.z - unprojectNear.z;
            const len = Math.hypot(dxr, dyr, dzr);
            if (len < 1e-9) return null;
            dxr /= len; dyr /= len; dzr /= len;
            // 二直線（垂直線 d1=(0,1,0)、レイ d2=(dxr,dyr,dzr)）の最近接点。
            // sc = (b*e - c*d) / (a*c - b^2), a=1, c=1, b=dyr
            const denom = 1 - dyr * dyr;
            if (Math.abs(denom) < 1e-6) return null;
            // w0 = (startX - near.x, 0 - near.y, startZ - near.z)
            const wx = startX - unprojectNear.x;
            const wy = -unprojectNear.y;
            const wz = startZ - unprojectNear.z;
            const d = wy; // d1 · w0
            const eDot = dxr * wx + dyr * wy + dzr * wz; // d2 · w0
            return (dyr * eDot - d) / denom;
        };
        const hasPolygonPointGestureListeners = (): boolean =>
            polygonPointClickListeners.length > 0 ||
            polygonPointDragStartListeners.length > 0 ||
            polygonPointDragListeners.length > 0 ||
            polygonPointDragEndListeners.length > 0;
        let polygonPointGesture:
            | {
                  pointerId: number;
                  polygonId: string;
                  index: number;
                  startClientX: number;
                  startClientY: number;
                  dragging: boolean;
                  /** ドラッグ開始時の頂点 world 座標。水平面/垂直線交点計算で使用 (#186) */
                  startWorldX: number;
                  startWorldY: number;
                  startWorldZ: number;
              }
            | null = null;
        let polygonPointHoverState: { polygonId: string; index: number } | null =
            null;
        const dispatchHoverListeners = (
            event: PolygonPointPointerEvent | null,
        ): void => {
            for (const l of polygonPointHoverListeners.slice()) {
                try {
                    l(event);
                } catch (err) {
                    console.error(
                        "[JpmapTerrain] onPolygonPointHover listener threw:",
                        err,
                    );
                }
            }
        };
        const dispatchPointEvent = (
            listeners: PolygonPointClickListener[],
            event: PolygonPointPointerEvent,
            label: string,
        ): void => {
            for (const l of listeners.slice()) {
                try {
                    l(event);
                } catch (err) {
                    console.error(
                        `[JpmapTerrain] ${label} listener threw:`,
                        err,
                    );
                }
            }
        };
        const dispatchDragEvent = (
            listeners: PolygonPointDragListener[],
            event: PolygonPointDragEvent,
            label: string,
        ): void => {
            for (const l of listeners.slice()) {
                try {
                    l(event);
                } catch (err) {
                    console.error(
                        `[JpmapTerrain] ${label} listener threw:`,
                        err,
                    );
                }
            }
        };
        /** 汎用 subscribe ヘルパ。配列に listener を追加し、解除関数を返す (#184) */
        const subscribe = <T>(
            listeners: T[],
            listener: T,
        ): (() => void) => {
            listeners.push(listener);
            let removed = false;
            return (): void => {
                if (removed) return;
                removed = true;
                const idx = listeners.indexOf(listener);
                if (idx !== -1) listeners.splice(idx, 1);
            };
        };

        /** ワールド座標(wx, wz)を現在のgrid基準で緯度経度に変換 */
        const worldToLatLon = (wx: number, wz: number): { lat: number; lon: number } => {
            const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((currentLat * Math.PI) / 180);
            const lat = currentLat + (wz - gridResidualZ) / METERS_PER_DEGREE_LAT;
            const lon = currentLon + (wx - gridResidualX) / metersPerDegreeLon;
            return { lat, lon };
        };

        canvas.addEventListener("contextmenu", (e) => e.preventDefault());

        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            // 頂点インタラクション (#184): 頂点 mesh 上の主ボタン pointerdown は
            // ドラッグ/クリックジェスチャに切り替え、既存のカメラ操作には進めない。
            if (
                hasPolygonPointGestureListeners() &&
                !(e.ctrlKey || e.metaKey)
            ) {
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const hit = pickPolygonPoint(sx, sy);
                if (hit) {
                    polygonPointGesture = {
                        pointerId: e.pointerId,
                        polygonId: hit.polygonId,
                        index: hit.index,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        dragging: false,
                        startWorldX: hit.worldX,
                        startWorldY: hit.worldY,
                        startWorldZ: hit.worldZ,
                    };
                    canvas.setPointerCapture(e.pointerId);
                    // 同じ canvas に登録されている後続 pointerdown リスナー
                    // （地形クリック追跡 #183 など）まで伝播させると、頂点
                    // ジェスチャと並行して onTerrainClick が発火しうる。仕様
                    // どおり頂点ジェスチャ中はそれらを完全に抑制するため、
                    // 同イベントの後続リスナーへの配送を止める。
                    e.stopImmediatePropagation();
                    return;
                }
            }
            pointerDown = true;
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
            activePointerId = e.pointerId;
            canvas.setPointerCapture(e.pointerId);

            // Ctrl/Cmd 押下開始時: 画面中央の地形メッシュ交点を回転中心にする
            // （カメラのワールド位置は保持されるためジャンプは発生しない）
            if (e.ctrlKey || e.metaKey) {
                // 直前までの pan オフセットを lat/lon に反映してから target を差し替える
                commitPanOffset();
                const cx = canvas.clientWidth / 2;
                const cy = canvas.clientHeight / 2;
                const centerPick = scene.pick(cx, cy, (m) =>
                    m.name.startsWith("tile-ground-")
                );
                if (centerPick?.hit && centerPick.pickedPoint) {
                    if (currentViewMode === "2d") {
                        // 2D 中の setTarget は alpha/radius も再計算され、
                        // ズーム後の radius が回転開始時に巻き戻る (#286)。
                        // alpha/beta/radius を保護する。
                        const prevAlpha = camera.alpha;
                        const prevRadius = camera.radius;
                        camera.setTarget(centerPick.pickedPoint);
                        camera.alpha = prevAlpha;
                        camera.beta = BETA_2D;
                        camera.radius = prevRadius;
                    } else {
                        camera.setTarget(centerPick.pickedPoint);
                    }
                    // ターゲット差分を緯度経度へ折り込み、Marker/Polygon の位置基準
                    // (currentLat/Lon と gridResidualX/Z) を新ターゲットと整合させる。
                    // これを行わずに gridResidualX/Z だけ更新すると、currentLat/Lon
                    // との不整合により Polygon ノードが回転開始時に微小ジャンプする (#170)。
                    commitPanOffset();
                }
            } else {
                // 単独ドラッグ
                // Issue #259: パン無効時は dragAnchor/dragMeshMode を立てず、
                // pointermove のパン処理を発火させない（戦場を中央へ固定する）。
                if (!panEnabled) {
                    return;
                }
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;

                const pick = scene.pick(sx, sy, (m) => m.name.startsWith("tile-ground-"));
                if (pick?.hit && pick.pickedPoint) {
                    // メッシュピックモード: 緯度経度アンカーを保存
                    dragMeshMode = true;
                    const latLon = worldToLatLon(pick.pickedPoint.x, pick.pickedPoint.z);
                    dragAnchorLat = latLon.lat;
                    dragAnchorLon = latLon.lon;
                    dragPlaneY = pick.pickedPoint.y;
                    dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                } else {
                    // フォールバック: 既存の平面交差モード
                    dragMeshMode = false;
                    dragPlaneY = 0;
                    dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                }
                retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
            }
        });

        canvas.addEventListener("pointermove", (e: PointerEvent) => {
            // 頂点インタラクション (#184) のジェスチャ進行中はカメラ操作に進めない
            if (polygonPointGesture && polygonPointGesture.pointerId === e.pointerId) {
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                if (!polygonPointGesture.dragging) {
                    const dx = e.clientX - polygonPointGesture.startClientX;
                    const dy = e.clientY - polygonPointGesture.startClientY;
                    if (
                        Math.abs(dx) >= POLYGON_POINT_DRAG_THRESHOLD_PX ||
                        Math.abs(dy) >= POLYGON_POINT_DRAG_THRESHOLD_PX
                    ) {
                        polygonPointGesture.dragging = true;
                        const ground = computeDragGroundHit(sx, sy);
                        const plane = computeDragPlaneHit(
                            sx,
                            sy,
                            polygonPointGesture.startWorldY,
                        );
                        const pointerAltitude = computeDragVerticalHit(
                            sx,
                            sy,
                            polygonPointGesture.startWorldX,
                            polygonPointGesture.startWorldZ,
                        );
                        const startEvent: PolygonPointDragEvent = {
                            polygonId: polygonPointGesture.polygonId,
                            index: polygonPointGesture.index,
                            pointerEvent: e,
                            ...ground,
                            ...plane,
                            pointerAltitude,
                        };
                        dispatchDragEvent(
                            polygonPointDragStartListeners,
                            startEvent,
                            "onPolygonPointDragStart",
                        );
                    }
                }
                if (polygonPointGesture.dragging) {
                    const ground = computeDragGroundHit(sx, sy);
                    const plane = computeDragPlaneHit(
                        sx,
                        sy,
                        polygonPointGesture.startWorldY,
                    );
                    const pointerAltitude = computeDragVerticalHit(
                        sx,
                        sy,
                        polygonPointGesture.startWorldX,
                        polygonPointGesture.startWorldZ,
                    );
                    const dragEvent: PolygonPointDragEvent = {
                        polygonId: polygonPointGesture.polygonId,
                        index: polygonPointGesture.index,
                        pointerEvent: e,
                        ...ground,
                        ...plane,
                        pointerAltitude,
                    };
                    dispatchDragEvent(
                        polygonPointDragListeners,
                        dragEvent,
                        "onPolygonPointDrag",
                    );
                }
                return;
            }

            // hover 検出 (#184): pointer が押下されておらず、リスナーが存在するときのみ
            if (
                !pointerDown &&
                polygonPointHoverListeners.length > 0
            ) {
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const hit = pickPolygonPoint(sx, sy);
                if (hit) {
                    if (
                        !polygonPointHoverState ||
                        polygonPointHoverState.polygonId !== hit.polygonId ||
                        polygonPointHoverState.index !== hit.index
                    ) {
                        polygonPointHoverState = hit;
                        canvas.style.cursor = "pointer";
                        dispatchHoverListeners({
                            polygonId: hit.polygonId,
                            index: hit.index,
                            pointerEvent: e,
                        });
                    }
                } else if (polygonPointHoverState !== null) {
                    polygonPointHoverState = null;
                    canvas.style.cursor = "";
                    dispatchHoverListeners(null);
                }
            }

            if (!pointerDown || e.pointerId !== activePointerId) return;

            if (e.ctrlKey || e.metaKey) {
                // Ctrl/Cmd + ドラッグ: 水平=パン(alpha)、垂直=チルト(beta)
                const dx = e.clientX - lastPointerX;
                const dy = e.clientY - lastPointerY;
                if (currentViewMode === "2d") {
                    // 2D 中の Ctrl+drag は「画面中心を軸とする twist 回転」。
                    // カーソルが中心を見る角度（atan2）の差分を camera.alpha に加える。
                    // 例: 中心の少し上から右へドラッグ → 角度が時計回りに増加 → 画面が右回り。
                    const rect = canvas.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    const px0 = lastPointerX - cx;
                    const py0 = lastPointerY - cy;
                    const px1 = e.clientX - cx;
                    const py1 = e.clientY - cy;
                    // 中心近傍は角度が不安定なため一定距離未満では回転しない。
                    const minR = 8; // px
                    if (
                        Math.hypot(px0, py0) >= minR &&
                        Math.hypot(px1, py1) >= minR
                    ) {
                        const a0 = Math.atan2(py0, px0);
                        const a1 = Math.atan2(py1, px1);
                        let delta = a1 - a0;
                        if (delta > Math.PI) delta -= 2 * Math.PI;
                        else if (delta < -Math.PI) delta += 2 * Math.PI;
                        camera.alpha += delta;
                    }
                    lastPointerX = e.clientX;
                    lastPointerY = e.clientY;
                    // 2D ではチルト操作は無効、衝突判定も不要
                    return;
                }
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
            } else if (dragAnchor || dragMeshMode) {
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;

                if (dragMeshMode) {
                    // メッシュピックモード: 現在のカーソル位置でメッシュをピック
                    const movePick = scene.pick(sx, sy, (m) => m.name.startsWith("tile-ground-"));
                    if (movePick?.hit && movePick.pickedPoint) {
                        const currentLatLon = worldToLatLon(movePick.pickedPoint.x, movePick.pickedPoint.z);
                        const deltaLat = dragAnchorLat - currentLatLon.lat;
                        const deltaLon = dragAnchorLon - currentLatLon.lon;
                        // 緯度経度差分をワールド座標のオフセットに変換
                        const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((currentLat * Math.PI) / 180);
                        camera.target.x += deltaLon * metersPerDegreeLon;
                        camera.target.z += deltaLat * METERS_PER_DEGREE_LAT;
                        // 平面交差アンカーも同期（フォールバック切替に備える）
                        dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                    } else if (dragAnchor) {
                        // メッシュピック失敗時: 平面交差パンにフォールバック
                        const current = intersectPlane(sx, sy, dragPlaneY);
                        if (current) {
                            camera.target.x += dragAnchor.x - current.x;
                            camera.target.z += dragAnchor.z - current.z;
                            dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                        }
                    }
                } else if (dragAnchor) {
                    // フォールバック: 既存の平面交差パン
                    const current = intersectPlane(sx, sy, dragPlaneY);
                    if (current) {
                        camera.target.x += dragAnchor.x - current.x;
                        camera.target.z += dragAnchor.z - current.z;
                        dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                    }
                }
                retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
            }
        });

        canvas.addEventListener("pointerup", (e: PointerEvent) => {
            // 頂点インタラクション (#184): ジェスチャ進行中の up は click / dragEnd を発火する
            if (
                polygonPointGesture &&
                polygonPointGesture.pointerId === e.pointerId
            ) {
                const gesture = polygonPointGesture;
                polygonPointGesture = null;
                canvas.releasePointerCapture(e.pointerId);
                if (gesture.dragging) {
                    const rect = canvas.getBoundingClientRect();
                    const sx = e.clientX - rect.left;
                    const sy = e.clientY - rect.top;
                    const ground = computeDragGroundHit(sx, sy);
                    const plane = computeDragPlaneHit(
                        sx,
                        sy,
                        gesture.startWorldY,
                    );
                    const pointerAltitude = computeDragVerticalHit(
                        sx,
                        sy,
                        gesture.startWorldX,
                        gesture.startWorldZ,
                    );
                    const endEvent: PolygonPointDragEvent = {
                        polygonId: gesture.polygonId,
                        index: gesture.index,
                        pointerEvent: e,
                        ...ground,
                        ...plane,
                        pointerAltitude,
                    };
                    dispatchDragEvent(
                        polygonPointDragEndListeners,
                        endEvent,
                        "onPolygonPointDragEnd",
                    );
                } else {
                    // pointerup 時点で修飾キーが押下されていればカメラ操作扱い
                    // とし、click を発火しない（terrain click と同じポリシー）。
                    // また、pointerup 位置が pointerdown と同じ頂点上にあることを
                    // 再確認し、別頂点上や頂点外での click 誤発火を抑止する。
                    if (e.ctrlKey || e.metaKey) {
                        return;
                    }
                    const rect = canvas.getBoundingClientRect();
                    const sx = e.clientX - rect.left;
                    const sy = e.clientY - rect.top;
                    const pickedPoint = pickPolygonPoint(sx, sy);
                    if (
                        pickedPoint &&
                        pickedPoint.polygonId === gesture.polygonId &&
                        pickedPoint.index === gesture.index
                    ) {
                        const clickEvent: PolygonPointPointerEvent = {
                            polygonId: gesture.polygonId,
                            index: gesture.index,
                            pointerEvent: e,
                        };
                        dispatchPointEvent(
                            polygonPointClickListeners,
                            clickEvent,
                            "onPolygonPointClick",
                        );
                    }
                }
                return;
            }
            if (e.pointerId !== activePointerId) return;
            pointerDown = false;
            // releasePointerCapture が lostpointercapture を発火させ
            // resetPointerState 経由で commitPanOffset / retargetAtCameraPosition が
            // 二重に呼ばれる。2D モードでは大ドラッグ時に refreshTerrain の
            // 同期前半で gridResidual が再計算され、僅かに target が動くため
            // 二度目の retarget で pickWithRay の結果が変動し見かけのズーム
            // ジッタが発生する。明示的に抑止する (#254)。
            suppressNextResetPointerState = true;
            canvas.releasePointerCapture(e.pointerId);
            commitPanOffset();
            if (currentViewMode === "2d") {
                retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
            } else {
                // 3D: commitPanOffset が target.x/z = gridResidual にリセット済み。
                // setTarget() を呼ぶと rebuildAnglesAndRadius() が走り beta/tilt が変わるため、
                // 真下レイキャストで target.y のみ直接代入する (#225)。
                const rayDown = new Ray(
                    new Vector3(camera.target.x, camera.position.y, camera.target.z),
                    new Vector3(0, -1, 0),
                    CAMERA_FAR_CLIP,
                );
                const pick = scene.pickWithRay(
                    rayDown,
                    (m) => m.name.startsWith("tile-ground-"),
                );
                if (pick?.hit && pick.pickedPoint) {
                    // target.y の変化ぶん camera.position.y が上下するのを防ぐため、
                    // 変更前の camera.position.y を維持するよう radius を補正する (#225)。
                    const desiredCamY = camera.position.y;
                    camera.target.y = pick.pickedPoint.y;
                    const cosB = Math.cos(camera.beta);
                    if (Math.abs(cosB) >= 1e-6) {
                        const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                        const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
                        camera.radius = clamp(
                            (desiredCamY - pick.pickedPoint.y) / cosB,
                            lower,
                            upper,
                        );
                    }
                }
            }
            // #225: pointerup 後の最新状態で URL を更新するため、
            // 外部に「インタラクション終了」を通知する。`_notifyIfChanged`
            // が変化なしと判定するケースを救済する目的。
            options?.onCameraInteractionEnd?.();
        });

        const resetPointerState = (e?: PointerEvent): void => {
            pointerDown = false;
            activePointerId = -1;
            dragAnchor = null;
            dragMeshMode = false;
            // 頂点ジェスチャも併せて中断する (#184)
            if (polygonPointGesture && (!e || polygonPointGesture.pointerId === e.pointerId)) {
                const gesture = polygonPointGesture;
                polygonPointGesture = null;
                if (gesture.dragging && e) {
                    // spec/package.md §3.3.10: dragEnd も「現在カーソル直下の
                    // 地形交点」を採用する。pointercancel / lostpointercapture
                    // 経由でも実イベント座標を解決し直して通知する。
                    const rect = canvas.getBoundingClientRect();
                    const sx = e.clientX - rect.left;
                    const sy = e.clientY - rect.top;
                    const ground = computeDragGroundHit(sx, sy);
                    const plane = computeDragPlaneHit(
                        sx,
                        sy,
                        gesture.startWorldY,
                    );
                    const pointerAltitude = computeDragVerticalHit(
                        sx,
                        sy,
                        gesture.startWorldX,
                        gesture.startWorldZ,
                    );
                    const endEvent: PolygonPointDragEvent = {
                        polygonId: gesture.polygonId,
                        index: gesture.index,
                        pointerEvent: e,
                        ...ground,
                        ...plane,
                        pointerAltitude,
                    };
                    dispatchDragEvent(
                        polygonPointDragEndListeners,
                        endEvent,
                        "onPolygonPointDragEnd",
                    );
                }
            }
            commitPanOffset();
            retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
        };

        canvas.addEventListener("pointercancel", (e: PointerEvent) =>
            resetPointerState(e),
        );
        canvas.addEventListener("lostpointercapture", (e: PointerEvent) => {
            if (suppressNextResetPointerState) {
                suppressNextResetPointerState = false;
                return;
            }
            resetPointerState(e);
        });

        // ---- 地形クリック通知 (Issue #183) ----
        //
        // 既存の pan/rotate 用 pointer ハンドラと独立に、
        // 「pointerdown→pointerup の間にほとんど動いていない」場合のみ
        // 地形メッシュへの click とみなして購読リスナーへ通知する。
        const terrainClickListeners: TerrainClickListener[] = [];
        let terrainClickStart: {
            pointerId: number;
            x: number;
            y: number;
            modifier: boolean;
        } | null = null;
        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            terrainClickStart = {
                pointerId: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                modifier: e.ctrlKey || e.metaKey,
            };
        });
        const cancelTerrainClick = (e: PointerEvent): void => {
            if (terrainClickStart && terrainClickStart.pointerId === e.pointerId) {
                terrainClickStart = null;
            }
        };
        canvas.addEventListener("pointercancel", cancelTerrainClick);
        canvas.addEventListener("lostpointercapture", cancelTerrainClick);
        canvas.addEventListener("pointerup", (e: PointerEvent) => {
            const start = terrainClickStart;
            terrainClickStart = null;
            if (!start || start.pointerId !== e.pointerId) return;
            // Ctrl/Cmd 併用はカメラ操作（パン/チルト）扱いのためクリック通知しない。
            // pointerdown 後に修飾キー状態が変わるケースもあるため、pointerup 時点も確認する。
            if (start.modifier || e.ctrlKey || e.metaKey) return;
            if (terrainClickListeners.length === 0) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (
                Math.abs(dx) > TERRAIN_CLICK_DRAG_THRESHOLD_PX ||
                Math.abs(dy) > TERRAIN_CLICK_DRAG_THRESHOLD_PX
            ) {
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const pick = scene.pick(sx, sy, (m) =>
                m.name.startsWith("tile-ground-"),
            );
            if (!pick?.hit || !pick.pickedPoint) return;
            const wx = pick.pickedPoint.x;
            const wy = pick.pickedPoint.y;
            const wz = pick.pickedPoint.z;
            const { lat, lon } = worldToLatLon(wx, wz);
            const event: TerrainClickEvent = {
                lat,
                lon,
                altitude: wy,
                world: { x: wx, y: wy, z: wz },
                pointerEvent: e,
            };
            // iterate 中の add/remove 安全のため slice
            for (const listener of terrainClickListeners.slice()) {
                try {
                    listener(event);
                } catch (err) {
                    console.error(
                        "[JpmapTerrain] onTerrainClick listener threw:",
                        err,
                    );
                }
            }
        });

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
            // 2D ortho: queryViewRayDistance はカメラ→地形の 3D 距離を返すが、
            // position.y が ORTHO_MIN_CAM_Y で固定のため radius と無関係な定数になる。
            // radius を直接使うことで一定割合 (5%) のステップを保つ (#254)。
            const dist =
                currentViewMode === "2d"
                    ? camera.radius
                    : (queryViewRayDistance() ?? camera.radius);
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
            // scene.pick() は内部で DPR スケーリングを行うため CSS 座標をそのまま渡す。
            // 頂点メッシュ等が pickable な場合はノイズになるため、地形メッシュに限定する (#184)。
            const pick = scene.pick(sx, sy, (m) =>
                m.name.startsWith("tile-ground-"),
            );
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
                // Issue #259: パン無効時はカーソル位置中心のズーム（target 移動）を禁止し、
                // 画面中央基準のズームのみ行う。zoomFromCenter は画面中央の地形ピック→
                // zoomTowardPoint(中央座標) となるため target がほぼ動かず地図移動を防ぐ。
                if (!panEnabled) {
                    const factor = computeWheelFactor(e.deltaY < 0);
                    zoomFromCenter(factor);
                    return;
                }
                const rect = canvas.getBoundingClientRect();
                const hit = pickOrPlane(e.clientX - rect.left, e.clientY - rect.top);
                if (hit && isPickNearTarget(hit)) {
                    const factor = computeWheelFactor(e.deltaY < 0);
                    zoomTowardPoint(hit.worldX, hit.worldZ, factor);
                    retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
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
                        const cosB = Math.cos(camera.beta);
                        // 現在のカメラワールド座標（緯度経度固定）
                        const camX = camera.target.x + camera.radius * sinB * Math.cos(camera.alpha);
                        const camZ = camera.target.z + camera.radius * sinB * Math.sin(camera.alpha);
                        // radius factor 分だけカメラ高度のみ変化
                        const newRadius = clamp(camera.radius * factor, effectiveLower2, upper);
                        const newCamY = camera.target.y + newRadius * cosB;
                        // 2D モードでは retargetAtCameraPosition が camera.radius を使って高度を決めるため、
                        // 先に radius を更新してから旧 camX/Z・新 camY で再ターゲットする (#254)。
                        camera.radius = newRadius;
                        // 新しいカメラ位置から Ray を飛ばし、camera.targetを設定
                        retargetAtCameraPosition(camX, newCamY, camZ);
                        commitPanOffset();
                        retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
                    } else {
                        // Phase 1: ターゲットに向かってズーム
                        const effectiveLower1 = Math.max(lower, terrainMinRadius());
                        if (zoomIn && camera.radius <= effectiveLower1) return;
                        if (!zoomIn && camera.radius >= upper) return;
                        camera.radius = clamp(camera.radius * factor, effectiveLower1, upper);
                        retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
                    }
                }
            },
            { passive: false }
        );

        canvas.addEventListener("dblclick", (e: MouseEvent) => {
            // Issue #259: パン無効時はカーソル位置中心ズームを禁止し、ターゲット基準の半径ズームのみ。
            if (!panEnabled) {
                const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                const effectiveLower = Math.max(lower, terrainMinRadius());
                if (camera.radius <= effectiveLower) return;
                camera.radius = clamp(
                    camera.radius * 0.7,
                    effectiveLower,
                    camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS,
                );
                retargetAtCameraPosition(
                    camera.position.x,
                    camera.position.y,
                    camera.position.z,
                );
                return;
            }
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
        // 外部コンパス制御 (Issue #245)
        let externalCompassDegrees: number | null = null;
        const syncCompass = (): void => {
            if (externalCompassDegrees !== null) return;
            const degrees = (camera.alpha * 180) / Math.PI + 90;
            ui.compass.style.transform = `rotate(${degrees}deg)`;
        };
        camera.onViewMatrixChangedObservable.add(syncCompass);

        // スケールバー更新
        const SCALE_BAR_BASE_PX = 100;
        let prevScaleText = "";
        let updatingScaleBar = false;
        const updateScaleBar = (): void => {
            // 再入ガード: intersectPlane が getViewMatrix を呼ぶと
            // onViewMatrixChangedObservable が再度 notify される条件が成立した場合
            // 無限再帰になるのを防ぐ (RangeError: Maximum call stack)
            if (updatingScaleBar) return;
            updatingScaleBar = true;
            try {
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
            } finally {
                updatingScaleBar = false;
            }
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
            // 外部制御中はコンパスクリックを無視
            if (externalCompassDegrees !== null) return;
            // カメラ光軸と地形メッシュの交点を新しい中心座標にする
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const centerHit = pickOrPlane(cx, cy);
            if (centerHit) {
                camera.target.x = centerHit.worldX;
                camera.target.z = centerHit.worldZ;
                commitPanOffset();
                retargetAtCameraPosition(camera.position.x, camera.position.y, camera.position.z);
            }

            const targetAlpha = -Math.PI / 2; // 北向き
            // 2D モード時は tilt を変更しない（既に BETA_2D 固定） (Issue #193)。
            const targetBeta =
                currentViewMode === "2d"
                    ? camera.beta
                    : (camera.lowerBetaLimit ?? lowerBetaLimit3d); // ほぼ真下
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

        // ---- 視点モード切替 (Issue #193) ----
        // 宣言は camera 初期化直後に hoist 済み。ここでは UI 連携・初期反映を行う。
        const applyOrthoFrustum = (): void => {
            const w = engine.getRenderWidth();
            const h = engine.getRenderHeight();
            if (w <= 0 || h <= 0) return;
            const aspect = w / h;
            // 2D の可視範囲は radius（地形上面からの高度）に比例させる (#254)。
            // perspective でターゲット平面に映る範囲 = radius * tan(fov/2) と一致する。
            // 絶対高度 (target.y + radius) を使うと標高の高い地形で最大ズームが効かなくなる。
            // 前提: camera.fovMode は既定の FOVMODE_VERTICAL_FIXED（fov は鉛直方向）。
            const halfH = camera.radius * Math.tan(camera.fov / 2);
            const halfW = halfH * aspect;
            camera.orthoTop = halfH;
            camera.orthoBottom = -halfH;
            camera.orthoLeft = -halfW;
            camera.orthoRight = halfW;
        };

        const updateViewModeToggleLabel = (mode: ViewMode): void => {
            // 「次に切り替える先」を示すアクションボタンとしてラベルを表示する。
            // textContent / aria-label を「次に切り替える先」で揃えるため、
            // 「現在の状態」を意味する aria-pressed は付与しない（混在を避ける）。
            ui.viewModeButton.textContent = mode === "3d" ? "2D" : "3D";
            ui.viewModeButton.setAttribute(
                "aria-label",
                mode === "3d" ? "視点切替: 2D に変更" : "視点切替: 3D に変更",
            );
        };

        const applyViewModeInternal = (
            next: ViewMode,
            opts?: { silent?: boolean; force?: boolean },
        ): void => {
            if (next === currentViewMode && !opts?.force) return;
            if (next === "2d") {
                // 現在の tilt を保存（3D 復帰時に復元するため）
                savedTiltDeg = (camera.beta * 180) / Math.PI;

                // ArcRotateCamera は beta=0 でジンバルロックが生じ alpha（方位）変化がカメラ位置に
                // 反映されなくなる。また lowerBetaLimit=0.1 のままでは 0 付近にクランプされてしまう。
                // そのため 2D 中は lowerBetaLimit を 0 に緩め、実質 0 の極小値（BETA_2D）で固定する。
                // この値は論理 tilt=0 として扱い、getTilt() は常に 0 を返す。
                camera.lowerBetaLimit = 0;
                camera.beta = BETA_2D;
                camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
                applyOrthoFrustum();
            } else {
                // 2D → 3D: 2D 中は position.y を ORTHO_MIN_CAM_Y に引き上げており
                // target.y もそれに連動して高い。3D ではカメラが地形の上空を
                // 周回するため、target.y を地形高度に戻し、radius / position.y を
                // 再計算する (#254)。
                if (currentViewMode === "2d") {
                    // ズームレベルを保持するため、先に radius を退避する。
                    const savedRadius2d = camera.radius;
                    const savedAlpha2d = camera.alpha;

                    const rayDown = new Ray(
                        new Vector3(
                            camera.target.x,
                            camera.position.y,
                            camera.target.z,
                        ),
                        Vector3.Down(),
                        CAMERA_FAR_CLIP,
                    );
                    const pick = scene.pickWithRay(
                        rayDown,
                        (m) => m.name.startsWith("tile-ground-"),
                    );
                    const tY =
                        pick?.hit && pick.pickedPoint
                            ? pick.pickedPoint.y
                            : 0;

                    // 3D 復帰時の beta を先に確定する。
                    const beta3d = clamp(
                        (savedTiltDeg * Math.PI) / 180,
                        lowerBetaLimit3d,
                        camera.upperBetaLimit ?? Math.PI,
                    );
                    const cosB = Math.cos(beta3d);
                    const sinB = Math.sin(beta3d);

                    // radius はそのまま引き継ぎ、target.y + radius*cosB で正しい高度に配置する。
                    const newCamY = tY + savedRadius2d * cosB;
                    const newCamX =
                        camera.target.x +
                        savedRadius2d * sinB * Math.cos(savedAlpha2d);
                    const newCamZ =
                        camera.target.z +
                        savedRadius2d * sinB * Math.sin(savedAlpha2d);

                    camera.setPosition(
                        new Vector3(newCamX, newCamY, newCamZ),
                    );
                    camera.setTarget(
                        new Vector3(camera.target.x, tY, camera.target.z),
                    );
                    camera.radius = savedRadius2d;
                    camera.alpha = savedAlpha2d;
                    camera.beta = beta3d;
                }
                camera.mode = Camera.PERSPECTIVE_CAMERA;

                // 3D 復帰時に元の lowerBetaLimit を戻してから beta を復元する。
                camera.lowerBetaLimit = lowerBetaLimit3d;
                const upperBeta = camera.upperBetaLimit ?? Math.PI;
                camera.beta = clamp(
                    (savedTiltDeg * Math.PI) / 180,
                    lowerBetaLimit3d,
                    upperBeta,
                );
            }
            currentViewMode = next;
            updateViewModeToggleLabel(next);
            if (!opts?.silent) {
                options?.onViewModeChange?.(next);
            }
        };

        // 初期反映: ラベルは現在モードに合わせる。`silent: true` で初期 listener は発火させない。
        updateViewModeToggleLabel(currentViewMode);
        if (currentViewMode === "2d") {
            // 同値だが初期化のため force で適用する（camera.mode / ortho frustum を確定させる）。
            applyViewModeInternal("2d", { silent: true, force: true });

            // URL から zoomLevel が指定された場合、radius へ変換する (#254)。
            if (options?.zoomLevel !== undefined) {
                const h = engine.getRenderHeight();
                if (h > 0) {
                    const r = zoomLevelToRadius(
                        options.zoomLevel,
                        h,
                        currentLat,
                        camera.fov,
                    );
                    const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                    const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
                    camera.radius = clamp(r, lower, upper);
                }
            }
        }

        // 2D の間は radius / リサイズで ortho frustum を追従させる必要がある。
        // 毎フレーム更新は安価（4 つの数値設定）なので onBeforeRender で常時走らせる。
        const orthoFrustumObserver = scene.onBeforeRenderObservable.add(() => {
            if (currentViewMode === "2d") {
                applyOrthoFrustum();
                // 初回レンダやリロード直後など retargetAtCameraPosition が未発火の状態で
                // position.y が低いままだと近くの高地形が near clip される。
                // 安全弁として ORTHO_MIN_CAM_Y 未満なら引き上げる (#254)。
                if (camera.position.y < ORTHO_MIN_CAM_Y) {
                    const savedRadius = camera.radius;
                    const savedAlpha = camera.alpha;
                    const tx = camera.target.x;
                    const tz = camera.target.z;
                    camera.setPosition(new Vector3(tx, ORTHO_MIN_CAM_Y, tz));
                    camera.setTarget(
                        new Vector3(tx, ORTHO_MIN_CAM_Y - savedRadius, tz),
                    );
                    camera.radius = savedRadius;
                    camera.alpha = savedAlpha;
                    camera.beta = BETA_2D;
                }
            }
        });

        ui.viewModeButton.addEventListener("click", () => {
            applyViewModeInternal(currentViewMode === "3d" ? "2d" : "3d");
        });

        // カメラ-地形衝突回避: 地面にめり込まないよう radius を補正してストップ
        const clampCameraAboveTerrain = (): void => {
            const minR = terrainMinRadius();
            if (camera.radius >= minR) return;
            camera.radius = minR;
        };
        scene.onBeforeRenderObservable.add(clampCameraAboveTerrain);

        // メッシュ標高更新時にキャッシュを無効化して即座に再チェック
        const terrainUpdatedListeners: Array<() => void> = [];
        tileManager.onTerrainUpdated = () => {
            prevAlpha = NaN; // terrainMinRadius のキャッシュを無効化
            for (const fn of terrainUpdatedListeners.slice()) {
                try {
                    fn();
                } catch (err) {
                    console.warn("[jpmap-terrain] terrain listener failed:", err);
                }
            }
        };
        const subscribeTerrainUpdated = (listener: () => void): (() => void) => {
            terrainUpdatedListeners.push(listener);
            return () => {
                const idx = terrainUpdatedListeners.indexOf(listener);
                if (idx !== -1) terrainUpdatedListeners.splice(idx, 1);
            };
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
                if (currentViewMode === "2d") {
                    // 2D モードでは平行投影のため altitude（海抜高度）は表示範囲に影響しない。
                    // ズーム制御は zoomLevel (= radius) で行う。altitude 指定は無視する (#254)。
                } else {
                    // URL/API の altitude はカメラ世界高度 (海抜 = camera.position.y) として扱う。
                    // ArcRotateCamera は radius を保持するため、
                    //   camY = target.y + radius * cos(beta)
                    // を解いて radius に変換する (#225)。
                    const cosB = Math.cos(camera.beta);
                    if (Math.abs(cosB) >= 1e-6) {
                        const desiredRadius =
                            (values.altitude - camera.target.y) / cosB;
                        camera.radius = clamp(desiredRadius, lower, upper);
                    } else {
                        camera.radius = clamp(values.altitude, lower, upper);
                    }
                }
            }
            if (values.azimuth !== undefined) {
                camera.alpha = alphaFromAzimuthDeg(values.azimuth);
            }
            if (values.tilt !== undefined && currentViewMode === "3d") {
                const lower = camera.lowerBetaLimit ?? lowerBetaLimit3d;
                const upper = camera.upperBetaLimit ?? Math.PI;
                camera.beta = clamp(
                    (values.tilt * Math.PI) / 180,
                    lower,
                    upper,
                );
                // 3D 中の tilt 変更は、以後 2D に切り替えたときに復元される値となる。
                savedTiltDeg = (camera.beta * 180) / Math.PI;
            } else if (values.tilt !== undefined) {
                // 2D 中は tilt を camera.beta に反映せず、復帰時の値だけ更新する (Issue #193)。
                const lowerDeg = (lowerBetaLimit3d * 180) / Math.PI;
                const upperDeg =
                    ((camera.upperBetaLimit ?? Math.PI) * 180) / Math.PI;
                savedTiltDeg = clamp(values.tilt, lowerDeg, upperDeg);
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
            getLat: derivedLat,
            getLon: derivedLon,
            getAltitude: () => {
                // 両モード共通: camera.position.y（Y=0 からの絶対高度）。
                // 3D: パン中に position.y が一定に保たれる (#225)。
                // 2D: position.y は ORTHO_MIN_CAM_Y 固定（平行投影のため表示には無影響）。
                //     ズームは camera.radius / zoomLevel で制御する (#254)。
                return camera.position.y;
            },
            getAzimuth: () => azimuthDegFromAlpha(camera.alpha),
            getTilt: () =>
                currentViewMode === "2d"
                    ? 0
                    : (camera.beta * 180) / Math.PI,
            getZoomLevel: () => {
                if (currentViewMode !== "2d") return undefined;
                const h = engine.getRenderHeight();
                if (h <= 0) return undefined;
                return clampZoomLevel(
                    radiusToZoomLevel(camera.radius, h, currentLat, camera.fov),
                );
            },
            setLat: (value) => applyView({ lat: value }, true),
            setLon: (value) => applyView({ lon: value }, true),
            setAltitude: (value) => applyView({ altitude: value }, true),
            setAzimuth: (value) => applyView({ azimuth: value }, true),
            setTilt: (value) => applyView({ tilt: value }, true),
            setView: (values, opts) =>
                applyView(values, opts?.refreshTerrain ?? true),
            refreshTerrainWithExternalFrustum: (lat, lon, frustumPlanes, cameraPosition, lodBias) => {
                // terrain camera の target を外部 lat/lon に合わせてから tileManager に委譲
                currentLat = clamp(lat, JAPAN_BOUNDS.minLat, JAPAN_BOUNDS.maxLat);
                currentLon = clamp(lon, JAPAN_BOUNDS.minLon, JAPAN_BOUNDS.maxLon);
                const centerTile = toTileXY(currentLat, currentLon, MAX_ZOOM);
                const { lat: tileCenterLat, lon: tileCenterLon } = tileCenterLatLon(
                    centerTile.x, centerTile.y, MAX_ZOOM,
                );
                const metersPerDegLon =
                    METERS_PER_DEGREE_LAT * Math.cos((currentLat * Math.PI) / 180);
                gridResidualX = (currentLon - tileCenterLon) * metersPerDegLon;
                gridResidualZ = (currentLat - tileCenterLat) * METERS_PER_DEGREE_LAT;
                camera.target.x = gridResidualX;
                camera.target.z = gridResidualZ;
                return tileManager.refreshWithExternalFrustum(lat, lon, frustumPlanes, cameraPosition, lodBias);
            },
            detachTileCamera: () => tileManager.detachCamera(),
            attachTileCamera: () => tileManager.attachCamera(),
            setExternalCompassDegrees: (degrees) => {
                externalCompassDegrees = degrees;
                if (degrees !== null) {
                    ui.compass.style.transform = `rotate(${degrees}deg)`;
                } else {
                    // 通常モードに戻す: 現在の camera.alpha で即時同期
                    syncCompass();
                }
            },
            // ---- T6 (Issue #120) ----
            getMapType: () =>
                tileManager.mapType === "std" ? "standard" : "photo",
            setMapType: (value) => {
                const internal = value === "standard" ? "std" : "photo";
                applyMapTypeChange(internal);
            },
            // ---- 視点モード (Issue #193) ----
            getViewMode: () => currentViewMode,
            setViewMode: (value) => applyViewModeInternal(value),
            setUiVisibility: createUiVisibilityController({
                compass: ui.compass,
                locateMe: ui.locateMe,
                zoomIn: ui.zoomIn,
                zoomOut: ui.zoomOut,
                scaleBarBar: ui.scaleBar.bar,
                scaleBarLabel: ui.scaleBar.label,
                mapToggle: ui.mapToggle,
                viewModeButton: ui.viewModeButton,
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
            isTerrainIdle: () => tileManager.isIdle,
            dispose: () => {
                disableSunShadows();
                // 視点モード追従の onBeforeRender observer を解除 (Issue #193)。
                scene.onBeforeRenderObservable.remove(orthoFrustumObserver);
                // 地形クリックリスナー (Issue #183) も dispose 時に解放する。
                // 解除関数を呼ばないまま dispose されたケースで、クロージャに
                // 残ったリスナー参照経由で外部オブジェクトが解放されないのを防ぐ。
                terrainClickListeners.length = 0;
                // 頂点インタラクションのリスナー (Issue #184) も同様にクリアする。
                polygonPointHoverListeners.length = 0;
                polygonPointClickListeners.length = 0;
                polygonPointDragStartListeners.length = 0;
                polygonPointDragListeners.length = 0;
                polygonPointDragEndListeners.length = 0;
                // hover カーソル/状態も元に戻す。dispose 時点で hover 中だった
                // 場合に canvas.style.cursor = 'pointer' が残らないようにする。
                polygonPointHoverState = null;
                canvas.style.cursor = "";
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
                removeFromParent(ui.viewModeButton);
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
            getMarkerContext: () => ({
                scene,
                tileManager: {
                    queryElevationAtWorld: (wx, wz) =>
                        tileManager.queryElevationAtWorld(wx, wz),
                    subscribeTerrainUpdated,
                },
                getOrigin: () => ({
                    lat: currentLat,
                    lon: currentLon,
                    gridResidualX,
                    gridResidualZ,
                }),
                getCameraPosition: () => ({
                    x: camera.globalPosition.x,
                    y: camera.globalPosition.y,
                    z: camera.globalPosition.z,
                    radius: camera.radius,
                    beta: camera.beta,
                }),
            }),
            subscribeTerrainClick: (listener) => {
                terrainClickListeners.push(listener);
                let removed = false;
                return (): void => {
                    if (removed) return;
                    removed = true;
                    const idx = terrainClickListeners.indexOf(listener);
                    if (idx !== -1) terrainClickListeners.splice(idx, 1);
                };
            },
            subscribePolygonPointHover: (listener) => {
                polygonPointHoverListeners.push(listener);
                let removed = false;
                return (): void => {
                    if (removed) return;
                    removed = true;
                    const idx = polygonPointHoverListeners.indexOf(listener);
                    if (idx !== -1) polygonPointHoverListeners.splice(idx, 1);
                    // 最後の hover リスナーが解除されたタイミングで、以後の
                    // pointermove では hover 検出が走らずカーソルが pointer の
                    // まま残り得る。明示的にクリアして元の状態へ戻す。
                    if (polygonPointHoverListeners.length === 0) {
                        polygonPointHoverState = null;
                        canvas.style.cursor = "";
                    }
                };
            },
            subscribePolygonPointClick: (listener) =>
                subscribe(polygonPointClickListeners, listener),
            subscribePolygonPointDragStart: (listener) =>
                subscribe(polygonPointDragStartListeners, listener),
            subscribePolygonPointDrag: (listener) =>
                subscribe(polygonPointDragListeners, listener),
            subscribePolygonPointDragEnd: (listener) =>
                subscribe(polygonPointDragEndListeners, listener),
        };
        options?.onReady?.(controller);

        // 初回ロード
        await refreshTerrain();

        // URL 復元時のカメラ高度ずれ修正 (Issue #225):
        // refreshTerrain 後にテレイン標高を camera.target.y へ反映する。
        // target.y = 0 のままだと、標高のある地形で camera 世界座標が
        // 想定より低く「ズームイン」して見える。
        // さらに altitude (= URL/API の camera.position.y) を維持するため
        // target.y 確定後に radius を再計算する。
        // 通常は refreshTerrain の await 完了後に中心タイルのキャッシュが利用可能だが、
        // タイルサーバ障害等で null が返った場合は onTerrainUpdated で遅延補正する。
        // canvas の表示はカメラ高度が確定した後の初回レンダリングまで遅延させる
        // ことで、リロード時のフラッシュを防ぐ (#225)。
        const desiredCamY = altitude;
        // 2D + zoomLevel 指定時は radius を変更しない（zoomLevel が radius を決定済み）。
        const initUsesZoomLevel =
            currentViewMode === "2d" && options?.zoomLevel !== undefined;
        const adjustRadiusForCamY = (targetY: number): void => {
            if (initUsesZoomLevel) return;
            const cosB = Math.cos(camera.beta);
            if (Math.abs(cosB) < 1e-6) return;
            const r = (desiredCamY - targetY) / cosB;
            const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
            const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
            camera.radius = clamp(r, lower, upper);
        };
        const initElev = tileManager.queryElevationAtWorld(
            gridResidualX,
            gridResidualZ,
        );
        // 初回レンダ後、target.y のみメッシュ高度に揃える (#225)。
        // alpha/beta/target.x/z は維持して画面が動かないようにし、
        // radius のみ調整して camera.position.y = altitude を保つ。
        // 真下方向にレイキャストすることで、tilt によらず target 直下の地形高度を
        // 取得する。視線方向だと tilt が大きいほど前方地形を拾い、リロード時に
        // 水平位置がずれる原因となる (#225)。
        const snapTargetYToMesh = (): void => {
            const ray = new Ray(
                new Vector3(camera.target.x, camera.position.y, camera.target.z),
                new Vector3(0, -1, 0),
                CAMERA_FAR_CLIP,
            );
            const pick = scene.pickWithRay(ray, (m) =>
                m.name.startsWith("tile-ground-"),
            );
            if (pick?.hit && pick.pickedPoint) {
                camera.target.y = pick.pickedPoint.y;
                adjustRadiusForCamY(pick.pickedPoint.y);
            }
        };
        if (initElev !== null) {
            camera.target.y = initElev;
            adjustRadiusForCamY(initElev);
            scene.onAfterRenderObservable.addOnce(() => {
                canvas.style.visibility = "";
                snapTargetYToMesh();
            });
        } else {
            // タイムアウト付きフォールバック: タイルサーバー障害等で標高が取得できない場合、
            // canvas が永久に非表示にならないよう 5 秒でフォールバック表示する (#225)。
            const ELEV_TIMEOUT_MS = 5000;
            let elevResolved = false;
            const fallbackTimer = window.setTimeout(() => {
                if (!elevResolved) {
                    elevResolved = true;
                    unsub();
                    canvas.style.visibility = "";
                }
            }, ELEV_TIMEOUT_MS);
            const unsub = subscribeTerrainUpdated(() => {
                const elev = tileManager.queryElevationAtWorld(
                    gridResidualX,
                    gridResidualZ,
                );
                if (elev !== null) {
                    elevResolved = true;
                    clearTimeout(fallbackTimer);
                    camera.target.y = elev;
                    adjustRadiusForCamY(elev);
                    unsub();
                    scene.onAfterRenderObservable.addOnce(() => {
                        canvas.style.visibility = "";
                        snapTargetYToMesh();
                    });
                }
            });
        }

        return scene;
    };
}

export default new DefaultScene();
