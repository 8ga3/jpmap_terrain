/** URL に緯度・経度を埋め込み / 復元するモジュール */

import { clamp, JAPAN_BOUNDS } from "./gsiTile";

export interface LatLon {
    lat: number;
    lon: number;
}

const PRECISION = 6;

/** @lat,lon パターン（パス・ハッシュ両方で利用） */
const AT_PATTERN = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

/**
 * URL から緯度・経度を読み取る。優先順位:
 * 1. パス内の `@lat,lon`（Google Maps 互換）
 * 2. クエリパラメータ `?lat=&lon=`
 * いずれも無い場合は null を返す。
 */
export const parseLatLonFromUrl = (url: string): LatLon | null => {
    try {
        const parsed = new URL(url, "http://localhost");

        // pathname + hash のみに @lat,lon を適用（userinfo やクエリ値の @ を誤検出しない）
        const target = parsed.pathname + parsed.hash;
        const atMatch = target.match(AT_PATTERN);
        if (atMatch) {
            const lat = Number(atMatch[1]);
            const lon = Number(atMatch[2]);
            if (isFinite(lat) && isFinite(lon)) {
                return {
                    lat: clamp(lat, JAPAN_BOUNDS.minLat, JAPAN_BOUNDS.maxLat),
                    lon: clamp(lon, JAPAN_BOUNDS.minLon, JAPAN_BOUNDS.maxLon),
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
                };
            }
        }
    } catch {
        // URL 解析失敗時は無視
    }

    return null;
};

/** パスセグメント文字列を生成する（例: `/@35.681236,139.767125`） */
export const toAtPath = (lat: number, lon: number): string =>
    `/@${lat.toFixed(PRECISION)},${lon.toFixed(PRECISION)}`;

/**
 * history.replaceState で URL のパスを `/@lat,lon` 形式に更新する。
 * 既存のクエリパラメータは保持する。デバウンス付きファクトリを返す。
 */
export const createUrlUpdater = (
    debounceMs: number = 200
): ((lat: number, lon: number) => void) => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    return (lat: number, lon: number): void => {
        if (timerId !== null) {
            clearTimeout(timerId);
        }
        timerId = setTimeout(() => {
            timerId = null;
            const path = toAtPath(lat, lon);
            const search = location.search;
            history.replaceState(null, "", path + search);
        }, debounceMs);
    };
};
