/** URL に緯度・経度・カメラ姿勢を埋め込み / 復元するモジュール (Issue #64) */

import { clamp, JAPAN_BOUNDS } from "./gsiTile";
import { JPMAP_TERRAIN_DEFAULTS } from "../lib/types";

export interface LatLon {
    lat: number;
    lon: number;
}

/** カメラ姿勢を含む URL 状態 (Issue #64) */
export interface CameraUrlState extends LatLon {
    altitude: number;
    azimuth: number;
    tilt: number;
}

const PRECISION = 6;
const AZIMUTH_TILT_PRECISION = 2;

/** tilt のクランプ最小値 (rad)。視野が水平に潰れないよう微小値を確保する。 */
const TILT_MIN_RAD = 0.1;
/** tilt のクランプ最小値 (deg)。{@link TILT_MIN_RAD} を度に変換した値（≒ 5.7295779513°）。 */
const TILT_MIN_DEG = (TILT_MIN_RAD * 180) / Math.PI;

/**
 * altitude / tilt のクランプ範囲。
 * - altitude: src/scenes/default.ts の CAMERA_LOWER_RADIUS / CAMERA_UPPER_RADIUS に基づく [50, 75000] (m)
 * - tilt: [{@link TILT_MIN_DEG}, 75]（deg）。下限は {@link TILT_MIN_RAD} rad を度換算した値
 */
export const CAMERA_URL_LIMITS = {
    altitude: { min: 50, max: 75000 },
    tilt: { min: TILT_MIN_DEG, max: 75 },
} as const;

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
 * @lat,lon[,altitude,azimuth,tilt] パターン。
 * 2〜5 トークンに対応し、欠損トークンはパース後にデフォルト補完する。
 */
const AT_PATTERN =
    /@(-?\d+\.?\d*),(-?\d+\.?\d*)(?:,(-?\d+\.?\d*))?(?:,(-?\d+\.?\d*))?(?:,(-?\d+\.?\d*))?/;

/** altitude を [50, 75000] にクランプし整数化する */
export const clampAltitude = (v: number): number => {
    const c = clamp(v, CAMERA_URL_LIMITS.altitude.min, CAMERA_URL_LIMITS.altitude.max);
    return Math.round(c);
};

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
 * 1. パス / ハッシュ内の `@lat,lon[,altitude,azimuth,tilt]`
 * 2. クエリパラメータ `?lat=&lon=`（altitude/azimuth/tilt はデフォルト補完）
 * いずれも無い場合は null を返す。
 */
export const parseCameraStateFromUrl = (url: string): CameraUrlState | null => {
    try {
        const parsed = new URL(url, "http://localhost");

        // pathname + hash のみに @lat,lon を適用（userinfo やクエリ値の @ を誤検出しない）
        const target = parsed.pathname + parsed.hash;
        const atMatch = target.match(AT_PATTERN);
        if (atMatch) {
            const lat = Number(atMatch[1]);
            const lon = Number(atMatch[2]);
            if (isFinite(lat) && isFinite(lon)) {
                const altitude = pickFinite(atMatch[3], CAMERA_URL_DEFAULTS.altitude);
                const azimuth = pickFinite(atMatch[4], CAMERA_URL_DEFAULTS.azimuth);
                const tilt = pickFinite(atMatch[5], CAMERA_URL_DEFAULTS.tilt);
                return {
                    lat: clamp(lat, JAPAN_BOUNDS.minLat, JAPAN_BOUNDS.maxLat),
                    lon: clamp(lon, JAPAN_BOUNDS.minLon, JAPAN_BOUNDS.maxLon),
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
                    lat: clamp(lat, JAPAN_BOUNDS.minLat, JAPAN_BOUNDS.maxLat),
                    lon: clamp(lon, JAPAN_BOUNDS.minLon, JAPAN_BOUNDS.maxLon),
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
export const parseLatLonFromUrl = (url: string): LatLon | null => {
    const state = parseCameraStateFromUrl(url);
    if (state === null) return null;
    return { lat: state.lat, lon: state.lon };
};

/**
 * パスセグメント文字列を生成する。
 * - 数値2引数: `/@lat,lon`（2要素）
 * - 状態オブジェクト: altitude/azimuth/tilt のいずれかが定義されていれば 5要素、
 *   全て未定義なら 2要素を返す。
 */
export function toAtPath(lat: number, lon: number): string;
export function toAtPath(state: Partial<CameraUrlState> & LatLon): string;
export function toAtPath(
    a: number | (Partial<CameraUrlState> & LatLon),
    b?: number,
): string {
    if (typeof a === "number" && typeof b === "number") {
        return `/@${a.toFixed(PRECISION)},${b.toFixed(PRECISION)}`;
    }
    const state = a as Partial<CameraUrlState> & LatLon;
    const hasExtra =
        state.altitude !== undefined ||
        state.azimuth !== undefined ||
        state.tilt !== undefined;
    const latStr = state.lat.toFixed(PRECISION);
    const lonStr = state.lon.toFixed(PRECISION);
    if (!hasExtra) {
        return `/@${latStr},${lonStr}`;
    }
    const altitude = clampAltitude(state.altitude ?? CAMERA_URL_DEFAULTS.altitude);
    const azimuth = normalizeAzimuth(state.azimuth ?? CAMERA_URL_DEFAULTS.azimuth);
    const tilt = clampTilt(state.tilt ?? CAMERA_URL_DEFAULTS.tilt);
    return `/@${latStr},${lonStr},${altitude},${azimuth.toFixed(AZIMUTH_TILT_PRECISION)},${tilt.toFixed(AZIMUTH_TILT_PRECISION)}`;
}

/**
 * history.replaceState で URL のパスを `/@lat,lon[,altitude,azimuth,tilt]` 形式に更新する。
 * 既存のクエリパラメータは保持する。デバウンス付きファクトリを返す。
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
            const path = toAtPath(state);
            const search = location.search;
            history.replaceState(null, "", path + search);
        }, debounceMs);
    };
};
