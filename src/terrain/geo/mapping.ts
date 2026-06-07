/**
 * Web メルカトル（XYZ タイル）のグローバルピクセル座標と緯度経度の相互変換。
 *
 * グローブ地形（Issue #275）で、タイルのピクセル格子を ECEF 頂点へ写すための
 * 前段。PoC（Issue #321）でメッシュ生成・標高サンプルに散在していた
 * メルカトル変換式を集約したもの。
 *
 * 「グローバルピクセル座標」は zoom 全体を 1 枚の画像とみなしたときの通し座標で、
 * 原点は左上（北西端）。`totalPixels = TILE_SIZE * 2^zoom`。X は西→東、Y は北→南。
 *
 * NOTE: データ取得層 `gsiTile.ts`（`toTileXY` / `tileCenterLatLon`）はタイル整数座標
 * 単位の変換で温存対象。本モジュールはサブピクセル精度のグローバルピクセル変換を担う。
 */
import { TILE_SIZE } from "../gsiTile";

/** zoom レベル全体のグローバルピクセル幅（= 高さ）。 */
export const totalPixelsForZoom = (zoom: number): number =>
    TILE_SIZE * 2 ** zoom;

/**
 * グローバルピクセル座標 → 緯度経度[deg]（Web メルカトル逆変換）。
 *
 * @param globalPx 西→東のグローバルピクセル X。
 * @param globalPy 北→南のグローバルピクセル Y。
 * @param totalPixels `totalPixelsForZoom(zoom)`。
 */
export const pixelToLatLon = (
    globalPx: number,
    globalPy: number,
    totalPixels: number,
): { lat: number; lon: number } => {
    const lon = (globalPx / totalPixels) * 360 - 180;
    const ny = globalPy / totalPixels;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180) / Math.PI;
    return { lat, lon };
};

/**
 * 緯度経度[deg] → グローバルピクセル座標（Web メルカトル順変換）。
 * `pixelToLatLon` の逆関数。
 *
 * @param latDeg 緯度[deg]（メルカトル有効範囲 ±85.05112878° 前提）。
 * @param lonDeg 経度[deg]。
 * @param totalPixels `totalPixelsForZoom(zoom)`。
 */
export const latLonToPixel = (
    latDeg: number,
    lonDeg: number,
    totalPixels: number,
): { px: number; py: number } => {
    const latRad = (latDeg * Math.PI) / 180;
    const px = ((lonDeg + 180) / 360) * totalPixels;
    const py =
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
        totalPixels;
    return { px, py };
};
