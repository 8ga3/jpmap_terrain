/**
 * Plan Viewer デモ用ユーティリティ
 *
 * ウェイポイント・エッジのラベルフォーマット関数。
 * haversine 距離計算・距離/高低差フォーマットは共通ユーティリティ
 * `../shared/geoUtils` を使用する。
 */

import type { ParsedWaypoint } from "./parsePlan";

export {
    formatAltitudeDelta,
    formatHorizontalDistance,
    haversineDistanceMeters,
} from "../shared/geoUtils";

import {
    formatAltitudeDelta,
    formatHorizontalDistance,
    haversineDistanceMeters,
} from "../shared/geoUtils";

/**
 * ウェイポイントラベル: 番号 + 高度
 */
export const formatWaypointLabel = (wp: ParsedWaypoint): string => {
    const alt = Math.round(wp.altitude);
    return `#${wp.number}\n${alt} m`;
};

/**
 * ウェイポイント間エッジラベル: 水平距離 + 高度差
 */
export const formatWaypointEdgeLabel = (
    a: ParsedWaypoint,
    b: ParsedWaypoint,
): string => {
    const horizontal = haversineDistanceMeters(a, b);
    const delta = b.altitude - a.altitude;
    return `${formatHorizontalDistance(horizontal)}\n${formatAltitudeDelta(delta)}`;
};

/**
 * ラリーポイントラベル: 番号のみ
 */
export const formatRallyPointLabel = (number: number): string => {
    return `R${number}`;
};

/**
 * ホームポジションラベル: "H" + 高度
 */
export const formatHomePositionLabel = (altitude: number): string => {
    const alt = Math.round(altitude);
    return `H\n${alt} m`;
};
