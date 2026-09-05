/**
 * roiorbit デモのカメラ経路計算の単体テスト。
 *
 * - cameraPositionForRoiOrbit: 円周上の位置・カメラ絶対高度固定
 * - headingForRoiOrbit: ROI 中心を向く方位角（コンパス UI 同期用）
 * - advanceRoiOrbit: 周回ステートマシンの進行・1周期での剰余・フレームスキップ耐性
 */
import { describe, expect, it } from "vitest";

import {
    advanceRoiOrbit,
    cameraPositionForRoiOrbit,
    headingForRoiOrbit,
    type RoiOrbitConfig,
    type RoiOrbitState,
} from "../src/demos/roiorbit/orbitLoop";

const CONFIG: RoiOrbitConfig = {
    center: { lat: 35.360833, lon: 138.727361 },
    radiusM: 420,
    cameraAltitudeM: 3900,
    angularSpeedDegPerSec: 3, // 1周 = 120秒
};

describe("cameraPositionForRoiOrbit", () => {
    it("elapsedMs=0（角度0=中心の真北）では中心の北側に位置し、絶対高度は一定値", () => {
        const state: RoiOrbitState = { elapsedMs: 0 };
        const position = cameraPositionForRoiOrbit(state, CONFIG);
        expect(position.lat).toBeGreaterThan(CONFIG.center.lat);
        expect(position.lon).toBeCloseTo(CONFIG.center.lon, 6);
        expect(position.altitudeM).toBe(CONFIG.cameraAltitudeM);
    });

    it("1/4周後（90°）は中心の東側に位置する", () => {
        // 90° / 3deg/s = 30秒 = 30_000ms
        const state: RoiOrbitState = { elapsedMs: 30_000 };
        const position = cameraPositionForRoiOrbit(state, CONFIG);
        expect(position.lon).toBeGreaterThan(CONFIG.center.lon);
        expect(position.lat).toBeCloseTo(CONFIG.center.lat, 6);
        expect(position.altitudeM).toBe(CONFIG.cameraAltitudeM);
    });

    it("時計回りに進行する（経過時間とともに角度が北→東→南→西の順で増える）", () => {
        const north = cameraPositionForRoiOrbit({ elapsedMs: 0 }, CONFIG);
        const east = cameraPositionForRoiOrbit({ elapsedMs: 30_000 }, CONFIG);
        const south = cameraPositionForRoiOrbit({ elapsedMs: 60_000 }, CONFIG);
        // 北→東で経度が増加、東→南で緯度が減少（時計回りの軌道）。
        expect(east.lon).toBeGreaterThan(north.lon);
        expect(south.lat).toBeLessThan(east.lat);
    });

    it("角速度が0以下の異常値では角度0（初期位置）に固定される", () => {
        const invalidConfig: RoiOrbitConfig = {
            ...CONFIG,
            angularSpeedDegPerSec: 0,
        };
        const position = cameraPositionForRoiOrbit(
            { elapsedMs: 50_000 },
            invalidConfig,
        );
        const initial = cameraPositionForRoiOrbit(
            { elapsedMs: 0 },
            invalidConfig,
        );
        expect(position).toEqual(initial);
    });
});

describe("headingForRoiOrbit", () => {
    it("角度0（中心の北側）では方位角は南（180°）で中心を向く", () => {
        const state: RoiOrbitState = { elapsedMs: 0 };
        expect(headingForRoiOrbit(state, CONFIG)).toBeCloseTo(180, 6);
    });

    it("1/4周後（中心の東側）では方位角は西（270°）で中心を向く", () => {
        const state: RoiOrbitState = { elapsedMs: 30_000 };
        expect(headingForRoiOrbit(state, CONFIG)).toBeCloseTo(270, 6);
    });
});

describe("advanceRoiOrbit", () => {
    it("deltaMsの分だけelapsedMsが進む", () => {
        const state: RoiOrbitState = { elapsedMs: 1_000 };
        const next = advanceRoiOrbit(state, 2_000, CONFIG);
        expect(next.elapsedMs).toBeCloseTo(3_000, 6);
    });

    it("1周期(120秒)経過するとelapsedMsが0へ戻る（剰余で正規化）", () => {
        const state: RoiOrbitState = { elapsedMs: 0 };
        const next = advanceRoiOrbit(state, 120_000, CONFIG);
        expect(next.elapsedMs).toBeCloseTo(0, 6);
    });

    it("1周期を跨ぐ大きなdeltaMsでも剰余で正しい位相に収束する", () => {
        const state: RoiOrbitState = { elapsedMs: 0 };
        // 120s(1周) * 100 + 45s の端数。
        const next = advanceRoiOrbit(state, 120_000 * 100 + 45_000, CONFIG);
        expect(next.elapsedMs).toBeCloseTo(45_000, 6);
    });

    it("負のdeltaMsは無視され後退しない", () => {
        const state: RoiOrbitState = { elapsedMs: 10_000 };
        const next = advanceRoiOrbit(state, -5_000, CONFIG);
        expect(next.elapsedMs).toBeCloseTo(10_000, 6);
    });

    it("角速度が0以下の異常値でも無限ループ・NaNにならない", () => {
        const invalidConfig: RoiOrbitConfig = {
            ...CONFIG,
            angularSpeedDegPerSec: 0,
        };
        const state: RoiOrbitState = { elapsedMs: 0 };
        const next = advanceRoiOrbit(state, 999_999, invalidConfig);
        expect(Number.isFinite(next.elapsedMs)).toBe(true);
    });

    it("角速度が0以下の異常値では周期が定まらないため状態を更新せず固定する", () => {
        const invalidConfig: RoiOrbitConfig = {
            ...CONFIG,
            angularSpeedDegPerSec: 0,
        };
        const state: RoiOrbitState = { elapsedMs: 12_345 };
        const next = advanceRoiOrbit(state, 999_999, invalidConfig);
        expect(next).toEqual(state);
    });
});
