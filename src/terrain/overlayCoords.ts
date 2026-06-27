/**
 * Overlay 共通座標ユーティリティ。
 *
 * globe 単一バックエンド化後は、緯度経度の範囲検証のみを共通関数として提供する。
 * `assertLatLonInBounds` は globe の overlay 実装（`globeSceneController` 等）から利用される。
 */

import { JAPAN_BOUNDS } from "./gsiTile";

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
