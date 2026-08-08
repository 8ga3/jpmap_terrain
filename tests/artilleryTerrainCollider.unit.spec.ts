/**
 * Artillery 地形コライダーのユニットテスト
 *
 * 回帰防止の対象:
 * - `isColliderTerrainMeshName`: 常時表示の粗いベースレイヤ（`base-tile-*`、zoom=2 の
 *   海面平坦メッシュ）をサンプリング対象から除外すること。これを含めると細かい地形タイルが
 *   未ロードの座標でレイがベースレイヤにヒットし、実地形と無関係な Y を非 null で返す。
 * - `fillMissingHeights`: サンプリングできなかった頂点を近傍平均で埋め、走査順の直前値で
 *   埋めていたときに生じた大きな段差を作らないこと。
 */
import { describe, it, expect } from "vitest";

import {
    isColliderTerrainMeshName,
    fillMissingHeights,
} from "../src/demos/artillery/terrainCollider";

describe("isColliderTerrainMeshName", () => {
    it("accepts globe LOD terrain tiles", () => {
        expect(isColliderTerrainMeshName("tile-15/29037/12956")).toBe(true);
    });

    it("accepts planar terrain tiles", () => {
        expect(isColliderTerrainMeshName("tile-ground-14/14552/6478")).toBe(true);
    });

    it("rejects the always-on coarse base layer", () => {
        // `base-tile-` は `tile-` で始まらないため前方一致だけで除外される。
        // 命名変更でこの前提が崩れると #612 が再発するため、明示的に固定する。
        expect(isColliderTerrainMeshName("base-tile-2/3/1")).toBe(false);
        expect("base-tile-2/3/1".startsWith("tile-")).toBe(false);
    });

    it("rejects non-terrain meshes", () => {
        expect(isColliderTerrainMeshName("artillery-collider")).toBe(false);
        expect(isColliderTerrainMeshName("cannon-red")).toBe(false);
        expect(isColliderTerrainMeshName("")).toBe(false);
    });
});

describe("fillMissingHeights", () => {
    it("returns 0 and leaves values untouched when there is no hole", () => {
        const h = Float32Array.from([1, 2, 3, 4]);
        expect(fillMissingHeights(h, 2, 2)).toBe(0);
        expect(Array.from(h)).toEqual([1, 2, 3, 4]);
    });

    it("keeps all holes when every vertex is missing", () => {
        const h = Float32Array.from([NaN, NaN, NaN, NaN]);
        expect(fillMissingHeights(h, 2, 2)).toBe(4);
        expect(Array.from(h).every(Number.isNaN)).toBe(true);
    });

    it("fills a single hole with the average of its valid neighbors", () => {
        // 中央のみ穴。周囲 8 頂点はすべて 100 → 中央も 100 になる。
        const h = Float32Array.from([100, 100, 100, 100, NaN, 100, 100, 100, 100]);
        expect(fillMissingHeights(h, 3, 3)).toBe(0);
        expect(h[4]).toBeCloseTo(100, 6);
    });

    it("propagates into a hole that is wider than one vertex", () => {
        // 4x4 の内側 2x2 が穴。外周はすべて 50。
        const h = new Float32Array(16).fill(50);
        for (const idx of [5, 6, 9, 10]) h[idx] = NaN;
        expect(fillMissingHeights(h, 4, 4)).toBe(0);
        for (const idx of [5, 6, 9, 10]) expect(h[idx]).toBeCloseTo(50, 6);
    });

    it("does not create the large steps produced by last-valid-value filling", () => {
        // 走査順の直前値で埋めると、行をまたいだ穴の縁で左端と右端の落差がそのまま
        // 段差になる。近傍平均なら穴は両側の値の間へ収まる。
        const width = 5;
        const height = 3;
        const h = new Float32Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                h[y * width + x] = x < 2 ? 1000 : 0;
            }
        }
        // 各行の x=2 を穴にする（1000 と 0 の境界）。
        for (let y = 0; y < height; y++) h[y * width + 2] = NaN;

        expect(fillMissingHeights(h, width, height)).toBe(0);
        for (let y = 0; y < height; y++) {
            const v = h[y * width + 2];
            expect(v).toBeGreaterThan(0);
            expect(v).toBeLessThan(1000);
        }
    });

    it("fills holes that only touch valid vertices diagonally", () => {
        const h = Float32Array.from([10, NaN, NaN, NaN]);
        expect(fillMissingHeights(h, 2, 2)).toBe(0);
        expect(Array.from(h).some(Number.isNaN)).toBe(false);
    });
});
