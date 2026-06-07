/**
 * geo/globeMesh の単体テスト (Issue #275 Phase 1)。
 *
 * - sampleElevBilinear: 定数・線形補間・無効値フォールバック
 * - buildGlobeTileMeshData: 頂点/インデックス数、アンカー（真の ECEF 中心）、
 *   アンカー相対の小さな頂点座標、UV の北端 v=1、法線本数
 */

import { describe, it, expect } from "@jest/globals";

import { TILE_SIZE } from "../src/terrain/gsiTile";
import { geodeticToEcef } from "../src/terrain/geo/ecef";
import { pixelToLatLon, totalPixelsForZoom } from "../src/terrain/geo/mapping";
import {
    sampleElevBilinear,
    buildGlobeTileMeshData,
} from "../src/terrain/geo/globeMesh";

describe("sampleElevBilinear", () => {
    it("定数ラスタは定数を返す", () => {
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(42);
        expect(sampleElevBilinear(elev, 10.5, 20.3)).toBeCloseTo(42, 9);
    });

    it("X 方向の線形勾配を補間する", () => {
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let y = 0; y < TILE_SIZE; y++) {
            for (let x = 0; x < TILE_SIZE; x++) elev[y * TILE_SIZE + x] = x;
        }
        expect(sampleElevBilinear(elev, 10.25, 5)).toBeCloseTo(10.25, 6);
    });

    it("無効値(NaN)は 0 として扱う", () => {
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NaN);
        expect(sampleElevBilinear(elev, 3, 3)).toBe(0);
    });
});

describe("buildGlobeTileMeshData", () => {
    const zoom = 14;
    const tx = 14552;
    const ty = 6451;
    const segments = 2;
    const geomElev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(50);

    const data = buildGlobeTileMeshData({
        zoom,
        tx,
        ty,
        geomElev,
        geomZoom: zoom,
        geomX: tx,
        geomY: ty,
        segments,
        edges: [],
    });

    it("頂点数 = 地表(seg+1)^2 + 周縁スカート", () => {
        // 3x3 地表(9) + 周縁 8 = 17 頂点。
        expect(data.positions.length).toBe(17 * 3);
        expect(data.normals.length).toBe(17 * 3);
        expect(data.uvs.length).toBe(17 * 2);
    });

    it("インデックス数 = 地表 + スカート壁", () => {
        // 地表 segments^2*6=24、スカート 4辺*segments*12=96 → 120。
        expect(data.indices.length).toBe(120);
    });

    it("アンカーはタイル中心の真の ECEF", () => {
        const total = totalPixelsForZoom(zoom);
        const center = pixelToLatLon(
            tx * TILE_SIZE + TILE_SIZE / 2,
            ty * TILE_SIZE + TILE_SIZE / 2,
            total,
        );
        const expected = geodeticToEcef(center.lat, center.lon, 0);
        expect(data.anchor.x).toBeCloseTo(expected.x, 6);
        expect(data.anchor.y).toBeCloseTo(expected.y, 6);
        expect(data.anchor.z).toBeCloseTo(expected.z, 6);
        expect(data.centerLat).toBeCloseTo(center.lat, 9);
        expect(data.centerLon).toBeCloseTo(center.lon, 9);
    });

    it("アンカーは地球半径オーダー", () => {
        const r = Math.hypot(data.anchor.x, data.anchor.y, data.anchor.z);
        expect(r).toBeGreaterThan(6_300_000);
        expect(r).toBeLessThan(6_400_000);
    });

    it("頂点座標はアンカー相対の小さな値", () => {
        // z14 タイル（辺 ≒ 2km）の頂点は中心から数 km 以内。
        for (let i = 0; i < data.positions.length; i++) {
            expect(Math.abs(data.positions[i])).toBeLessThan(5000);
        }
    });

    it("北端頂点(row=0)の UV は v=1", () => {
        // 最初の頂点 (row=0,col=0) は u=0, v=1。
        expect(data.uvs[0]).toBeCloseTo(0, 9);
        expect(data.uvs[1]).toBeCloseTo(1, 9);
    });

    it("南端頂点(row=segments,col=segments)の UV は (1,0)", () => {
        const last = 8; // (row=2,col=2) のインデックス
        expect(data.uvs[last * 2]).toBeCloseTo(1, 9);
        expect(data.uvs[last * 2 + 1]).toBeCloseTo(0, 9);
    });
});
