/**
 * `dioramaControllerMapping.ts` のunit test。
 */
import { describe, it, expect } from "vitest";
import {
    applyStickDeadzone,
    computeDioramaPanMetersFromStick,
    computeFootprintRadiusFactorFromStick,
    clampFootprintRadiusM,
    computeDioramaRotationRadFromStick,
    computeDioramaHeightMetersFromTriggers,
    clampDioramaHeightOffsetM,
    DEFAULT_STICK_DEADZONE,
    DEFAULT_FOOTPRINT_RADIUS_MIN_M,
    DEFAULT_FOOTPRINT_RADIUS_MAX_M,
    DEFAULT_ROTATION_SPEED_RAD_PER_SEC,
    DEFAULT_HEIGHT_SPEED_M_PER_SEC,
    DEFAULT_HEIGHT_OFFSET_MIN_M,
    DEFAULT_HEIGHT_OFFSET_MAX_M,
} from "../src/demos/diorama/dioramaControllerMapping";

describe("applyStickDeadzone", () => {
    it("|value| <= deadzone は 0 を返す", () => {
        expect(applyStickDeadzone(0.1, 0.15)).toBe(0);
        expect(applyStickDeadzone(-0.15, 0.15)).toBe(0);
        expect(applyStickDeadzone(0, 0.15)).toBe(0);
    });

    it("deadzone超過分を [-1,1] へ再マップする", () => {
        // deadzone=0.15, value=0.575 → (0.575-0.15)/(1-0.15) = 0.5
        expect(applyStickDeadzone(0.575, 0.15)).toBeCloseTo(0.5, 10);
        expect(applyStickDeadzone(-0.575, 0.15)).toBeCloseTo(-0.5, 10);
        expect(applyStickDeadzone(1, 0.15)).toBeCloseTo(1, 10);
        expect(applyStickDeadzone(-1, 0.15)).toBeCloseTo(-1, 10);
    });

    it("deadzone >= 1 は常に0を返す", () => {
        expect(applyStickDeadzone(1, 1)).toBe(0);
        expect(applyStickDeadzone(1, 1.5)).toBe(0);
    });

    it("非有限値は0を返す", () => {
        expect(applyStickDeadzone(NaN, 0.15)).toBe(0);
        expect(applyStickDeadzone(0.5, NaN)).toBe(0);
        expect(applyStickDeadzone(Infinity, 0.15)).toBe(0);
    });
});

describe("computeDioramaPanMetersFromStick", () => {
    it("入力が全てdeadzone以下なら移動量0", () => {
        const result = computeDioramaPanMetersFromStick({ x: 0.05, y: 0.05 }, 1, 800, 0.6);
        expect(result.eastM).toBe(0);
        expect(result.northM).toBe(0);
    });

    it("dtSecondsが0以下なら移動量0", () => {
        expect(computeDioramaPanMetersFromStick({ x: 1, y: 1 }, 0, 800, 0.6)).toEqual({ eastM: 0, northM: 0 });
        expect(computeDioramaPanMetersFromStick({ x: 1, y: 1 }, -1, 800, 0.6)).toEqual({ eastM: 0, northM: 0 });
    });

    it("footprintRadiusMに比例した速度でx=東、-y=北方向へ移動する", () => {
        // deadzone適用後 x=1, y=1 → speed = 0.6 * 800 = 480 m/s
        const result = computeDioramaPanMetersFromStick({ x: 1, y: 1 }, 1, 800, 0.6);
        expect(result.eastM).toBeCloseTo(480, 6);
        // y軸は前方向が負値の規約のため、+y入力は南（northMは負）になる。
        expect(result.northM).toBeCloseTo(-480, 6);
    });

    it("footprintRadiusMが下限未満でも下限値で速度を計算する（低ズームで操作不能にならない）", () => {
        const result = computeDioramaPanMetersFromStick(
            { x: 1, y: 0 },
            1,
            5, // 下限(既定20)未満
            0.6,
            { minFootprintRadiusForSpeedM: 20 },
        );
        expect(result.eastM).toBeCloseTo(0.6 * 20, 6);
    });
});

describe("computeFootprintRadiusFactorFromStick", () => {
    it("入力がdeadzone以下、またはdt/rateが不正なら係数1（変化なし）", () => {
        expect(computeFootprintRadiusFactorFromStick(0.05, 1, 2)).toBe(1);
        expect(computeFootprintRadiusFactorFromStick(1, 0, 2)).toBe(1);
        expect(computeFootprintRadiusFactorFromStick(1, 1, 0)).toBe(1);
        expect(computeFootprintRadiusFactorFromStick(1, 1, -1)).toBe(1);
    });

    it("前方向(y<0)入力で係数が1未満（ズームイン=半径縮小）になる", () => {
        const factor = computeFootprintRadiusFactorFromStick(-1, 1, 2);
        expect(factor).toBeLessThan(1);
        expect(factor).toBeCloseTo(0.5, 10); // 2^(-1*1) = 0.5
    });

    it("後方向(y>0)入力で係数が1超過（ズームアウト=半径拡大）になる", () => {
        const factor = computeFootprintRadiusFactorFromStick(1, 1, 2);
        expect(factor).toBeGreaterThan(1);
        expect(factor).toBeCloseTo(2, 10); // 2^(1*1) = 2
    });
});

describe("clampFootprintRadiusM", () => {
    it("範囲内の値はそのまま返す", () => {
        expect(clampFootprintRadiusM(800)).toBe(800);
    });

    it("下限未満は下限へ、上限超過は上限へクランプする", () => {
        expect(clampFootprintRadiusM(DEFAULT_FOOTPRINT_RADIUS_MIN_M - 50)).toBe(DEFAULT_FOOTPRINT_RADIUS_MIN_M);
        expect(clampFootprintRadiusM(DEFAULT_FOOTPRINT_RADIUS_MAX_M + 1000)).toBe(DEFAULT_FOOTPRINT_RADIUS_MAX_M);
    });

    it("NaN/Infinityは下限側へ丸める", () => {
        expect(clampFootprintRadiusM(NaN)).toBe(DEFAULT_FOOTPRINT_RADIUS_MIN_M);
        expect(clampFootprintRadiusM(Infinity)).toBe(DEFAULT_FOOTPRINT_RADIUS_MAX_M);
        expect(clampFootprintRadiusM(-Infinity)).toBe(DEFAULT_FOOTPRINT_RADIUS_MIN_M);
    });

    it("カスタムのmin/maxを指定できる", () => {
        expect(clampFootprintRadiusM(50, 100, 200)).toBe(100);
        expect(clampFootprintRadiusM(300, 100, 200)).toBe(200);
    });
});

describe("DEFAULT_STICK_DEADZONE", () => {
    it("[0,1)の妥当な既定値である", () => {
        expect(DEFAULT_STICK_DEADZONE).toBeGreaterThan(0);
        expect(DEFAULT_STICK_DEADZONE).toBeLessThan(1);
    });
});

describe("computeDioramaRotationRadFromStick", () => {
    it("入力がdeadzone以下なら回転角0", () => {
        expect(computeDioramaRotationRadFromStick(0.05, 1)).toBe(0);
    });

    it("dtSecondsが0以下なら回転角0", () => {
        expect(computeDioramaRotationRadFromStick(1, 0)).toBe(0);
        expect(computeDioramaRotationRadFromStick(1, -1)).toBe(0);
    });

    it("rotationSpeedRadPerSecが非有限なら回転角0", () => {
        expect(computeDioramaRotationRadFromStick(1, 1, NaN)).toBe(0);
        expect(computeDioramaRotationRadFromStick(1, 1, Infinity)).toBe(0);
    });

    it("フルスティック入力で speed*dt の回転角を返す", () => {
        const result = computeDioramaRotationRadFromStick(1, 1, DEFAULT_ROTATION_SPEED_RAD_PER_SEC);
        expect(result).toBeCloseTo(DEFAULT_ROTATION_SPEED_RAD_PER_SEC, 10);
    });

    it("負の入力で負の回転角を返す", () => {
        const result = computeDioramaRotationRadFromStick(-1, 1, DEFAULT_ROTATION_SPEED_RAD_PER_SEC);
        expect(result).toBeCloseTo(-DEFAULT_ROTATION_SPEED_RAD_PER_SEC, 10);
    });
});

describe("computeDioramaHeightMetersFromTriggers", () => {
    it("両トリガー未入力なら高さ変更量0", () => {
        expect(computeDioramaHeightMetersFromTriggers(0, 0, 1)).toBe(0);
    });

    it("dtSecondsが0以下なら高さ変更量0", () => {
        expect(computeDioramaHeightMetersFromTriggers(0, 1, 0)).toBe(0);
        expect(computeDioramaHeightMetersFromTriggers(0, 1, -1)).toBe(0);
    });

    it("heightSpeedMPerSecが非有限なら高さ変更量0", () => {
        expect(computeDioramaHeightMetersFromTriggers(0, 1, 1, NaN)).toBe(0);
    });

    it("右トリガーのみフル押下で上昇（正の変更量）", () => {
        const result = computeDioramaHeightMetersFromTriggers(0, 1, 1, DEFAULT_HEIGHT_SPEED_M_PER_SEC);
        expect(result).toBeCloseTo(DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
    });

    it("左トリガーのみフル押下で下降（負の変更量）", () => {
        const result = computeDioramaHeightMetersFromTriggers(1, 0, 1, DEFAULT_HEIGHT_SPEED_M_PER_SEC);
        expect(result).toBeCloseTo(-DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
    });

    it("両方フル押下は相殺されて0", () => {
        expect(computeDioramaHeightMetersFromTriggers(1, 1, 1, DEFAULT_HEIGHT_SPEED_M_PER_SEC)).toBe(0);
    });

    it("範囲外・非有限のトリガー値は0/1へクランプしてから計算する", () => {
        const result = computeDioramaHeightMetersFromTriggers(-1, 1.5, 1, DEFAULT_HEIGHT_SPEED_M_PER_SEC);
        expect(result).toBeCloseTo(DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
        expect(computeDioramaHeightMetersFromTriggers(NaN, 1, 1, DEFAULT_HEIGHT_SPEED_M_PER_SEC)).toBeCloseTo(
            DEFAULT_HEIGHT_SPEED_M_PER_SEC,
            10,
        );
    });
});

describe("clampDioramaHeightOffsetM", () => {
    it("範囲内の値はそのまま返す", () => {
        expect(clampDioramaHeightOffsetM(0.1)).toBe(0.1);
    });

    it("下限未満は下限へ、上限超過は上限へクランプする", () => {
        expect(clampDioramaHeightOffsetM(DEFAULT_HEIGHT_OFFSET_MIN_M - 1)).toBe(DEFAULT_HEIGHT_OFFSET_MIN_M);
        expect(clampDioramaHeightOffsetM(DEFAULT_HEIGHT_OFFSET_MAX_M + 1)).toBe(DEFAULT_HEIGHT_OFFSET_MAX_M);
    });

    it("NaNは0（オフセット無し）側へフォールバックしてからクランプする", () => {
        expect(clampDioramaHeightOffsetM(NaN)).toBe(0);
    });

    it("カスタムのmin/maxを指定できる", () => {
        expect(clampDioramaHeightOffsetM(-1, -0.5, 0.5)).toBe(-0.5);
        expect(clampDioramaHeightOffsetM(1, -0.5, 0.5)).toBe(0.5);
    });
});
