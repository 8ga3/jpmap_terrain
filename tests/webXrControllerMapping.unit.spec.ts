import { describe, expect, it } from "vitest";
import {
    applyStickDeadzone,
    computeAltitudeFactorFromStick,
    computeLodBiasForAltitude,
    computePanMetersFromStick,
    computeVrCameraClipPlanes,
    DEFAULT_MIN_ALTITUDE_FOR_PAN_SPEED_M,
    DEFAULT_STICK_DEADZONE,
    DEFAULT_VR_HOVER_HEIGHT_M,
    DEFAULT_VR_LOD_EFFECTIVE_RADIUS_MIN_M,
    DEFAULT_VR_MAX_Z_CAP_M,
    FOLLOW_TILE_BASE_RADIUS_M_REFERENCE,
    resolveVrHoverHeightM,
    resolveVrLodEffectiveRadiusM,
} from "../src/demos/viewer/webXrControllerMapping";

describe("applyStickDeadzone", () => {
    it("returns 0 within the deadzone", () => {
        expect(applyStickDeadzone(0.1, 0.15)).toBe(0);
        expect(applyStickDeadzone(-0.15, 0.15)).toBe(0);
    });

    it("rescales values outside the deadzone to [-1,1]", () => {
        expect(applyStickDeadzone(1, 0.15)).toBeCloseTo(1);
        expect(applyStickDeadzone(-1, 0.15)).toBeCloseTo(-1);
        // (0.5 - 0.15) / (1 - 0.15) = 0.35 / 0.85
        expect(applyStickDeadzone(0.5, 0.15)).toBeCloseTo(0.35 / 0.85);
        expect(applyStickDeadzone(-0.5, 0.15)).toBeCloseTo(-0.35 / 0.85);
    });

    it("returns 0 for non-finite input or deadzone >= 1", () => {
        expect(applyStickDeadzone(Number.NaN, 0.15)).toBe(0);
        expect(applyStickDeadzone(0.5, 1)).toBe(0);
        expect(applyStickDeadzone(0.5, Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe("computePanMetersFromStick", () => {
    it("returns zero movement when the stick is within the deadzone", () => {
        const result = computePanMetersFromStick({ x: 0.05, y: -0.05 }, 1 / 60, 1000, 0.5);
        expect(result).toEqual({ eastM: 0, northM: 0 });
    });

    it("moves east for positive x and north for negative y (forward)", () => {
        const result = computePanMetersFromStick({ x: 1, y: -1 }, 1, 1000, 0.01);
        // speed = 0.01 * 1000 = 10 m/s, dt=1s -> 10m
        expect(result.eastM).toBeCloseTo(10);
        expect(result.northM).toBeCloseTo(10);
    });

    it("moves west/south for negative x and positive y (backward)", () => {
        const result = computePanMetersFromStick({ x: -1, y: 1 }, 1, 1000, 0.01);
        expect(result.eastM).toBeCloseTo(-10);
        expect(result.northM).toBeCloseTo(-10);
    });

    it("clamps the speed scaling altitude to the configured minimum at low altitude", () => {
        const result = computePanMetersFromStick({ x: 1, y: 0 }, 1, 1, 0.01, {
            minAltitudeForSpeedM: 30,
        });
        // effective altitude clamped to 30m -> speed = 0.3 m/s
        expect(result.eastM).toBeCloseTo(0.3);
    });

    it("uses the default minimum altitude when not specified", () => {
        const result = computePanMetersFromStick({ x: 1, y: 0 }, 1, 0, 1);
        expect(result.eastM).toBeCloseTo(DEFAULT_MIN_ALTITUDE_FOR_PAN_SPEED_M);
    });

    it("returns zero movement for non-finite or non-positive dt", () => {
        expect(computePanMetersFromStick({ x: 1, y: 1 }, 0, 1000, 0.01)).toEqual({
            eastM: 0,
            northM: 0,
        });
        expect(computePanMetersFromStick({ x: 1, y: 1 }, -1, 1000, 0.01)).toEqual({
            eastM: 0,
            northM: 0,
        });
        expect(computePanMetersFromStick({ x: 1, y: 1 }, Number.NaN, 1000, 0.01)).toEqual({
            eastM: 0,
            northM: 0,
        });
    });

    it("honors a custom deadzone option", () => {
        const result = computePanMetersFromStick({ x: 0.5, y: 0 }, 1, 1000, 0.01, {
            deadzone: 0.6,
        });
        expect(result.eastM).toBe(0);
    });
});

describe("computeAltitudeFactorFromStick", () => {
    it("returns 1 (no change) when the stick is within the deadzone", () => {
        expect(computeAltitudeFactorFromStick(0.05, 1, 4)).toBe(1);
    });

    it("returns a factor < 1 (zoom in) when pushed forward (negative y)", () => {
        const factor = computeAltitudeFactorFromStick(-1, 1, 4);
        expect(factor).toBeCloseTo(0.25);
    });

    it("returns a factor > 1 (zoom out) when pulled backward (positive y)", () => {
        const factor = computeAltitudeFactorFromStick(1, 1, 4);
        expect(factor).toBeCloseTo(4);
    });

    it("scales with dtSeconds (half-second push zooms in less than a full second)", () => {
        const half = computeAltitudeFactorFromStick(-1, 0.5, 4);
        const full = computeAltitudeFactorFromStick(-1, 1, 4);
        expect(half).toBeGreaterThan(full);
        expect(half).toBeCloseTo(0.5);
    });

    it("returns 1 for non-finite/non-positive dt or zoom rate", () => {
        expect(computeAltitudeFactorFromStick(-1, 0, 4)).toBe(1);
        expect(computeAltitudeFactorFromStick(-1, -1, 4)).toBe(1);
        expect(computeAltitudeFactorFromStick(-1, Number.NaN, 4)).toBe(1);
        expect(computeAltitudeFactorFromStick(-1, 1, 0)).toBe(1);
        expect(computeAltitudeFactorFromStick(-1, 1, -1)).toBe(1);
    });

    it("uses the default deadzone when not specified", () => {
        expect(computeAltitudeFactorFromStick(DEFAULT_STICK_DEADZONE, 1, 4)).toBe(1);
    });
});

describe("computeLodBiasForAltitude", () => {
    it("returns 0 when targetRadiusM equals the reference base radius", () => {
        expect(computeLodBiasForAltitude(FOLLOW_TILE_BASE_RADIUS_M_REFERENCE)).toBeCloseTo(0);
    });

    it("returns a positive bias when targetRadiusM is smaller than the reference (zoomed in)", () => {
        // FOLLOW_TILE_BASE_RADIUS_M_REFERENCE * 2^-bias = targetRadiusM を満たす。
        const targetRadiusM = FOLLOW_TILE_BASE_RADIUS_M_REFERENCE / 4;
        const bias = computeLodBiasForAltitude(targetRadiusM);
        expect(bias).toBeCloseTo(2);
        expect(FOLLOW_TILE_BASE_RADIUS_M_REFERENCE * Math.pow(2, -bias)).toBeCloseTo(targetRadiusM);
    });

    it("returns a negative bias when targetRadiusM is larger than the reference (zoomed out)", () => {
        const targetRadiusM = FOLLOW_TILE_BASE_RADIUS_M_REFERENCE * 8;
        const bias = computeLodBiasForAltitude(targetRadiusM);
        expect(bias).toBeCloseTo(-3);
        expect(FOLLOW_TILE_BASE_RADIUS_M_REFERENCE * Math.pow(2, -bias)).toBeCloseTo(targetRadiusM);
    });
});

describe("resolveVrHoverHeightM", () => {
    it("returns the default hover height when the query param is absent", () => {
        expect(resolveVrHoverHeightM("")).toBe(DEFAULT_VR_HOVER_HEIGHT_M);
        expect(resolveVrHoverHeightM("?engine=webgl2")).toBe(DEFAULT_VR_HOVER_HEIGHT_M);
    });

    it("parses a valid vrHoverHeight query param", () => {
        expect(resolveVrHoverHeightM("?vrHoverHeight=300")).toBe(300);
        expect(resolveVrHoverHeightM("?engine=webgl2&vrHoverHeight=50")).toBe(50);
    });

    it("falls back to the default for non-numeric or non-positive values", () => {
        expect(resolveVrHoverHeightM("?vrHoverHeight=abc")).toBe(DEFAULT_VR_HOVER_HEIGHT_M);
        expect(resolveVrHoverHeightM("?vrHoverHeight=0")).toBe(DEFAULT_VR_HOVER_HEIGHT_M);
        expect(resolveVrHoverHeightM("?vrHoverHeight=-50")).toBe(DEFAULT_VR_HOVER_HEIGHT_M);
    });
});

describe("resolveVrLodEffectiveRadiusM", () => {
    it("floors low altitudes to the minimum effective radius", () => {
        expect(resolveVrLodEffectiveRadiusM(50)).toBe(DEFAULT_VR_LOD_EFFECTIVE_RADIUS_MIN_M);
        expect(resolveVrLodEffectiveRadiusM(150)).toBe(DEFAULT_VR_LOD_EFFECTIVE_RADIUS_MIN_M);
    });

    it("leaves altitudes above the minimum unchanged", () => {
        expect(resolveVrLodEffectiveRadiusM(2000)).toBe(2000);
    });

    it("honors a custom minimum", () => {
        expect(resolveVrLodEffectiveRadiusM(150, 100)).toBe(150);
        expect(resolveVrLodEffectiveRadiusM(50, 100)).toBe(100);
    });
});

describe("computeVrCameraClipPlanes", () => {
    it("uses a much smaller maxZ than the desktop GeospatialClippingBehavior formula at low altitude", () => {
        // デスクトップの式（horizonDist + planetRadius*0.1）だと altitude=150 でも
        // maxZ は惑星半径の1割（地球なら約638km）が下限になってしまう。
        const { minZ, maxZ } = computeVrCameraClipPlanes(150);
        expect(maxZ).toBeLessThan(200_000);
        expect(minZ).toBeGreaterThan(0);
        expect(maxZ).toBeGreaterThan(minZ);
    });

    it("increases minZ as altitude increases (once above the floor)", () => {
        const low = computeVrCameraClipPlanes(150);
        const high = computeVrCameraClipPlanes(500);
        expect(high.minZ).toBeGreaterThan(low.minZ);
    });

    it("increases maxZ as altitude increases (below the cap)", () => {
        const low = computeVrCameraClipPlanes(10);
        const high = computeVrCameraClipPlanes(20);
        expect(high.maxZ).toBeGreaterThan(low.maxZ);
        expect(high.maxZ).toBeLessThan(DEFAULT_VR_MAX_Z_CAP_M);
    });

    it("clamps to sane floors for near-zero or negative altitude", () => {
        const { minZ, maxZ } = computeVrCameraClipPlanes(0);
        expect(minZ).toBeGreaterThan(0);
        expect(maxZ).toBeGreaterThan(minZ);
        const negative = computeVrCameraClipPlanes(-100);
        expect(negative.minZ).toBeGreaterThan(0);
        expect(negative.maxZ).toBeGreaterThan(negative.minZ);
    });

    it("keeps maxZ/minZ ratio far smaller than the previous fixed 6,000,000 far clip", () => {
        const { minZ, maxZ } = computeVrCameraClipPlanes(150);
        // 修正前は minZ=1, maxZ=6,000,000（比率 600万）だった。
        expect(maxZ / minZ).toBeLessThan(600_000);
    });

    it("caps maxZ at high altitude instead of growing unbounded with horizon distance", () => {
        // 高度200km（タイルレベル8相当、実機検証で症状が確認された高度）では、
        // 地平線距離ベースの式だけだと maxZ が約3,200kmまで際限なく膨らんでしまう。
        // ブラウザが極端な depthFar を無視/クランプする問題を避けるため、絶対上限で
        // 頭打ちにする。
        const { maxZ } = computeVrCameraClipPlanes(200_000);
        expect(maxZ).toBe(DEFAULT_VR_MAX_Z_CAP_M);
    });

    it("caps maxZ identically at an even higher altitude (300km)", () => {
        const { maxZ } = computeVrCameraClipPlanes(300_000);
        expect(maxZ).toBe(DEFAULT_VR_MAX_Z_CAP_M);
    });
});
