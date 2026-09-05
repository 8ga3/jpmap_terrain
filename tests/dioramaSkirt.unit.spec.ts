/**
 * terrain/diorama/dioramaSkirt の単体テスト。
 *
 * - 頂点数・レイアウト（上端n・下端n・底面外周n・底面中心1）
 * - 上端頂点は入力の外周リングと同一座標
 * - 側面壁下端頂点([n..2n-1])・底面外周頂点([2n..3n-1])は同じx,zでy=baseY
 * - 側面壁下端と底面外周は座標が同一でも別インデックス（頂点共有しない）
 * - 側面壁の三角形数・底面の三角形数
 * - 側面壁の法線はスムーズシェーディング（隣接壁面の平均）、底面の法線は
 *   全頂点で厳密に真上（0,1,0）を向く（頂点分離により壁の法線と混ざらない）
 * - 頂点カラー: 側面壁は上端が下端より明るい（乗算値>1）、底面は一律1
 * - 頂点数不足（<3）は RangeError
 */
import { describe, expect, it } from "vitest";

import {
    buildDioramaSkirtGeometry,
    type DioramaSkirtRingPoint,
} from "../src/terrain/diorama/dioramaSkirt";

/** 半径1の正n角形リングを生成する（テスト用）。 */
const makeRing = (n: number, y = 0): DioramaSkirtRingPoint[] =>
    Array.from({ length: n }, (_, i) => {
        const angle = (2 * Math.PI * i) / n;
        return { x: Math.sin(angle), y, z: Math.cos(angle) };
    });

describe("buildDioramaSkirtGeometry", () => {
    it("頂点数は 3n+1（上端n・側面壁下端n・底面外周n・底面中心1）", () => {
        const ring = makeRing(8, 10);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        expect(geometry.positions.length).toBe((8 * 3 + 1) * 3);
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

    it("側面壁下端頂点([n..2n-1])は同じx,zでy=baseY", () => {
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

    it("底面外周頂点([2n..3n-1])は側面壁下端と同じx,zでy=baseY（座標は同一だが別頂点）", () => {
        const n = 6;
        const ring = makeRing(n, 42);
        const baseY = -123.5;
        const geometry = buildDioramaSkirtGeometry(ring, baseY);
        for (let i = 0; i < n; i++) {
            const wallIdx = n + i;
            const rimIdx = 2 * n + i;
            expect(geometry.positions[rimIdx * 3]).toBeCloseTo(
                geometry.positions[wallIdx * 3],
                6,
            );
            expect(geometry.positions[rimIdx * 3 + 1]).toBeCloseTo(baseY, 6);
            expect(geometry.positions[rimIdx * 3 + 2]).toBeCloseTo(
                geometry.positions[wallIdx * 3 + 2],
                6,
            );
        }
    });

    it("底面中心頂点([3n])はx=0,z=0・y=baseY", () => {
        const n = 8;
        const ring = makeRing(n);
        const baseY = -50;
        const geometry = buildDioramaSkirtGeometry(ring, baseY);
        const idx = n * 3;
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

    it("側面壁の三角形は[0..2n-1]の頂点のみを参照し、底面用頂点([2n]以降)を参照しない", () => {
        const n = 10;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -1);
        // 側面壁は先頭 2n*3 個のインデックス（1segmentにつき三角形2枚）。
        const wallIndices = geometry.indices.slice(0, n * 2 * 3);
        for (const idx of wallIndices) {
            expect(idx).toBeLessThan(n * 2);
        }
    });

    it("底面の三角形は中心と[2n..3n-1]のみを参照し、側面壁下端([n..2n-1])を参照しない", () => {
        const n = 10;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -1);
        const bottomCenterIndex = n * 3;
        const bottomIndices = geometry.indices.slice(n * 2 * 3);
        for (const idx of bottomIndices) {
            const isRimOrCenter =
                idx === bottomCenterIndex || (idx >= 2 * n && idx < 3 * n);
            expect(isRimOrCenter).toBe(true);
        }
    });

    it("インデックスの最大値は頂点数-1を超えない", () => {
        const n = 12;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -1);
        const maxIndex = Math.max(...geometry.indices);
        const vertexCount = n * 3 + 1;
        expect(maxIndex).toBe(vertexCount - 1);
    });

    it("底面（[2n..3n-1]・中心[3n]）の法線は頂点分離により全て厳密に真上(0,1,0)を向く", () => {
        const n = 8;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        for (let i = 2 * n; i <= 3 * n; i++) {
            expect(geometry.normals[i * 3]).toBeCloseTo(0, 5);
            expect(geometry.normals[i * 3 + 1]).toBeCloseTo(1, 5);
            expect(geometry.normals[i * 3 + 2]).toBeCloseTo(0, 5);
        }
    });

    it("側面壁下端([n..2n-1])の法線は底面のような真上(0,1,0)にはならない（壁面同士の平均のまま）", () => {
        const n = 8;
        const ring = makeRing(n, 0);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        for (let i = n; i < 2 * n; i++) {
            // 底面が y=-5 で頂点分離済みのため、壁下端の法線は底面の(0,1,0)と
            // 混ざらず、水平に近い（|y成分|が小さい）壁本来の向きのままになる。
            expect(Math.abs(geometry.normals[i * 3 + 1])).toBeLessThan(0.5);
        }
    });

    it("outerRing の点数が3未満はRangeError", () => {
        expect(() => buildDioramaSkirtGeometry(makeRing(2), -1)).toThrow(
            RangeError,
        );
        expect(() => buildDioramaSkirtGeometry([], -1)).toThrow(RangeError);
    });

    it("頂点カラー配列の長さは頂点数*4（RGBA）", () => {
        const n = 8;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        expect(geometry.colors.length).toBe((n * 3 + 1) * 4);
    });

    it("側面壁上端([0..n-1])の頂点カラーは下端より明るい（乗算値が1より大きい、無彩色でA=1）", () => {
        const n = 8;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        for (let i = 0; i < n; i++) {
            expect(geometry.colors[i * 4]).toBeGreaterThan(1);
            // RGBは同じ値（無彩色の明暗変化のみ、色味は変えない）。
            expect(geometry.colors[i * 4 + 1]).toBeCloseTo(
                geometry.colors[i * 4],
                9,
            );
            expect(geometry.colors[i * 4 + 2]).toBeCloseTo(
                geometry.colors[i * 4],
                9,
            );
            expect(geometry.colors[i * 4 + 3]).toBeCloseTo(1, 9);
        }
    });

    it("側面壁下端([n..2n-1])の頂点カラーは上端より暗い（乗算値が1未満）", () => {
        const n = 8;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        for (let i = n; i < 2 * n; i++) {
            expect(geometry.colors[i * 4]).toBeLessThan(1);
            expect(geometry.colors[i * 4]).toBeGreaterThan(0);
            // RGBは同じ値（無彩色の明暗変化のみ、色味は変えない）。
            expect(geometry.colors[i * 4 + 1]).toBeCloseTo(
                geometry.colors[i * 4],
                9,
            );
            expect(geometry.colors[i * 4 + 2]).toBeCloseTo(
                geometry.colors[i * 4],
                9,
            );
            expect(geometry.colors[i * 4 + 3]).toBeCloseTo(1, 9);
        }
    });

    it("底面（[2n..3n-1]・中心[3n]）の頂点カラーは乗算1（グラデーション対象外）", () => {
        const n = 8;
        const ring = makeRing(n);
        const geometry = buildDioramaSkirtGeometry(ring, -5);
        for (let i = 2 * n; i <= 3 * n; i++) {
            expect(geometry.colors[i * 4]).toBeCloseTo(1, 9);
            expect(geometry.colors[i * 4 + 1]).toBeCloseTo(1, 9);
            expect(geometry.colors[i * 4 + 2]).toBeCloseTo(1, 9);
            expect(geometry.colors[i * 4 + 3]).toBeCloseTo(1, 9);
        }
    });
});
