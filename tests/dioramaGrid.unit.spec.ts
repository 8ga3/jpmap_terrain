/**
 * terrain/diorama/dioramaGrid の単体テスト。
 *
 * - metersPerDegreeAt が既知の近似値（赤道付近・高緯度）と整合する
 * - offsetToLatLon の往復（東西/南北オフセット→緯度経度→距離）が指定半径と一致する
 * - buildDioramaGridPoints の点数・並び順・中心点・各リング半径
 * - buildDioramaGridIndices の三角形数・頂点インデックス範囲
 */
import { describe, it, expect } from "vitest";

import {
    metersPerDegreeAt,
    offsetToLatLon,
    buildDioramaGridPoints,
    buildDioramaGridIndices,
    type DioramaGridOptions,
} from "../src/terrain/diorama/dioramaGrid";

const TOKYO = { lat: 35.681236, lon: 139.767125 };

describe("metersPerDegreeAt", () => {
    it("赤道での経度/緯度比はWGS84の扁平率由来の理論値 1/(1-e^2) と一致する", () => {
        // 赤道(lat=0)では 卯酉線曲率半径 N=a、子午線曲率半径 M=a(1-e^2) となるため、
        // lon/lat の比は 1/(1-e^2)（およそ1.0067）になる。両者が等しくなるのは極のみ。
        const mpd = metersPerDegreeAt(0);
        const e2 = 0.0066943799901413165; // WGS84 first eccentricity squared
        expect(mpd.lon / mpd.lat).toBeCloseTo(1 / (1 - e2), 6);
    });

    it("緯度1度あたり距離は概ね111.1km前後（WGS84の代表値）", () => {
        const mpd = metersPerDegreeAt(35.68);
        expect(mpd.lat).toBeGreaterThan(110_500);
        expect(mpd.lat).toBeLessThan(111_500);
    });

    it("高緯度では経度1度あたり距離が緯度1度あたり距離より小さくなる", () => {
        const mpd = metersPerDegreeAt(60);
        expect(mpd.lon).toBeLessThan(mpd.lat);
    });

    it("極付近（|lat|が有効域を超える）はRangeError（ゼロ除算を未然に防ぐ）", () => {
        expect(() => metersPerDegreeAt(90)).toThrow(RangeError);
        expect(() => metersPerDegreeAt(-90)).toThrow(RangeError);
        expect(() => metersPerDegreeAt(86)).toThrow(RangeError);
    });

    it("有効域の境界ぎりぎりでは例外を投げず、有限の正数を返す", () => {
        const mpd = metersPerDegreeAt(85);
        expect(Number.isFinite(mpd.lat)).toBe(true);
        expect(Number.isFinite(mpd.lon)).toBe(true);
        expect(mpd.lon).toBeGreaterThan(0);
    });
});

describe("offsetToLatLon", () => {
    it("北へ1000mオフセットした地点は、中心からの距離が約1000mになる", () => {
        const mpd = metersPerDegreeAt(TOKYO.lat);
        const { lat, lon } = offsetToLatLon(TOKYO, 0, 1000);
        // 東西オフセットは0のため経度は不変、緯度差から距離を逆算して照合する。
        expect(lon).toBeCloseTo(TOKYO.lon, 9);
        const distM = (lat - TOKYO.lat) * mpd.lat;
        expect(distM).toBeCloseTo(1000, 0);
    });

    it("東へ1000mオフセットした地点は、中心からの距離が約1000mになる", () => {
        const mpd = metersPerDegreeAt(TOKYO.lat);
        const { lat, lon } = offsetToLatLon(TOKYO, 1000, 0);
        expect(lat).toBeCloseTo(TOKYO.lat, 9);
        const distM = (lon - TOKYO.lon) * mpd.lon;
        expect(distM).toBeCloseTo(1000, 0);
    });

    it("オフセット0は中心と同じ緯度経度", () => {
        const { lat, lon } = offsetToLatLon(TOKYO, 0, 0);
        expect(lat).toBeCloseTo(TOKYO.lat, 12);
        expect(lon).toBeCloseTo(TOKYO.lon, 12);
    });

    it("極付近を中心にするとRangeError（ゼロ除算を未然に防ぐ）", () => {
        expect(() => offsetToLatLon({ lat: 89, lon: 0 }, 100, 0)).toThrow(RangeError);
    });
});

describe("buildDioramaGridPoints", () => {
    const options: DioramaGridOptions = { ringCount: 3, radialSegments: 8 };

    it("点数は 1 + ringCount * radialSegments", () => {
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        expect(points.length).toBe(1 + 3 * 8);
    });

    it("先頭は中心点（ring=0, オフセット0）", () => {
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        expect(points[0]).toMatchObject({ x: 0, z: 0, ring: 0, segment: 0 });
        expect(points[0].lat).toBeCloseTo(TOKYO.lat, 12);
        expect(points[0].lon).toBeCloseTo(TOKYO.lon, 12);
    });

    it("各リングの点は中心から半径 footprintRadiusM*ring/ringCount の距離にある", () => {
        const footprintRadiusM = 900;
        const points = buildDioramaGridPoints(TOKYO, footprintRadiusM, options);
        for (const p of points) {
            if (p.ring === 0) continue;
            const expectedRadius = (footprintRadiusM * p.ring) / options.ringCount;
            const actualRadius = Math.hypot(p.x, p.z);
            expect(actualRadius).toBeCloseTo(expectedRadius, 6);
        }
    });

    it("最外リングの半径は footprintRadiusM と一致する", () => {
        const footprintRadiusM = 1200;
        const points = buildDioramaGridPoints(TOKYO, footprintRadiusM, options);
        const outer = points.filter((p) => p.ring === options.ringCount);
        expect(outer.length).toBe(options.radialSegments);
        for (const p of outer) {
            expect(Math.hypot(p.x, p.z)).toBeCloseTo(footprintRadiusM, 6);
        }
    });

    it("角度0（segment=0）は北方向（+z, x=0）", () => {
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        const p = points.find((pt) => pt.ring === 1 && pt.segment === 0);
        expect(p).toBeDefined();
        expect(p?.x).toBeCloseTo(0, 9);
        expect(p?.z ?? 0).toBeGreaterThan(0);
    });

    it("極付近を中心にするとRangeError（ゼロ除算を未然に防ぐ）", () => {
        expect(() => buildDioramaGridPoints({ lat: 89, lon: 0 }, 500, options)).toThrow(RangeError);
    });

    it("ringCount < 1 は RangeError", () => {
        expect(() =>
            buildDioramaGridPoints(TOKYO, 500, { ringCount: 0, radialSegments: 8 }),
        ).toThrow(RangeError);
    });

    it("radialSegments < 3 は RangeError", () => {
        expect(() =>
            buildDioramaGridPoints(TOKYO, 500, { ringCount: 3, radialSegments: 2 }),
        ).toThrow(RangeError);
    });

    it("footprintRadiusM <= 0 は RangeError", () => {
        expect(() => buildDioramaGridPoints(TOKYO, 0, options)).toThrow(RangeError);
        expect(() => buildDioramaGridPoints(TOKYO, -10, options)).toThrow(RangeError);
    });
});

describe("buildDioramaGridIndices", () => {
    it("三角形数は radialSegments + (ringCount-1) * radialSegments * 2", () => {
        const options: DioramaGridOptions = { ringCount: 4, radialSegments: 6 };
        const indices = buildDioramaGridIndices(options);
        const expectedTriangles =
            options.radialSegments + (options.ringCount - 1) * options.radialSegments * 2;
        expect(indices.length).toBe(expectedTriangles * 3);
    });

    it("インデックスの最大値は点数-1を超えない", () => {
        const options: DioramaGridOptions = { ringCount: 3, radialSegments: 8 };
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        const indices = buildDioramaGridIndices(options);
        const maxIndex = Math.max(...indices);
        expect(maxIndex).toBeLessThan(points.length);
        expect(maxIndex).toBe(points.length - 1);
    });

    it("最初の三角形は中心(0)を含む", () => {
        const options: DioramaGridOptions = { ringCount: 2, radialSegments: 5 };
        const indices = buildDioramaGridIndices(options);
        expect(indices[0]).toBe(0);
    });
});
