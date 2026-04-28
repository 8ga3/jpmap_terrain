/**
 * Overlay 共通座標ユーティリティ (Issue #170)。
 *
 * Marker / Polygon など、`MarkerContext`（= {@link OverlayContext}）を共有する
 * オーバーレイ実装が共通で利用する関数を集約する。
 *
 * - `latLonToWorld`: 緯度経度 → ワールド座標 (wx, wz) 変換
 * - `assertLatLonInBounds`: JAPAN_BOUNDS 範囲外なら Error
 * - `computeDistanceScale`: カメラ距離に応じたスクリーン定スケール係数（下限 0.1）
 * - `computeDynamicLineHeight`: カメラ距離・仰角から動的に決まる「線の高さ (m)」
 *
 * すべて `MarkerManager` から移設したロジックそのままで、挙動は不変である。
 */

import { JAPAN_BOUNDS } from "./gsiTile";
import { METERS_PER_DEGREE_LAT, type MarkerContext } from "../scenes/default";

/**
 * Marker / Polygon が共有する境界コンテキスト。
 *
 * 構造変更を避けるため `MarkerContext` の型 alias として定義する。
 */
export type OverlayContext = MarkerContext;

/**
 * スケール基準距離 (m)。カメラ距離がこの値なら scale=1、それ以上は distance/refDistance
 * 倍してスクリーン空間サイズを一定に保つ。
 */
export const REF_DISTANCE_M = 1000;

/**
 * 緯度経度をシーン内ワールド座標 (wx, wz) に変換する。
 *
 * 原点 (`ctx.getOrigin()`) と地理院タイル整列のための `gridResidualX/Z` を加味する。
 */
export const latLonToWorld = (
    ctx: OverlayContext,
    lat: number,
    lon: number,
): { wx: number; wz: number } => {
    const origin = ctx.getOrigin();
    const metersPerDegLon =
        METERS_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
    const wx = (lon - origin.lon) * metersPerDegLon + origin.gridResidualX;
    const wz = (lat - origin.lat) * METERS_PER_DEGREE_LAT + origin.gridResidualZ;
    return { wx, wz };
};

/**
 * `lat` / `lon` が `JAPAN_BOUNDS` の範囲内であることを検証する。
 * 範囲外なら `errorPrefix` を含むメッセージで Error を投げる。
 */
export const assertLatLonInBounds = (
    lat: number,
    lon: number,
    errorPrefix: string,
): void => {
    if (
        lat < JAPAN_BOUNDS.minLat ||
        lat > JAPAN_BOUNDS.maxLat ||
        lon < JAPAN_BOUNDS.minLon ||
        lon > JAPAN_BOUNDS.maxLon
    ) {
        throw new Error(
            `${errorPrefix}: lat/lon out of JAPAN_BOUNDS (lat=${lat}, lon=${lon})`,
        );
    }
};

/**
 * カメラ位置とワールド座標 (wx, wy, wz) からスクリーン定スケール係数を計算する。
 * 近距離での過大スケールを抑えるため下限 0.1 を持つ。
 */
export const computeDistanceScale = (
    ctx: OverlayContext,
    wx: number,
    wy: number,
    wz: number,
): number => {
    const cam = ctx.getCameraPosition();
    const dx = cam.x - wx;
    const dy = cam.y - wy;
    const dz = cam.z - wz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const scale = dist / REF_DISTANCE_M;
    return Math.max(scale, 0.1);
};

/**
 * 動的な線高さ (m) をカメラ位置と beta 角度から計算する。
 *
 * 画面中央付近にマーカー/ポリゴン頂点が表示されるよう、
 * カメラ距離 (radius) に対して一定割合の高さにしつつ、仰角 (beta) で調整する。
 * - radius * 0.1 をベースとし、sin(beta) で 0.3 〜1.0 にクランプした係数を掛ける。
 * - 下限 100m、上限 10000m で見た目の肉付きを安定させる。
 */
export const computeDynamicLineHeight = (ctx: OverlayContext): number => {
    const cam = ctx.getCameraPosition();
    const radius = Math.max(cam.radius, 1);
    const sinBeta = Math.sin(cam.beta);
    const factor = Math.min(1, Math.max(0.3, sinBeta));
    const h = radius * 0.1 * factor;
    return Math.min(10000, Math.max(100, h));
};
