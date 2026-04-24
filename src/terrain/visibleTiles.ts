/** カメラFrustum内の可視タイルを Quadtree + SSE で算出する */

import { TileCoord, convertTileZoom, computeSubTileOffset } from "./tileTypes";

export interface FrustumPlane {
    normal: { x: number; y: number; z: number };
    d: number;
}

/** マルチLOD可視タイルの結果 */
export interface LodTileEntry {
    coord: TileCoord;
    tileSize: number;
}

/** デフォルトの最大タイル数 */
export const DEFAULT_MAX_TILES = 120;
/** 日本の標高上限概算（富士山 3776m + マージン） */
export const DEFAULT_MAX_ELEVATION = 4000;
/**
 * SSE のデフォルトしきい値（ピクセル単位）。
 *
 * 採用条件は `SSE ≤ threshold`。`SSE` はタイルが画面上で占めるピクセル高さの概算なので、
 * `threshold` が大きいほど粗いタイルを早期受容（= ズームアップしても高 zoom に上がりにくい）、
 * 小さいほど最深まで分割（= 高解像度を維持する）。
 * 既定 600 は「タイル 1 枚あたり画面 600 ピクセル」相当を許容する設定で、
 * 256 のようなより厳しいしきい値より分割負荷を抑えることを優先している。
 */
const DEFAULT_SSE_THRESHOLD = 600;
/** minZoom タイル単位での root 探索半径の既定値（±N 格子）。 */
const DEFAULT_ROOT_SEARCH_RADIUS = 2;

/**
 * AABB が Frustum の全平面の内側または交差にあるか判定。
 * P-vertex テストで早期除外し、完全に外側なら false。
 */
export const isAABBInFrustum = (
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    planes: readonly FrustumPlane[]
): boolean => {
    for (const plane of planes) {
        const { normal, d } = plane;
        const px = normal.x >= 0 ? maxX : minX;
        const py = normal.y >= 0 ? maxY : minY;
        const pz = normal.z >= 0 ? maxZ : minZ;
        if (normal.x * px + normal.y * py + normal.z * pz + d < 0) {
            return false;
        }
    }
    return true;
};

export interface QuadtreeTilesOptions {
    /** 最高ズームレベル（分割の上限） */
    maxZoom: number;
    /** 最低ズームレベル（root の zoom） */
    minZoom: number;
    /** 基本zoom（= maxZoom 相当）の中心タイル座標 */
    baseCenter: TileCoord;
    /** 各zoomでのタイル実サイズ（メートル）を返す関数 */
    tileSizeForZoom: (zoom: number) => number;
    /** カメラ Frustum の6平面 */
    frustumPlanes: readonly FrustumPlane[];
    /** baseCenter 原点ローカル座標系でのカメラ位置 */
    cameraPosition: { x: number; y: number; z: number };
    /** 垂直 FOV（rad） */
    verticalFov: number;
    /** ビューポート高さ（ピクセル） */
    viewportHeight: number;
    /** SSE 採用しきい値（ピクセル）。省略時は DEFAULT_SSE_THRESHOLD。 */
    sseThreshold?: number;
    /** AABB の maxY に使う値。省略時 DEFAULT_MAX_ELEVATION */
    maxElevation?: number;
    /** 結果タイル数の上限。省略時 DEFAULT_MAX_TILES */
    maxTiles?: number;
    /** root タイル（minZoom）の探索半径。省略時 DEFAULT_ROOT_SEARCH_RADIUS */
    rootSearchRadius?: number;
    /** @internal テスト用。再帰安全弁の訪問上限を直接指定する。 */
    _maxVisited?: number;
}

/**
 * baseCenter 原点ローカル座標系における、zoom 指定タイルの AABB を返す。
 * 端数補正（computeSubTileOffset）を毎回適用し、累積誤差を避ける。
 */
const computeTileAABB = (
    coord: TileCoord,
    baseCenter: TileCoord,
    tileSizeForZoom: (zoom: number) => number,
    maxElevation: number,
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } => {
    const tileSize = tileSizeForZoom(coord.zoom);
    const center = convertTileZoom(baseCenter, coord.zoom);
    const { fracX, fracY } = computeSubTileOffset(baseCenter, coord.zoom);
    const dx = coord.x - center.x;
    const dy = coord.y - center.y;
    // Babylon 座標系では Y タイル方向が -Z。tileOffsetToWorld と同じ規約。
    const offsetX = (dx - fracX) * tileSize;
    const offsetZ = -(dy - fracY) * tileSize;
    const half = tileSize / 2;
    return {
        minX: offsetX - half,
        minY: 0,
        minZ: offsetZ - half,
        maxX: offsetX + half,
        maxY: maxElevation,
        maxZ: offsetZ + half,
    };
};

/**
 * タイルフットプリント（平面矩形 y=0 投影）とカメラ位置との 3D 距離。
 *
 * SSE 計算ではタイル地表からの実距離を使いたいが、視錐台カリング用 AABB の高さは
 * `maxElevation` まで広がっており、カメラがその範囲内（例: 高度 4000m 以下のトップダウン視点）
 * だと AABB そのものとの最短距離は 0 を返してしまい、SSE が爆発して maxZoom まで過剰分割される。
 * ここでは水平方向は AABB と同じ XZ 矩形、垂直方向はカメラ高度 |y| を使って実効距離とする。
 */
const distanceFootprintToPoint = (
    aabb: { minX: number; minZ: number; maxX: number; maxZ: number },
    p: { x: number; y: number; z: number },
): number => {
    const ex = Math.max(0, Math.max(aabb.minX - p.x, p.x - aabb.maxX));
    const ez = Math.max(0, Math.max(aabb.minZ - p.z, p.z - aabb.maxZ));
    const ey = Math.abs(p.y);
    return Math.sqrt(ex * ex + ey * ey + ez * ez);
};

/**
 * カメラ Frustum 内の可視タイルを Quadtree + SSE で算出する。
 *
 * - root 集合は `convertTileZoom(baseCenter, minZoom)` を中心に `±rootSearchRadius` 格子。
 * - 各ノードで視錐台カリング → SSE しきい値判定を行い、不要なら採用、必要なら 4 子に分割。
 * - `SSE = tileSize(z) * viewportHeight / (max(1, D) * 2 * tan(verticalFov / 2))`
 *   - `D` はタイルのフットプリント距離 `distanceFootprintToPoint` で算出。
 *     水平方向は XZ 矩形（AABB のフットプリント）とカメラの最短距離、
 *     垂直方向はカメラ高度 `|y|` を使い `sqrt(ex² + ey² + ez²)` とする。
 *     AABB 全体との最短距離ではなく、カメラが高さ方向で AABB 内にいても
 *     `|y|` が残るため過剰分割を抑制できる（`D = 0` → `max(1, D) = 1`）。
 * - 採用条件: `SSE <= sseThreshold` もしくは `zoom === maxZoom`。
 * - `maxTiles` 超過時はカメラ距離 D の昇順ソート後に先頭 `maxTiles` 件へ打ち切る。
 */
export const computeQuadtreeTiles = (
    opts: QuadtreeTilesOptions
): LodTileEntry[] => {
    const {
        maxZoom,
        minZoom,
        baseCenter,
        tileSizeForZoom,
        frustumPlanes,
        cameraPosition,
        verticalFov,
        viewportHeight,
        sseThreshold = DEFAULT_SSE_THRESHOLD,
        maxElevation = DEFAULT_MAX_ELEVATION,
        maxTiles = DEFAULT_MAX_TILES,
        rootSearchRadius = DEFAULT_ROOT_SEARCH_RADIUS,
        _maxVisited,
    } = opts;

    if (maxZoom < minZoom) return [];

    // SSE 分母の定数部分。fov=0 等の極小値で発散しないよう下限を設定。
    const tanHalfFov = Math.tan(verticalFov / 2);
    const sseDenomBase = 2 * Math.max(1e-6, tanHalfFov);

    // 暴発的な再帰を防ぐ安全弁。通常運用では到達しない。
    const maxVisited = _maxVisited ?? Math.max(maxTiles, 256) * 32;
    let visited = 0;
    let maxVisitedReached = false;

    const shouldAccept = (tileSize: number, distance: number, zoom: number): boolean => {
        if (zoom >= maxZoom) return true;
        const d = Math.max(1, distance);
        const sse = (tileSize * viewportHeight) / (d * sseDenomBase);
        return sse <= sseThreshold;
    };

    const accepted: { entry: LodTileEntry; distance: number }[] = [];

    /**
     * Quadtree 再帰探索。
     * 視錐台外なら即 return。採用条件を満たせば accepted に追加、
     * そうでなければ 4 子ノードへ分岐。
     * 訪問上限（maxVisited）超過時は視錐台内なら強制採用（粗い LOD フォールバック）。
     */
    const traverse = (coord: TileCoord): void => {
        const overBudget = visited >= maxVisited;
        if (!overBudget) visited++;

        // タイル座標範囲外（地球の外）を除外。
        // 低 zoom の root 格子が地球範囲を越えて無効タイル 404 を量産するのを防ぐ。
        const limit = 1 << coord.zoom;
        if (coord.x < 0 || coord.x >= limit || coord.y < 0 || coord.y >= limit) return;

        const aabb = computeTileAABB(coord, baseCenter, tileSizeForZoom, maxElevation);
        if (!isAABBInFrustum(
            aabb.minX, aabb.minY, aabb.minZ,
            aabb.maxX, aabb.maxY, aabb.maxZ,
            frustumPlanes,
        )) return;

        // SSE 計算はフットプリント距離（カメラ高度＋水平距離）を使う。
        // AABB 全体との最短距離だとカメラがその高さ内に入っているとき 0 になり、過剰分割になる。
        const distance = distanceFootprintToPoint(aabb, cameraPosition);
        const tileSize = tileSizeForZoom(coord.zoom);

        // 訪問上限超過: これ以上分割せず、視錐台内なら現在の zoom で強制採用する。
        // 黙って破棄するとタイル欠け（穴）が発生するため、粗い LOD へフォールバックする。
        if (overBudget) {
            maxVisitedReached = true;
            accepted.push({
                entry: { coord, tileSize },
                distance,
            });
            return;
        }

        if (shouldAccept(tileSize, distance, coord.zoom)) {
            accepted.push({
                entry: { coord, tileSize },
                distance,
            });
            return;
        }

        const nextZoom = coord.zoom + 1;
        for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
                traverse({
                    zoom: nextZoom,
                    x: coord.x * 2 + sx,
                    y: coord.y * 2 + sy,
                });
            }
        }
    };

    // root 集合: minZoom 中心からの ±rootSearchRadius 格子。
    const rootCenter = convertTileZoom(baseCenter, minZoom);
    for (let dy = -rootSearchRadius; dy <= rootSearchRadius; dy++) {
        for (let dx = -rootSearchRadius; dx <= rootSearchRadius; dx++) {
            traverse({
                zoom: minZoom,
                x: rootCenter.x + dx,
                y: rootCenter.y + dy,
            });
        }
    }

    if (maxVisitedReached) {
        console.warn(
            `[visibleTiles] maxVisited limit (${maxVisited}) reached; ` +
            `${accepted.length} tiles force-accepted at coarser LOD to prevent gaps.`,
        );
    }

    accepted.sort((a, b) => a.distance - b.distance);
    return accepted.slice(0, maxTiles).map((a) => a.entry);
};
