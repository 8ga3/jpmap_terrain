/**
 * `JpmapTerrain` クラス本体
 *
 * spec/package.md §3 (Initial Implementation) の API を提供する。
 *
 * - T3 (#117): クラス骨格 / 公開型
 * - T4 (#118): mountElement への canvas 配置と Scene 初期化
 * - T5 (#119): カメラ get/set / flyTo の実体
 * - T6 (#120): UI 表示 get/set / mapType 切替
 * - T7 (#121): dispose / resize の実体
 */

import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import { DefaultScene, type DefaultSceneController } from "../scenes/default";
import { createBabylonEngine } from "./internal/engineFactory";
import {
    CameraChangeEvent,
    CameraChangeListener,
    FlyToOptions,
    JPMAP_TERRAIN_DEFAULTS,
    JpmapTerrainOptions,
    MapType,
    MapTypeChangeListener,
    MarkerHandle,
    MarkerOptions,
    MarkerUpdate,
    PolygonHandle,
    PolygonOptions,
    PolygonPointOptions,
    PolygonPointPartial,
    SUN_AUTO_UPDATE_INTERVAL_MS,
    TerrainClickListener,
    PolygonPointHoverListener,
    PolygonPointClickListener,
    PolygonPointDragListener,
    ViewMode,
    ViewModeChangeListener,
} from "./types";
import { createMarkerManager, type MarkerManager } from "../terrain/markerManager";
import { createPolygonManager, type PolygonManager } from "../terrain/polygonManager";

/**
 * jpmap-terrain ビューア。
 *
 * インスタンスは `JpmapTerrain.create()` 経由でのみ生成する（async 初期化のため）。
 */
export class JpmapTerrain {
    private readonly mountElement: HTMLElement;

    private _lat: number;
    private _lon: number;
    private _altitude: number;
    private _azimuth: number;
    private _tilt: number;
    private _mapType: MapType;
    private _viewMode: ViewMode;

    private _showCompass = true;
    private _showZoomButtons = true;
    private _showScaleBar = true;
    private _showMapToggle = true;
    private _showViewModeButton = true;
    private _showAttribution = true;

    /** 太陽位置計算用の保持日時。`null` の場合は内部フォールバックを使用する */
    private _dateTime: Date | null;
    /** `true`: 60s 周期で実時刻に追従。`false`: `_dateTime` を固定値として使用 */
    private _autoSunPosition: boolean;
    /** auto モード時の `setInterval` ハンドル */
    private _sunTimer: ReturnType<typeof setInterval> | null = null;
    /** auto モード中、最後に内部反映した実時刻。`dateTime` getter が返す値 */
    private _autoLastAppliedDate: Date | null = null;

    /** 太陽 DirectionalLight 影描画 (Issue #39)。既定 OFF */
    private _showSunShadows: boolean;

    private _canvas: HTMLCanvasElement | null = null;
    private _engine: AbstractEngine | null = null;
    private _scene: Scene | null = null;
    private _onWindowResize: (() => void) | null = null;
    private _resizeObserver: ResizeObserver | null = null;
    private _disposed = false;
    private _controller: DefaultSceneController | null = null;
    /** 進行中の flyTo をキャンセルするためのトークン */
    private _flyToToken = 0;
    /** `onCameraChange` で登録されたリスナー一覧 */
    private _cameraListeners: CameraChangeListener[] = [];
    /** `scene.onBeforeRenderObservable` への登録ハンドル */
    private _cameraObserver: Observer<Scene> | null = null;
    /** 直近にリスナー通知した値のスナップショット（初回は null） */
    private _lastCameraSnapshot: CameraChangeEvent | null = null;
    /** `onMapTypeChange` で登録されたリスナー一覧 (Issue #149) */
    private _mapTypeListeners: MapTypeChangeListener[] = [];
    /** `onViewModeChange` で登録されたリスナー一覧 (Issue #193) */
    private _viewModeListeners: ViewModeChangeListener[] = [];

    /** マーカー管理 (Issue #167)。`onReady` で初期化される */
    private _markerManager: MarkerManager | null = null;

    /** ポリゴン管理 (Issue #170)。`onReady` で初期化される */
    private _polygonManager: PolygonManager | null = null;

    private constructor(mountElement: HTMLElement, options: JpmapTerrainOptions) {
        this.mountElement = mountElement;
        this._lat = options.lat ?? JPMAP_TERRAIN_DEFAULTS.lat;
        this._lon = options.lon ?? JPMAP_TERRAIN_DEFAULTS.lon;
        this._altitude = options.altitude ?? JPMAP_TERRAIN_DEFAULTS.altitude;
        this._azimuth = options.azimuth ?? JPMAP_TERRAIN_DEFAULTS.azimuth;
        this._tilt = options.tilt ?? JPMAP_TERRAIN_DEFAULTS.tilt;
        this._mapType = options.mapType ?? JPMAP_TERRAIN_DEFAULTS.mapType;
        this._viewMode = options.viewMode ?? JPMAP_TERRAIN_DEFAULTS.viewMode;
        this._showViewModeButton =
            options.showViewModeButton ??
            JPMAP_TERRAIN_DEFAULTS.showViewModeButton;
        // 太陽位置 (Issue #35)。`Invalid Date` は `console.warn` のうえ null に倒す。
        this._dateTime = JpmapTerrain._sanitizeDateTimeOption(options.dateTime);
        this._autoSunPosition =
            options.autoSunPosition ?? JPMAP_TERRAIN_DEFAULTS.autoSunPosition;
        this._showSunShadows =
            options.showSunShadows ?? JPMAP_TERRAIN_DEFAULTS.showSunShadows;
    }

    /**
     * options / setter から渡された `dateTime` を検証し、`Invalid Date` の場合は
     * `console.warn` を出して `null` に倒す。
     */
    private static _sanitizeDateTimeOption(
        value: Date | null | undefined,
    ): Date | null {
        if (value === undefined || value === null) {
            return JPMAP_TERRAIN_DEFAULTS.dateTime;
        }
        if (Number.isNaN(value.getTime())) {
            console.warn(
                "[JpmapTerrain] dateTime setter received Invalid Date; falling back to null",
            );
            return null;
        }
        return value;
    }

    /**
     * 指定したマウント要素にビューアを生成する。
     *
     * @param mountElement キャンバスと UI を配置する DOM 要素
     * @param options 初期化オプション（spec/package.md §3.2）
     * @returns 初期化済みの `JpmapTerrain` インスタンス
     */
    public static async create(
        mountElement: HTMLElement,
        options: JpmapTerrainOptions = {},
    ): Promise<JpmapTerrain> {
        if (!mountElement) {
            throw new TypeError("JpmapTerrain.create: mountElement is required");
        }
        const instance = new JpmapTerrain(mountElement, options);
        await instance.initAsync(options);
        return instance;
    }

    /**
     * mountElement に canvas を配置し Babylon.js Engine / Scene を初期化する (T4)。
     * UI を mountElement 配下に完全に閉じ込める作業は T6 (#120) で行う。
     *
     * 初期化途中で例外が発生した場合は append した canvas / 確保済み Engine をクリーンアップして再 throw する。
     */
    private async initAsync(options: JpmapTerrainOptions): Promise<void> {
        const canvas = document.createElement("canvas");
        // 同一ページで複数インスタンスを生成した場合に id が衝突しないよう、固定 id は付与しない。
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        canvas.style.outline = "none";
        canvas.style.touchAction = "none";
        this.mountElement.appendChild(canvas);
        this._canvas = canvas;

        try {
            const engine = await createBabylonEngine(
                canvas,
                options.engine ?? JPMAP_TERRAIN_DEFAULTS.engine,
            );
            this._engine = engine;

            const sceneFactory = new DefaultScene();
            const scene = await sceneFactory.createScene(engine, canvas, {
                lat: this._lat,
                lon: this._lon,
                altitude: this._altitude,
                azimuth: this._azimuth,
                tilt: this._tilt,
                mapType: this._mapType,
                onMapTypeChange: (next) => this._handleMapTypeChange(next),
                viewMode: this._viewMode,
                onViewModeChange: (next) => this._handleViewModeChange(next),
                onReady: (controller) => {
                    this._controller = controller;
                    // T6: 初期表示状態を controller に反映する
                    controller.setUiVisibility(
                        "compass",
                        this._showCompass,
                    );
                    controller.setUiVisibility(
                        "zoomButtons",
                        this._showZoomButtons,
                    );
                    controller.setUiVisibility(
                        "scaleBar",
                        this._showScaleBar,
                    );
                    controller.setUiVisibility(
                        "mapToggle",
                        this._showMapToggle,
                    );
                    controller.setUiVisibility(
                        "viewModeButton",
                        this._showViewModeButton,
                    );
                    controller.setUiVisibility(
                        "attribution",
                        this._showAttribution,
                    );
                    // 太陽位置（Issue #35）。auto モードならタイマー始動 + 即時 1 回反映、
                    // 固定モードなら `_dateTime`（or null）で初期反映する。
                    if (this._autoSunPosition) {
                        this._startSunTimer();
                        this._tickSunTimer();
                    } else {
                        controller.setSunState(this._dateTime);
                    }
                    // 太陽影 (Issue #39)。既定 OFF のため通常は no-op。
                    if (this._showSunShadows) {
                        controller.setSunShadows(true);
                    }
                    // マーカー (Issue #167)。境界コンテキスト経由で manager を構築する。
                    this._markerManager = createMarkerManager(
                        controller.getMarkerContext(),
                    );
                    // ポリゴン (Issue #170)。MarkerContext と同一のコンテキストを共有する。
                    this._polygonManager = createPolygonManager(
                        controller.getMarkerContext(),
                    );
                },
            });
            this._scene = scene;

            engine.runRenderLoop(() => scene.render());

            // カメラ変化監視: 毎フレーム前に現在値スナップショットを取り、差分があればリスナー通知。
            this._cameraObserver = scene.onBeforeRenderObservable.add(() =>
                this._notifyIfChanged(),
            );

            const onResize = (): void => engine.resize();
            window.addEventListener("resize", onResize);
            this._onWindowResize = onResize;

            // mountElement のサイズ変化にも追従させる (T7 / #121)。
            // サポートしない環境 (古いブラウザや jsdom) ではスキップし、`window.resize` にフォールバックする。
            if (typeof ResizeObserver !== "undefined") {
                const ro = new ResizeObserver(() => {
                    // engine.resize は canvas サイズを再計測しレンダリングターゲットを追従させる。
                    engine.resize();
                });
                ro.observe(this.mountElement);
                this._resizeObserver = ro;
            }
        } catch (error) {
            // 部分的に確保済みのリソースを解放してから再 throw
            if (this._resizeObserver) {
                this._resizeObserver.disconnect();
                this._resizeObserver = null;
            }
            if (this._onWindowResize) {
                window.removeEventListener("resize", this._onWindowResize);
                this._onWindowResize = null;
            }
            if (this._scene) {
                this._scene.dispose();
                this._scene = null;
            }
            if (this._engine) {
                this._engine.dispose();
                this._engine = null;
            }
            if (canvas.parentElement === this.mountElement) {
                this.mountElement.removeChild(canvas);
            }
            this._canvas = null;
            throw error;
        }
    }

    // ---- 内部デバッグ用アクセサ ----

    /**
     * 内部 Babylon.js Scene への参照を返す（デバッグ・テスト用途）。
     *
     * @internal このプロパティは公開 API ではない。
     * 開発デモ (`src/index.ts`) と Playwright (`tests/validation.spec.ts`) のみが
     * `window.scene` 経由で `Scene.isReady()` 等を参照するために使用する。
     * 利用側コードからは参照しないこと。
     */
    public get __debugScene(): Scene | null {
        return this._scene;
    }

    // ---- 位置・カメラ制御 (spec §3.3.1) ----

    public get lat(): number {
        return this._controller?.getLat() ?? this._lat;
    }
    public set lat(value: number) {
        this._lat = value;
        this._controller?.setLat(value);
    }

    public get lon(): number {
        return this._controller?.getLon() ?? this._lon;
    }
    public set lon(value: number) {
        this._lon = value;
        this._controller?.setLon(value);
    }

    public get altitude(): number {
        return this._controller?.getAltitude() ?? this._altitude;
    }
    public set altitude(value: number) {
        this._altitude = value;
        this._controller?.setAltitude(value);
    }

    public get azimuth(): number {
        return this._controller?.getAzimuth() ?? this._azimuth;
    }
    public set azimuth(value: number) {
        this._azimuth = value;
        this._controller?.setAzimuth(value);
    }

    public get tilt(): number {
        return this._controller?.getTilt() ?? this._tilt;
    }
    public set tilt(value: number) {
        this._tilt = value;
        this._controller?.setTilt(value);
    }

    /**
     * 指定座標へカメラをアニメーション付きで移動する (T5)。
     *
     * 指定された長さ（`duration`, デフォルト 800ms）の間、`requestAnimationFrame` で状態を連続補間しコントローラへ順次反映する。
     * 連続で `flyTo` が呼ばれた場合は後勝ちとし、前の遷移は途中で中断し Promise を resolve する。
     *
     * タイル fetch 負荷を抑えるため、中間フレームでは `setView({ refreshTerrain: false })` とし、
     * 最終フレーム（もしくは 中断・即時適用パス）でのみ `refreshTerrain: true` でタイル中心を更新する。
     */
    public async flyTo(options: FlyToOptions): Promise<void> {
        const duration = Math.max(0, options.duration ?? 800);
        const startLat = this.lat;
        const startLon = this.lon;
        const startAlt = this.altitude;
        const startAz = this.azimuth;
        const startTilt = this.tilt;
        const targetLat = options.lat;
        const targetLon = options.lon;
        const targetAlt = options.altitude ?? startAlt;
        const targetAz = options.azimuth ?? startAz;
        const targetTilt = options.tilt ?? startTilt;

        // この flyTo 中に適用したフレーム値をキャッシュし、
        // 中断時に「その位置で 1 回だけ refresh を行う」ために保持する。
        const lastApplied = {
            lat: startLat,
            lon: startLon,
            altitude: startAlt,
            azimuth: startAz,
            tilt: startTilt,
        };

        const applyAndCacheLocal = (values: typeof lastApplied): void => {
            // controller 不在時のフォールバック用にローカル状態も同期する。
            this._lat = values.lat;
            this._lon = values.lon;
            this._altitude = values.altitude;
            this._azimuth = values.azimuth;
            this._tilt = values.tilt;
            lastApplied.lat = values.lat;
            lastApplied.lon = values.lon;
            lastApplied.altitude = values.altitude;
            lastApplied.azimuth = values.azimuth;
            lastApplied.tilt = values.tilt;
        };

        // 長さ 0 または animation frame を提供しない環境（テスト等）は即時適用
        const raf =
            typeof requestAnimationFrame === "function"
                ? requestAnimationFrame
                : null;
        if (duration === 0 || raf === null) {
            const finalValues = {
                lat: targetLat,
                lon: targetLon,
                altitude: targetAlt,
                azimuth: targetAz,
                tilt: targetTilt,
            };
            applyAndCacheLocal(finalValues);
            this._controller?.setView(finalValues, { refreshTerrain: true });
            return;
        }

        const token = ++this._flyToToken;
        const startTime =
            typeof performance !== "undefined" && performance.now
                ? performance.now()
                : Date.now();
        const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

        return new Promise<void>((resolve) => {
            const step = (now: number): void => {
                // 後勝ちの flyTo が起動されたら中断
                if (token !== this._flyToToken) {
                    // 最後に適用した位置で 1 回 refresh してタイルを追いつかせる。
                    // 後勝ちの flyTo がさらに上書きするため、余分な fetch にはならない。
                    this._controller?.setView(
                        { lat: lastApplied.lat, lon: lastApplied.lon },
                        { refreshTerrain: true },
                    );
                    resolve();
                    return;
                }
                const elapsed = now - startTime;
                const t = Math.min(1, elapsed / duration);
                const k = easeOutCubic(t);
                const values = {
                    lat: startLat + (targetLat - startLat) * k,
                    lon: startLon + (targetLon - startLon) * k,
                    altitude: startAlt + (targetAlt - startAlt) * k,
                    azimuth: startAz + (targetAz - startAz) * k,
                    tilt: startTilt + (targetTilt - startTilt) * k,
                };
                applyAndCacheLocal(values);
                // 中間フレームでは refresh しない。最終フレームだけ refresh。
                const isLast = t >= 1;
                this._controller?.setView(values, { refreshTerrain: isLast });
                if (!isLast) {
                    raf(step);
                } else {
                    resolve();
                }
            };
            raf(step);
        });
    }

    // ---- UI 表示制御 (spec §3.3.2) ----

    public get showCompass(): boolean {
        return this._showCompass;
    }
    public set showCompass(value: boolean) {
        this._showCompass = value;
        this._controller?.setUiVisibility("compass", value);
    }

    public get showZoomButtons(): boolean {
        return this._showZoomButtons;
    }
    public set showZoomButtons(value: boolean) {
        this._showZoomButtons = value;
        this._controller?.setUiVisibility("zoomButtons", value);
    }

    public get showScaleBar(): boolean {
        return this._showScaleBar;
    }
    public set showScaleBar(value: boolean) {
        this._showScaleBar = value;
        this._controller?.setUiVisibility("scaleBar", value);
    }

    public get showMapToggle(): boolean {
        return this._showMapToggle;
    }
    public set showMapToggle(value: boolean) {
        this._showMapToggle = value;
        this._controller?.setUiVisibility("mapToggle", value);
    }

    public get showViewModeButton(): boolean {
        return this._showViewModeButton;
    }
    public set showViewModeButton(value: boolean) {
        this._showViewModeButton = value;
        this._controller?.setUiVisibility("viewModeButton", value);
    }

    public get showAttribution(): boolean {
        return this._showAttribution;
    }
    public set showAttribution(value: boolean) {
        this._showAttribution = value;
        this._controller?.setUiVisibility("attribution", value);
    }

    public get mapType(): MapType {
        return this._controller?.getMapType() ?? this._mapType;
    }
    public set mapType(value: MapType) {
        this._mapType = value;
        this._controller?.setMapType(value);
    }

    /**
     * 現在のカメラ視点モード (Issue #193)。
     * `"3d"` (透視投影) / `"2d"` (平行投影、tilt=0 固定)。
     */
    public get viewMode(): ViewMode {
        return this._controller?.getViewMode() ?? this._viewMode;
    }
    public set viewMode(value: ViewMode) {
        this._viewMode = value;
        this._controller?.setViewMode(value);
    }

    /**
     * `viewMode` が変化した際に呼ばれるリスナーを登録する (Issue #193)。
     *
     * `onMapTypeChange` と対称な API。UI ボタン操作・`viewMode` setter のいずれの
     * 経路でも、値が変化したフレームのみ通知する。同値再 set では通知しない。
     * 戻り値の関数で登録解除（複数回呼んでも安全）。リスナーが throw しても他リスナー
     * へ伝播し、`console.error` で握りつぶす。`dispose()` 後の呼び出しは何もせず、
     * no-op の unsubscribe を返す。
     */
    public onViewModeChange(listener: ViewModeChangeListener): () => void {
        if (this._disposed) {
            return () => {
                /* no-op: viewer is already disposed */
            };
        }
        this._viewModeListeners.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = this._viewModeListeners.indexOf(listener);
            if (idx !== -1) {
                this._viewModeListeners.splice(idx, 1);
            }
        };
    }

    /**
     * controller から伝播される `viewMode` 変化を受け取り、
     * 内部状態の更新と登録リスナーへの通知を行う (Issue #193)。
     * controller 側で同値再 set はフィルタ済みのため、ここでは無条件に通知する。
     */
    private _handleViewModeChange(next: ViewMode): void {
        if (this._disposed) return;
        this._viewMode = next;
        const listeners = this._viewModeListeners.slice();
        for (const listener of listeners) {
            try {
                listener(next);
            } catch (err) {
                console.error("[JpmapTerrain] onViewModeChange listener threw:", err);
            }
        }
    }

    /**
     * `mapType` が変化した際に呼ばれるリスナーを登録する (Issue #149)。
     *
     * - `onCameraChange` と対称な API。
     * - UI ボタン操作・`mapType` setter のいずれの経路でも、値が変化したフレームのみ通知する。
     * - 同値再 set では通知しない。
     * - 戻り値の関数で登録解除（複数回呼んでも安全）。
     * - リスナーが throw しても他リスナーへ伝播し、`console.error` で握りつぶす。
     * - `dispose()` 後の呼び出しは何もせず、no-op の unsubscribe を返す。
     *
     * @param listener `mapType` 変化を受け取るリスナー
     * @returns 登録解除関数
     */
    public onMapTypeChange(listener: MapTypeChangeListener): () => void {
        if (this._disposed) {
            return () => {
                /* no-op: viewer is already disposed */
            };
        }
        this._mapTypeListeners.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = this._mapTypeListeners.indexOf(listener);
            if (idx !== -1) {
                this._mapTypeListeners.splice(idx, 1);
            }
        };
    }

    /**
     * controller から伝播される `mapType` 変化を受け取り、
     * 内部状態の更新と登録リスナーへの通知を行う (Issue #149)。
     * controller 側で同値再 set はフィルタ済みのため、ここでは無条件に通知する。
     */
    private _handleMapTypeChange(next: MapType): void {
        if (this._disposed) return;
        this._mapType = next;
        const listeners = this._mapTypeListeners.slice();
        for (const listener of listeners) {
            try {
                listener(next);
            } catch (err) {
                console.error("[JpmapTerrain] onMapTypeChange listener threw:", err);
            }
        }
    }

    // ---- 地形クリック通知 (Issue #183) ----

    /**
     * 地形タイル上での「クリック」を購読する。
     *
     * - 主ボタン (`button === 0`) のみ対象。
     * - `pointerdown` から `pointerup` までの移動量が
     *   {@link import("./types").TERRAIN_CLICK_DRAG_THRESHOLD_PX} (= 4 CSS px) 以下のときのみ発火する
     *   （ドラッグやカメラ操作は発火しない）。
     * - `Ctrl` / `Cmd` 併用クリックはカメラ操作扱いのため発火しない。
     * - `tile-ground-*` メッシュへのヒットがない場合は発火しない。
     * - `dispose()` 後の登録は no-op、解除関数も no-op。
     * - リスナー throw は他リスナーに伝播せず、`console.error` で握りつぶす。
     *
     * @returns 登録解除関数（複数回呼んでも安全）
     */
    public onTerrainClick(listener: TerrainClickListener): () => void {
        if (this._disposed || !this._controller) {
            return () => {
                /* no-op: viewer is already disposed or not ready */
            };
        }
        return this._controller.subscribeTerrainClick(listener);
    }

    // ---- ポリゴン頂点インタラクション (Issue #184) ----

    /**
     * ポリゴン頂点上の hover を購読する。リスナーは頂点に入った/対象切替時に
     * `{ polygonId, index, pointerEvent }` を、頂点から離れたときに `null` を受け取る。
     * hover 中はカーソルが自動的に `pointer` に切り替わり、解除時に空文字へ戻る。
     */
    public onPolygonPointHover(
        listener: PolygonPointHoverListener,
    ): () => void {
        if (this._disposed || !this._controller) {
            return () => {
                /* no-op */
            };
        }
        return this._controller.subscribePolygonPointHover(listener);
    }

    /**
     * ポリゴン頂点上のクリックを購読する。
     * `pointerdown` から `pointerup` までの移動量が
     * {@link import("./types").POLYGON_POINT_DRAG_THRESHOLD_PX} (= 3 CSS px) 未満のとき発火する。
     * 修飾キー `Ctrl` / `Cmd` 併用時はカメラ操作のため発火しない。
     */
    public onPolygonPointClick(
        listener: PolygonPointClickListener,
    ): () => void {
        if (this._disposed || !this._controller) {
            return () => {
                /* no-op */
            };
        }
        return this._controller.subscribePolygonPointClick(listener);
    }

    /** ポリゴン頂点ドラッグ開始 (#184)。閾値は 3 CSS px。 */
    public onPolygonPointDragStart(
        listener: PolygonPointDragListener,
    ): () => void {
        if (this._disposed || !this._controller) {
            return () => {
                /* no-op */
            };
        }
        return this._controller.subscribePolygonPointDragStart(listener);
    }

    /**
     * ポリゴン頂点ドラッグ中（`pointermove` 毎） (#184)。
     * カーソル位置の地形メッシュ交点を `lat` / `lon` / `groundAltitude` で通知する
     * （地形にヒットしなかった場合は `null`）。
     */
    public onPolygonPointDrag(
        listener: PolygonPointDragListener,
    ): () => void {
        if (this._disposed || !this._controller) {
            return () => {
                /* no-op */
            };
        }
        return this._controller.subscribePolygonPointDrag(listener);
    }

    /** ポリゴン頂点ドラッグ終了 (#184)。`pointerup` または `pointercancel` で発火する。 */
    public onPolygonPointDragEnd(
        listener: PolygonPointDragListener,
    ): () => void {
        if (this._disposed || !this._controller) {
            return () => {
                /* no-op */
            };
        }
        return this._controller.subscribePolygonPointDragEnd(listener);
    }

    // ---- 太陽位置 (spec §3.3.6 / Issue #35) ----

    /**
     * 太陽位置計算に使う日時を取得する。
     *
     * - `autoSunPosition === false`: 最後に set した値（または options 値、`null`）を返す。
     * - `autoSunPosition === true`: 最後にタイマーで内部反映した実時刻を返す（一度も
     *   反映していない場合は `null`）。
     */
    public get dateTime(): Date | null {
        if (this._autoSunPosition) {
            return this._autoLastAppliedDate;
        }
        return this._dateTime;
    }
    public set dateTime(value: Date | null) {
        if (this._disposed) return;
        this._dateTime = JpmapTerrain._sanitizeDateTimeOption(value);
        // auto モード中は太陽計算で使わない（auto 優先）が、値だけ保持する。
        if (!this._autoSunPosition) {
            this._controller?.setSunState(this._dateTime);
        }
    }

    public get autoSunPosition(): boolean {
        return this._autoSunPosition;
    }
    public set autoSunPosition(value: boolean) {
        if (this._disposed) return;
        if (this._autoSunPosition === value) return;
        this._autoSunPosition = value;
        if (value) {
            this._startSunTimer();
            // 即時 1 回反映
            this._tickSunTimer();
        } else {
            this._stopSunTimer();
            this._autoLastAppliedDate = null;
            // 保持されていた `_dateTime`（または null）で再計算
            this._controller?.setSunState(this._dateTime);
        }
    }

    /**
     * 太陽 DirectionalLight による地形への影描画の有効/無効 (Issue #39)。
     *
     * - `true`: `ShadowGenerator` を生成し、地形タイル全体を caster / receiver に登録する。
     * - `false`（既定）: `ShadowGenerator` を生成しない / 既存があれば dispose する。
     * - 同値再 set は no-op。`dispose()` 後の set も no-op。
     *
     * GPU 負荷が比較的大きいため、必要時のみ ON にすることを推奨する。
     */
    public get showSunShadows(): boolean {
        return this._showSunShadows;
    }
    public set showSunShadows(value: boolean) {
        if (this._disposed) return;
        if (this._showSunShadows === value) return;
        this._showSunShadows = value;
        this._controller?.setSunShadows(value);
    }

    /** 60 秒周期で `new Date()` を太陽計算に流し込むタイマーを開始する */
    private _startSunTimer(): void {
        if (this._disposed) return;
        if (this._sunTimer !== null) return;
        this._sunTimer = setInterval(
            () => this._tickSunTimer(),
            SUN_AUTO_UPDATE_INTERVAL_MS,
        );
    }

    private _stopSunTimer(): void {
        if (this._sunTimer === null) return;
        clearInterval(this._sunTimer);
        this._sunTimer = null;
    }

    /** auto モードの 1 回分の反映。実行毎に「最後に反映した実時刻」を記録する */
    private _tickSunTimer(): void {
        if (this._disposed) return;
        const now = new Date();
        this._autoLastAppliedDate = now;
        this._controller?.setSunState(now);
    }

    // ---- カメラ変化通知 (Issue #136) ----

    /**
     * カメラ位置・姿勢のいずれかが変化したタイミングで呼ばれるリスナーを登録する。
     *
     * - 戻り値の関数で登録解除（複数回呼んでも安全）。
     * - 初回登録時の即時発火は行わない。
     * - 比較精度: epsilon = 1e-9。
     * - 同一リスナーを複数回登録した場合は登録回数だけ呼ばれる単純動作。
     * - リスナーが throw しても他リスナーへ伝播し、`console.error` で握りつぶす。
     * - `dispose()` 後の呼び出しは何もせず、no-op の unsubscribe を返す。
     *
     * @param listener カメラ変化を受け取るリスナー
     * @returns 登録解除関数
     */
    public onCameraChange(listener: CameraChangeListener): () => void {
        if (this._disposed) {
            return () => {
                /* no-op: viewer is already disposed */
            };
        }
        this._cameraListeners.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = this._cameraListeners.indexOf(listener);
            if (idx !== -1) {
                this._cameraListeners.splice(idx, 1);
            }
        };
    }

    /**
     * 現在のカメラ状態を取得し、前回スナップショットから変化があれば登録リスナーへ通知する。
     * 初回（`_lastCameraSnapshot === null`）はスナップショットだけ更新し発火しない。
     *
     * リスナー未登録時はスナップショット生成も比較も行わずに即 return することで、
     * `onCameraChange` を使わない利用形態のフレーム毎オーバーヘッドを避ける。
     * （次回登録時には `_lastCameraSnapshot === null` から再開するため、
     * 「登録直後に発火しない」仕様を引き続き満たす。）
     */
    private _notifyIfChanged(): void {
        if (this._disposed) return;
        if (this._cameraListeners.length === 0) return;
        const snapshot: CameraChangeEvent = {
            lat: this.lat,
            lon: this.lon,
            altitude: this.altitude,
            azimuth: this.azimuth,
            tilt: this.tilt,
            viewMode: this.viewMode,
        };
        const prev = this._lastCameraSnapshot;
        if (prev === null) {
            this._lastCameraSnapshot = snapshot;
            return;
        }
        const eps = 1e-9;
        const changed =
            Math.abs(snapshot.lat - prev.lat) > eps ||
            Math.abs(snapshot.lon - prev.lon) > eps ||
            Math.abs(snapshot.altitude - prev.altitude) > eps ||
            Math.abs(snapshot.azimuth - prev.azimuth) > eps ||
            Math.abs(snapshot.tilt - prev.tilt) > eps ||
            snapshot.viewMode !== prev.viewMode;
        if (!changed) return;
        this._lastCameraSnapshot = snapshot;
        // iterate 中の add/remove 安全のためスナップショットを取って iterate
        const listeners = this._cameraListeners.slice();
        for (const listener of listeners) {
            try {
                listener(snapshot);
            } catch (err) {
                console.error("[JpmapTerrain] onCameraChange listener threw:", err);
            }
        }
    }

    // ---- マーカー (Issue #167) ----

    private _assertAlive(): void {
        if (this._disposed) {
            throw new Error("JpmapTerrain has been disposed");
        }
    }

    private _requireMarkerManager(): MarkerManager {
        if (!this._markerManager) {
            throw new Error("JpmapTerrain marker manager is not ready yet");
        }
        return this._markerManager;
    }

    /**
     * dispose 後のマーカー API は次の方針で統一する:
     * - 戻り値が `MarkerHandle`（非 null）の API（`addMarker` / `updateMarker`）は
     *   呼び出し側が結果を必ず使うため、明示的に `Error` を投げる。
     * - 戻り値が void / `MarkerHandle | null` / `readonly string[]` の API
     *   （`getMarker` / `removeMarker` / `setMarkerEnabled` / `listMarkers`）は
     *   片付け中のクリーンアップで安全に呼べるよう no-op として扱う。
     */
    public addMarker(id: string, options: MarkerOptions): MarkerHandle {
        this._assertAlive();
        return this._requireMarkerManager().add(id, options);
    }

    public getMarker(id: string): MarkerHandle | null {
        if (this._disposed || !this._markerManager) return null;
        return this._markerManager.get(id);
    }

    public updateMarker(id: string, partial: MarkerUpdate): MarkerHandle {
        this._assertAlive();
        return this._requireMarkerManager().update(id, partial);
    }

    public removeMarker(id: string): void {
        if (this._disposed || !this._markerManager) return;
        this._markerManager.remove(id);
    }

    public setMarkerEnabled(id: string, enabled: boolean): void {
        if (this._disposed || !this._markerManager) return;
        this._markerManager.setEnabled(id, enabled);
    }

    public listMarkers(): readonly string[] {
        if (this._disposed) return [];
        return this._markerManager?.list() ?? [];
    }

    // ---- ポリゴン (Issue #170) ----

    private _requirePolygonManager(): PolygonManager {
        if (!this._polygonManager) {
            throw new Error("JpmapTerrain polygon manager is not ready yet");
        }
        return this._polygonManager;
    }

    /**
     * dispose 後のポリゴン API はマーカーと同方針で統一する:
     * - 戻り値が `PolygonHandle`（非 null）の API（`addPolygon`）は throw。
     * - 戻り値が void / `PolygonHandle | null` / `readonly string[]` の API は no-op として扱う。
     */
    public addPolygon(id: string, options: PolygonOptions): PolygonHandle {
        this._assertAlive();
        return this._requirePolygonManager().add(id, options);
    }

    public getPolygon(id: string): PolygonHandle | null {
        if (this._disposed || !this._polygonManager) return null;
        return this._polygonManager.get(id);
    }

    public removePolygon(id: string): void {
        if (this._disposed || !this._polygonManager) return;
        this._polygonManager.remove(id);
    }

    public setPolygonEnabled(id: string, enabled: boolean): void {
        if (this._disposed || !this._polygonManager) return;
        this._polygonManager.setEnabled(id, enabled);
    }

    public setVerticalsEnabled(id: string, enabled: boolean): void {
        if (this._disposed || !this._polygonManager) return;
        this._polygonManager.setVerticalsEnabled(id, enabled);
    }

    public setLabelsEnabled(id: string, enabled: boolean): void {
        if (this._disposed || !this._polygonManager) return;
        this._polygonManager.setLabelsEnabled(id, enabled);
    }

    public setWallsEnabled(id: string, enabled: boolean): void {
        if (this._disposed || !this._polygonManager) return;
        this._polygonManager.setWallsEnabled(id, enabled);
    }

    public listPolygons(): readonly string[] {
        if (this._disposed) return [];
        return this._polygonManager?.list() ?? [];
    }

    /**
     * 指定 index に新しい頂点を挿入する (#173)。`index === points.length` で末尾追加。
     * 範囲外 index・JAPAN_BOUNDS 外・`absolute` モードで altitude 未指定 は throw。
     * dispose 後 / マネージャ未初期化 / 未存在 id は throw。
     */
    public insertPolygonPoint(
        id: string,
        index: number,
        point: PolygonPointOptions,
    ): PolygonHandle {
        this._assertAlive();
        return this._requirePolygonManager().insertPoint(id, index, point);
    }

    /**
     * 指定 index の頂点を削除する (#173)。残り 1 点未満になる場合は throw。
     */
    public removePolygonPoint(id: string, index: number): PolygonHandle {
        this._assertAlive();
        return this._requirePolygonManager().removePoint(id, index);
    }

    /**
     * 指定 index の頂点を部分更新する (#173)。
     * `partial.label === null` のときラベルを削除する。`undefined` のフィールドは現状維持。
     */
    public updatePolygonPoint(
        id: string,
        index: number,
        partial: PolygonPointPartial,
    ): PolygonHandle {
        this._assertAlive();
        return this._requirePolygonManager().updatePoint(id, index, partial);
    }

    /**
     * 全頂点を置き換える (#173)。`points.length < 1` は throw。
     */
    public replacePolygonPoints(
        id: string,
        points: readonly PolygonPointOptions[],
    ): PolygonHandle {
        this._assertAlive();
        return this._requirePolygonManager().replacePoints(id, points);
    }

    // ---- ライフサイクル (spec §3.3.3) ----

    /**
     * ビューアを破棄し、`mountElement` 配下の canvas と controlPanel が生成した UI 要素を除去する (T7 / Issue #121)。
     *
     * - 進行中の `flyTo` を中断
     * - `ResizeObserver` / `window.resize` リスナを解除
     * - controlPanel の UI 要素を `document.body` から除去（DefaultSceneController.dispose 経由）
     * - Babylon.js Scene / Engine を dispose
     * - `mountElement` 配下に配置した canvas を除去
     *
     * 冪等性: 2 回以上呼んでも例外にならず、何もしない。
     */
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        // 進行中の flyTo を中断
        this._flyToToken++;
        // 太陽位置タイマー (Issue #35) を停止
        this._stopSunTimer();
        this._autoLastAppliedDate = null;
        // カメラ変化通知を解除し、リスナー一覧もクリアする
        if (this._cameraObserver && this._scene) {
            this._scene.onBeforeRenderObservable.remove(this._cameraObserver);
        }
        this._cameraObserver = null;
        this._cameraListeners = [];
        this._lastCameraSnapshot = null;
        this._mapTypeListeners = [];
        this._viewModeListeners = [];
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._onWindowResize) {
            window.removeEventListener("resize", this._onWindowResize);
            this._onWindowResize = null;
        }
        // マーカーマネージャを Scene dispose 前に解放する (Issue #167)。
        if (this._markerManager) {
            try {
                this._markerManager.dispose();
            } catch (err) {
                console.error("[JpmapTerrain] markerManager.dispose threw:", err);
            }
            this._markerManager = null;
        }
        // ポリゴンマネージャも Scene dispose 前に解放する (Issue #170)。
        if (this._polygonManager) {
            try {
                this._polygonManager.dispose();
            } catch (err) {
                console.error("[JpmapTerrain] polygonManager.dispose threw:", err);
            }
            this._polygonManager = null;
        }
        // controlPanel が body に追加した UI 要素を Scene dispose 前に除去する。
        if (this._controller) {
            try {
                this._controller.dispose();
            } catch {
                // UI 除去の失敗は致命的ではないため握りつぶす
            }
        }
        this._controller = null;
        if (this._scene) {
            this._scene.dispose();
            this._scene = null;
        }
        if (this._engine) {
            this._engine.dispose();
            this._engine = null;
        }
        if (this._canvas && this._canvas.parentElement === this.mountElement) {
            this.mountElement.removeChild(this._canvas);
        }
        this._canvas = null;
    }

    /**
     * リサイズを通知し Engine を再計測する (T7 / Issue #121)。
     *
     * 内部は `ResizeObserver` で自動追従しているため、通常は手動呼び出し不要。
     * レイアウトをスクリプトから一気に変更した場合などに明示的に呼ぶ。
     */
    public resize(): void {
        if (this._engine) {
            this._engine.resize();
        }
    }
}
