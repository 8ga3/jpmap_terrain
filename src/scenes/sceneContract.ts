/**
 * シーン層と `JpmapTerrain`（パッケージ層）/ overlay 層が共有する境界契約 (Issue #414)。
 *
 * カメラ・位置操作の {@link DefaultSceneController}、初期化オプション
 * {@link DefaultSceneInitOptions}、overlay 構築用の {@link MarkerContext}、および
 * 緯度メートル換算定数 {@link METERS_PER_DEGREE_LAT} を提供する。
 * globe 単一バックエンド化（#414）に伴い、これらの共有シンボルを描画実装から切り離す。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { FrustumPlane } from "../terrain/visibleTiles";
import type {
    TerrainClickListener,
    PolygonPointHoverListener,
    PolygonPointClickListener,
    PolygonPointDragListener,
    ViewMode,
} from "../lib/types";
import type { MarkerManager } from "../terrain/markerManager";
import type { PolygonManager } from "../terrain/polygonManager";
import type { CircleManager } from "../terrain/circleManager";
import type { ModelManager } from "../terrain/modelManager";

/** 1度の緯度あたりのメートル数（概算） */
export const METERS_PER_DEGREE_LAT = 111320;

/**
 * MarkerManager 構築用の境界コンテキスト (Issue #167)。
 *
 * **legacy（旧 planar 実装）向けの契約**。globe 単一バックエンド（#414）では
 * {@link DefaultSceneController.getMarkerContext} は未対応で `globeSceneController` が throw し、
 * marker 構築は {@link DefaultSceneController.getMarkerManager} アダプタ経由で行う。
 * シーン内部のクロージャ（カメラ位置・grid 残差）を直接参照させず、
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
     * 現在のカメラ状態（legacy MarkerContext 向け）。
     * - position: ワールド位置 (distScale 計算用)
     * - radius / beta: カメラ距離・仰角に相当する値。マーカー高さをカメラ距離・
     *   仰角に応じて動的に決めるために使用される（特定のカメラ実装には依存しない）。
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
 * 外部からカメラ・位置を操作するためのコントローラ (T5 / Issue #119)。
 *
 * `JpmapTerrain` (パッケージ層) から get/set/flyTo を呼び出す際の境界となる。
 * シーン内部のクロージャ (`currentLat` / `camera` / `refreshTerrain`) を直接公開せず、
 * 必要な操作のみ関数として提供する。
 */
export interface DefaultSceneController {
    getLat(): number;
    getLon(): number;
    /** 高度（メートル）。視点から地表までのカメラ距離に相当する */
    getAltitude(): number;
    /** 方位角（度）。0 = 北、時計回りに増加 */
    getAzimuth(): number;
    /** チルト角（度）。0 = 真下、90 = 水平 */
    getTilt(): number;
    /**
     * 2D モード時の Google Maps 互換ズームレベル (#254)。
     * 3D モードでは `undefined` を返す。
     */
    getZoomLevel(): number | undefined;

    /** 緯度を即時反映する。緯度経度クランプ範囲（globe: WORLD_BOUNDS）でクランプされる */
    setLat(value: number): void;
    /** 経度を即時反映する。緯度経度クランプ範囲（globe: WORLD_BOUNDS）でクランプされる */
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

    /**
     * @internal MarkerManager 構築用コンテキスト (Issue #167)。
     *
     * **legacy（旧 planar）向け**。globe 単一バックエンド（#414）では未対応で実装側が
     * throw するため呼び出さないこと。globe では {@link getMarkerManager} アダプタを用いる。
     */
    getMarkerContext(): MarkerContext;
    /**
     * globe バックエンド（#275 Phase 4 / P4-0）のフック。公開 `MarkerManager` 互換の
     * アダプタを返す。
     */
    getMarkerManager?(): MarkerManager | null;
    /**
     * globe バックエンドのフック。公開 `PolygonManager` 互換のアダプタを返す。
     */
    getPolygonManager?(): PolygonManager | null;
    /**
     * globe バックエンドのフック。公開 `CircleManager` 互換のアダプタを返す。
     */
    getCircleManager?(): CircleManager | null;
    /**
     * globe バックエンドのフック。公開 `ModelManager` 互換のアダプタを返す (#275 Phase 4 / P4-2)。
     */
    getModelManager?(): ModelManager | null;

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
 * シーン初期化オプション (T4 / Issue #118)。
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
    /** カメラ高度（メートル）。視点から地表までのカメラ距離に相当する */
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
     * WASD キーボードによるマップのパン操作を有効にするかどうか（globe バックエンドのみ有効）。
     * 既定 `true`。
     */
    enableKeyboardPan?: boolean;
    /**
     * シーン構築完了時に外部操作用コントローラを受け取るコールバック (T5)。
     * `JpmapTerrain` の get/set/flyTo はこのコントローラ経由でカメラ・位置を更新する。
     */
    onReady?: (controller: DefaultSceneController) => void;
}
