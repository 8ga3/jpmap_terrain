/**
 * Web メルカトル（XYZ タイル）のグローバルピクセル座標と緯度経度の相互変換。
 *
 * グローブ地形で、タイルのピクセル格子を ECEF 頂点へ写すための
 * 前段。PoC でメッシュ生成・標高サンプルに散在していた
 * メルカトル変換式を集約したもの。
 *
 * 「グローバルピクセル座標」は zoom 全体を 1 枚の画像とみなしたときの通し座標で、
 * 原点は左上（北西端）。`totalPixels = TILE_SIZE * 2^zoom`。X は西→東、Y は北→南。
 *
 * NOTE: データ取得層 `gsiTile.ts`（`toTileXY` / `tileCenterLatLon`）はタイル整数座標
 * 単位の変換で温存対象。本モジュールはサブピクセル精度のグローバルピクセル変換を担う。
 */
import { clamp, TILE_SIZE } from "../gsiTile";

/**
 * Web メルカトルの緯度有効域[deg]。±この緯度で投影が ±無限大に発散するため、
 * `gsiTile.toTileXY` と同じ値でクランプする。
 */
export const MERCATOR_MAX_LAT = 85.05112878;

/** 経度を [-180, 180) に正規化する（`gsiTile.toTileXY` と同じ式）。 */
const normalizeLon = (lonDeg: number): number =>
    ((((lonDeg + 180) % 360) + 360) % 360) - 180;

/** zoom レベル全体のグローバルピクセル幅（= 高さ）。 */
export const totalPixelsForZoom = (zoom: number): number =>
    TILE_SIZE * 2 ** zoom;

/**
 * グローバルピクセル座標 → 緯度経度[deg]（Web メルカトル逆変換）。
 *
 * 範囲外入力に対する堅牢化として `globalPx/globalPy` を [0, totalPixels] にクランプし、
 * lon を [-180, 180]、lat をメルカトル有効域内に収める。
 *
 * NOTE: lon は「ラップ（正規化）」ではなく「クランプ」する。逆変換で lon をラップすると、
 * 最東端タイル右端（globalPx=totalPixels, lon=180）が -180 へ飛び、1 タイルが経度 360° に
 * 跨る不正メッシュになる。連続したピクセル→経度の単調写像を保つためクランプとする
 * （順変換 `latLonToPixel` 側では入力 lon の正規化が正しいので、そちらでのみ正規化する）。
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
    const px = clamp(globalPx, 0, totalPixels);
    const py = clamp(globalPy, 0, totalPixels);
    const lon = (px / totalPixels) * 360 - 180;
    const ny = py / totalPixels;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180) / Math.PI;
    return { lat, lon };
};

/**
 * 緯度経度[deg] → グローバルピクセル座標（Web メルカトル順変換）。
 * 域内入力に対しては `pixelToLatLon` の逆関数。
 *
 * `gsiTile.toTileXY` と挙動を揃えるため、緯度を ±{@link MERCATOR_MAX_LAT} にクランプし
 * （`Math.log(tan+sec)` の発散 → `Infinity/NaN` を防ぐ）、経度を [-180, 180) に正規化してから
 * 変換する。
 *
 * NOTE: 経度を [-180, 180) に正規化するため、境界では厳密な逆にならない。`pixelToLatLon` が
 * 返し得る lon=180°（globalPx=totalPixels）は本関数では -180°（px=0）として扱う。球面上は
 * 同一経線で幾何学的に等価なので問題ないが、この 1 点では `latLonToPixel(pixelToLatLon(p)) === p`
 * が px について成り立たない。
 *
 * @param latDeg 緯度[deg]。
 * @param lonDeg 経度[deg]。
 * @param totalPixels `totalPixelsForZoom(zoom)`。
 */
export const latLonToPixel = (
    latDeg: number,
    lonDeg: number,
    totalPixels: number,
): { px: number; py: number } => {
    const latClamped = clamp(latDeg, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
    const lonNormalized = normalizeLon(lonDeg);
    const latRad = (latClamped * Math.PI) / 180;
    // 出力も [0, totalPixels] に収める。MERCATOR_MAX_LAT は丸め値のため、緯度上限ちょうどで
    // py が ±数 e-5 px だけ域外に出る。`gsiTile.toTileXY` が最終的にタイル整数を [0, n-1] へ
    // クランプするのと同じ定義域をピクセル粒度で保証する。
    const px = clamp(
        ((lonNormalized + 180) / 360) * totalPixels,
        0,
        totalPixels,
    );
    const py = clamp(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
            2) *
            totalPixels,
        0,
        totalPixels,
    );
    return { px, py };
};
