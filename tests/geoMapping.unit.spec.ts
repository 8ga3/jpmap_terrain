/**
 * geo/mapping の単体テスト (Issue #275 Phase 0)。
 *
 * - pixelToLatLon ⇄ latLonToPixel の往復精度
 * - totalPixelsForZoom が TILE_SIZE * 2^zoom
 * - 端・中心の既知点（北西端・中心・経度方向の線形性）で規約を固定
 * - 既存 gsiTile.tileCenterLatLon との整合（タイル中心ピクセル → 同じ緯度経度）
 */

import { describe, it, expect } from "@jest/globals";

import {
    totalPixelsForZoom,
    pixelToLatLon,
    latLonToPixel,
    MERCATOR_MAX_LAT,
} from "../src/terrain/geo/mapping";
import { TILE_SIZE, tileCenterLatLon, toTileXY } from "../src/terrain/gsiTile";

describe("totalPixelsForZoom", () => {
    it("TILE_SIZE * 2^zoom", () => {
        expect(totalPixelsForZoom(0)).toBe(TILE_SIZE);
        expect(totalPixelsForZoom(1)).toBe(TILE_SIZE * 2);
        expect(totalPixelsForZoom(15)).toBe(TILE_SIZE * 2 ** 15);
    });
});

describe("pixelToLatLon 既知点", () => {
    it("北西端 (0,0) は lon=-180, lat≈85.0511", () => {
        const total = totalPixelsForZoom(10);
        const { lat, lon } = pixelToLatLon(0, 0, total);
        expect(lon).toBeCloseTo(-180, 9);
        expect(lat).toBeCloseTo(85.0511287798, 6);
    });

    it("中心 (total/2) は lat=0, lon=0", () => {
        const total = totalPixelsForZoom(10);
        const { lat, lon } = pixelToLatLon(total / 2, total / 2, total);
        expect(lat).toBeCloseTo(0, 9);
        expect(lon).toBeCloseTo(0, 9);
    });

    it("経度はピクセル X に線形", () => {
        const total = totalPixelsForZoom(8);
        const a = pixelToLatLon(0, total / 2, total).lon;
        const b = pixelToLatLon(total / 4, total / 2, total).lon;
        expect(b - a).toBeCloseTo(90, 9);
    });
});

describe("往復精度 latLon → pixel → latLon", () => {
    const samples: { name: string; lat: number; lon: number }[] = [
        { name: "東京", lat: 35.681236, lon: 139.767125 },
        { name: "赤道本初子午線", lat: 0, lon: 0 },
        { name: "南半球", lat: -33.8688, lon: 151.2093 },
        { name: "高緯度", lat: 80, lon: -179.9 },
        { name: "メルカトル境界付近", lat: 85.0, lon: 122.0 },
    ];

    for (const s of samples) {
        it(`${s.name} が往復する`, () => {
            const total = totalPixelsForZoom(15);
            const { px, py } = latLonToPixel(s.lat, s.lon, total);
            const { lat, lon } = pixelToLatLon(px, py, total);
            expect(lat).toBeCloseTo(s.lat, 9);
            expect(lon).toBeCloseTo(s.lon, 9);
        });
    }
});

describe("往復精度 pixel → latLon → pixel", () => {
    it("任意ピクセルが往復する", () => {
        const total = totalPixelsForZoom(12);
        const px0 = 123456.7;
        const py0 = 98765.4;
        const { lat, lon } = pixelToLatLon(px0, py0, total);
        const { px, py } = latLonToPixel(lat, lon, total);
        expect(px).toBeCloseTo(px0, 4);
        expect(py).toBeCloseTo(py0, 4);
    });
});

describe("gsiTile との整合", () => {
    it("タイル中心ピクセルが tileCenterLatLon と一致", () => {
        const zoom = 14;
        const tx = 14552;
        const ty = 6451;
        const total = totalPixelsForZoom(zoom);
        const centerPx = (tx + 0.5) * TILE_SIZE;
        const centerPy = (ty + 0.5) * TILE_SIZE;
        const got = pixelToLatLon(centerPx, centerPy, total);
        const want = tileCenterLatLon(tx, ty, zoom);
        expect(got.lat).toBeCloseTo(want.lat, 9);
        expect(got.lon).toBeCloseTo(want.lon, 9);
    });
});

describe("latLonToPixel の堅牢化（クランプ/正規化）", () => {
    const total = totalPixelsForZoom(15);

    it("緯度はメルカトル有効域 ±MERCATOR_MAX_LAT にクランプされ py は有限", () => {
        const beyond = latLonToPixel(89, 0, total); // 有効域超
        const atLimit = latLonToPixel(MERCATOR_MAX_LAT, 0, total);
        expect(Number.isFinite(beyond.py)).toBe(true);
        expect(beyond.py).toBeCloseTo(atLimit.py, 6);
        // クランプにより py は [0, total] 内（北端 0 付近）。
        expect(beyond.py).toBeGreaterThanOrEqual(0);
        expect(beyond.py).toBeLessThanOrEqual(total);
    });

    it("南側も同様にクランプされる", () => {
        const beyond = latLonToPixel(-89, 0, total);
        const atLimit = latLonToPixel(-MERCATOR_MAX_LAT, 0, total);
        expect(beyond.py).toBeCloseTo(atLimit.py, 6);
        expect(beyond.py).toBeLessThanOrEqual(total);
    });

    it("経度は [-180,180) に正規化される（lon=190 → -170 相当）", () => {
        const wrapped = latLonToPixel(0, 190, total);
        const normalized = latLonToPixel(0, -170, total);
        expect(wrapped.px).toBeCloseTo(normalized.px, 6);
        expect(wrapped.px).toBeGreaterThanOrEqual(0);
        expect(wrapped.px).toBeLessThanOrEqual(total);
    });

    it("域外入力でも px/py は有限かつ [0,total] 内", () => {
        for (const [lat, lon] of [
            [89, 200],
            [-89, -200],
            [120, 540],
        ]) {
            const { px, py } = latLonToPixel(lat, lon, total);
            expect(Number.isFinite(px)).toBe(true);
            expect(Number.isFinite(py)).toBe(true);
            expect(px).toBeGreaterThanOrEqual(0);
            expect(px).toBeLessThanOrEqual(total);
            expect(py).toBeGreaterThanOrEqual(0);
            expect(py).toBeLessThanOrEqual(total);
        }
    });

    it("域内の点はピクセル→タイル整数で gsiTile.toTileXY と一致する", () => {
        const zoom = 12;
        const t = totalPixelsForZoom(zoom);
        const lat = 35.681236;
        const lon = 139.767125;
        const { px, py } = latLonToPixel(lat, lon, t);
        const want = toTileXY(lat, lon, zoom);
        expect(Math.floor(px / TILE_SIZE)).toBe(want.x);
        expect(Math.floor(py / TILE_SIZE)).toBe(want.y);
    });
});

describe("pixelToLatLon の堅牢化（範囲外クランプ）", () => {
    const total = totalPixelsForZoom(10);

    it("範囲外の globalPy はクランプされ lat はメルカトル有効域内", () => {
        const over = pixelToLatLon(total / 2, total * 2, total); // 南へ振り切り
        const under = pixelToLatLon(total / 2, -total, total); // 北へ振り切り
        expect(over.lat).toBeCloseTo(-MERCATOR_MAX_LAT, 6);
        expect(under.lat).toBeCloseTo(MERCATOR_MAX_LAT, 6);
    });

    it("範囲外の globalPx はクランプされ lon は [-180,180] 内（ラップしない）", () => {
        const east = pixelToLatLon(total * 3, total / 2, total);
        const west = pixelToLatLon(-total, total / 2, total);
        expect(east.lon).toBeCloseTo(180, 6); // ラップせず東端へクランプ
        expect(west.lon).toBeCloseTo(-180, 6);
    });
});
