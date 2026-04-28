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
    /** フォントサイズ(px)。default 18 */
    fontSize?: number;
    /** CSS color。default "#000000" */
    color?: string;
    /** 背景色。default "transparent"（透明）。CSS color を指定可 */
    backgroundColor?: string;
    /** 行高倍率。default 1.2 */
    lineHeight?: number;
}

export interface MarkerIconOptions {
    /** 画像URL。`javascript:` / `vbscript:` 等は拒否 */
    url: string;
    /** 表示幅(world meters)。default 40 */
    width?: number;
    /** 表示高(world meters)。default 40 */
    height?: number;
}

export interface MarkerLineOptions {
    /**
     * 線色 CSS。default "#000000"。
     * Canvas `fillStyle` に直接代入されるため CSS で許容される表記
     * （`#RRGGBB` / `rgb(...)` / `red` 等）が利用可能。
     */
    color?: string;
    /** 線幅(world meters)。default 4 */
    width?: number;
    /**
     * 線の長さ (m)。default 500。
     * 実装はカメラ距離・仰角に応じた動的高さを優先採用するため、
     * 通常はカメラ距離が解決できないテスト/フォールバック時の参考値となる
     * （`spec/package.md §3.3.7` 参照）。
     */
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

// ---- ポリゴン (Issue #169 / #170) ----

/**
 * ポリゴン頂点の Y 値解決方法。
 * - `terrain` (default): タイル標高に追従する。1 点でも未解決の場合はポリゴン全体を非表示にする。
 * - `absolute`: `altitude` (m) を絶対高度として使用する。`altitude` 未指定の点があれば throw する。
 */
export type AltitudeMode = "terrain" | "absolute";

/**
 * ポリゴンを構成する 1 頂点。
 */
export interface PolygonPointOptions {
    /** 緯度 (度) */
    lat: number;
    /** 経度 (度) */
    lon: number;
    /**
     * 高度 (m)。
     * - `altitudeMode === "absolute"` のとき必須。海抜高度として Y に直接採用する。
     * - `altitudeMode === "terrain"` のとき任意。指定値は地表標高への加算オフセット (m)。未指定時は 0。
     */
    altitude?: number;
}

/**
 * ポリゴン全体のスタイル（spec/package.md §3.3.8.1）。
 *
 * - `lineColor` / `lineWidth` / `lineOpacity` / `pointColor` / `pointDiameter` / `pointOpacity` は #170 で適用。
 * - `dropLine*` / `label*` は #171 で適用予定。`#170` では型予約のみ（既定値で埋めるが描画には未使用）。
 * - `wallColor` / `wallOpacity` は #172 で適用予定。
 */
export interface PolygonStyleOptions {
    /** 線色 CSS。default `#ff0000` */
    lineColor?: string;
    /** 線描画に用いる Tube の半径 (m, world)。default 2 */
    lineWidth?: number;
    /** 線の不透明度 [0,1]。default 1 */
    lineOpacity?: number;
    /** 球の色 CSS。default `#ff0000` */
    pointColor?: string;
    /** 球の直径 (m, world、distScale 適用前)。default 20 */
    pointDiameter?: number;
    /** 球の不透明度 [0,1]。default 1 */
    pointOpacity?: number;
    /** 垂線の色 CSS（#171 で適用）。 */
    dropLineColor?: string;
    /** 垂線の太さ (m, world)（#171 で適用）。 */
    dropLineWidth?: number;
    /** 垂線の不透明度 [0,1]（#171 で適用）。 */
    dropLineOpacity?: number;
    /** ラベル文字色 CSS（#171 で適用）。 */
    labelColor?: string;
    /** ラベル背景色 CSS（#171 で適用）。 */
    labelBackgroundColor?: string;
    /** ラベル文字サイズ (px)（#171 で適用）。 */
    labelFontSize?: number;
    /** 壁の色 CSS（#172 で適用）。 */
    wallColor?: string;
    /** 壁の不透明度 [0,1]（#172 で適用）。 */
    wallOpacity?: number;
}

/**
 * ポリゴン追加オプション。
 */
export interface PolygonOptions {
    /** 頂点列。最低 2 点。 */
    points: readonly PolygonPointOptions[];
    /**
     * `true` の場合、最後の頂点と最初の頂点を結ぶ線を 1 本追加する（#170）。
     * 面塗りなどは #172 で実装する。default false
     */
    closed?: boolean;
    /** 高度モード。default `"terrain"` */
    altitudeMode?: AltitudeMode;
    /**
     * ラベル（点ごと）。`points[i]` に対応する文字列を `labels[i]` で渡す。
     * `#171` で描画予定。`#170` では受け取るが描画はしない。
     */
    labels?: ReadonlyArray<string>;
    /** スタイル */
    style?: PolygonStyleOptions;
    /** default true */
    enabled?: boolean;
}

/**
 * `JpmapTerrain.updatePolygon`（#173 で公開予定）の部分更新型。
 * `#170` では `PolygonManager` 内部実装でのみ使用する。
 */
export type PolygonUpdate = Partial<
    Pick<
        PolygonOptions,
        | "points"
        | "closed"
        | "altitudeMode"
        | "labels"
        | "style"
        | "enabled"
    >
>;

/**
 * `JpmapTerrain.addPolygon` / `getPolygon` の戻り値（read-only スナップショット）。
 */
export interface PolygonHandle {
    readonly id: string;
    readonly points: readonly Readonly<PolygonPointOptions>[];
    readonly closed: boolean;
    readonly altitudeMode: AltitudeMode;
    readonly labels: ReadonlyArray<string> | undefined;
    readonly style: Readonly<Required<PolygonStyleOptions>>;
    readonly enabled: boolean;
    /**
     * `terrain` モード時、全頂点の標高が解決済みなら true。
     * `absolute` モード時は常に true。
     */
    readonly elevationResolved: boolean;
}

/**
 * ポリゴンの既定値（spec/package.md §3.3.8.1）。
 *
 * `style` は仕様書記載の #170 範囲既定値（`#ff0000` / 直径 20m / 線幅 2m / opacity 1）を採用する。
 * `dropLine*` / `label*` / `wallColor` / `wallOpacity` は型予約のため、ハンドル `style` の
 * `Required<>` を満たすための既定値を内部的に保持するが、`#170` では描画には使用されない。
 */
export const POLYGON_DEFAULTS = {
    closed: false,
    altitudeMode: "terrain" as AltitudeMode,
    enabled: true,
    style: {
        lineColor: "#ff0000",
        lineWidth: 2,
        lineOpacity: 1,
        pointColor: "#ff0000",
        pointDiameter: 20,
        pointOpacity: 1,
        // 以下は #171 / #172 用の予約値（描画未使用）。Required<> 充足のために保持。
        dropLineColor: "#ff0000",
        dropLineWidth: 1,
        dropLineOpacity: 1,
        labelColor: "#ffffff",
        labelBackgroundColor: "#000000",
        labelFontSize: 14,
        wallColor: "#ff0000",
        wallOpacity: 0.3,
    },
} as const;
