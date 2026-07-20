/**
 * 箱庭ジオラマの標高サンプリング。
 *
 * `dioramaGrid` の格子点（lat/lon）に対応する標高[m]を、既存の低レベル
 * DEMタイル取得プリミティブ（`gsiTile.loadElevationTile`）とバイリニア
 * サンプラ（`geo/elevSample.sampleElevBilinear`）だけを使って求める。
 * `globeTileManager` の視錐台駆動 quadtree LOD は使わない
 * （箱庭は中心点＋固定半径の境界のある地形のため過剰）。
 */
import { TILE_SIZE, toTileXY, loadElevationTile } from "../gsiTile";
import { totalPixelsForZoom, latLonToPixel } from "../geo/mapping";
import { sampleElevBilinear } from "../geo/elevSample";

/** 標高取得対象の1点（lat/lon のみを要求。他フィールドは無視）。 */
export interface DioramaElevationPoint {
    lat: number;
    lon: number;
}

/** `z/x/y` 形式のタイルキー。 */
const tileKeyOf = (x: number, y: number): string => `${x}/${y}`;

/**
 * 格子点群の標高[m]を取得する。戻り値は入力と同じ順序・長さの `Float32Array`。
 *
 * 内部では点群が跨るタイル座標を重複排除して並列フェッチし（点数よりタイル数が
 * 大幅に少ない前提）、各点をバイリニアサンプルする。個別タイルの取得に失敗した
 * 場合は該当タイルを 0m 埋めにフォールバックし、処理全体は継続する
 * （箱庭は診断デモではなく表示継続を優先するため）。
 */
export const fetchDioramaElevations = async (
    points: readonly DioramaElevationPoint[],
    zoom: number,
): Promise<Float32Array> => {
    const totalPixels = totalPixelsForZoom(zoom);

    const neededTiles = new Map<string, { x: number; y: number }>();
    for (const p of points) {
        const { x, y } = toTileXY(p.lat, p.lon, zoom);
        neededTiles.set(tileKeyOf(x, y), { x, y });
    }

    const tileData = new Map<string, Float32Array>();
    await Promise.all(
        Array.from(neededTiles.entries()).map(async ([key, { x, y }]) => {
            try {
                tileData.set(key, await loadElevationTile(zoom, x, y));
            } catch (err) {
                console.error(
                    `[jpmap-terrain diorama] failed to load elevation tile z${zoom}/${x}/${y}, falling back to 0m:`,
                    err,
                );
                tileData.set(key, new Float32Array(TILE_SIZE * TILE_SIZE));
            }
        }),
    );

    const elevations = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const { x, y } = toTileXY(p.lat, p.lon, zoom);
        const tile = tileData.get(tileKeyOf(x, y));
        if (!tile) {
            elevations[i] = 0;
            continue;
        }
        const { px: globalPx, py: globalPy } = latLonToPixel(p.lat, p.lon, totalPixels);
        const localPx = globalPx - x * TILE_SIZE;
        const localPy = globalPy - y * TILE_SIZE;
        elevations[i] = sampleElevBilinear(tile, localPx, localPy);
    }
    return elevations;
};
