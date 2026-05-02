/**
 * 距離計測デモのための純粋関数群 (#186)。
 *
 * - `formatPointLabel`: 頂点ラベル（lat / lon / altitude）を整形する。
 * - `formatEdgeLabel`: 辺ラベル（水平距離 + 高低差）を整形する。
 *
 * haversine 距離計算・距離/高低差フォーマットは共通ユーティリティ
 * `../shared/geoUtils` に移動した。
 */

export {
    haversineDistanceMeters,
    formatHorizontalDistance,
    formatAltitudeDelta,
} from "../shared/geoUtils";

import {
    haversineDistanceMeters,
    formatHorizontalDistance,
    formatAltitudeDelta,
} from "../shared/geoUtils";

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
