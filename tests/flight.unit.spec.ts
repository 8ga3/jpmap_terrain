/**
 * `src/demos/flight/index.ts` の unit test (Issue #245)。
 *
 * 飛行機デモでは `src/demos/avatar/orbit.ts` の計算ユーティリティを再利用する。
 * orbit.ts 自体のテストは `tests/avatar.unit.spec.ts` で網羅済みのため、
 * ここではフライトデモ固有のパラメータ（大半径・高高度）での動作を確認する。
 */
import { describe, it, expect } from "@jest/globals";

import { circularOrbitPosition, circularOrbitHeading } from "../src/demos/avatar/orbit";

describe("flight demo - orbit with large radius", () => {
    const CENTER_LAT = 35.681236;
    const CENTER_LON = 139.767125;
    const RADIUS_M = 2000;

    it("半径 2000m でも中心からの距離が概ね半径に一致する", () => {
        const pos = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 45);
        const dLat = (pos.lat - CENTER_LAT) * (Math.PI / 180) * 6_371_008.8;
        const cosLat = Math.cos((CENTER_LAT * Math.PI) / 180);
        const dLon = (pos.lon - CENTER_LON) * (Math.PI / 180) * 6_371_008.8 * cosLat;
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);
        expect(dist).toBeCloseTo(RADIUS_M, -1);
    });

    it("半径 5000m でも中心からの距離が概ね半径に一致する", () => {
        const bigRadius = 5000;
        const pos = circularOrbitPosition(CENTER_LAT, CENTER_LON, bigRadius, 120);
        const dLat = (pos.lat - CENTER_LAT) * (Math.PI / 180) * 6_371_008.8;
        const cosLat = Math.cos((CENTER_LAT * Math.PI) / 180);
        const dLon = (pos.lon - CENTER_LON) * (Math.PI / 180) * 6_371_008.8 * cosLat;
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);
        expect(dist).toBeCloseTo(bigRadius, -1);
    });

    it("高速回転（60°/s × 6秒 = 360°）で一周して元に戻る", () => {
        const pos0 = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 0);
        const pos360 = circularOrbitPosition(CENTER_LAT, CENTER_LON, RADIUS_M, 360);
        expect(pos360.lat).toBeCloseTo(pos0.lat, 10);
        expect(pos360.lon).toBeCloseTo(pos0.lon, 10);
    });

    it("heading は角度 + 90° で接線方向を向く", () => {
        expect(circularOrbitHeading(0)).toBe(90);
        expect(circularOrbitHeading(90)).toBe(180);
        expect(circularOrbitHeading(270)).toBe(0);
    });
});
