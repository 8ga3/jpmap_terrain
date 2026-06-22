/**
 * @jest-environment jsdom
 */
/**
 * `src/demos/timelapse/index.ts` の純粋関数 export ユニットテスト (#231)。
 *
 * - `resolveCameraInit`: URL からカメラ初期値を解決し、タイムラプス固有デフォルトと合成する。
 *   - URL 未指定: 空オブジェクト（呼び出し側の TIMELAPSE_CAMERA_DEFAULTS が活きる）
 *   - 部分指定 (@lat,lon や ?lat=&lon=): lat/lon/altitude のみ（azimuth/tilt は返さない）
 *   - 完全指定 (@lat,lon,altitude,azimuth,tilt): 全フィールドを返す
 */
import { describe, it, expect } from "@jest/globals";
import { resolveCameraInit, resolveEngine, resolveShowSunShadows, resolveTerrainEngine } from "../src/demos/timelapse/index";

describe("resolveCameraInit", () => {
    it("URL 未指定は空オブジェクトを返す", () => {
        expect(resolveCameraInit("http://localhost/timelapse/")).toEqual({});
    });

    it("@lat,lon のみ指定: lat/lon/altitude を返し azimuth/tilt は含まない", () => {
        const result = resolveCameraInit("http://localhost/timelapse/@35.681236,139.767125");
        expect(result.lat).toBeCloseTo(35.681236, 4);
        expect(result.lon).toBeCloseTo(139.767125, 4);
        expect(result.altitude).toBeDefined();
        expect(result).not.toHaveProperty("azimuth");
        expect(result).not.toHaveProperty("tilt");
    });

    it("@lat,lon,altitude のみ指定: azimuth/tilt は含まない", () => {
        const result = resolveCameraInit("http://localhost/timelapse/@35.681236,139.767125,5000");
        expect(result.altitude).toBe(5000);
        expect(result).not.toHaveProperty("azimuth");
        expect(result).not.toHaveProperty("tilt");
    });

    it("@lat,lon,altitude,azimuth,tilt 完全指定: 全フィールドを返す", () => {
        const result = resolveCameraInit(
            "http://localhost/timelapse/@35.681236,139.767125,2000,90.00,60.00",
        );
        expect(result.lat).toBeCloseTo(35.681236, 4);
        expect(result.lon).toBeCloseTo(139.767125, 4);
        expect(result.altitude).toBe(2000);
        expect(result.azimuth).toBeCloseTo(90, 1);
        expect(result.tilt).toBeCloseTo(60, 1);
    });

    it("?lat=&lon= クエリ形式: azimuth/tilt は含まない", () => {
        const result = resolveCameraInit(
            "http://localhost/timelapse/?lat=35.681236&lon=139.767125",
        );
        expect(result.lat).toBeCloseTo(35.681236, 4);
        expect(result).not.toHaveProperty("azimuth");
        expect(result).not.toHaveProperty("tilt");
    });
});

describe("resolveEngine (timelapse)", () => {
    it("?engine=webgpu → 'webgpu'", () => {
        expect(resolveEngine("?engine=webgpu")).toBe("webgpu");
    });

    it("?engine=webgl → 'webgl2'", () => {
        expect(resolveEngine("?engine=webgl")).toBe("webgl2");
    });

    it("未指定は undefined", () => {
        expect(resolveEngine("")).toBeUndefined();
    });
});

describe("resolveShowSunShadows (timelapse)", () => {
    it("?showSunShadows=false のみ false", () => {
        expect(resolveShowSunShadows("?showSunShadows=false")).toBe(false);
    });

    it("未指定・その他は true（タイムラプスは既定 ON）", () => {
        expect(resolveShowSunShadows("")).toBe(true);
        expect(resolveShowSunShadows("?showSunShadows=true")).toBe(true);
    });
});

describe("resolveTerrainEngine (timelapse)", () => {
    it("?terrainEngine=globe → 'globe'", () => {
        expect(resolveTerrainEngine("?terrainEngine=globe")).toBe("globe");
    });

    it("?terrainEngine=planar → 'planar'", () => {
        expect(resolveTerrainEngine("?terrainEngine=planar")).toBe("planar");
    });

    it("不正値は undefined（lib 既定 globe にフォールバック, #413）", () => {
        expect(resolveTerrainEngine("?terrainEngine=foo")).toBeUndefined();
    });

    it("未指定は undefined", () => {
        expect(resolveTerrainEngine("")).toBeUndefined();
    });
});
