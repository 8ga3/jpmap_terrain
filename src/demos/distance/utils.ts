/**
 * 距離計測デモのための純粋関数群 (#186)。
 *
 * - `haversineDistanceMeters`: 2 点の lat/lon から水平距離 (m) を計算する。
 * - `formatHorizontalDistance`: m / km の単位を切替えて整形する。
 * - `formatAltitudeDelta`: 高低差 (m) を整形する（符号付き）。
 * - `formatPointLabel`: 頂点ラベル（lat / lon / altitude）を整形する。
 *
 * ロジックを demo 本体から分離することでユニットテスト対象を明確化する。
 */

/** 地球半径 (m)。WGS84 平均半径。 */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * 2 点の (lat, lon) から大圏距離 (m) を haversine 法で算出する。
 *
 * 小数点以下の round/floor は呼び出し側で行い、本関数は double 精度のままを返す。
 * 同一点なら 0 を返す。
 */
export const haversineDistanceMeters = (
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
): number => {
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lon - a.lon);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h =
        sinDLat * sinDLat +
        Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return EARTH_RADIUS_M * c;
};

/**
 * 水平距離を m / km の単位を自動切替で整形する。
 * - 1000 m 未満: `<整数> m`（小数なし、四捨五入）
 * - 1000 m 以上: `<小数 2 桁> km`
 */
export const formatHorizontalDistance = (meters: number): string => {
    if (!Number.isFinite(meters) || meters < 0) return "-";
    if (meters < 1000) {
        return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toFixed(2)} km`;
};

/**
 * 高低差を m で整形する。常に符号 (+/-) を付ける。
 * 絶対値 < 0.5 m は `±0 m` として扱う（四捨五入後 0 になるケースを明示）。
 */
export const formatAltitudeDelta = (deltaM: number): string => {
    if (!Number.isFinite(deltaM)) return "-";
    const rounded = Math.round(deltaM);
    if (rounded === 0) return "±0 m";
    const sign = rounded > 0 ? "+" : "";
    return `${sign}${rounded} m`;
};

/**
 * 頂点ラベル（複数行）。lat/lon は小数 5 桁、altitude は m 整数。
 */
export const formatPointLabel = (point: {
    lat: number;
    lon: number;
    altitude?: number;
}): string => {
    const lat = point.lat.toFixed(5);
    const lon = point.lon.toFixed(5);
    const alt = point.altitude !== undefined ? Math.round(point.altitude) : 0;
    return `${lat}\n${lon}\n${alt} m`;
};

/**
 * 辺ラベル（複数行）。「水平距離」と「高低差」を 2 行で表示する。
 */
export const formatEdgeLabel = (
    a: { lat: number; lon: number; altitude?: number },
    b: { lat: number; lon: number; altitude?: number },
): string => {
    const horizontal = haversineDistanceMeters(a, b);
    const delta = (b.altitude ?? 0) - (a.altitude ?? 0);
    return `${formatHorizontalDistance(horizontal)}\n${formatAltitudeDelta(delta)}`;
};

/**
 * 距離計測デモのツールバーモード。
 * - `add`: 地形クリックで頂点を追加
 * - `remove`: 頂点クリックで削除
 * - `edit`: 頂点ドラッグで lat/lon 移動、Shift+ドラッグで altitude 変更
 */
export type DistanceDemoMode = "add" | "remove" | "edit";

/** 既定モード。`/distance.html` を開いた直後の状態。 */
export const DEFAULT_DISTANCE_DEMO_MODE: DistanceDemoMode = "add";
