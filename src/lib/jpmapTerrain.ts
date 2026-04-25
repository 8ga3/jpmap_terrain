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

import { DefaultScene } from "../scenes/default";
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
            });
            this._scene = scene;

            engine.runRenderLoop(() => scene.render());

            const onResize = (): void => engine.resize();
            window.addEventListener("resize", onResize);
            this._onWindowResize = onResize;
        } catch (error) {
            // 部分的に確保済みのリソースを解放してから再 throw
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
        return this._lat;
    }
    public set lat(value: number) {
        this._lat = value;
        // T5 (#119) で camera target に反映する。
    }

    public get lon(): number {
        return this._lon;
    }
    public set lon(value: number) {
        this._lon = value;
    }

    public get altitude(): number {
        return this._altitude;
    }
    public set altitude(value: number) {
        this._altitude = value;
    }

    public get azimuth(): number {
        return this._azimuth;
    }
    public set azimuth(value: number) {
        this._azimuth = value;
    }

    public get tilt(): number {
        return this._tilt;
    }
    public set tilt(value: number) {
        this._tilt = value;
    }

    /**
     * 指定座標へカメラをアニメーション付きで移動する。
     * 実体は T5 (#119) で実装する。
     */
    public async flyTo(options: FlyToOptions): Promise<void> {
        // setter 経由で更新し、将来 setter に追加される副作用（T5: カメラ反映等）を共有する。
        this.lat = options.lat;
        this.lon = options.lon;
        if (options.altitude !== undefined) this.altitude = options.altitude;
        if (options.azimuth !== undefined) this.azimuth = options.azimuth;
        if (options.tilt !== undefined) this.tilt = options.tilt;
        // T5 (#119) でアニメーション遷移を実装する。
    }

    // ---- UI 表示制御 (spec §3.3.2) ----

    public get showCompass(): boolean {
        return this._showCompass;
    }
    public set showCompass(value: boolean) {
        this._showCompass = value;
    }

    public get showZoomButtons(): boolean {
        return this._showZoomButtons;
    }
    public set showZoomButtons(value: boolean) {
        this._showZoomButtons = value;
    }

    public get showScaleBar(): boolean {
        return this._showScaleBar;
    }
    public set showScaleBar(value: boolean) {
        this._showScaleBar = value;
    }

    public get showMapToggle(): boolean {
        return this._showMapToggle;
    }
    public set showMapToggle(value: boolean) {
        this._showMapToggle = value;
    }

    public get showAttribution(): boolean {
        return this._showAttribution;
    }
    public set showAttribution(value: boolean) {
        this._showAttribution = value;
    }

    public get mapType(): MapType {
        return this._mapType;
    }
    public set mapType(value: MapType) {
        this._mapType = value;
        // T6 (#120) で地図種類切替を実装する。
    }

    // ---- ライフサイクル (spec §3.3.3) ----

    /**
     * ビューアを破棄し、マウント要素から関連 DOM を除去する。
     * 完全なクリーンアップは T7 (#121) で拡充する。
     */
    public dispose(): void {
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
        if (this._canvas && this._canvas.parentElement === this.mountElement) {
            this.mountElement.removeChild(this._canvas);
        }
        this._canvas = null;
    }

    /**
     * リサイズを通知し Engine を再計測する。
     * `ResizeObserver` 連携は T7 (#121) で拡充する。
     */
    public resize(): void {
        if (this._engine) {
            this._engine.resize();
        }
    }
}
