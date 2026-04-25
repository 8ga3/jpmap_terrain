/**
 * `JpmapTerrain` クラス骨格（T3 / Issue #117）
 *
 * spec/package.md §3 (Initial Implementation) の API シグネチャを定義する。
 * Babylon.js Scene / Engine への接続および UI 配線は後続 Issue で実装する。
 *
 * - T4 (#118): mountElement へのキャンバス・UI 配置と Scene 初期化
 * - T5 (#119): カメラ get/set / flyTo の実体
 * - T6 (#120): UI 表示 get/set / mapType 切替
 * - T7 (#121): dispose / resize の実体
 */

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
        // T4 (#118) で Scene / Engine 初期化処理を実装する。
        return instance;
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
        this._lat = options.lat;
        this._lon = options.lon;
        if (options.altitude !== undefined) this._altitude = options.altitude;
        if (options.azimuth !== undefined) this._azimuth = options.azimuth;
        if (options.tilt !== undefined) this._tilt = options.tilt;
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
     * 実体は T7 (#121) で実装する。
     */
    public dispose(): void {
        // T7 (#121) で Engine / Scene / DOM を解放する。
    }

    /**
     * リサイズを通知する。
     * 実体は T7 (#121) で実装する。
     */
    public resize(): void {
        // T7 (#121) で Engine.resize() を呼び出す。
    }
}
