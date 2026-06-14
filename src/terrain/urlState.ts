/** URL に緯度・経度・カメラ姿勢を埋め込み / 復元するモジュール (Issue #64) */

import { clamp, JAPAN_BOUNDS } from "./gsiTile";
import { JPMAP_TERRAIN_DEFAULTS } from "../lib/types";
import type { MapType, ViewMode, TerrainEngine } from "../lib/types";

export interface LatLon {
    lat: number;
    lon: number;
}

/**
 * globe バックエンド用の緯度経度クランプ範囲（全球）。
 * planar は日本被覆域（{@link JAPAN_BOUNDS}）のみ描画するためクランプするが、
 * globe（GeospatialCamera）は地球全体を描画できるため全球を許容する (#375)。
 */
export const WORLD_BOUNDS = { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 } as const;

/**
 * terrainEngine に応じた緯度経度クランプ範囲を返す (#375)。
 * - `globe` → {@link WORLD_BOUNDS}（全球）
 * - それ以外（planar / 未指定）→ {@link JAPAN_BOUNDS}（日本被覆域）
 */
const resolveLatLonBounds = (
    terrainEngine?: TerrainEngine,
): typeof JAPAN_BOUNDS | typeof WORLD_BOUNDS =>
    terrainEngine === "globe" ? WORLD_BOUNDS : JAPAN_BOUNDS;

/** カメラ姿勢を含む URL 状態 (Issue #64) */
export interface CameraUrlState extends LatLon {
    altitude: number;
    azimuth: number;
    tilt: number;
    /**
     * 2D モード時の Google Maps 互換ズームレベル (#254)。
     * 定義されている場合、`toAtPath` は `@lat,lon,Xz` 形式で出力し
     * altitude / azimuth / tilt は URL に含めない。
     */
    zoomLevel?: number;
}

const PRECISION = 6;
const AZIMUTH_TILT_PRECISION = 2;

/** tilt のクランプ最小値 (rad)。視野が水平に潰れないよう微小値を確保する。 */
const TILT_MIN_RAD = 0.1;
/** tilt のクランプ最小値 (deg)。{@link TILT_MIN_RAD} を度に変換した値（≒ 5.7295779513°）。 */
const TILT_MIN_DEG = (TILT_MIN_RAD * 180) / Math.PI;

/**
 * WGS84 楕円体の長半径 (m)。`@babylonjs/core` の `Wgs84Ellipsoid.semiMajorAxis` と同値。
 * 本モジュールを Babylon 非依存（jest を軽く保つ）に保つため数値として定義する。
 */
const WGS84_SEMI_MAJOR_AXIS_M = 6_378_137;

/** GeospatialCamera 既定 `radiusMax` の planetRadius 倍率（planetRadius × 4）。 */
const GLOBE_MAX_RADIUS_SCALE = 4;

/**
 * altitude のクランプ上限 (m)。
 * globe（GeospatialCamera）バックエンドはカメラの `radius` を altitude として URL に書き出す。
 * GeospatialCamera の既定 `radiusMax` は planetRadius × 4（= {@link WGS84_SEMI_MAJOR_AXIS_M} ×
 * {@link GLOBE_MAX_RADIUS_SCALE} = 25,512,548m）であり、高高度（全球視点）でもクランプで丸めない
 * よう上限をこの値に合わせる (#369)。planar では camera.position.y が upperRadiusLimit（75km）で
 * 自前クランプされるため、本上限の引き上げは planar の URL 復元挙動に影響しない
 * （planar 由来の値は最大でも ≈ 78776m）。
 */
const ALTITUDE_MAX = WGS84_SEMI_MAJOR_AXIS_M * GLOBE_MAX_RADIUS_SCALE;

/**
 * altitude / tilt のクランプ範囲。
 * - altitude: [50, {@link ALTITUDE_MAX}] (m)。上限は globe の最大 radius に合わせる (#369)。
 * - tilt: [{@link TILT_MIN_DEG}, 75]（deg）。下限は {@link TILT_MIN_RAD} rad を度換算した値
 */
export const CAMERA_URL_LIMITS = {
    altitude: { min: 50, max: ALTITUDE_MAX },
    tilt: { min: TILT_MIN_DEG, max: 75 },
    zoomLevel: { min: 5, max: 23 },
} as const;

/** ズームレベルの表示精度（小数桁数） */
const ZOOM_LEVEL_PRECISION = 2;

/**
 * `?terrainEngine=` クエリ文字列から地形バックエンドを解決する (#275 Phase 4 / P4-1)。
 * 各デモ（viewer / polygon 等）で共通利用するため本モジュールに集約する。
 * - `globe` → `"globe"`（GeospatialCamera + ECEF の地球儀バックエンド）
 * - `planar` → `"planar"`（従来の平面シーン）
 * - 上記以外 / 未指定 → `undefined`（lib 既定の `"planar"` にフォールバック）
 *
 * @param search `location.search` 等のクエリ文字列（先頭 `?` 任意）
 */
export const resolveTerrainEngine = (
    search: string,
): TerrainEngine | undefined => {
    const value = new URLSearchParams(search).get("terrainEngine");
    if (value === "globe") return "globe";
    if (value === "planar") return "planar";
    return undefined;
};

/**
 * Web Mercator の赤道上 zoom 0 における 1 ピクセルあたりメートル。
 * `2π × 6378137 / 256 ≈ 156543.03392804097`
 */
const EQUATOR_MPP = 156543.03392804097;

/**
 * `camera.radius` → Google Maps 互換ズームレベルへ変換する (#254)。
 *
 * Web Mercator の定義に基づく:
 *   mpp = EQUATOR_MPP × cos(φ) / 2^z
 *   visibleHeight = 2 × radius × tan(fov / 2)
 *   z = log₂(canvasHeight × EQUATOR_MPP × cos(φ) / (2 × radius × tan(fov / 2)))
 */
export const radiusToZoomLevel = (
    radius: number,
    canvasHeight: number,
    latDeg: number,
    fovRad: number,
): number => {
    const cosLat = Math.cos((latDeg * Math.PI) / 180);
    const tanHalfFov = Math.tan(fovRad / 2);
    return Math.log2(
        (canvasHeight * EQUATOR_MPP * cosLat) / (2 * radius * tanHalfFov),
    );
};

/**
 * Google Maps 互換ズームレベル → `camera.radius` へ変換する (#254)。
 * {@link radiusToZoomLevel} の逆関数。
 */
export const zoomLevelToRadius = (
    z: number,
    canvasHeight: number,
    latDeg: number,
    fovRad: number,
): number => {
    const cosLat = Math.cos((latDeg * Math.PI) / 180);
    const tanHalfFov = Math.tan(fovRad / 2);
    return (canvasHeight * EQUATOR_MPP * cosLat) / (2 ** z * 2 * tanHalfFov);
};

/**
 * URL に欠損トークンがあった場合の補完値。
 * spec/package.md §3.2 と同値であり、{@link JPMAP_TERRAIN_DEFAULTS} から派生させて二重定義を避ける。
 */
export const CAMERA_URL_DEFAULTS = {
    altitude: JPMAP_TERRAIN_DEFAULTS.altitude,
    azimuth: JPMAP_TERRAIN_DEFAULTS.azimuth,
    tilt: JPMAP_TERRAIN_DEFAULTS.tilt,
} as const;

/**
 * @lat,lon[,altitude_or_zoomz,azimuth,tilt] パターン。
 * 2〜5 トークンに対応し、欠損トークンはパース後にデフォルト補完する。
 * 3 番目のトークンが `z` で終わる場合（例: `14.50z`）はズームレベルとして解釈する (#254)。
 */
const AT_PATTERN =
    /@(-?\d+\.?\d*),(-?\d+\.?\d*)(?:,(-?\d+\.?\d*z?))?(?:,(-?\d+\.?\d*))?(?:,(-?\d+\.?\d*))?/;

/** altitude を [50, {@link ALTITUDE_MAX}] にクランプし整数化する */
export const clampAltitude = (v: number): number => {
    const c = clamp(v, CAMERA_URL_LIMITS.altitude.min, CAMERA_URL_LIMITS.altitude.max);
    return Math.round(c);
};

/** ズームレベルを [5, 23] にクランプする */
export const clampZoomLevel = (v: number): number =>
    clamp(v, CAMERA_URL_LIMITS.zoomLevel.min, CAMERA_URL_LIMITS.zoomLevel.max);

/** tilt を [TILT_MIN_DEG, 75]（deg）にクランプする */
export const clampTilt = (v: number): number =>
    clamp(v, CAMERA_URL_LIMITS.tilt.min, CAMERA_URL_LIMITS.tilt.max);

/** azimuth を [0, 360) に正規化する。NaN は 0 に倒す */
export const normalizeAzimuth = (v: number): number => {
    if (!isFinite(v)) return 0;
    return ((v % 360) + 360) % 360;
};

const pickFinite = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return isFinite(n) ? n : fallback;
};

/**
 * URL からカメラ姿勢を含む状態を読み取る。優先順位:
 * 1. パス / ハッシュ内の `@lat,lon[,altitude_or_zoomz,azimuth,tilt]`
 * 2. クエリパラメータ `?lat=&lon=`（altitude/azimuth/tilt はデフォルト補完）
 * いずれも無い場合は null を返す。
 *
 * 3 番目のトークンが `z` で終わる場合（例: `14.50z`）は Google Maps 互換の
 * ズームレベルとして解釈し、`zoomLevel` フィールドに格納する (#254)。
 *
 * `options.terrainEngine` が `"globe"` の場合、緯度経度を {@link WORLD_BOUNDS}（全球）で
 * クランプする。未指定 / `"planar"` の場合は従来どおり {@link JAPAN_BOUNDS} でクランプする (#375)。
 * `options` 未指定時は URL クエリ `?terrainEngine=` をフォールバックとして解決するため、
 * 呼び出し側が options を渡さなくても globe URL を1本で正しく復元できる (#375)。
 */
export const parseCameraStateFromUrl = (
    url: string,
    options?: { terrainEngine?: TerrainEngine },
): CameraUrlState | null => {
    try {
        const parsed = new URL(url, "http://localhost");

        // options 未指定時は URL クエリ `?terrainEngine=` をフォールバック解決する (#375)。
        // これにより呼び出し側が options を渡し忘れても URL 1本で globe 復元できる。
        const terrainEngine =
            options?.terrainEngine ?? resolveTerrainEngine(parsed.search);
        const bounds = resolveLatLonBounds(terrainEngine);

        // pathname + hash のみに @lat,lon を適用（userinfo やクエリ値の @ を誤検出しない）
        const target = parsed.pathname + parsed.hash;
        const atMatch = target.match(AT_PATTERN);
        if (atMatch) {
            const lat = Number(atMatch[1]);
            const lon = Number(atMatch[2]);
            if (isFinite(lat) && isFinite(lon)) {
                const clampedLat = clamp(lat, bounds.minLat, bounds.maxLat);
                const clampedLon = clamp(lon, bounds.minLon, bounds.maxLon);

                const rawThird = atMatch[3];
                if (rawThird !== undefined && rawThird.endsWith("z")) {
                    // ズームレベル形式: @lat,lon,14.50z (#254)
                    const z = Number(rawThird.slice(0, -1));
                    if (isFinite(z)) {
                        return {
                            lat: clampedLat,
                            lon: clampedLon,
                            altitude: clampAltitude(CAMERA_URL_DEFAULTS.altitude),
                            azimuth: normalizeAzimuth(CAMERA_URL_DEFAULTS.azimuth),
                            tilt: clampTilt(CAMERA_URL_DEFAULTS.tilt),
                            zoomLevel: clampZoomLevel(z),
                        };
                    }
                }

                const altitude = pickFinite(rawThird, CAMERA_URL_DEFAULTS.altitude);
                const azimuth = pickFinite(atMatch[4], CAMERA_URL_DEFAULTS.azimuth);
                const tilt = pickFinite(atMatch[5], CAMERA_URL_DEFAULTS.tilt);
                return {
                    lat: clampedLat,
                    lon: clampedLon,
                    altitude: clampAltitude(altitude),
                    azimuth: normalizeAzimuth(azimuth),
                    tilt: clampTilt(tilt),
                };
            }
        }

        // クエリパラメータ: ?lat=&lon=
        const latStr = parsed.searchParams.get("lat");
        const lonStr = parsed.searchParams.get("lon");
        if (latStr !== null && lonStr !== null) {
            const lat = Number(latStr);
            const lon = Number(lonStr);
            if (isFinite(lat) && isFinite(lon)) {
                return {
                    lat: clamp(lat, bounds.minLat, bounds.maxLat),
                    lon: clamp(lon, bounds.minLon, bounds.maxLon),
                    altitude: clampAltitude(CAMERA_URL_DEFAULTS.altitude),
                    azimuth: normalizeAzimuth(CAMERA_URL_DEFAULTS.azimuth),
                    tilt: clampTilt(CAMERA_URL_DEFAULTS.tilt),
                };
            }
        }
    } catch {
        // URL 解析失敗時は無視
    }

    return null;
};

/**
 * URL から緯度・経度のみを読み取る薄いラッパ（後方互換用）。
 * 内部は {@link parseCameraStateFromUrl} を再利用する。
 *
 * @deprecated 新規コードでは {@link parseCameraStateFromUrl} を使用してください。
 */
export const parseLatLonFromUrl = (
    url: string,
    options?: { terrainEngine?: TerrainEngine },
): LatLon | null => {
    const state = parseCameraStateFromUrl(url, options);
    if (state === null) return null;
    return { lat: state.lat, lon: state.lon };
};

/**
 * 現在の pathname から `@lat,lon,...` セグメント以降を取り除き、
 * デモを識別するプレフィクス（例: `''`, `/viewer`, `/timelapse`）を返す (Issue #155)。
 *
 * - 末尾の `.html` は剥がして拡張子なしに正規化する。
 * - 末尾スラッシュは取り除く（`/` は `''` を返す）。
 * - 想定外の深いパス（`/foo/bar`）はそのまま返し、呼び出し元で `${prefix}@...` を構築する。
 */
export const extractDemoPathPrefix = (pathname: string): string => {
    const atIndex = pathname.indexOf("@");
    let base = atIndex >= 0 ? pathname.slice(0, atIndex) : pathname;
    // 末尾スラッシュを除去（`/` は空文字に倒す）
    if (base.endsWith("/")) {
        base = base.slice(0, -1);
    }
    // 末尾 `.html` を剥がす
    if (base.endsWith(".html")) {
        base = base.slice(0, -".html".length);
    }
    return base;
};

/**
 * パスセグメント文字列を生成する。
 * - 数値2引数: `/@lat,lon`（2要素）
 * - 状態オブジェクト: altitude/azimuth/tilt のいずれかが定義されていれば 5要素、
 *   全て未定義なら 2要素を返す。
 *
 * `prefix` を渡すと `${prefix}/@lat,lon,...` 形式になる (Issue #155)。
 * 例: `prefix="/viewer"` → `/viewer/@lat,lon,...`（Google Maps 互換のフォーマット）
 * `prefix=""` のときは `/@lat,lon,...`。
 */
export function toAtPath(lat: number, lon: number, prefix?: string): string;
export function toAtPath(
    state: Partial<CameraUrlState> & LatLon,
    prefix?: string,
): string;
export function toAtPath(
    a: number | (Partial<CameraUrlState> & LatLon),
    b?: number | string,
    c?: string,
): string {
    const buildHead = (prefix: string): string => `${prefix}/@`;
    if (typeof a === "number" && typeof b === "number") {
        const prefix = c ?? "";
        return `${buildHead(prefix)}${a.toFixed(PRECISION)},${b.toFixed(PRECISION)}`;
    }
    const state = a as Partial<CameraUrlState> & LatLon;
    const prefix = (typeof b === "string" ? b : undefined) ?? "";
    const head = buildHead(prefix);
    const hasExtra =
        state.zoomLevel !== undefined ||
        state.altitude !== undefined ||
        state.azimuth !== undefined ||
        state.tilt !== undefined;
    const latStr = state.lat.toFixed(PRECISION);
    const lonStr = state.lon.toFixed(PRECISION);
    if (!hasExtra) {
        return `${head}${latStr},${lonStr}`;
    }
    // zoomLevel が定義されている場合は Google Maps 互換 `@lat,lon,Xz` 形式 (#254)。
    if (state.zoomLevel !== undefined) {
        const z = clampZoomLevel(state.zoomLevel);
        return `${head}${latStr},${lonStr},${z.toFixed(ZOOM_LEVEL_PRECISION)}z`;
    }
    const altitude = clampAltitude(state.altitude ?? CAMERA_URL_DEFAULTS.altitude);
    const azimuth = normalizeAzimuth(state.azimuth ?? CAMERA_URL_DEFAULTS.azimuth);
    const tilt = clampTilt(state.tilt ?? CAMERA_URL_DEFAULTS.tilt);
    return `${head}${latStr},${lonStr},${altitude},${azimuth.toFixed(AZIMUTH_TILT_PRECISION)},${tilt.toFixed(AZIMUTH_TILT_PRECISION)}`;
}

/**
 * history.replaceState で URL のパスを `${prefix}/@lat,lon[,altitude,azimuth,tilt]` 形式に更新する。
 * `prefix` が空のときは `/@lat,lon,...`、`/viewer` 等のときは `/viewer/@lat,lon,...`（Google Maps 互換）を出力する。
 * 現在の pathname からデモ識別子（例: `/viewer`, `/timelapse`）を抽出して保持し、
 * `.html` 拡張子は剥がして正規化する (Issue #155)。既存のクエリパラメータは保持する。
 * デバウンス付きファクトリを返す。
 */
export const createUrlUpdater = (
    debounceMs: number = 200,
): ((state: CameraUrlState) => void) => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    return (state: CameraUrlState): void => {
        if (timerId !== null) {
            clearTimeout(timerId);
        }
        timerId = setTimeout(() => {
            timerId = null;
            const prefix = extractDemoPathPrefix(location.pathname);
            const path = toAtPath(state, prefix);
            const search = location.search;
            history.replaceState(null, "", path + search);
        }, debounceMs);
    };
};

// ---- mapType クエリ (Issue #149) ----

/** `?mapType=` のクエリキー名 */
export const MAP_TYPE_QUERY_KEY = "mapType";

const MAP_TYPE_VALUES: ReadonlyArray<MapType> = ["standard", "photo"];

const isMapType = (value: string): value is MapType =>
    (MAP_TYPE_VALUES as ReadonlyArray<string>).includes(value);

/**
 * URL から `?mapType=standard|photo` を読み取る (Issue #149)。
 *
 * - 大小文字無視（`Standard`, `PHOTO` も可）。書き出しは小文字。
 * - 不正値・欠落・URL 解析失敗時は `null` を返す。
 */
export const parseMapTypeFromUrl = (url: string): MapType | null => {
    try {
        const parsed = new URL(url, "http://localhost");
        const raw = parsed.searchParams.get(MAP_TYPE_QUERY_KEY);
        if (raw === null) return null;
        const normalized = raw.toLowerCase();
        return isMapType(normalized) ? normalized : null;
    } catch {
        return null;
    }
};

/**
 * 入力 URL のクエリ部に `mapType=<value>` をマージして返す純粋関数 (Issue #149)。
 *
 * - パス・他クエリ（例 `?engine=`）・ハッシュは保持する。
 * - 既存の `mapType` パラメータは上書きする。
 * - 戻り値は `pathname + search + hash` のみ（`new URL` の dummy origin は除去）。
 */
export const withMapTypeInUrl = (url: string, mapType: MapType): string => {
    const parsed = new URL(url, "http://localhost");
    parsed.searchParams.set(MAP_TYPE_QUERY_KEY, mapType);
    return parsed.pathname + parsed.search + parsed.hash;
};

/**
 * `history.replaceState` で現在の URL に `?mapType=<value>` を反映する (Issue #149)。
 * パス・他クエリ・ハッシュは保持する。`window` / `history` が未定義な環境
 *（Node.js / SSR など、ブラウザグローバルが存在しない実行環境）では何もしない。
 */
export const updateMapTypeInUrl = (mapType: MapType): void => {
    if (typeof window === "undefined" || typeof window.history === "undefined") {
        return;
    }
    const next = withMapTypeInUrl(window.location.href, mapType);
    window.history.replaceState(null, "", next);
};

// ---- viewMode クエリ (Issue #193) ----

/** `?viewMode=` のクエリキー名 */
export const VIEW_MODE_QUERY_KEY = "viewMode";

const VIEW_MODE_VALUES: ReadonlyArray<ViewMode> = ["3d", "2d"];

const isViewMode = (value: string): value is ViewMode =>
    (VIEW_MODE_VALUES as ReadonlyArray<string>).includes(value);

/**
 * URL から `?viewMode=3d|2d` を読み取る (Issue #193)。
 *
 * - 大小文字無視（`3D`, `2D` も可）。書き出しは小文字。
 * - 不正値・欠落・URL 解析失敗時は `null` を返す。
 */
export const parseViewModeFromUrl = (url: string): ViewMode | null => {
    try {
        const parsed = new URL(url, "http://localhost");
        const raw = parsed.searchParams.get(VIEW_MODE_QUERY_KEY);
        if (raw === null) return null;
        const normalized = raw.toLowerCase();
        return isViewMode(normalized) ? normalized : null;
    } catch {
        return null;
    }
};

/**
 * 入力 URL のクエリ部に `viewMode=<value>` をマージして返す純粋関数 (Issue #193)。
 * パス・他クエリ・ハッシュは保持する。既存の `viewMode` パラメータは上書きする。
 */
export const withViewModeInUrl = (url: string, viewMode: ViewMode): string => {
    const parsed = new URL(url, "http://localhost");
    parsed.searchParams.set(VIEW_MODE_QUERY_KEY, viewMode);
    return parsed.pathname + parsed.search + parsed.hash;
};

/**
 * `history.replaceState` で現在の URL に `?viewMode=<value>` を反映する (Issue #193)。
 * `window` / `history` が未定義な環境では何もしない。
 */
export const updateViewModeInUrl = (viewMode: ViewMode): void => {
    if (typeof window === "undefined" || typeof window.history === "undefined") {
        return;
    }
    const next = withViewModeInUrl(window.location.href, viewMode);
    window.history.replaceState(null, "", next);
};
