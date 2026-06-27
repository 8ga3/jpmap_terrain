/** 隣接タイルの標高データを辺・頂点で縫い合わせるユーティリティ */

import { isInvalidElev } from "./gsiTile";

/** 隣接タイルの標高データ（同一zoomレベルのみ） */
export interface StitchNeighbors {
    top?: Float32Array;
    bottom?: Float32Array;
    left?: Float32Array;
    right?: Float32Array;
    topLeft?: Float32Array;
    topRight?: Float32Array;
    bottomLeft?: Float32Array;
    bottomRight?: Float32Array;
}

/** 無効値(NaN/NO_DATA_SENTINEL)を除外した平均値を返す。すべて無効なら NaN */
export const nanMean = (values: readonly number[]): number => {
    let sum = 0;
    let count = 0;
    for (const v of values) {
        if (!isInvalidElev(v)) {
            sum += v;
            count++;
        }
    }
    return count > 0 ? sum / count : NaN;
};

/**
 * タイルの辺を隣接タイルと縫い合わせる。
 * target を in-place で変更する。
 *
 * - 辺のピクセル（角を除く）は隣接タイルとの2値平均
 * - 角のピクセルは最大4タイルの平均
 * - NaN は平均計算から除外。全値が NaN の場合は変更しない
 */
export const stitchTileEdges = (
    target: Float32Array,
    neighbors: StitchNeighbors,
    tileSize: number,
): void => {
    const last = tileSize - 1;

    // --- 辺の縫い合わせ（角を除く） ---

    // 上辺: target row=0 ↔ top row=last
    if (neighbors.top) {
        for (let col = 1; col < last; col++) {
            const tIdx = col;
            const nIdx = last * tileSize + col;
            const avg = nanMean([target[tIdx], neighbors.top[nIdx]]);
            if (!Number.isNaN(avg)) target[tIdx] = avg;
        }
    }

    // 下辺: target row=last ↔ bottom row=0
    if (neighbors.bottom) {
        for (let col = 1; col < last; col++) {
            const tIdx = last * tileSize + col;
            const nIdx = col;
            const avg = nanMean([target[tIdx], neighbors.bottom[nIdx]]);
            if (!Number.isNaN(avg)) target[tIdx] = avg;
        }
    }

    // 左辺: target col=0 ↔ left col=last
    if (neighbors.left) {
        for (let row = 1; row < last; row++) {
            const tIdx = row * tileSize;
            const nIdx = row * tileSize + last;
            const avg = nanMean([target[tIdx], neighbors.left[nIdx]]);
            if (!Number.isNaN(avg)) target[tIdx] = avg;
        }
    }

    // 右辺: target col=last ↔ right col=0
    if (neighbors.right) {
        for (let row = 1; row < last; row++) {
            const tIdx = row * tileSize + last;
            const nIdx = row * tileSize;
            const avg = nanMean([target[tIdx], neighbors.right[nIdx]]);
            if (!Number.isNaN(avg)) target[tIdx] = avg;
        }
    }

    // --- 角の縫い合わせ（最大4タイル平均） ---

    // 左上 (0, 0)
    {
        const values: number[] = [target[0]];
        if (neighbors.top) values.push(neighbors.top[last * tileSize]);
        if (neighbors.left) values.push(neighbors.left[last]);
        if (neighbors.topLeft) values.push(neighbors.topLeft[last * tileSize + last]);
        const avg = nanMean(values);
        if (!Number.isNaN(avg)) target[0] = avg;
    }

    // 右上 (0, last)
    {
        const values: number[] = [target[last]];
        if (neighbors.top) values.push(neighbors.top[last * tileSize + last]);
        if (neighbors.right) values.push(neighbors.right[0]);
        if (neighbors.topRight) values.push(neighbors.topRight[last * tileSize]);
        const avg = nanMean(values);
        if (!Number.isNaN(avg)) target[last] = avg;
    }

    // 左下 (last, 0)
    {
        const values: number[] = [target[last * tileSize]];
        if (neighbors.bottom) values.push(neighbors.bottom[0]);
        if (neighbors.left) values.push(neighbors.left[last * tileSize + last]);
        if (neighbors.bottomLeft) values.push(neighbors.bottomLeft[last]);
        const avg = nanMean(values);
        if (!Number.isNaN(avg)) target[last * tileSize] = avg;
    }

    // 右下 (last, last)
    {
        const values: number[] = [target[last * tileSize + last]];
        if (neighbors.bottom) values.push(neighbors.bottom[last]);
        if (neighbors.right) values.push(neighbors.right[last * tileSize]);
        if (neighbors.bottomRight) values.push(neighbors.bottomRight[0]);
        const avg = nanMean(values);
        if (!Number.isNaN(avg)) target[last * tileSize + last] = avg;
    }
};

/** タイル座標（zoom/x/y）。stitching ユーティリティ内では tileManager とは独立に扱う。 */
export interface CoarseTileCoord {
    zoom: number;
    x: number;
    y: number;
}

/**
 * `selectCoarseEdgeNeighbors` のための粗タイル参照ソース。
 * elevation はそのままクロスレベル縫い合わせに使われる（filled 優先）。
 * - `wasAllNaN && !unblocked` の場合は誤伝搬防止のため候補から除外する。
 */
export interface CoarseTileSource {
    elevation: Float32Array;
    wasAllNaN?: boolean;
    unblocked?: boolean;
}

/**
 * クロスレベル縫い合わせ候補（粗タイル隣接）を選定する純関数。
 *
 * tileManager の active/pendingRelease/hidden 状態を抽象化したコールバックで受け取り、
 * pure に判定する。判定方針は次のとおり:
 *  - 同 zoom 隣接が「描画中（active かつ hidden でない）」場合のみクロスレベルを抑止する
 *  - 粗 zoom 候補は active だけでなく `pendingRelease` 中の旧タイルも参照する
 *
 * @param coord 対象タイル座標
 * @param minZoom 最小 zoom（粗 zoom 探索の下限）
 * @param isSameZoomVisible 同 zoom 隣接が実画面に出ているかを判定（true なら cross-level 不要）
 * @param lookupCoarse 粗 zoom 隣接の参照ソースを返す。存在しない場合は undefined
 */
export const selectCoarseEdgeNeighbors = (
    coord: CoarseTileCoord,
    minZoom: number,
    isSameZoomVisible: (c: CoarseTileCoord) => boolean,
    lookupCoarse: (c: CoarseTileCoord) => CoarseTileSource | undefined,
): CoarseEdgeNeighbor[] => {
    const result: CoarseEdgeNeighbor[] = [];
    const { zoom: z, x, y } = coord;
    const dirs = [
        { dir: "top" as const, ndx: 0, ndy: -1 },
        { dir: "bottom" as const, ndx: 0, ndy: 1 },
        { dir: "left" as const, ndx: -1, ndy: 0 },
        { dir: "right" as const, ndx: 1, ndy: 0 },
    ];
    for (const d of dirs) {
        // 同 zoom 隣接が実画面に出ていればクロスレベル不要
        if (isSameZoomVisible({ zoom: z, x: x + d.ndx, y: y + d.ndy })) continue;

        // 粗 zoom を z-1 から minZoom まで降順で探索（細かい粗 zoom を優先）
        for (let zp = z - 1; zp >= minZoom; zp--) {
            const diff = z - zp;
            const scale = 1 << diff;
            const subX = x & (scale - 1);
            const subY = y & (scale - 1);
            let onParentEdge: boolean;
            switch (d.dir) {
                case "top": onParentEdge = subY === 0; break;
                case "bottom": onParentEdge = subY === scale - 1; break;
                case "left": onParentEdge = subX === 0; break;
                case "right": onParentEdge = subX === scale - 1; break;
            }
            if (!onParentEdge) continue;

            const px = x >> diff;
            const py = y >> diff;
            const src = lookupCoarse({ zoom: zp, x: px + d.ndx, y: py + d.ndy });
            if (!src) continue;
            if (src.wasAllNaN && !src.unblocked) continue;
            result.push({
                elevation: src.elevation,
                direction: d.dir,
                subX,
                subY,
                scale,
            });
            break;
        }
    }
    return result;
};

/** クロスレベル縫い合わせで参照する粗タイル隣接情報 */
export interface CoarseEdgeNeighbor {
    /** 粗タイルの標高データ（target と同じ tileSize 解像度） */
    elevation: Float32Array;
    /** target から見た粗タイルの方向 */
    direction: "top" | "bottom" | "left" | "right";
    /** target が属する親タイル内でのサブ位置 X（0..scale-1） */
    subX: number;
    /** target が属する親タイル内でのサブ位置 Y（0..scale-1） */
    subY: number;
    /** 親 1 辺あたりの target タイル数（= 2^(targetZoom - coarseZoom)） */
    scale: number;
}

/**
 * 異 zoom 隣接（粗タイル）と target タイルの境界辺を縫い合わせる。
 *
 * - target（細タイル）の境界辺の各ピクセルを、粗タイル対応辺の線形補間値で
 *   in-place に上書きする（粗タイル側は変更しない）。
 * - これにより細タイルが粗タイルにスナップされ、T-junction 隙間を解消する。
 * - NaN は補間から除外。両端が NaN の場合はそのピクセルを変更しない。
 * - 角ピクセルは上書きしない。同 zoom 隣接タイルが角を共有する場合に、
 *   隣接細タイル同士で異なる粗サンプル位置にスナップされて角値が不一致となる
 *   （= 同 zoom タイル間に新たな亀裂が生じる）のを防ぐため、角は
 *   `stitchTileEdges`（同 zoom）の処理結果をそのまま保持する。
 */
export const stitchTileEdgesCrossLevel = (
    target: Float32Array,
    coarseNeighbors: readonly CoarseEdgeNeighbor[],
    tileSize: number,
): void => {
    const last = tileSize - 1;
    if (last <= 1) return; // 角しかないサイズでは何もしない

    for (const n of coarseNeighbors) {
        const subSize = tileSize / n.scale; // 粗タイル内で target が占めるピクセル幅
        // 角ピクセル (i=0, i=last) は除外し、辺の内側のみを上書きする。
        for (let i = 1; i < last; i++) {
            const u = i / last; // 0..1（target 辺方向）
            // 粗タイルの対応辺上での位置（連続値）
            const along =
                n.direction === "top" || n.direction === "bottom"
                    ? n.subX * subSize + u * (subSize - 1)
                    : n.subY * subSize + u * (subSize - 1);
            const lo = Math.max(0, Math.min(last, Math.floor(along)));
            const hi = Math.max(0, Math.min(last, lo + 1));
            const t = along - lo;

            let coarseIdxLo: number;
            let coarseIdxHi: number;
            let targetIdx: number;
            switch (n.direction) {
                case "top":
                    // target row=0 ↔ coarse row=last
                    coarseIdxLo = last * tileSize + lo;
                    coarseIdxHi = last * tileSize + hi;
                    targetIdx = i;
                    break;
                case "bottom":
                    // target row=last ↔ coarse row=0
                    coarseIdxLo = lo;
                    coarseIdxHi = hi;
                    targetIdx = last * tileSize + i;
                    break;
                case "left":
                    // target col=0 ↔ coarse col=last
                    coarseIdxLo = lo * tileSize + last;
                    coarseIdxHi = hi * tileSize + last;
                    targetIdx = i * tileSize;
                    break;
                case "right":
                    // target col=last ↔ coarse col=0
                    coarseIdxLo = lo * tileSize;
                    coarseIdxHi = hi * tileSize;
                    targetIdx = i * tileSize + last;
                    break;
            }

            const a = n.elevation[coarseIdxLo];
            const b = n.elevation[coarseIdxHi];
            let v: number;
            const aNaN = isInvalidElev(a);
            const bNaN = isInvalidElev(b);
            if (aNaN && bNaN) continue;
            else if (aNaN) v = b;
            else if (bNaN) v = a;
            else v = a * (1 - t) + b * t;
            target[targetIdx] = v;
        }
    }
};
