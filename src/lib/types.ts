/**
 * jpmap-terrain 公開型定義
 *
 * spec/package.md §3 (Initial Implementation) に対応する型を提供する。
 */

/** 描画エンジン種別 */
export type EngineType = "webgpu" | "webgl2";

/** 地図種類 */
export type MapType = "standard" | "photo";

/**
 * `JpmapTerrain.create` 初期化オプション。
 * すべて任意指定で、未指定時は spec/package.md §3.2 のデフォルト値が適用される。
 */
export interface JpmapTerrainOptions {
    /** 描画エンジン。WebGPU 非対応時は自動で WebGL2 にフォールバックする */
    engine?: EngineType;
    /** 緯度（度） */
    lat?: number;
    /** 経度（度） */
    lon?: number;
    /** 高度（メートル） */
    altitude?: number;
    /** カメラ方位角（度） */
    azimuth?: number;
    /** カメラチルト角（度） */
    tilt?: number;
    /** 地図種類 */
    mapType?: MapType;
    /**
     * 太陽位置計算に使う日時（UTC として扱う）。
     * 未指定 / `null` の場合は内部の決定的フォールバック（{@link SUN_FALLBACK_DATETIME_ISO}）を使用する。
     * `Invalid Date` が渡された場合は `console.warn` のうえ `null` 同等に倒す（例外は投げない）。
     */
    dateTime?: Date | null;
    /**
     * `true`: 60 秒周期で実時刻に追従して内部更新する。
     * `false`（既定）: `dateTime` を固定値として使用する。
     */
    autoSunPosition?: boolean;
    /**
     * 太陽 DirectionalLight による地形への影描画を有効にする (Issue #39)。
     * 既定は `false`（OFF）。`true` のとき `ShadowGenerator` を生成し、
     * 既存タイルおよび以後追加されるタイルメッシュを caster / receiver として登録する。
     * GPU 負荷が大きいため、必要時のみ有効化することを推奨する。
     */
    showSunShadows?: boolean;
}

/**
 * `JpmapTerrain.flyTo` のオプション。
 * `lat` / `lon` は必須、その他は省略時に現在値を維持する。
 */
export interface FlyToOptions {
    /** 目的地の緯度（度） */
    lat: number;
    /** 目的地の経度（度） */
    lon: number;
    /** 目的地の高度（メートル） */
    altitude?: number;
    /** 目的地の方位角（度） */
    azimuth?: number;
    /** 目的地のチルト角（度） */
    tilt?: number;
    /** 遷移時間（ミリ秒） */
    duration?: number;
}

/**
 * spec/package.md §3.2 で定義されるデフォルト初期値（パッケージ内部用）。
 * 公開 API には含めず、`JpmapTerrain` 内部からのみ参照する。
 */
export const JPMAP_TERRAIN_DEFAULTS = {
    engine: "webgpu" as EngineType,
    lat: 35.681236,
    lon: 139.767125,
    altitude: 2000,
    azimuth: 0,
    tilt: 45,
    mapType: "standard" as MapType,
    dateTime: null as Date | null,
    autoSunPosition: false as boolean,
    showSunShadows: false as boolean,
} as const;

/**
 * `dateTime` 未指定 / `null` 時に使用する決定的フォールバック時刻（ISO 8601 + Z）。
 *
 * 夏至日本時間正午（UTC 03:00）。Skybox / ライト / 太陽メッシュが落ち着いた絵を作るため、
 * Visual Regression テストでも同じ値をクエリで明示し、機械実行時刻に依存しない描画を保証する。
 */
export const SUN_FALLBACK_DATETIME_ISO = "2025-06-21T03:00:00Z";

/**
 * `autoSunPosition === true` のとき、`new Date()` を取り直して太陽位置を再反映する周期 (ms)。
 * spec/package.md §3.3.5 に基づく 60 秒固定。テスト用に export している。
 */
export const SUN_AUTO_UPDATE_INTERVAL_MS = 60_000;

/**
 * カメラ変化通知ペイロード（spec/package.md 追記は別 Issue）。
 * `JpmapTerrain.onCameraChange` のリスナー引数。
 */
export interface CameraChangeEvent {
    readonly lat: number;
    readonly lon: number;
    readonly altitude: number;
    readonly azimuth: number;
    readonly tilt: number;
}

/** `JpmapTerrain.onCameraChange` リスナー */
export type CameraChangeListener = (event: CameraChangeEvent) => void;

/**
 * `JpmapTerrain.onMapTypeChange` リスナー (Issue #149)。
 * `mapType` が実際に変化したタイミングのみ呼ばれる。
 */
export type MapTypeChangeListener = (mapType: MapType) => void;

// ---- マーカー (Issue #167) ----

export interface MarkerTextOptions {
    /** テキスト本体。"\n" で複数行。最大 512 chars（超過は console.warn のうえ truncate） */
    value: string;
    /** フォントサイズ(px)。default 14 */
    fontSize?: number;
    /** CSS color。default "#ffffff" */
    color?: string;
    /** 背景色。default "rgba(0,0,0,0.6)"。"transparent" 可 */
    backgroundColor?: string;
    /** 行高倍率。default 1.2 */
    lineHeight?: number;
}

export interface MarkerIconOptions {
    /** 画像URL。`javascript:` / `vbscript:` 等は拒否 */
    url: string;
    /** 表示幅(world meters)。default 64 */
    width?: number;
    /** 表示高(world meters)。default 64 */
    height?: number;
}

export interface MarkerLineOptions {
    /** 線色 CSS。default "#ffffff" */
    color?: string;
    /** 線幅(world meters)。default 1.5 */
    width?: number;
    /** 線の長さ(地表からビルボード基点)。default 200 */
    height?: number;
}

export interface MarkerOptions {
    lat: number;
    lon: number;
    icon?: MarkerIconOptions;
    text?: MarkerTextOptions;
    line?: MarkerLineOptions;
    /** default true */
    enabled?: boolean;
}

export type MarkerUpdate = Partial<
    Pick<MarkerOptions, "icon" | "text" | "line" | "enabled">
> & {
    lat?: number;
    lon?: number;
};

export interface MarkerHandle {
    readonly id: string;
    readonly lat: number;
    readonly lon: number;
    readonly enabled: boolean;
    readonly icon: Readonly<MarkerIconOptions> | null;
    readonly text: Readonly<MarkerTextOptions> | null;
    readonly line: Readonly<Required<MarkerLineOptions>>;
    readonly elevationResolved: boolean;
}

export const MARKER_DEFAULTS = {
    enabled: true,
    line: { color: "#000000", width: 4, height: 500 },
    icon: { width: 40, height: 40 },
    text: {
        fontSize: 18,
        color: "#000000",
        backgroundColor: "transparent",
        lineHeight: 1.2,
    },
    textMaxLength: 512,
} as const;
