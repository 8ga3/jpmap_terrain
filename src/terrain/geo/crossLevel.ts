/**
 * クロスレベル標高スナップ。
 *
 * LOD 境界（細タイルが粗タイルに隣接）で残る陰影シームを消すため、細タイルの境界辺
 * 頂点の標高を、隣接する粗タイルのメッシュ表面にスナップする。平面版の
 * `src/terrain/tileStitching.ts`（`selectCoarseEdgeNeighbors` / `stitchTileEdgesCrossLevel`）
 * と同じ考え方。標高スナップは ECEF 変換前の「標高値」に対する処理なので座標系非依存で、
 * グローブ版にもそのまま適用できる。PoC  を本体共有モジュールへ昇格。
 */
import { TILE_SIZE } from "../gsiTile";
import { sampleElevBilinear } from "./elevSample";

/** タイル一意キー（globeLod.tileKey と同形式）。 */
const key = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

export type EdgeDir = "north" | "south" | "west" | "east";

/** 細タイルの 1 辺がスナップ対象とする粗タイル。 */
export interface CoarseEdge {
    edge: EdgeDir;
    coarseElev: Float32Array;
    coarseX: number;
    coarseY: number;
    /** 親 1 辺あたりの細タイル数 = 2^(fineZoom - coarseZoom)。 */
    scale: number;
}

export interface TileCoord {
    zoom: number;
    x: number;
    y: number;
}

/**
 * 細タイルの各辺について、隣接が粗タイルなら対応する粗タイル（CoarseEdge）を返す。
 * 平面版 `selectCoarseEdgeNeighbors` と同じ判定:
 * - 同 zoom 隣接が選択集合にあればクロスレベル不要（スキップ）。
 * - そうでなければ z-1 → minZoom の順で、当該辺に接する粗タイルを探す。
 *
 * @returns edges: スナップ対象の辺。pending: 必要な粗タイルが選択済みだが標高未ロードで
 *          ビルドを遅延すべき場合 true。
 */
export const selectCoarseEdges = (
    coord: TileCoord,
    isDesired: (k: string) => boolean,
    getElev: (k: string) => Float32Array | undefined,
    isFailed: (k: string) => boolean,
    minZoom: number,
): { edges: CoarseEdge[]; pending: boolean } => {
    const { zoom: z, x, y } = coord;
    const dirs: { dir: EdgeDir; dx: number; dy: number }[] = [
        { dir: "north", dx: 0, dy: -1 },
        { dir: "south", dx: 0, dy: 1 },
        { dir: "west", dx: -1, dy: 0 },
        { dir: "east", dx: 1, dy: 0 },
    ];
    const edges: CoarseEdge[] = [];
    let pending = false;

    for (const { dir, dx, dy } of dirs) {
        // 同 zoom 隣接が選択されていればクロスレベル不要。
        if (isDesired(key(z, x + dx, y + dy))) continue;

        for (let zc = z - 1; zc >= minZoom; zc--) {
            const diff = z - zc;
            const scale = 1 << diff;
            const subX = x & (scale - 1);
            const subY = y & (scale - 1);
            // この細タイルが粗親の当該辺に接しているか（接していなければ別の粗タイルが隣接）。
            let onParentEdge: boolean;
            switch (dir) {
                case "north": onParentEdge = subY === 0; break;
                case "south": onParentEdge = subY === scale - 1; break;
                case "west": onParentEdge = subX === 0; break;
                case "east": onParentEdge = subX === scale - 1; break;
            }
            if (!onParentEdge) continue;

            const cx = (x + dx) >> diff;
            const cy = (y + dy) >> diff;
            const ck = key(zc, cx, cy);
            if (!isDesired(ck)) continue;
            const elev = getElev(ck);
            if (!elev) {
                // 粗タイルは選択済みだが標高ロード失敗ならスナップ不可、それ以外は遅延。
                if (!isFailed(ck)) pending = true;
                break;
            }
            edges.push({ edge: dir, coarseElev: elev, coarseX: cx, coarseY: cy, scale });
            break;
        }
    }
    return { edges, pending };
};

/**
 * 粗メッシュ頂点の標高。`buildGlobeTileMeshData` が頂点標高を bilinear サンプル
 * （`sampleElevBilinear`）で求めるのと同一の式で評価する。最近傍だと segments が
 * TILE_SIZE を割り切らない場合に実際の粗タイルメッシュ表面とズレ、境界シームが残る。
 */
const coarseVertexElev = (
    coarseElev: Float32Array,
    gr: number,
    gc: number,
    segments: number,
): number =>
    sampleElevBilinear(
        coarseElev,
        (gc / segments) * TILE_SIZE,
        (gr / segments) * TILE_SIZE,
    );

/** 粗メッシュ表面の標高をグリッド座標 (gx,gy)∈[0,segments] で bilinear 評価。 */
const sampleCoarseMeshElev = (
    coarseElev: Float32Array,
    gx: number,
    gy: number,
    segments: number,
): number => {
    const cx = Math.max(0, Math.min(segments, gx));
    const cy = Math.max(0, Math.min(segments, gy));
    const gx0 = Math.floor(cx);
    const gy0 = Math.floor(cy);
    const gx1 = Math.min(gx0 + 1, segments);
    const gy1 = Math.min(gy0 + 1, segments);
    const tx = cx - gx0;
    const ty = cy - gy0;
    const e00 = coarseVertexElev(coarseElev, gy0, gx0, segments);
    const e10 = coarseVertexElev(coarseElev, gy0, gx1, segments);
    const e01 = coarseVertexElev(coarseElev, gy1, gx0, segments);
    const e11 = coarseVertexElev(coarseElev, gy1, gx1, segments);
    const a = e00 * (1 - tx) + e10 * tx;
    const b = e01 * (1 - tx) + e11 * tx;
    return a * (1 - ty) + b * ty;
};

/**
 * 細タイルの境界辺頂点の標高をスナップ値で返す（境界以外/対象外辺は null）。
 *
 * 細頂点のグローバルピクセル座標を粗タイルのローカルグリッド座標へ写像し、
 * 粗メッシュ表面を bilinear 評価する。境界辺は粗メッシュの辺（gx か gy が 0/segments）
 * 上に乗るため、bilinear は粗メッシュ辺上の線形補間に縮退し、隙間なく一致する。
 */
export const snapEdgeElevation = (
    edges: readonly CoarseEdge[],
    row: number,
    col: number,
    segments: number,
    tx: number,
    ty: number,
    pxF: number,
    pyF: number,
): number | null => {
    if (edges.length === 0) return null;
    let edge: CoarseEdge | undefined;
    // 角は北/南辺を優先（隣接細タイルとの角不一致を避けるため一方に固定）。
    if (row === 0) edge = edges.find((e) => e.edge === "north");
    else if (row === segments) edge = edges.find((e) => e.edge === "south");
    if (!edge) {
        if (col === 0) edge = edges.find((e) => e.edge === "west");
        else if (col === segments) edge = edges.find((e) => e.edge === "east");
    }
    if (!edge) return null;

    const fgx = tx * TILE_SIZE + pxF;
    const fgy = ty * TILE_SIZE + pyF;
    // 細グローバルピクセル → 粗ローカルピクセル[0,TILE_SIZE] → 粗グリッド[0,segments]。
    const cgx = fgx / edge.scale - edge.coarseX * TILE_SIZE;
    const cgy = fgy / edge.scale - edge.coarseY * TILE_SIZE;
    const gx = (cgx / TILE_SIZE) * segments;
    const gy = (cgy / TILE_SIZE) * segments;
    return sampleCoarseMeshElev(edge.coarseElev, gx, gy, segments);
};
