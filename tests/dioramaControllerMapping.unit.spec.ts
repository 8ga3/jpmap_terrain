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
    computeHeadingRadFromHorizontal,
    rotateHorizontalUnitVector,
    computePanAxesFromDirectionalInput,
    snapHeadingRad,
    DEFAULT_STICK_DEADZONE,
    DEFAULT_FOOTPRINT_RADIUS_MIN_M,
    DEFAULT_FOOTPRINT_RADIUS_MAX_M,
    DEFAULT_ROTATION_SPEED_RAD_PER_SEC,
    DEFAULT_HEIGHT_SPEED_M_PER_SEC,
    DEFAULT_HEIGHT_OFFSET_MIN_M,
    DEFAULT_HEIGHT_OFFSET_MAX_M,
    DEFAULT_HEADING_SNAP_STEP_RAD,
    DEFAULT_HEADING_SNAP_HYSTERESIS_RAD,
    computeHorizontalDisplacement,
    isInsideDioramaDeadZone,
    DEFAULT_DEAD_ZONE_HYSTERESIS_M,
    angleDeltaRad,
    normalizeAngleRad,
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

describe("computeHeadingRadFromHorizontal", () => {
    it("北(z=1)は0、東(x=1)はπ/2、南(z=-1)はπ、西(x=-1)は-π/2を返す", () => {
        expect(computeHeadingRadFromHorizontal(0, 1)).toBeCloseTo(0);
        expect(computeHeadingRadFromHorizontal(1, 0)).toBeCloseTo(Math.PI / 2);
        expect(computeHeadingRadFromHorizontal(0, -1)).toBeCloseTo(Math.PI);
        expect(computeHeadingRadFromHorizontal(-1, 0)).toBeCloseTo(-Math.PI / 2);
    });

    it("零ベクトル・非有限値は0を返す", () => {
        expect(computeHeadingRadFromHorizontal(0, 0)).toBe(0);
        expect(computeHeadingRadFromHorizontal(NaN, 1)).toBe(0);
        expect(computeHeadingRadFromHorizontal(0, Infinity)).toBe(0);
    });
});

describe("rotateHorizontalUnitVector", () => {
    it("北ベクトルをπ/2回転させると東ベクトルになる（向き角の加算と整合）", () => {
        const rotated = rotateHorizontalUnitVector({ x: 0, z: 1 }, Math.PI / 2);
        expect(rotated.x).toBeCloseTo(1);
        expect(rotated.z).toBeCloseTo(0);
    });

    it("deltaRad=0は入力をそのまま返す", () => {
        expect(rotateHorizontalUnitVector({ x: 0.6, z: 0.8 }, 0)).toEqual({ x: 0.6, z: 0.8 });
    });

    it("非有限値のdeltaRadは入力をそのまま返す", () => {
        expect(rotateHorizontalUnitVector({ x: 0.6, z: 0.8 }, NaN)).toEqual({ x: 0.6, z: 0.8 });
    });
});

describe("computePanAxesFromDirectionalInput", () => {
    it("北向き基準で前進すると北（y=-1）、右移動すると東（x=1）になる", () => {
        const north = { x: 0, z: 1 };
        const east = { x: 1, z: 0 };
        expect(computePanAxesFromDirectionalInput(1, 0, north, east)).toEqual({ x: 0, y: -1 });
        expect(computePanAxesFromDirectionalInput(0, 1, north, east)).toEqual({ x: 1, y: 0 });
    });

    it("東向き基準で前進すると東（x=1）へ移動する（頭の向き基準の回転が反映される）", () => {
        const east = { x: 1, z: 0 };
        const south = { x: 0, z: -1 };
        const panAxes = computePanAxesFromDirectionalInput(1, 0, east, south);
        expect(panAxes.x).toBeCloseTo(1);
        expect(panAxes.y).toBeCloseTo(0);
    });

    it("前進+右同時入力は大きさ1へ正規化される（斜め移動が軸沿いより速くならない）", () => {
        const north = { x: 0, z: 1 };
        const east = { x: 1, z: 0 };
        const panAxes = computePanAxesFromDirectionalInput(1, 1, north, east);
        expect(Math.hypot(panAxes.x, panAxes.y)).toBeCloseTo(1);
    });

    it("入力が両方0の場合は{x:0,y:0}を返す", () => {
        expect(computePanAxesFromDirectionalInput(0, 0, { x: 0, z: 1 }, { x: 1, z: 0 })).toEqual({ x: 0, y: 0 });
    });
});

describe("snapHeadingRad", () => {
    it("既定値は45°ステップ・5°ヒステリシス", () => {
        expect(DEFAULT_HEADING_SNAP_STEP_RAD).toBeCloseTo(Math.PI / 4);
        expect(DEFAULT_HEADING_SNAP_HYSTERESIS_RAD).toBeCloseTo(Math.PI / 36);
    });

    it("初回（previousが未指定）はヒステリシス無しで最も近い方位へスナップする", () => {
        expect(snapHeadingRad(0.3, undefined)).toBeCloseTo(0);
        expect(snapHeadingRad(0.5, undefined)).toBeCloseTo(Math.PI / 4);
    });

    it("前回値からの差がstep/2+ヒステリシス以内なら前回値を維持する（境界近傍のちらつき防止）", () => {
        // step/2 + hysteresis = 22.5° + 5° = 27.5° ≈ 0.4801rad
        expect(snapHeadingRad(0.47, 0)).toBe(0);
    });

    it("前回値からの差がstep/2+ヒステリシスを超えたら次の方位へ切り替わる", () => {
        expect(snapHeadingRad(0.49, 0)).toBeCloseTo(Math.PI / 4);
    });

    it("±πの境界をまたいでも正しく最短距離で判定する（ラップアラウンド）", () => {
        // previous=π（180°）、raw=-π+0.05（-180°付近から反対側へわずかに超えた値）は
        // 実際にはprevious（180°）からわずか0.05radしか離れていない。
        expect(snapHeadingRad(-Math.PI + 0.05, Math.PI)).toBeCloseTo(Math.PI);
    });

    it("非有限値のrawHeadingRadは前回値（未指定なら0）を維持する", () => {
        expect(snapHeadingRad(NaN, 0.5)).toBe(0.5);
        expect(snapHeadingRad(NaN, undefined)).toBe(0);
    });

    it("stepRadが0以下の場合は前回値（未指定なら0）を維持する", () => {
        expect(snapHeadingRad(1, 0.5, 0)).toBe(0.5);
    });
});

describe("normalizeAngleRad", () => {
    it("(-π, π]の範囲内の値はそのまま返す", () => {
        expect(normalizeAngleRad(0)).toBeCloseTo(0);
        expect(normalizeAngleRad(Math.PI)).toBeCloseTo(Math.PI);
        expect(normalizeAngleRad(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    });

    it("範囲外の値は(-π, π]へラップする", () => {
        expect(normalizeAngleRad(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2);
        expect(normalizeAngleRad(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
        expect(normalizeAngleRad(Math.PI * 3)).toBeCloseTo(Math.PI);
    });
});

describe("angleDeltaRad", () => {
    it("通常の範囲内では単純な引き算と一致する", () => {
        expect(angleDeltaRad(0, Math.PI / 4)).toBeCloseTo(Math.PI / 4);
        expect(angleDeltaRad(Math.PI / 4, 0)).toBeCloseTo(-Math.PI / 4);
    });

    it("±π境界を跨ぐ場合でも最短差分（絶対値がπ以下）を返す（回帰テスト）", () => {
        // raw≈-π, snapped=π は実際には反対方向へのわずかな差（π - (-π+0.01) ≈ -0.01+2π→-0.01）。
        // 単純な引き算（snapped - raw）だとほぼ2πになってしまう問題の回帰テスト。
        const raw = -Math.PI + 0.01;
        const snapped = Math.PI;
        const delta = angleDeltaRad(raw, snapped);
        expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI);
        expect(delta).toBeCloseTo(-0.01);
    });

    it("同じ角度なら差分は0", () => {
        expect(angleDeltaRad(Math.PI / 3, Math.PI / 3)).toBeCloseTo(0);
    });
});

describe("computeHorizontalDisplacement", () => {
    it("fromからtoへの単位ベクトルと距離を返す", () => {
        const { unit, distanceM } = computeHorizontalDisplacement(0, 0, 0, 5);
        expect(unit).toEqual({ x: 0, z: 1 });
        expect(distanceM).toBeCloseTo(5);
    });

    it("斜め方向でも正しい単位ベクトル・距離を返す", () => {
        const { unit, distanceM } = computeHorizontalDisplacement(0, 0, 3, 4);
        expect(unit.x).toBeCloseTo(0.6);
        expect(unit.z).toBeCloseTo(0.8);
        expect(distanceM).toBeCloseTo(5);
    });

    it("fromとtoが同一（距離0）の場合は{x:0,z:0}・距離0を返す", () => {
        expect(computeHorizontalDisplacement(1, 1, 1, 1)).toEqual({ unit: { x: 0, z: 0 }, distanceM: 0 });
    });

    it("非有限値を含む場合は{x:0,z:0}・距離0を返す", () => {
        expect(computeHorizontalDisplacement(NaN, 0, 0, 0)).toEqual({ unit: { x: 0, z: 0 }, distanceM: 0 });
        expect(computeHorizontalDisplacement(0, 0, Infinity, 0)).toEqual({ unit: { x: 0, z: 0 }, distanceM: 0 });
    });
});

describe("isInsideDioramaDeadZone", () => {
    it("既定のヒステリシス幅は0.05m", () => {
        expect(DEFAULT_DEAD_ZONE_HYSTERESIS_M).toBe(0.05);
    });

    it("外側にいた場合、距離が半径以下になった時点でデッドゾーン内と判定する", () => {
        expect(isInsideDioramaDeadZone(0.3, false, 0.35)).toBe(true);
        expect(isInsideDioramaDeadZone(0.35, false, 0.35)).toBe(true);
        expect(isInsideDioramaDeadZone(0.36, false, 0.35)).toBe(false);
    });

    it("内側にいた場合、半径+ヒステリシスを超えるまでデッドゾーン内のまま維持する", () => {
        expect(isInsideDioramaDeadZone(0.39, true, 0.35)).toBe(true);
        expect(isInsideDioramaDeadZone(0.399, true, 0.35)).toBe(true);
        expect(isInsideDioramaDeadZone(0.41, true, 0.35)).toBe(false);
    });

    it("カスタムのヒステリシス幅を指定できる", () => {
        expect(isInsideDioramaDeadZone(0.5, true, 0.35, 0.2)).toBe(true);
        expect(isInsideDioramaDeadZone(0.56, true, 0.35, 0.2)).toBe(false);
    });

    it("非有限値のdistanceMは前フレームの判定を維持する", () => {
        expect(isInsideDioramaDeadZone(NaN, true, 0.35)).toBe(true);
        expect(isInsideDioramaDeadZone(NaN, false, 0.35)).toBe(false);
    });

    it("負のdeadZoneRadiusMは前フレームの判定を維持する", () => {
        expect(isInsideDioramaDeadZone(0.1, false, -1)).toBe(false);
        expect(isInsideDioramaDeadZone(0.1, true, -1)).toBe(true);
    });
});

