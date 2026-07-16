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
 * カメラ視点モード。
 *
 * - `"3d"`: 透視投影（既定）。`tilt` が有効で、地形の起伏が立体的に見える。
 * - `"2d"`: 平行投影。`tilt = 0`（真下視点）に固定され、tilt 操作は無効化される。
 *   3D へ復帰した際は、2D 切替直前の `tilt` 値が復元される。
 */
export type ViewMode = "3d" | "2d";

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
    /**
     * 2D モード時の Google Maps 互換ズームレベル。
     * `viewMode: "2d"` と組み合わせて指定する。指定時は `altitude` より優先。
     */
    zoomLevel?: number;
    /** 地図種類 */
    mapType?: MapType;
    /**
     * カメラ視点モード。
     * - `"3d"` (既定): 透視投影。`tilt` 有効。
     * - `"2d"`: 平行投影。`tilt = 0` 固定で tilt 操作は無効。
     */
    viewMode?: ViewMode;
    /**
     * ライブラリ内蔵の 3D/2D 切替ボタンを表示するかどうか。
     * 既定 `true`。デモ側で独自の UI を用意する場合に `false` を指定する。
     */
    showViewModeButton?: boolean;
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
     * 太陽 DirectionalLight による地形への影描画を有効にする。
     * 既定は `false`（OFF）。`true` のとき `ShadowGenerator` を生成し、
     * 既存タイルおよび以後追加されるタイルメッシュを caster / receiver として登録する。
     * GPU 負荷が大きいため、必要時のみ有効化することを推奨する。
     */
    showSunShadows?: boolean;
    /**
     * ドラッグによるマップのパン（平行移動）操作を有効にするかどうか。
     * 既定 `true`。`false` を指定すると単純ドラッグでのパンを無効化し、地図中心を
     * 固定したままにできる（Ctrl/Cmd+ドラッグの回転・チルト、ホイールズームは有効のまま）。
     * 砲撃ゲームのように戦場を常に中央へ固定したいデモで使用する。
     */
    enablePan?: boolean;
    /**
     * WASD キーボードによるマップのパン操作を有効にするかどうか（globe バックエンドのみ）。
     * 既定 `true`。`false` を指定すると WASD によるカメラパンを無効化する（左ドラッグパン・
     * 回転・ズームは有効のまま）。WASD を独自操作に使うデモ（avatar-controller など）で、
     * 組み込みの WASD パンとの競合を避けるために使用する。planar では WASD パン自体が無いため無効。
     */
    enableKeyboardPan?: boolean;
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
    viewMode: "3d" as ViewMode,
    showViewModeButton: true as boolean,
    dateTime: null as Date | null,
    autoSunPosition: false as boolean,
    showSunShadows: false as boolean,
    enablePan: true as boolean,
    enableKeyboardPan: true as boolean,
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
    /**
     * 現在のカメラ視点モード。
     * `"2d"` のとき `tilt` は常に `0` を返す。
     */
    readonly viewMode: ViewMode;
    /**
     * 2D モード時の Google Maps 互換ズームレベル。
     * `viewMode === "2d"` のとき `camera.radius` から算出した値。
     * 3D モードでは `undefined`。
     */
    readonly zoomLevel?: number;
}

/** `JpmapTerrain.onCameraChange` リスナー */
export type CameraChangeListener = (event: CameraChangeEvent) => void;

/**
 * `JpmapTerrain.onMapTypeChange` リスナー。
 * `mapType` が実際に変化したタイミングのみ呼ばれる。
 */
export type MapTypeChangeListener = (mapType: MapType) => void;

/**
 * `JpmapTerrain.onViewModeChange` リスナー。
 * `viewMode` が実際に変化したタイミングのみ呼ばれる。
 */
export type ViewModeChangeListener = (viewMode: ViewMode) => void;

// ---- 地形クリック通知 ----

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

// ---- ポリゴン頂点インタラクション ----

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
 * - `lat` / `lon` / `groundAltitude` : カーソル位置の地形メッシュとの交点。
 *   地形にヒットしなかった場合は `null`。
 * - `planeLat` / `planeLon` : カーソルレイと「ドラッグ開始時の頂点高さ」
 *   を保つ水平面との交点。交点が得られないときは `null`。
 *   `altitudeMode` によらず、頂点の現在の world Y を保ちながら
 *   カーソルと同じ画面位置に頂点を追従させたいときに使用する。
 */
export interface PolygonPointDragEvent extends PolygonPointPointerEvent {
    /** カーソル位置の地形メッシュ交点の緯度（ヒットなしのとき null） */
    readonly lat: number | null;
    /** カーソル位置の地形メッシュ交点の経度（ヒットなしのとき null） */
    readonly lon: number | null;
    /** カーソル位置の地表標高 (m, ヒットなしのとき null) */
    readonly groundAltitude: number | null;
    /**
     * ドラッグ開始時の頂点高さを保つ水平面とカーソルレイの交点の緯度。
     * 交点が得られない（カメラが面と平行等）場合は `null`。
     */
    readonly planeLat: number | null;
    /**
     * ドラッグ開始時の頂点高さを保つ水平面とカーソルレイの交点の経度。
     * 交点が得られない場合は `null`。
     */
    readonly planeLon: number | null;
    /**
     * ドラッグ開始時の頂点 (x, z) を通る垂直線とカーソルレイの
     * 最近接点の world Y。高度編集時にポイントをカーソル位置に
     * 追従させるために使用する。交点が得られない（カメラがほぼ
     * 真上 / 真下を向いている）場合は `null`。
     */
    readonly pointerAltitude: number | null;
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

// ---- マーカー ----

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

// ---- ポリゴン ----

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
 * - `lineColor` / `lineWidth` / `lineOpacity` / `pointColor` / `pointDiameter` / `pointOpacity` は適用される。
 * - `dropLine*` / `label*` は適用される。
 * - `wallColor` / `wallOpacity` は適用予定。
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
    /** 壁の色 CSS。default `#ff0000` */
    wallColor?: string;
    /** 壁の不透明度 [0,1]。default 0.3 */
    wallOpacity?: number;
}

/**
 * ポリゴン追加オプション。
 */
export interface PolygonOptions {
    /** 頂点列。最低 1 点。1 点のみのときは点・垂線・点ラベルのみ描画され、線・壁・辺ラベルは存在しない。 */
    points: readonly PolygonPointOptions[];
    /**
     * `true` の場合、最後の頂点と最初の頂点を結ぶ線を 1 本追加する。
     * 面塗りなどは今後実装予定。default false
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
     * 値が `undefined` または `length` 範囲外の辺にはラベルを描画しない。
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
    /** 隣接垂線間をつなぐ「壁」の表示 ON/OFF。default true */
    wallsEnabled?: boolean;
}

/**
 * 点単位の部分更新型。
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
 * `JpmapTerrain.updatePolygon`（で公開予定）の部分更新型。
 * `` では `PolygonManager` 内部実装でのみ使用する。
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
     * 辺ラベル。一度でも `edgeLabels` を指定された場合は
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
    /** 壁の表示状態 */
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
 * `wallColor` / `wallOpacity` は適用予定（型予約）。
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
        // 以下は予約値（描画未使用）。Required<> 充足のために保持。
        wallColor: "#ff0000",
        wallOpacity: 0.3,
    },
} as const;

/**
 * `PolygonStyleOptions` の未指定項目を `POLYGON_DEFAULTS.style` で補完する。
 * `globeSceneController.ts` / `globePolygonManager.ts` の双方から利用する共通ヘルパー。
 */
export const resolvePolygonStyle = (
    style: PolygonStyleOptions | undefined,
): Required<PolygonStyleOptions> => ({
    lineColor: style?.lineColor ?? POLYGON_DEFAULTS.style.lineColor,
    lineWidth: style?.lineWidth ?? POLYGON_DEFAULTS.style.lineWidth,
    lineOpacity: style?.lineOpacity ?? POLYGON_DEFAULTS.style.lineOpacity,
    pointDiameter: style?.pointDiameter ?? POLYGON_DEFAULTS.style.pointDiameter,
    pointColor: style?.pointColor ?? POLYGON_DEFAULTS.style.pointColor,
    pointOpacity: style?.pointOpacity ?? POLYGON_DEFAULTS.style.pointOpacity,
    dropLineColor: style?.dropLineColor ?? POLYGON_DEFAULTS.style.dropLineColor,
    dropLineWidth: style?.dropLineWidth ?? POLYGON_DEFAULTS.style.dropLineWidth,
    dropLineOpacity: style?.dropLineOpacity ?? POLYGON_DEFAULTS.style.dropLineOpacity,
    labelColor: style?.labelColor ?? POLYGON_DEFAULTS.style.labelColor,
    labelBackgroundColor:
        style?.labelBackgroundColor ?? POLYGON_DEFAULTS.style.labelBackgroundColor,
    labelFontSize: style?.labelFontSize ?? POLYGON_DEFAULTS.style.labelFontSize,
    wallColor: style?.wallColor ?? POLYGON_DEFAULTS.style.wallColor,
    wallOpacity: style?.wallOpacity ?? POLYGON_DEFAULTS.style.wallOpacity,
});

// ---- 円 ----

/**
 * 円の中心点。
 *
 * - `lat` / `lon` (度) は JAPAN_BOUNDS 内の値である必要がある。
 * - `altitude` (m) は `altitudeMode === "absolute"` のとき必須（海抜高度）。
 *   `altitudeMode === "terrain"` のときは任意で、地表標高への加算オフセット (m)。未指定時は 0。
 */
export interface CircleCenterOptions {
    /** 緯度 (度) */
    lat: number;
    /** 経度 (度) */
    lon: number;
    /** 高度 (m)。absolute 時必須、terrain 時は任意（地表 + altitude） */
    altitude?: number;
}

/**
 * 円のスタイル。
 *
 * 中心点・円周・壁・中心ラベルの色 / 太さ / 不透明度 / フォントを指定する。
 * すべて任意指定で、未指定時は {@link CIRCLE_DEFAULTS} の値が適用される。
 */
export interface CircleStyleOptions {
    /** 中心点の色 CSS。default `#ff0000` */
    pointColor?: string;
    /** 中心点（球）の直径 (m, world、distScale 適用前)。default 20 */
    pointDiameter?: number;
    /** 中心点の不透明度 [0,1]。default 1 */
    pointOpacity?: number;
    /** 円周線の色 CSS。default `#ff0000` */
    lineColor?: string;
    /** 円周線の Tube 半径 (m, world)。default 2 */
    lineWidth?: number;
    /** 円周線の不透明度 [0,1]。default 1 */
    lineOpacity?: number;
    /** 壁の色 CSS。default `#ff0000` */
    wallColor?: string;
    /** 壁の不透明度 [0,1]。default 0.3 */
    wallOpacity?: number;
    /** 中心ラベルの文字色 CSS。default `#000000` */
    labelColor?: string;
    /** 中心ラベルの背景色 CSS。default `"transparent"` */
    labelBackgroundColor?: string;
    /** 中心ラベルの文字サイズ (px)。default 14 */
    labelFontSize?: number;
}

/**
 * 円追加オプション。
 *
 * - `radius` は world m。`> 0` かつ {@link CIRCLE_RADIUS_MAX_M} 以下である必要がある。
 * - `segments` は円周分割数。`[CIRCLE_SEGMENTS_MIN, CIRCLE_SEGMENTS_MAX]` の範囲内である必要がある。
 * - `label` は中心点に表示するラベル文言。未指定時は `lat / lon / altitude / radius` の 4 行を自動生成。
 *   明示的に `null` を指定するとラベルを非表示にする。
 */
export interface CircleOptions {
    /** 中心点 */
    center: CircleCenterOptions;
    /** 半径 (m, world)。> 0 かつ {@link CIRCLE_RADIUS_MAX_M} 以下 */
    radius: number;
    /** 円周分割数。default {@link CIRCLE_DEFAULTS.segments} */
    segments?: number;
    /** 高度モード。default `"terrain"` */
    altitudeMode?: AltitudeMode;
    /**
     * 中心ラベル文言。
     * - `undefined` (既定): `lat / lon / altitude / radius` の 4 行を自動生成。
     * - `string`: 明示的にラベル文字列を指定（`\n` で改行）。
     * - `null`: ラベルを非表示にする。
     */
    label?: string | null;
    /** スタイル */
    style?: CircleStyleOptions;
    /** 円全体の表示 ON/OFF。default true */
    enabled?: boolean;
    /** 中心点の表示 ON/OFF。default true */
    pointEnabled?: boolean;
    /** 円周線の表示 ON/OFF。default true */
    lineEnabled?: boolean;
    /** 壁の表示 ON/OFF。default true */
    wallEnabled?: boolean;
    /** 中心ラベルの表示 ON/OFF。default true */
    labelEnabled?: boolean;
}

/**
 * `JpmapTerrain.updateCircle`の部分更新型。
 *
 * partial 未指定フィールドは現状維持される。
 * `segments` 変更時のみ円周 Tube / 壁 Ribbon を dispose+再生成する。
 */
export type CircleUpdate = Partial<
    Pick<
        CircleOptions,
        | "center"
        | "radius"
        | "segments"
        | "altitudeMode"
        | "label"
        | "style"
        | "enabled"
        | "pointEnabled"
        | "lineEnabled"
        | "wallEnabled"
        | "labelEnabled"
    >
>;

/**
 * `JpmapTerrain.addCircle` / `getCircle` / `updateCircle` の戻り値。
 * read-only スナップショットで、ハンドル経由で現在状態を確認できる。
 */
export interface CircleHandle {
    readonly id: string;
    readonly center: Readonly<CircleCenterOptions>;
    readonly radius: number;
    readonly segments: number;
    readonly altitudeMode: AltitudeMode;
    /**
     * 中心ラベルの現在値。
     * - `null`: 非表示。
     * - `string`: 表示中の文字列（自動生成 / カスタム指定 のいずれか）。
     */
    readonly label: string | null;
    readonly style: Readonly<Required<CircleStyleOptions>>;
    readonly enabled: boolean;
    readonly pointEnabled: boolean;
    readonly lineEnabled: boolean;
    readonly wallEnabled: boolean;
    readonly labelEnabled: boolean;
    /**
     * `terrain` モード時、中心点の地表標高が解決済みなら true。
     * 円は平面円として描画されるため、中心の標高のみが必要。
     * `absolute` モード時は常に true。
     */
    readonly elevationResolved: boolean;
}

/** 円周分割数の下限 */
export const CIRCLE_SEGMENTS_MIN = 8;
/** 円周分割数の上限 */
export const CIRCLE_SEGMENTS_MAX = 512;
/** 円半径の上限 (m, world)。100 km */
export const CIRCLE_RADIUS_MAX_M = 100_000;

/**
 * 円の既定値。
 *
 * `style` は Polygon の既定値と同一の配色を採用する。
 */
export const CIRCLE_DEFAULTS = {
    segments: 64,
    altitudeMode: "terrain" as AltitudeMode,
    enabled: true,
    pointEnabled: true,
    lineEnabled: true,
    wallEnabled: true,
    labelEnabled: true,
    style: {
        pointColor: "#ff0000",
        pointDiameter: 20,
        pointOpacity: 1,
        lineColor: "#ff0000",
        lineWidth: 2,
        lineOpacity: 1,
        wallColor: "#ff0000",
        wallOpacity: 0.3,
        labelColor: "#000000",
        labelBackgroundColor: "transparent",
        labelFontSize: 14,
    },
} as const;

// ---- 3Dモデル ----

/**
 * 3Dモデルの3軸値（回転・スケール共通）。
 * 未指定軸はデフォルト値が適用される。
 */
export interface ModelVector3 {
    /** X 軸値 */
    x?: number;
    /** Y 軸値 */
    y?: number;
    /** Z 軸値 */
    z?: number;
}

/**
 * `JpmapTerrain.addModel` のオプション。
 *
 * Babylon.js がサポートする 3D モデルファイル (glb / gltf / obj / stl) を
 * 地形上にロードして配置する。ローダーは拡張子に応じて動的インポートされる。
 */
export interface ModelOptions {
    /** モデルファイルの URL（相対 / 絶対いずれも可） */
    url: string;
    /** 緯度 (度) */
    lat: number;
    /** 経度 (度) */
    lon: number;
    /**
     * 高度 (m)。
     * - `altitudeMode === "absolute"`: 海抜高度。必須。
     * - `altitudeMode === "terrain"`: 地表からのオフセット (m)。default 0。
     */
    altitude?: number;
    /** 高度モード。default `"terrain"` */
    altitudeMode?: AltitudeMode;
    /**
     * 回転 (度)。各軸は Euler 回転として適用される。
     * default `{ x: 0, y: 0, z: 0 }`
     */
    rotation?: ModelVector3;
    /**
     * スケール倍率。default `{ x: 1, y: 1, z: 1 }`
     */
    scaling?: ModelVector3;
    /** 表示 / 非表示。default true */
    enabled?: boolean;
    /**
     * 地表追従（重力）。default true。
     * `true` のとき毎フレーム地表標高を取得して Y 座標を追従させる。
     * `altitudeMode === "terrain"` のときのみ有効（`absolute` 時は無視）。
     */
    gravity?: boolean;
}

/**
 * `JpmapTerrain.updateModel` の部分更新型。
 *
 * 未指定フィールドは現状維持される。`url` は変更不可（モデル差替えは remove → add）。
 */
export type ModelUpdate = Partial<
    Pick<
        ModelOptions,
        | "lat"
        | "lon"
        | "altitude"
        | "altitudeMode"
        | "rotation"
        | "scaling"
        | "enabled"
        | "gravity"
    >
>;

/**
 * `JpmapTerrain.addModel` / `getModel` / `updateModel` の戻り値。
 * read-only スナップショット。
 */
export interface ModelHandle {
    readonly id: string;
    readonly url: string;
    readonly lat: number;
    readonly lon: number;
    readonly altitude: number;
    readonly altitudeMode: AltitudeMode;
    readonly rotation: Readonly<Required<ModelVector3>>;
    readonly scaling: Readonly<Required<ModelVector3>>;
    readonly enabled: boolean;
    readonly gravity: boolean;
    /**
     * モデルのロードが完了しているなら true。
     * ロード中（非同期 ImportMeshAsync 処理中）は false。
     */
    readonly loaded: boolean;
    /**
     * `terrain` モード時、地表標高が解決済みなら true。
     * `absolute` モード時は常に true。
     */
    readonly elevationResolved: boolean;
    /** モデルが持つアニメーション名の一覧。ロード前は空配列 */
    readonly animationNames: readonly string[];
}

/**
 * 3Dモデルの既定値。
 */
export const MODEL_DEFAULTS = {
    altitude: 0,
    altitudeMode: "terrain" as AltitudeMode,
    rotation: { x: 0, y: 0, z: 0 },
    scaling: { x: 1, y: 1, z: 1 },
    enabled: true,
    gravity: true,
} as const;
