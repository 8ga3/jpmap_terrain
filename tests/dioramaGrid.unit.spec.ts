/**
 * terrain/diorama/dioramaGrid の単体テスト。
 *
 * - metersPerDegreeAt が既知の近似値（赤道付近・高緯度）と整合する
 * - offsetToLatLon の往復（東西/南北オフセット→緯度経度→距離）が指定半径と一致する
 * - buildDioramaGridPoints の点数・並び順（row-major）・四隅の座標
 * - buildDioramaGridIndices の三角形数・頂点インデックス範囲・法線が上向き（+Y）
 * - extractGridPerimeterIndices の外周点数・巡回順（時計回り）
 */
import { describe, it, expect } from "vitest";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";

import {
    metersPerDegreeAt,
    offsetToLatLon,
    buildDioramaGridPoints,
    buildDioramaGridIndices,
    extractGridPerimeterIndices,
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
    const options: DioramaGridOptions = { gridSegments: 4 };

    it("点数は (gridSegments+1)^2", () => {
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        expect(points.length).toBe(5 * 5);
    });

    it("並び順はrow-major（points[row*(gridSegments+1)+col] が該当row/colを持つ）", () => {
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        for (let row = 0; row <= options.gridSegments; row++) {
            for (let col = 0; col <= options.gridSegments; col++) {
                const p = points[row * (options.gridSegments + 1) + col];
                expect(p.row).toBe(row);
                expect(p.col).toBe(col);
            }
        }
    });

    it("北西端(row=0,col=0)はx=-footprintHalfSizeM,z=+footprintHalfSizeM", () => {
        const footprintHalfSizeM = 900;
        const points = buildDioramaGridPoints(TOKYO, footprintHalfSizeM, options);
        const nw = points[0];
        expect(nw.x).toBeCloseTo(-footprintHalfSizeM, 6);
        expect(nw.z).toBeCloseTo(footprintHalfSizeM, 6);
    });

    it("北東端(row=0,col=gridSegments)はx=+footprintHalfSizeM,z=+footprintHalfSizeM", () => {
        const footprintHalfSizeM = 900;
        const points = buildDioramaGridPoints(TOKYO, footprintHalfSizeM, options);
        const ne = points[options.gridSegments];
        expect(ne.x).toBeCloseTo(footprintHalfSizeM, 6);
        expect(ne.z).toBeCloseTo(footprintHalfSizeM, 6);
    });

    it("南西端(row=gridSegments,col=0)はx=-footprintHalfSizeM,z=-footprintHalfSizeM", () => {
        const footprintHalfSizeM = 900;
        const points = buildDioramaGridPoints(TOKYO, footprintHalfSizeM, options);
        const sw = points[options.gridSegments * (options.gridSegments + 1)];
        expect(sw.x).toBeCloseTo(-footprintHalfSizeM, 6);
        expect(sw.z).toBeCloseTo(-footprintHalfSizeM, 6);
    });

    it("南東端(row=gridSegments,col=gridSegments)はx=+footprintHalfSizeM,z=-footprintHalfSizeM", () => {
        const footprintHalfSizeM = 900;
        const points = buildDioramaGridPoints(TOKYO, footprintHalfSizeM, options);
        const se = points[points.length - 1];
        expect(se.x).toBeCloseTo(footprintHalfSizeM, 6);
        expect(se.z).toBeCloseTo(-footprintHalfSizeM, 6);
    });

    it("中心(gridSegmentsが偶数のとき厳密に存在)はx=0,z=0で中心の緯度経度と一致する", () => {
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        const half = options.gridSegments / 2;
        const center = points[half * (options.gridSegments + 1) + half];
        expect(center.x).toBeCloseTo(0, 9);
        expect(center.z).toBeCloseTo(0, 9);
        expect(center.lat).toBeCloseTo(TOKYO.lat, 9);
        expect(center.lon).toBeCloseTo(TOKYO.lon, 9);
    });

    it("極付近を中心にするとRangeError（ゼロ除算を未然に防ぐ）", () => {
        expect(() => buildDioramaGridPoints({ lat: 89, lon: 0 }, 500, options)).toThrow(RangeError);
    });

    it("gridSegments < 1 は RangeError", () => {
        expect(() => buildDioramaGridPoints(TOKYO, 500, { gridSegments: 0 })).toThrow(RangeError);
    });

    it("footprintHalfSizeM <= 0 は RangeError", () => {
        expect(() => buildDioramaGridPoints(TOKYO, 0, options)).toThrow(RangeError);
        expect(() => buildDioramaGridPoints(TOKYO, -10, options)).toThrow(RangeError);
    });

    it("gridSegments が非整数は RangeError", () => {
        expect(() => buildDioramaGridPoints(TOKYO, 500, { gridSegments: 4.5 })).toThrow(RangeError);
    });

    it("gridSegments が NaN/Infinity は RangeError", () => {
        expect(() => buildDioramaGridPoints(TOKYO, 500, { gridSegments: NaN })).toThrow(RangeError);
        expect(() => buildDioramaGridPoints(TOKYO, 500, { gridSegments: Infinity })).toThrow(RangeError);
    });

    it("footprintHalfSizeM が Infinity は RangeError", () => {
        expect(() => buildDioramaGridPoints(TOKYO, Infinity, options)).toThrow(RangeError);
    });
});

describe("buildDioramaGridIndices", () => {
    it("三角形数は gridSegments^2 * 2", () => {
        const options: DioramaGridOptions = { gridSegments: 4 };
        const indices = buildDioramaGridIndices(options);
        expect(indices.length).toBe(4 * 4 * 2 * 3);
    });

    it("gridSegments が非整数/NaN/Infinityは RangeError", () => {
        expect(() => buildDioramaGridIndices({ gridSegments: 4.5 })).toThrow(RangeError);
        expect(() => buildDioramaGridIndices({ gridSegments: NaN })).toThrow(RangeError);
        expect(() => buildDioramaGridIndices({ gridSegments: Infinity })).toThrow(RangeError);
    });

    it("インデックスの最大値は点数-1を超えない", () => {
        const options: DioramaGridOptions = { gridSegments: 4 };
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        const indices = buildDioramaGridIndices(options);
        const maxIndex = Math.max(...indices);
        expect(maxIndex).toBeLessThan(points.length);
        expect(maxIndex).toBe(points.length - 1);
    });

    it("平坦なグリッド（全頂点y=0）の法線は+Y方向を向く（Babylon既定の巻き順規約）", () => {
        const options: DioramaGridOptions = { gridSegments: 4 };
        const points = buildDioramaGridPoints(TOKYO, 500, options);
        const positions = new Float32Array(points.length * 3);
        for (let i = 0; i < points.length; i++) {
            positions[i * 3] = points[i].x;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = points[i].z;
        }
        const indices = buildDioramaGridIndices(options);
        const normals = new Float32Array(positions.length);
        VertexData.ComputeNormals(positions, indices, normals);
        for (let i = 1; i < normals.length; i += 3) {
            expect(normals[i]).toBeCloseTo(1, 3);
        }
    });
});

describe("extractGridPerimeterIndices", () => {
    it("外周点数は4*gridSegments（四隅を重複させない）", () => {
        const options: DioramaGridOptions = { gridSegments: 5 };
        const perimeter = extractGridPerimeterIndices(options);
        expect(perimeter.length).toBe(4 * options.gridSegments);
        expect(new Set(perimeter).size).toBe(perimeter.length);
    });

    it("先頭は北西端(row=0,col=0)、続いて北辺を西→東に辿る", () => {
        const options: DioramaGridOptions = { gridSegments: 4 };
        const perimeter = extractGridPerimeterIndices(options);
        expect(perimeter[0]).toBe(0);
        expect(perimeter[1]).toBe(1);
        expect(perimeter[options.gridSegments - 1]).toBe(options.gridSegments - 1);
    });

    it("北辺の次は東辺（北東端から南東端へ向かう）", () => {
        const options: DioramaGridOptions = { gridSegments: 4 };
        const vertsPerSide = options.gridSegments + 1;
        const perimeter = extractGridPerimeterIndices(options);
        // 北辺(gridSegments点)の直後が北東端(row=0,col=gridSegments)。
        expect(perimeter[options.gridSegments]).toBe(options.gridSegments);
        // 東辺の最後の手前は南隣（row=gridSegments-1,col=gridSegments）。
        expect(perimeter[options.gridSegments * 2 - 1]).toBe((options.gridSegments - 1) * vertsPerSide + options.gridSegments);
    });

    it("全ての点が外周（row=0またはrow=gridSegments、col=0またはcol=gridSegments）にある", () => {
        const options: DioramaGridOptions = { gridSegments: 5 };
        const vertsPerSide = options.gridSegments + 1;
        const perimeter = extractGridPerimeterIndices(options);
        for (const idx of perimeter) {
            const row = Math.floor(idx / vertsPerSide);
            const col = idx % vertsPerSide;
            const onBorder = row === 0 || row === options.gridSegments || col === 0 || col === options.gridSegments;
            expect(onBorder).toBe(true);
        }
    });

    it("gridSegments が非整数/NaN/Infinityは RangeError", () => {
        expect(() => extractGridPerimeterIndices({ gridSegments: 4.5 })).toThrow(RangeError);
        expect(() => extractGridPerimeterIndices({ gridSegments: NaN })).toThrow(RangeError);
        expect(() => extractGridPerimeterIndices({ gridSegments: Infinity })).toThrow(RangeError);
    });
});
