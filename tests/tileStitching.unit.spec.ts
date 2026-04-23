import { describe, it, expect } from "@jest/globals";
import { nanMean, stitchTileEdges, StitchNeighbors } from "../src/terrain/tileStitching";

// --- nanMean ---

describe("nanMean", () => {
    it("通常の数値の平均を返す", () => {
        expect(nanMean([2, 4, 6])).toBe(4);
    });

    it("NaN を除外して平均を計算する", () => {
        expect(nanMean([NaN, 4, 6])).toBe(5);
    });

    it("すべて NaN なら NaN を返す", () => {
        expect(nanMean([NaN, NaN, NaN])).toBeNaN();
    });

    it("空配列は NaN を返す", () => {
        expect(nanMean([])).toBeNaN();
    });

    it("要素1つでもそのまま返す", () => {
        expect(nanMean([42])).toBe(42);
    });

    it("NaN 1つ + 有効値1つ → 有効値を返す", () => {
        expect(nanMean([NaN, 10])).toBe(10);
    });
});

// --- stitchTileEdges ---

/** size×size の Float32Array を指定値で埋める */
const fill = (size: number, value: number): Float32Array =>
    new Float32Array(size * size).fill(value);

/** size×size の Float32Array を NaN で埋める */
const fillNaN = (size: number): Float32Array => {
    const arr = new Float32Array(size * size);
    arr.fill(NaN);
    return arr;
};

describe("stitchTileEdges", () => {
    const S = 4; // 小さいタイルサイズでテスト

    it("隣接タイルなしの場合は何も変わらない", () => {
        const target = fill(S, 10);
        const copy = new Float32Array(target);
        stitchTileEdges(target, {}, S);
        expect(target).toEqual(copy);
    });

    it("上辺を隣接タイルと平均する（角を除く）", () => {
        const target = fill(S, 10);
        const top = fill(S, 20);
        stitchTileEdges(target, { top }, S);

        // 上辺の col=1,2 (角を除く) は (10+20)/2 = 15
        expect(target[1]).toBe(15);
        expect(target[2]).toBe(15);

        // 内部ピクセルは変わらない
        expect(target[S + 1]).toBe(10);
    });

    it("下辺を隣接タイルと平均する（角を除く）", () => {
        const target = fill(S, 10);
        const bottom = fill(S, 30);
        stitchTileEdges(target, { bottom }, S);

        const lastRow = (S - 1) * S;
        expect(target[lastRow + 1]).toBe(20);
        expect(target[lastRow + 2]).toBe(20);
    });

    it("左辺を隣接タイルと平均する（角を除く）", () => {
        const target = fill(S, 10);
        const left = fill(S, 6);
        stitchTileEdges(target, { left }, S);

        // row=1,2 の col=0 は (10+6)/2 = 8
        expect(target[1 * S]).toBe(8);
        expect(target[2 * S]).toBe(8);
    });

    it("右辺を隣接タイルと平均する（角を除く）", () => {
        const target = fill(S, 10);
        const right = fill(S, 0);
        stitchTileEdges(target, { right }, S);

        // row=1,2 の col=last は (10+0)/2 = 5
        expect(target[1 * S + (S - 1)]).toBe(5);
        expect(target[2 * S + (S - 1)]).toBe(5);
    });

    it("左上角を最大4タイルで平均する", () => {
        const target = fill(S, 10);
        const top = fill(S, 20);
        const left = fill(S, 30);
        const topLeft = fill(S, 40);
        stitchTileEdges(target, { top, left, topLeft }, S);

        // 左上 = mean(10,20,30,40) = 25
        expect(target[0]).toBe(25);
    });

    it("右上角を最大4タイルで平均する", () => {
        const target = fill(S, 10);
        const top = fill(S, 20);
        const right = fill(S, 30);
        const topRight = fill(S, 40);
        stitchTileEdges(target, { top, right, topRight }, S);

        expect(target[S - 1]).toBe(25);
    });

    it("左下角を最大4タイルで平均する", () => {
        const target = fill(S, 10);
        const bottom = fill(S, 20);
        const left = fill(S, 30);
        const bottomLeft = fill(S, 40);
        stitchTileEdges(target, { bottom, left, bottomLeft }, S);

        expect(target[(S - 1) * S]).toBe(25);
    });

    it("右下角を最大4タイルで平均する", () => {
        const target = fill(S, 10);
        const bottom = fill(S, 20);
        const right = fill(S, 30);
        const bottomRight = fill(S, 40);
        stitchTileEdges(target, { bottom, right, bottomRight }, S);

        expect(target[(S - 1) * S + (S - 1)]).toBe(25);
    });

    it("角に隣接タイルが2つだけのとき2タイル平均になる", () => {
        const target = fill(S, 10);
        const top = fill(S, 30);
        stitchTileEdges(target, { top }, S);

        // 左上 = mean(10, 30) = 20（left, topLeft なし）
        expect(target[0]).toBe(20);
    });

    it("NaN を含む隣接タイルの辺はNaNを除外して平均する", () => {
        const target = fill(S, 10);
        const top = fillNaN(S);
        stitchTileEdges(target, { top }, S);

        // top が全 NaN → target のみで平均 = 10 (変更なし)
        expect(target[1]).toBe(10);
        expect(target[2]).toBe(10);
    });

    it("target も隣接タイルも NaN の場合は変更しない", () => {
        const target = fillNaN(S);
        const top = fillNaN(S);
        stitchTileEdges(target, { top }, S);

        expect(target[1]).toBeNaN();
        expect(target[2]).toBeNaN();
    });

    it("target の辺が NaN、隣接が有効値なら隣接値になる", () => {
        const target = fillNaN(S);
        const top = fill(S, 50);
        stitchTileEdges(target, { top }, S);

        // target[1] = NaN, top の対応ピクセルは 50 → mean = 50
        expect(target[1]).toBe(50);
        expect(target[2]).toBe(50);
    });

    it("NaN 角: 一部のみ有効値なら有効値だけで平均する", () => {
        const target = fill(S, 10);
        const top = fillNaN(S);
        const left = fill(S, 30);
        const topLeft = fillNaN(S);
        stitchTileEdges(target, { top, left, topLeft }, S);

        // mean(10, NaN, 30, NaN) = mean(10, 30) = 20
        expect(target[0]).toBe(20);
    });

    it("全辺と全角を同時に処理できる", () => {
        const target = fill(S, 0);
        const neighbors: StitchNeighbors = {
            top: fill(S, 4),
            bottom: fill(S, 4),
            left: fill(S, 4),
            right: fill(S, 4),
            topLeft: fill(S, 4),
            topRight: fill(S, 4),
            bottomLeft: fill(S, 4),
            bottomRight: fill(S, 4),
        };
        stitchTileEdges(target, neighbors, S);

        // 辺 = (0+4)/2 = 2
        expect(target[1]).toBe(2); // top edge
        expect(target[(S - 1) * S + 1]).toBe(2); // bottom edge
        expect(target[1 * S]).toBe(2); // left edge
        expect(target[1 * S + (S - 1)]).toBe(2); // right edge

        // 角 = mean(0,4,4,4) = 3
        expect(target[0]).toBe(3);
        expect(target[S - 1]).toBe(3);
        expect(target[(S - 1) * S]).toBe(3);
        expect(target[(S - 1) * S + (S - 1)]).toBe(3);

        // 内部 = 変わらない
        expect(target[S + 1]).toBe(0);
    });

    it("実際のタイルサイズ 256 でも動作する", () => {
        const SIZE = 256;
        const target = fill(SIZE, 100);
        const right = fill(SIZE, 200);
        stitchTileEdges(target, { right }, SIZE);

        // 右辺 row=1 col=255 = (100+200)/2 = 150
        expect(target[1 * SIZE + 255]).toBe(150);
        // 内部は変わらない
        expect(target[1 * SIZE + 254]).toBe(100);
    });
});
