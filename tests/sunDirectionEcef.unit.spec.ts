/**
 * `src/terrain/geo/sunDirectionEcef.ts` の純粋関数ユニットテスト。
 *
 * 太陽の地平座標(azimuth/altitude)@観測点(lat/lon) を、右手系 ECEF
 * （X→経度0 / Y→東経90° / Z→北極）の太陽方向単位ベクトルへ変換する関数の代表値を固定する。
 */
import { describe, it, expect } from "vitest";
import { sunDirectionEcef } from "../src/terrain/geo/sunDirectionEcef";

const expectVecClose = (
    actual: { x: number; y: number; z: number },
    expected: [number, number, number],
    digits = 6,
): void => {
    expect(actual.x).toBeCloseTo(expected[0], digits);
    expect(actual.y).toBeCloseTo(expected[1], digits);
    expect(actual.z).toBeCloseTo(expected[2], digits);
};

describe("sunDirectionEcef", () => {
    it("戻り値は単位ベクトル", () => {
        const v = sunDirectionEcef(35.68, 139.76, 42, 180);
        expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6);
    });

    it("lat=0,lon=0 で天頂の太陽 → +X 軸（経度0 の地表 up）", () => {
        // 天頂(altitude=90)では方位角は無関係。
        expectVecClose(sunDirectionEcef(0, 0, 90, 0), [1, 0, 0]);
        expectVecClose(sunDirectionEcef(0, 0, 90, 123), [1, 0, 0]);
    });

    it("lat=0,lon=0 で北の地平線上の太陽 → +Z 軸（北極方向）", () => {
        expectVecClose(sunDirectionEcef(0, 0, 0, 0), [0, 0, 1]);
    });

    it("lat=0,lon=0 で東の地平線上の太陽 → +Y 軸（東経90°方向）", () => {
        expectVecClose(sunDirectionEcef(0, 0, 0, 90), [0, 1, 0]);
    });

    it("lat=90（北極）で天頂の太陽 → +Z 軸", () => {
        expectVecClose(sunDirectionEcef(90, 0, 90, 0), [0, 0, 1]);
    });
});
