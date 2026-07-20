/**
 * terrain/diorama/dioramaSkirt の単体テスト。
 *
 * - 頂点数・レイアウト（上端n・下端n・底面中心1）
 * - 上端頂点は入力の外周リングと同一座標
 * - 下端頂点は同じ x,z で y=baseY
 * - 側面壁の三角形数・底面の三角形数
 * - 頂点数不足（<3）は RangeError
 */
import { describe, it, expect } from "vitest";

import { buildDioramaSkirtGeometry, type DioramaSkirtRingPoint } from "../src/terrain/diorama/dioramaSkirt";

/** 半径1の正n角形リングを生成する（テスト用）。 */
const makeRing = (n: number, y = 0): DioramaSkirtRingPoint[] =>
    Array.from({ length: n }, (_, i) => {
        const angle = (2 * Math.PI * i) / n;
        return { x: Math.sin(angle), y, z: Math.cos(angle) };
    });

describe("buildDioramaSkirtGeometry", () => {
    it("頂点数は 2n+1（上端n・下端n・底面中心1）", () => {
        const ring = makeRing(8, 10);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        expect(geometry.positions.length).toBe((8 * 2 + 1) * 3);
    });

    it("上端頂点([0..n-1])は入力の外周リングと同一座標", () => {
        const ring = makeRing(6, 42);
        const geometry = buildDioramaSkirtGeometry(ring, -10);
        for (let i = 0; i < ring.length; i++) {
            expect(geometry.positions[i * 3]).toBeCloseTo(ring[i].x, 6);
            expect(geometry.positions[i * 3 + 1]).toBeCloseTo(ring[i].y, 6);
            expect(geometry.positions[i * 3 + 2]).toBeCloseTo(ring[i].z, 6);
        }
    });

    it("下端頂点([n..2n-1])は同じx,zでy=baseY", () => {
        const n = 6;
        const ring = makeRing(n, 42);
        const baseY = -123.5;
        const geometry = buildDioramaSkirtGeometry(ring, baseY);
        for (let i = 0; i < n; i++) {
            const idx = n + i;
            expect(geometry.positions[idx * 3]).toBeCloseTo(ring[i].x, 6);
            expect(geometry.positions[idx * 3 + 1]).toBeCloseTo(baseY, 6);
            expect(geometry.positions[idx * 3 + 2]).toBeCloseTo(ring[i].z, 6);
        }
    });

    it("底面中心頂点([2n])はx=0,z=0・y=baseY", () => {
        const n = 8;
        const ring = makeRing(n);
        const baseY = -50;
        const geometry = buildDioramaSkirtGeometry(ring, baseY);
        const idx = n * 2;
        expect(geometry.positions[idx * 3]).toBeCloseTo(0, 9);
        expect(geometry.positions[idx * 3 + 1]).toBeCloseTo(baseY, 9);
        expect(geometry.positions[idx * 3 + 2]).toBeCloseTo(0, 9);
    });

    it("三角形数は側面壁 2n + 底面 n = 3n", () => {
        const n = 10;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -1);
        expect(geometry.indices.length).toBe(3 * n * 3);
    });

    it("インデックスの最大値は頂点数-1を超えない", () => {
        const n = 12;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -1);
        const maxIndex = Math.max(...geometry.indices);
        const vertexCount = n * 2 + 1;
        expect(maxIndex).toBe(vertexCount - 1);
    });

    it("outerRing の点数が3未満はRangeError", () => {
        expect(() => buildDioramaSkirtGeometry(makeRing(2), -1)).toThrow(RangeError);
        expect(() => buildDioramaSkirtGeometry([], -1)).toThrow(RangeError);
    });
});
