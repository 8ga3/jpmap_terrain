import { describe, it, expect } from "@jest/globals";
import {
    nanMean,
    stitchTileEdges,
    StitchNeighbors,
    stitchTileEdgesCrossLevel,
    CoarseEdgeNeighbor,
} from "../src/terrain/tileStitching";

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

// --- stitchTileEdgesCrossLevel ---

describe("stitchTileEdgesCrossLevel", () => {
    const S = 8; // サブタイル領域 (subSize) を 4 に保てる適度なサイズ

    it("隣接が空なら何も変わらない", () => {
        const target = fill(S, 10);
        const copy = new Float32Array(target);
        stitchTileEdgesCrossLevel(target, [], S);
        expect(target).toEqual(copy);
    });

    it("上辺: 粗タイル一定値で target 上辺がスナップされる", () => {
        const target = fill(S, 10);
        const coarse = fill(S, 50);
        // scale=2, subX=0, subY=0 → target は粗タイルの左上の子
        const neighbor: CoarseEdgeNeighbor = {
            elevation: coarse,
            direction: "top",
            subX: 0,
            subY: 0,
            scale: 2,
        };
        stitchTileEdgesCrossLevel(target, [neighbor], S);
        // 粗タイルが一定値なので target 上辺は全て 50 にスナップ
        for (let i = 0; i < S; i++) expect(target[i]).toBe(50);
        // 内部は変わらない
        expect(target[S]).toBe(10);
        expect(target[S + 1]).toBe(10);
    });

    it("下辺: 粗タイルの上辺の対応区間にスナップされる", () => {
        const target = fill(S, 10);
        const coarse = fill(S, 30);
        const neighbor: CoarseEdgeNeighbor = {
            elevation: coarse,
            direction: "bottom",
            subX: 1,
            subY: 1,
            scale: 2,
        };
        stitchTileEdgesCrossLevel(target, [neighbor], S);
        const lastRow = (S - 1) * S;
        for (let i = 0; i < S; i++) expect(target[lastRow + i]).toBe(30);
    });

    it("左辺と右辺: 一定値の粗タイルにスナップされる", () => {
        const target = fill(S, 10);
        const coarseL = fill(S, 70);
        const coarseR = fill(S, 80);
        const neighbors: CoarseEdgeNeighbor[] = [
            { elevation: coarseL, direction: "left", subX: 0, subY: 0, scale: 2 },
            { elevation: coarseR, direction: "right", subX: 1, subY: 0, scale: 2 },
        ];
        stitchTileEdgesCrossLevel(target, neighbors, S);
        for (let r = 0; r < S; r++) {
            expect(target[r * S]).toBe(70);
            expect(target[r * S + (S - 1)]).toBe(80);
        }
    });

    it("粗タイルの値が辺方向に勾配を持つ場合、線形補間で間の値になる", () => {
        // 粗タイル下辺 (row=last) を col 方向に 0..S-1 の勾配にする
        const coarse = new Float32Array(S * S);
        for (let r = 0; r < S; r++) {
            for (let c = 0; c < S; c++) {
                coarse[r * S + c] = r === S - 1 ? c : 0;
            }
        }
        const target = fill(S, 100);
        // scale=2, subX=0 → target 上辺は粗タイル下辺の col=0..3 範囲を読む。
        // along = 0*4 + u*(4-1) = u*3, u = i/(S-1)。
        // 補間値は連続値で along（NaN なし両端有効なので a*(1-t)+b*t = along）。
        const neighbor: CoarseEdgeNeighbor = {
            elevation: coarse,
            direction: "top",
            subX: 0,
            subY: 0,
            scale: 2,
        };
        stitchTileEdgesCrossLevel(target, [neighbor], S);
        for (let i = 0; i < S; i++) {
            const expected = (i / (S - 1)) * 3;
            expect(target[i]).toBeCloseTo(expected, 6);
        }
    });

    it("粗タイル両端 NaN の場合は target を変更しない", () => {
        const coarse = fillNaN(S);
        const target = fill(S, 99);
        const neighbor: CoarseEdgeNeighbor = {
            elevation: coarse,
            direction: "top",
            subX: 0,
            subY: 0,
            scale: 2,
        };
        stitchTileEdgesCrossLevel(target, [neighbor], S);
        for (let i = 0; i < S; i++) expect(target[i]).toBe(99);
    });

    it("粗タイル片側 NaN なら有効値で埋める", () => {
        // 粗タイル下辺 col=0 のみ 50、他は NaN
        const coarse = fillNaN(S);
        coarse[(S - 1) * S + 0] = 50;
        const target = fill(S, 10);
        const neighbor: CoarseEdgeNeighbor = {
            elevation: coarse,
            direction: "top",
            subX: 0,
            subY: 0,
            scale: 2,
        };
        stitchTileEdgesCrossLevel(target, [neighbor], S);
        // i=0: a=coarse[last,0]=50, b=coarse[last,1]=NaN → 50 にスナップ
        expect(target[0]).toBe(50);
    });

    it("scale=4: subSize=2 でも適切な範囲を参照する", () => {
        const SS = 8;
        // 粗タイル下辺 col=4..6 範囲（subX=2, scale=4 → along base = 2*2=4）が値 7、その他 0
        const coarse = new Float32Array(SS * SS);
        for (let c = 4; c <= 6; c++) coarse[(SS - 1) * SS + c] = 7;
        const target = fill(SS, 0);
        const neighbor: CoarseEdgeNeighbor = {
            elevation: coarse,
            direction: "top",
            subX: 2,
            subY: 0,
            scale: 4,
        };
        stitchTileEdgesCrossLevel(target, [neighbor], SS);
        // i=0: along=4 → coarse[last,4]=7 ・i=last(7): along=4+1=5 → coarse[last,5]=7
        expect(target[0]).toBe(7);
        expect(target[SS - 1]).toBe(7);
    });
});
