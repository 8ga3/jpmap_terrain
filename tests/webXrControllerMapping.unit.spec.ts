import { describe, expect, it } from "vitest";
import {
    applyStickDeadzone,
    computeAltitudeFactorFromStick,
    computePanMetersFromStick,
    DEFAULT_MIN_ALTITUDE_FOR_PAN_SPEED_M,
    DEFAULT_STICK_DEADZONE,
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
