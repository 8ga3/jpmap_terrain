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

// ---- 地形クリック通知 (Issue #183) ----

/**
 * `JpmapTerrain.onTerrainClick` のリスナー引数。
 *
 * 地形タイル上でマウス/タッチによる「クリック」（ドラッグ閾値未満の pointerdown→pointerup）
 * が発生したときに通知される。ドラッグ操作（カメラ操作含む）では発火しない。
 */
export interface TerrainClickEvent {
    /** クリック地点の緯度（度） */
    readonly lat: number;
    /** クリック地点の経度（度） */
    readonly lon: number;
    /** クリック地点の標高 (m, 海抜) */
    readonly altitude: number;
    /** Babylon.js ワールド座標 */
    readonly world: { readonly x: number; readonly y: number; readonly z: number };
    /** 元の `PointerEvent`（修飾キー判定等のため） */
    readonly pointerEvent: PointerEvent;
}

/** `JpmapTerrain.onTerrainClick` リスナー */
export type TerrainClickListener = (event: TerrainClickEvent) => void;

/**
 * `pointerdown` から `pointerup` までの最大移動量 (CSS px)。
 * これを超える移動はクリックではなくドラッグとみなし、`onTerrainClick` を発火しない。
 */
export const TERRAIN_CLICK_DRAG_THRESHOLD_PX = 4;

// ---- ポリゴン頂点インタラクション (Issue #184) ----

/**
 * ポリゴン頂点上のポインタイベント共通ペイロード。
 *
 * `JpmapTerrain.onPolygonPointHover` / `onPolygonPointClick` /
 * `onPolygonPointDragStart` / `onPolygonPointDrag` / `onPolygonPointDragEnd`
 * のリスナー引数として共通利用される。
 */
export interface PolygonPointPointerEvent {
    /** 対象ポリゴンの id */
    readonly polygonId: string;
    /** 対象頂点の index（0-based） */
    readonly index: number;
    /** 元の `PointerEvent`（`shiftKey` / `ctrlKey` / `button` 判定等） */
    readonly pointerEvent: PointerEvent;
}

/**
 * ポリゴン頂点ドラッグ中のペイロード。
 *
 * カーソル位置の地形メッシュとの交点に基づく lat/lon と地表標高を含む。
 * 地形にヒットしなかった場合は `lat`/`lon`/`groundAltitude` が `null`。
 */
export interface PolygonPointDragEvent extends PolygonPointPointerEvent {
    /** カーソル位置の地形メッシュ交点の緯度（ヒットなしのとき null） */
    readonly lat: number | null;
    /** カーソル位置の地形メッシュ交点の経度（ヒットなしのとき null） */
    readonly lon: number | null;
    /** カーソル位置の地表標高 (m, ヒットなしのとき null) */
    readonly groundAltitude: number | null;
}

/** `onPolygonPointHover` リスナー（hover 解除時は `null` で呼ばれる） */
export type PolygonPointHoverListener = (
    event: PolygonPointPointerEvent | null,
) => void;

/** `onPolygonPointClick` リスナー */
export type PolygonPointClickListener = (
    event: PolygonPointPointerEvent,
) => void;

/** `onPolygonPointDragStart` / `onPolygonPointDrag` / `onPolygonPointDragEnd` リスナー */
export type PolygonPointDragListener = (event: PolygonPointDragEvent) => void;

/**
 * `pointerdown` から開始し、ドラッグ判定に必要な最小移動量 (CSS px)。
 * これ未満の移動量で pointerup した場合は click 扱いとなる。
 */
export const POLYGON_POINT_DRAG_THRESHOLD_PX = 3;

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
 * - `dropLine*` / `label*` は #171 で適用。
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
    /** 垂線の色 CSS。default `#ff0000` */
    dropLineColor?: string;
    /** 垂線の太さ (m, world、Tube 半径)。default 1 */
    dropLineWidth?: number;
    /** 垂線の不透明度 [0,1]。default 1 */
    dropLineOpacity?: number;
    /** ラベル文字色 CSS。default `#000000` */
    labelColor?: string;
    /** ラベル背景色 CSS。default `"transparent"`。不透明色を指定するとラベル領域全体をその色で塗る。 */
    labelBackgroundColor?: string;
    /** ラベル文字サイズ (px)。default 14 */
    labelFontSize?: number;
    /** 壁の色 CSS (#172)。default `#ff0000` */
    wallColor?: string;
    /** 壁の不透明度 [0,1] (#172)。default 0.3 */
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
     * 値が指定された点にのみラベル平面（ビルボード + DynamicTexture）を描画する。
     */
    labels?: ReadonlyArray<string>;
    /**
     * 辺ラベル（隣接頂点間ごと）。`edgeLabels[i]` は `points[i]` → `points[i+1]` の
     * 中点に表示される。`closed === true` のときの末尾要素 `edgeLabels[points.length-1]`
     * は `points[points.length-1]` → `points[0]` のラベルとして扱う。
     * 値が `undefined` または `length` 範囲外の辺にはラベルを描画しない (#185)。
     */
    edgeLabels?: ReadonlyArray<string | undefined>;
    /** スタイル */
    style?: PolygonStyleOptions;
    /** default true */
    enabled?: boolean;
    /** 各ポイントから地表へ落とす垂線の表示 ON/OFF。default true */
    verticalsEnabled?: boolean;
    /** ポイント脇のラベルの表示 ON/OFF。default true */
    labelsEnabled?: boolean;
    /** 隣接垂線間をつなぐ「壁」の表示 ON/OFF (#172)。default true */
    wallsEnabled?: boolean;
}

/**
 * 点単位の部分更新型 (Issue #173)。
 *
 * - `lat` / `lon` / `altitude` / `label` のいずれか（複数可）を指定可能。
 * - `label` に `null` を渡した場合、当該 index のラベル（メッシュ）を削除する。
 * - `altitudeMode` はポリゴン全体の属性のため partial には含めない。
 */
export interface PolygonPointPartial {
    readonly lat?: number;
    readonly lon?: number;
    readonly altitude?: number;
    readonly label?: string | null;
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
        | "edgeLabels"
        | "style"
        | "enabled"
        | "verticalsEnabled"
        | "labelsEnabled"
        | "wallsEnabled"
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
    readonly labels: ReadonlyArray<string | undefined> | undefined;
    /**
     * 辺ラベル（#185）。一度でも `edgeLabels` を指定された場合は
     * `points` と整合する長さ（`closed ? N : N-1`）の配列を返し、
     * 未指定要素は `undefined`。一度も指定されていない場合は `undefined`。
     */
    readonly edgeLabels: ReadonlyArray<string | undefined> | undefined;
    readonly style: Readonly<Required<PolygonStyleOptions>>;
    readonly enabled: boolean;
    /** 垂線の表示状態 */
    readonly verticalsEnabled: boolean;
    /** ラベルの表示状態 */
    readonly labelsEnabled: boolean;
    /** 壁の表示状態 (#172) */
    readonly wallsEnabled: boolean;
    /**
     * `terrain` モード時、全頂点の標高が解決済みなら true。
     * `absolute` モード時は常に true。
     */
    readonly elevationResolved: boolean;
}

/**
 * ポリゴンの既定値（spec/package.md §3.3.8.1）。
 *
 * `style` は仕様書記載の既定値を採用する。
 * `wallColor` / `wallOpacity` は #172 で適用予定（型予約）。
 */
export const POLYGON_DEFAULTS = {
    closed: false,
    altitudeMode: "terrain" as AltitudeMode,
    enabled: true,
    verticalsEnabled: true,
    labelsEnabled: true,
    wallsEnabled: true,
    style: {
        lineColor: "#ff0000",
        lineWidth: 2,
        lineOpacity: 1,
        pointColor: "#ff0000",
        pointDiameter: 20,
        pointOpacity: 1,
        dropLineColor: "#ff0000",
        dropLineWidth: 1,
        dropLineOpacity: 1,
        labelColor: "#000000",
        labelBackgroundColor: "transparent",
        labelFontSize: 14,
        // 以下は #172 用の予約値（描画未使用）。Required<> 充足のために保持。
        wallColor: "#ff0000",
        wallOpacity: 0.3,
    },
} as const;
