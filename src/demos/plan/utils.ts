/**
 * Plan Viewer デモ用ユーティリティ (#38)
 *
 * ウェイポイント・エッジのラベルフォーマット関数。
 * 水平距離計算は distance デモの haversine ロジックを流用する。
 */

import type { ParsedWaypoint } from "./parsePlan";

/** 地球半径 (m)。WGS84 平均半径。 */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * 2 点の (lat, lon) から大圏距離 (m) を haversine 法で算出する。
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
    const hClamped = Math.min(1, Math.max(0, h));
    const c = 2 * Math.atan2(Math.sqrt(hClamped), Math.sqrt(1 - hClamped));
    return EARTH_RADIUS_M * c;
};

/**
 * 水平距離を m / km の単位を自動切替で整形する。
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
 */
export const formatAltitudeDelta = (deltaM: number): string => {
    if (!Number.isFinite(deltaM)) return "-";
    const rounded = Math.round(deltaM);
    if (rounded === 0) return "±0 m";
    const sign = rounded > 0 ? "+" : "";
    return `${sign}${rounded} m`;
};

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
