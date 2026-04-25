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
import type { Scene } from "@babylonjs/core/scene";

import { DefaultScene, type DefaultSceneController } from "../scenes/default";
import { createBabylonEngine } from "./internal/engineFactory";
import {
    FlyToOptions,
    JPMAP_TERRAIN_DEFAULTS,
    JpmapTerrainOptions,
    MapType,
} from "./types";

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

    private _showCompass = true;
    private _showZoomButtons = true;
    private _showScaleBar = true;
    private _showMapToggle = true;
    private _showAttribution = true;

    private _canvas: HTMLCanvasElement | null = null;
    private _engine: AbstractEngine | null = null;
    private _scene: Scene | null = null;
    private _onWindowResize: (() => void) | null = null;
    private _resizeObserver: ResizeObserver | null = null;
    private _disposed = false;
    private _controller: DefaultSceneController | null = null;
    /** 進行中の flyTo をキャンセルするためのトークン */
    private _flyToToken = 0;

    private constructor(mountElement: HTMLElement, options: JpmapTerrainOptions) {
        this.mountElement = mountElement;
        this._lat = options.lat ?? JPMAP_TERRAIN_DEFAULTS.lat;
        this._lon = options.lon ?? JPMAP_TERRAIN_DEFAULTS.lon;
        this._altitude = options.altitude ?? JPMAP_TERRAIN_DEFAULTS.altitude;
        this._azimuth = options.azimuth ?? JPMAP_TERRAIN_DEFAULTS.azimuth;
        this._tilt = options.tilt ?? JPMAP_TERRAIN_DEFAULTS.tilt;
        this._mapType = options.mapType ?? JPMAP_TERRAIN_DEFAULTS.mapType;
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
                urlSync: false,
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
                        "attribution",
                        this._showAttribution,
                    );
                },
            });
            this._scene = scene;

            engine.runRenderLoop(() => scene.render());

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

    // ---- ライフサイクル (spec §3.3.3) ----

    /**
     * ビューアを破棄し、`mountElement` から canvas / UI を除去する (T7 / Issue #121)。
     *
     * - 進行中の `flyTo` を中断
     * - `ResizeObserver` / `window.resize` リスナを解除
     * - Babylon.js Scene / Engine を dispose
     * - controlPanel が `document.body` に追加した UI 要素は Scene dispose 後にも残るため、
     *   `mountElement` 配下の canvas 除去に加えて onReady で取得した UI 要素もここで除去する設計は T9 で controlPanel 側に設ける。
     *
     * 冪等性: 2 回以上呼んでも例外にならず、何もしない。
     */
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        // 進行中の flyTo を中断
        this._flyToToken++;
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._onWindowResize) {
            window.removeEventListener("resize", this._onWindowResize);
            this._onWindowResize = null;
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
