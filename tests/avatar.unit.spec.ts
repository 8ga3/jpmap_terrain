/**
 * `src/demos/avatar/orbit.ts` の unit test。
 *
 * 円軌道計算のロジック（純粋関数）をテストする。
 */
import { describe, expect, it } from "vitest";

import {
    circularOrbitHeading,
    circularOrbitPosition,
} from "../src/demos/avatar/orbit";

describe("circularOrbitPosition", () => {
    const CENTER_LAT = 35.681236;
    const CENTER_LON = 139.767125;
    const RADIUS_M = 200;

    it("角度 0° で中心の北側に位置する", () => {
        const pos = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 0);
        expect(pos.lat).toBeGreaterThan(CENTER_LAT);
        expect(pos.lon).toBeCloseTo(CENTER_LON, 5);
    });

    it("角度 90° で中心の東側に位置する", () => {
        const pos = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 90);
        expect(pos.lat).toBeCloseTo(CENTER_LAT, 5);
        expect(pos.lon).toBeGreaterThan(CENTER_LON);
    });

    it("角度 180° で中心の南側に位置する", () => {
        const pos = circularOrbitPosition(
            CENTER_LAT,
            CENTER_LON,
            RADIUS_M,
            180,
        );
        expect(pos.lat).toBeLessThan(CENTER_LAT);
        expect(pos.lon).toBeCloseTo(CENTER_LON, 5);
    });

    it("角度 270° で中心の西側に位置する", () => {
        const pos = circularOrbitPosition(
            CENTER_LAT,
            CENTER_LON,
            RADIUS_M,
            270,
        );
        expect(pos.lat).toBeCloseTo(CENTER_LAT, 5);
        expect(pos.lon).toBeLessThan(CENTER_LON);
    });

    it("半径 0 のとき中心と一致する", () => {
        const pos = circularOrbitPosition(CENTER_LAT, CENTER_LON, 0, 45);
        expect(pos.lat).toBeCloseTo(CENTER_LAT, 10);
        expect(pos.lon).toBeCloseTo(CENTER_LON, 10);
    });

    it("中心からの距離が概ね半径に一致する", () => {
        const pos = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 45);
        const dLat = (pos.lat - CENTER_LAT) * (Math.PI / 180) * 6_371_008.8;
        const cosLat = Math.cos((CENTER_LAT * Math.PI) / 180);
        const dLon =
            (pos.lon - CENTER_LON) * (Math.PI / 180) * 6_371_008.8 * cosLat;
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);
        expect(dist).toBeCloseTo(RADIUS_M, 0);
    });

    it("360° 回転すると 0° と同じ位置に戻る", () => {
        const pos0 = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 0);
        const pos360 = circularOrbitPosition(
            CENTER_LAT,
            CENTER_LON,
            RADIUS_M,
            360,
        );
        expect(pos360.lat).toBeCloseTo(pos0.lat, 10);
        expect(pos360.lon).toBeCloseTo(pos0.lon, 10);
    });
});

describe("circularOrbitHeading", () => {
    it("角度 0° で進行方向は 90°（東向き）", () => {
        expect(circularOrbitHeading(0)).toBe(90);
    });

    it("角度 90° で進行方向は 180°（南向き）", () => {
        expect(circularOrbitHeading(90)).toBe(180);
    });

    it("角度 180° で進行方向は 270°（西向き）", () => {
        expect(circularOrbitHeading(180)).toBe(270);
    });

    it("角度 270° で進行方向は 0°（北向き）", () => {
        expect(circularOrbitHeading(270)).toBe(0);
    });

    it("角度 350° で進行方向は 80°", () => {
        expect(circularOrbitHeading(350)).toBe(80);
    });

    it("負の角度 -10° で進行方向は 80°（正規化される）", () => {
        expect(circularOrbitHeading(-10)).toBe(80);
    });

    it("負の角度 -100° で進行方向は 350°（正規化される）", () => {
        expect(circularOrbitHeading(-100)).toBe(350);
    });
});
