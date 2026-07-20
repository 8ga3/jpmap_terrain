/**
 * 箱庭ジオラマの標高サンプリング。
 *
 * `dioramaGrid` の格子点（lat/lon）に対応する標高[m]を、既存の低レベル
 * DEMタイル取得プリミティブ（`gsiTile.loadElevationTile`）とバイリニア
 * サンプラ（`geo/elevSample.sampleElevBilinear`）だけを使って求める。
 * `globeTileManager` の視錐台駆動 quadtree LOD は使わない
 * （箱庭は中心点＋固定半径の境界のある地形のため過剰）。
 *
 * 一方、湖沼・山岳地帯で DEM に欠測（no-data）が生じる問題への対処は
 * `globeTileManager.ts` と同じ方針（`isAllNaN` 判定 → `fillInvalidPixels` による
 * 局所補間、全ピクセル無効なタイルは粗ズーム祖先へフォールバック）を踏襲する。
 * 箱庭は視錐台駆動の継続的なタイル読込ではなく、footprint 分の少数タイルを
 * 一括フェッチする設計のため、`globeTileManager` が行う同ズーム隣接タイルとの
 * 波状ステッチ（`stitchTileEdges` による反復補間）までは行わず、粗ズーム祖先への
 * 段階的フォールバックのみを簡略実装する。
 */
import { TILE_SIZE, toTileXY, loadElevationTile, isAllNaN, fillInvalidPixels } from "../gsiTile";
import { totalPixelsForZoom, latLonToPixel } from "../geo/mapping";
import { sampleElevBilinear } from "../geo/elevSample";

/** 標高取得対象の1点（lat/lon のみを要求。他フィールドは無視）。 */
export interface DioramaElevationPoint {
    lat: number;
    lon: number;
}

/** タイル座標のキー（`x/y` 形式）。本モジュール内では zoom は呼び出し単位で固定のため含めない。 */
const tileKeyOf = (x: number, y: number): string => `${x}/${y}`;

/**
 * 粗ズームへのフォールバック探索深さ。
 * `globeTileManager.ts` の `GEOM_ELEV_FALLBACK_DEPTH` と同じ値を用いる。
 */
const COARSE_FALLBACK_DEPTH = 4;

/** 解決済みタイル（要求ズームで有効データが得られなければ粗ズームへフォールバックした結果）。 */
interface ResolvedTile {
    /** 実際に使用したズーム（要求ズームで有効データが得られなければ粗ズームへ倒れる）。 */
    zoom: number;
    x: number;
    y: number;
    elev: Float32Array;
}

/** タイル取得を試み、失敗時（404・一時障害いずれも）は null を返す（呼び出し側で握りつぶす前提）。 */
const tryLoadElevationTile = async (
    zoom: number,
    x: number,
    y: number,
): Promise<Float32Array | null> => {
    try {
        return await loadElevationTile(zoom, x, y);
    } catch {
        return null;
    }
};

/**
 * 1タイル分の標高を解決する。`globeTileManager.ts` と同じ方針でフォールバックする:
 * - 取得成功かつ全ピクセル無効でなければ `fillInvalidPixels` で局所的な穴
 *   （湖沼・山岳の欠測ピクセル）を補間する。
 * - 全ピクセル無効（要求ズームに有効データが皆無。大きな湖等）の場合は、
 *   `COARSE_FALLBACK_DEPTH` を上限に粗ズーム祖先タイルへ段階的にフォールバックする
 *   （祖先タイルに有効ピクセルがあれば、そのまま該当ズーム/座標の結果として採用する）。
 * - 祖先も含め有効データが皆無（外洋等）であれば 0m 埋めタイルにフォールバックする。
 *
 * 本関数は例外を投げない（すべての失敗経路が最終的に何らかの `ResolvedTile` を返す）。
 */
const resolveTileElevation = async (
    zoom: number,
    x: number,
    y: number,
): Promise<ResolvedTile> => {
    const native = await tryLoadElevationTile(zoom, x, y);
    if (native && !isAllNaN(native)) {
        fillInvalidPixels(native, TILE_SIZE, TILE_SIZE);
        return { zoom, x, y, elev: native };
    }

    const floor = Math.max(0, zoom - COARSE_FALLBACK_DEPTH);
    for (let cz = zoom - 1; cz >= floor; cz--) {
        const d = zoom - cz;
        const cx = x >> d;
        const cy = y >> d;
        const coarse = await tryLoadElevationTile(cz, cx, cy);
        if (coarse && !isAllNaN(coarse)) {
            fillInvalidPixels(coarse, TILE_SIZE, TILE_SIZE);
            return { zoom: cz, x: cx, y: cy, elev: coarse };
        }
    }

    // 祖先を辿っても有効データが皆無（外洋等）。0m埋めタイルへフォールバックする。
    console.error(
        `[jpmap-terrain diorama] no valid elevation data for z${zoom}/${x}/${y} ` +
            `(including coarse ancestors up to depth ${COARSE_FALLBACK_DEPTH}), falling back to 0m`,
    );
    return { zoom, x, y, elev: new Float32Array(TILE_SIZE * TILE_SIZE) };
};

/** ズームレベルが0以上の整数であることを検証する（非整数/負数はtoTileXY/totalPixelsForZoomを不正な計算に導くため）。 */
const assertValidZoom = (zoom: number): void => {
    if (!(Number.isInteger(zoom) && zoom >= 0)) {
        throw new RangeError(`zoom must be a non-negative integer (got ${zoom})`);
    }
};

/**
 * 格子点群の標高[m]を取得する。戻り値は入力と同じ順序・長さの `Float32Array`。
 *
 * 内部では点群が跨るタイル座標を重複排除して並列フェッチし（点数よりタイル数が
 * 大幅に少ない前提）、各点をバイリニアサンプルする。タイルは {@link resolveTileElevation}
 * で解決するため、湖沼・山岳地帯の欠測ピクセルは局所補間または粗ズームフォールバックで
 * 埋められる（詳細は同関数のドキュメント参照）。
 */
export const fetchDioramaElevations = async (
    points: readonly DioramaElevationPoint[],
    zoom: number,
): Promise<Float32Array> => {
    assertValidZoom(zoom);
    const neededTiles = new Map<string, { x: number; y: number }>();
    for (const p of points) {
        const { x, y } = toTileXY(p.lat, p.lon, zoom);
        neededTiles.set(tileKeyOf(x, y), { x, y });
    }

    const resolvedTiles = new Map<string, ResolvedTile>();
    await Promise.all(
        Array.from(neededTiles.entries()).map(async ([key, { x, y }]) => {
            resolvedTiles.set(key, await resolveTileElevation(zoom, x, y));
        }),
    );

    const elevations = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const { x, y } = toTileXY(p.lat, p.lon, zoom);
        const resolved = resolvedTiles.get(tileKeyOf(x, y));
        if (!resolved) {
            elevations[i] = 0;
            continue;
        }
        // 粗ズームへフォールバックした場合、対応するピクセル座標は元の要求ズームではなく
        // 実際に使用した resolved.zoom/x/y 側で計算する必要がある。
        const effectiveTotalPixels = totalPixelsForZoom(resolved.zoom);
        const { px: globalPx, py: globalPy } = latLonToPixel(p.lat, p.lon, effectiveTotalPixels);
        const localPx = globalPx - resolved.x * TILE_SIZE;
        const localPy = globalPy - resolved.y * TILE_SIZE;
        elevations[i] = sampleElevBilinear(resolved.elev, localPx, localPy);
    }
    return elevations;
};

