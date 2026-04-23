/** 隣接タイルの標高データを辺・頂点で縫い合わせるユーティリティ */

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

/** NaN を除外した平均値を返す。すべて NaN なら NaN */
export const nanMean = (values: readonly number[]): number => {
    let sum = 0;
    let count = 0;
    for (const v of values) {
        if (!Number.isNaN(v)) {
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
