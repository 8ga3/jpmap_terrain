/**
 * geo/crossLevel の単体テスト (Issue #275 Phase 1)。
 *
 * - selectCoarseEdges: 同 zoom 隣接が選択済みならスキップ / 粗親辺の検出 / 標高未ロードで pending
 * - snapEdgeElevation: 境界辺で粗メッシュ表面値を返し、辺以外は null
 */

import { describe, it, expect } from "@jest/globals";

import { TILE_SIZE } from "../src/terrain/gsiTile";
import {
    selectCoarseEdges,
    snapEdgeElevation,
    type CoarseEdge,
} from "../src/terrain/geo/crossLevel";

/** 一定標高 value で埋めた粗タイル標高ラスタ。 */
const constElev = (value: number): Float32Array =>
    new Float32Array(TILE_SIZE * TILE_SIZE).fill(value);

describe("selectCoarseEdges", () => {
    // 細タイル (12, 10, 4)。y=4 偶数なので北隣 (12,10,3) は別の粗親に属する。
    const fine = { zoom: 12, x: 10, y: 4 };
    const NORTH_COARSE = "11/5/1"; // cx=(10)>>1=5, cy=(4-1)>>1=1

    it("北辺の粗親を検出する", () => {
        const elev = constElev(100);
        const { edges, pending } = selectCoarseEdges(
            fine,
            (k) => k === NORTH_COARSE,
            (k) => (k === NORTH_COARSE ? elev : undefined),
            () => false,
            11,
        );
        expect(pending).toBe(false);
        const north = edges.find((e) => e.edge === "north");
        expect(north).toBeDefined();
        expect(north?.coarseX).toBe(5);
        expect(north?.coarseY).toBe(1);
        expect(north?.scale).toBe(2);
    });

    it("同 zoom 隣接が選択済みの辺はスキップ", () => {
        const elev = constElev(100);
        // 北の同 zoom 隣接 "12/10/3" が desired なら north はクロスレベル不要。
        const { edges } = selectCoarseEdges(
            fine,
            (k) => k === "12/10/3" || k === NORTH_COARSE,
            (k) => (k === NORTH_COARSE ? elev : undefined),
            () => false,
            11,
        );
        expect(edges.find((e) => e.edge === "north")).toBeUndefined();
    });

    it("粗親が選択済みだが標高未ロードなら pending", () => {
        const { edges, pending } = selectCoarseEdges(
            fine,
            (k) => k === NORTH_COARSE,
            () => undefined, // 標高未ロード
            () => false, // 失敗もしていない
            11,
        );
        expect(pending).toBe(true);
        expect(edges.find((e) => e.edge === "north")).toBeUndefined();
    });

    it("粗親が選択済みで標高ロード失敗なら pending にしない", () => {
        const { pending } = selectCoarseEdges(
            fine,
            (k) => k === NORTH_COARSE,
            () => undefined,
            (k) => k === NORTH_COARSE, // failed
            11,
        );
        expect(pending).toBe(false);
    });
});

describe("snapEdgeElevation", () => {
    const segments = 4;
    const edges: CoarseEdge[] = [
        { edge: "north", coarseElev: constElev(123), coarseX: 5, coarseY: 1, scale: 2 },
    ];

    it("edges 空なら null", () => {
        expect(snapEdgeElevation([], 0, 0, segments, 10, 4, 0, 0)).toBeNull();
    });

    it("北辺(row=0)は粗メッシュ表面値を返す", () => {
        // 細タイル (12,10,4) の北辺頂点。粗標高は一定なので 123 が返る。
        const v = snapEdgeElevation(edges, 0, 2, segments, 10, 4, (2 / segments) * TILE_SIZE, 0);
        expect(v).toBeCloseTo(123, 6);
    });

    it("内部頂点(辺でない)は null", () => {
        const v = snapEdgeElevation(
            edges,
            2,
            2,
            segments,
            10,
            4,
            (2 / segments) * TILE_SIZE,
            (2 / segments) * TILE_SIZE,
        );
        expect(v).toBeNull();
    });
});
