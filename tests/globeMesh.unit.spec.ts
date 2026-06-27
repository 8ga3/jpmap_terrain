/**
 * geo/globeMesh の単体テスト。
 *
 * - sampleElevBilinear: 定数・線形補間・無効値フォールバック
 * - buildGlobeTileMeshData: 頂点/インデックス数、アンカー（真の ECEF 中心）、
 *   アンカー相対の小さな頂点座標、UV の北端 v=1、法線本数
 */

import { describe, it, expect } from "@jest/globals";

import { TILE_SIZE, NO_DATA_SENTINEL } from "../src/terrain/gsiTile";
import { geodeticToEcef } from "../src/terrain/geo/ecef";
import { pixelToLatLon, totalPixelsForZoom } from "../src/terrain/geo/mapping";
import { sampleElevBilinear } from "../src/terrain/geo/elevSample";
import { buildGlobeTileMeshData } from "../src/terrain/geo/globeMesh";

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

    it("4隅すべて無効(NaN)なら 0 を返す", () => {
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NaN);
        expect(sampleElevBilinear(elev, 3, 3)).toBe(0);
    });

    it("4隅の一部が NaN でも有効値のみで補間（0 に引っ張られない）", () => {
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NaN);
        elev[0] = 100; // (x=0,y=0) のみ有効
        // 中心(0.5,0.5) は 4隅 (0,0)/(1,0)/(0,1)/(1,1) を参照。有効は (0,0) のみ。
        // 旧実装（NaN→0 混入）では 25 に沈むが、重み正規化では有効値 100 を返す。
        expect(sampleElevBilinear(elev, 0.5, 0.5)).toBeCloseTo(100, 6);
    });

    it("有効な2隅の加重平均（無効隅を除外して正規化）", () => {
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NaN);
        elev[0] = 100; // (x=0,y=0)
        elev[1] = 200; // (x=1,y=0)
        // (px=0.5,py=0): 上辺の 2隅のみ有効、重み 0.5/0.5 → 150。
        expect(sampleElevBilinear(elev, 0.5, 0)).toBeCloseTo(150, 6);
    });

    it("番兵値 NO_DATA_SENTINEL(-100) を無効として除外する (#339)", () => {
        // 穴埋め残しの番兵値が有効標高として混入すると、メッシュ/terrainElevAt が
        // -100m へ引っ張られて沈む。NaN と同様に重み計算から除外する。
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NO_DATA_SENTINEL);
        elev[0] = 80; // (x=0,y=0) のみ有効
        expect(sampleElevBilinear(elev, 0.5, 0.5)).toBeCloseTo(80, 6);
        // 全隅が番兵なら 0 を返す（4隅すべて無効）。
        const allSentinel = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NO_DATA_SENTINEL);
        expect(sampleElevBilinear(allSentinel, 3, 3)).toBe(0);
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
