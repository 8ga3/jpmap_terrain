/**
 * zoomloop デモのカメラ経路計算の単体テスト。
 *
 * - interpolatePosition / interpolateAltitude: 補間の境界値・中間値
 * - interpolateOrientation: Quaternion Slerp による最短回転経路（0°/360° 境界での過大回転が
 *   起きないこと）と境界値（t=0/1 で start/end に一致すること）
 * - computeCameraFrame: イージング適用後の合成結果
 * - advanceZoomLoop / cameraFrameForState: ループステートマシンの往復・静止・
 *   フレームスキップ耐性
 */
import { describe, it, expect } from "vitest";

import {
    advanceZoomLoop,
    cameraFrameForState,
    computeCameraFrame,
    easeInOutCubic,
    interpolateAltitude,
    interpolateOrientation,
    interpolatePosition,
    type CameraEndpoint,
    type ZoomLoopConfig,
    type ZoomLoopState,
} from "../src/demos/zoomloop/cameraPath";

/** 大気圏（カルマン線目安）より十分低い/高い高度。位置固定しきい値のテスト用。 */
const LOW_ALTITUDE = 1_000;
const HIGH_ALTITUDE = 1_000_000;

const ZOOM_IN: CameraEndpoint = {
    lat: 35.345984,
    lon: 138.732388,
    altitude: 2570,
    azimuth: 0.35,
    tilt: 68.74,
};

const ZOOM_OUT: CameraEndpoint = {
    lat: 33.169094,
    lon: 134.931644,
    altitude: 3176946,
    azimuth: 359.83,
    tilt: 41.13,
};

describe("interpolatePosition", () => {
    const start = { lat: 10, lon: 20 };
    const end = { lat: 30, lon: 40 };

    it("t=0/1 で始点・終点を返す", () => {
        const at0 = interpolatePosition(start, end, 0);
        const at1 = interpolatePosition(start, end, 1);
        expect(at0.lat).toBeCloseTo(10, 5);
        expect(at0.lon).toBeCloseTo(20, 5);
        expect(at1.lat).toBeCloseTo(30, 5);
        expect(at1.lon).toBeCloseTo(40, 5);
    });

    it("t=0.5 は大圏（球面上の最短測地線）上の中点になる（緯度経度の単純な算術平均とは異なる）", () => {
        // クォータニオン補間なので、算術平均 {lat:20, lon:30} ではなく
        // 大圏上の中点（球面幾何で決まる値）になる。
        const mid = interpolatePosition(start, end, 0.5);
        expect(mid.lat).toBeCloseTo(20.282367, 5);
        expect(mid.lon).toBeCloseTo(29.351653, 5);
    });

    it("extraTurnsを指定しても t=1 では終点に一致する（丸ごとの周回は最終到達点に影響しない）", () => {
        const withoutTurns = interpolatePosition(start, end, 1, 0);
        const withTurns = interpolatePosition(start, end, 1, 2);
        expect(withTurns.lat).toBeCloseTo(withoutTurns.lat, 6);
        expect(withTurns.lon).toBeCloseTo(withoutTurns.lon, 6);
        expect(withoutTurns.lat).toBeCloseTo(30, 5);
        expect(withoutTurns.lon).toBeCloseTo(40, 5);
    });

    it("extraTurnsを指定すると途中経過（t=0.5）が周回無しの場合と異なる経路になる", () => {
        const midWithoutTurns = interpolatePosition(start, end, 0.5, 0);
        const midWithTurns = interpolatePosition(start, end, 0.5, 1);
        expect(Math.abs(midWithTurns.lat - midWithoutTurns.lat)).toBeGreaterThan(1);
    });
});

describe("interpolateAltitude", () => {
    it("対数空間で補間する（t=0.5 は幾何平均）", () => {
        expect(interpolateAltitude(100, 10000, 0)).toBeCloseTo(100, 6);
        expect(interpolateAltitude(100, 10000, 1)).toBeCloseTo(10000, 6);
        expect(interpolateAltitude(100, 10000, 0.5)).toBeCloseTo(1000, 6); // sqrt(100*10000)
    });

    it("一方が0以下なら線形補間へフォールバックする", () => {
        expect(interpolateAltitude(0, 100, 0.5)).toBeCloseTo(50, 6);
    });
});

describe("interpolateOrientation", () => {
    it("t=0/1 で start/end と一致する", () => {
        const start = { azimuth: ZOOM_IN.azimuth, tilt: ZOOM_IN.tilt };
        const end = { azimuth: ZOOM_OUT.azimuth, tilt: ZOOM_OUT.tilt };
        const at0 = interpolateOrientation(start, end, 0);
        const at1 = interpolateOrientation(start, end, 1);
        expect(at0.azimuth).toBeCloseTo(start.azimuth, 2);
        expect(at0.tilt).toBeCloseTo(start.tilt, 2);
        expect(at1.azimuth).toBeCloseTo(end.azimuth, 2);
        expect(at1.tilt).toBeCloseTo(end.tilt, 2);
    });

    it("0°/360°境界を跨ぐ場合でも最短回転で補間する（長い方向へ回らない）", () => {
        // 0.35° → 359.83° は実質 0.52° しか離れていない（360°側を跨ぐ最短経路）。
        // 単純な数値線形補間なら中間 t=0.5 で約180°になってしまうが、
        // Quaternion Slerp は最短回転を取るため 0° 付近に留まるはず。
        const start = { azimuth: 0.35, tilt: 68.74 };
        const end = { azimuth: 359.83, tilt: 41.13 };
        const mid = interpolateOrientation(start, end, 0.5);
        // 0°からの角距離（[-180,180]換算）で判定する。
        const diffFromZero = ((mid.azimuth + 180) % 360 + 360) % 360 - 180;
        expect(Math.abs(diffFromZero)).toBeLessThan(5);
    });

    it("tiltは滑らかに単調変化する（開始・終了間で大きく飛ばない）", () => {
        const start = { azimuth: ZOOM_IN.azimuth, tilt: ZOOM_IN.tilt };
        const end = { azimuth: ZOOM_OUT.azimuth, tilt: ZOOM_OUT.tilt };
        const samples = [0, 0.25, 0.5, 0.75, 1].map(
            (t) => interpolateOrientation(start, end, t).tilt,
        );
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-6);
        }
    });
});

describe("easeInOutCubic", () => {
    it("境界値・中点が既知の値になる", () => {
        expect(easeInOutCubic(0)).toBeCloseTo(0, 6);
        expect(easeInOutCubic(1)).toBeCloseTo(1, 6);
        expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    });
});

describe("computeCameraFrame", () => {
    it("progress=0/1 で端点と一致する", () => {
        const at0 = computeCameraFrame(ZOOM_IN, ZOOM_OUT, 0);
        const at1 = computeCameraFrame(ZOOM_IN, ZOOM_OUT, 1);
        expect(at0.lat).toBeCloseTo(ZOOM_IN.lat, 6);
        expect(at0.altitude).toBeCloseTo(ZOOM_IN.altitude, 3);
        expect(at1.lat).toBeCloseTo(ZOOM_OUT.lat, 6);
        expect(at1.altitude).toBeCloseTo(ZOOM_OUT.altitude, 1);
    });

    it("範囲外のprogressはクランプされる", () => {
        const below = computeCameraFrame(ZOOM_IN, ZOOM_OUT, -1);
        const above = computeCameraFrame(ZOOM_IN, ZOOM_OUT, 2);
        expect(below.lat).toBeCloseTo(ZOOM_IN.lat, 6);
        expect(above.lat).toBeCloseTo(ZOOM_OUT.lat, 6);
    });

    describe("positionHoldAltitude（位置移動の固定/移動しきい値）", () => {
        const holdAltitude = 100_000;

        it("ズームアウト（上昇）：しきい値高度に達するまで位置はstartに固定される", () => {
            const start: CameraEndpoint = { lat: 0, lon: 0, altitude: LOW_ALTITUDE, azimuth: 0, tilt: 0 };
            const end: CameraEndpoint = { lat: 30, lon: 30, altitude: HIGH_ALTITUDE, azimuth: 0, tilt: 0 };
            // しきい値高度に達する前（低progress）は位置が動いていないはず。
            const before = computeCameraFrame(start, end, 0.1, 0, holdAltitude);
            expect(before.lat).toBeCloseTo(start.lat, 6);
            expect(before.lon).toBeCloseTo(start.lon, 6);
            // 十分進んだ後（高progress）は終点付近まで移動しているはず。
            const after = computeCameraFrame(start, end, 0.99, 0, holdAltitude);
            expect(after.lat).toBeCloseTo(end.lat, 1);
            expect(after.lon).toBeCloseTo(end.lon, 1);
        });

        it("ズームイン（下降）：開始直後から位置が動き、しきい値高度を下回ったらendに固定される", () => {
            const start: CameraEndpoint = { lat: 0, lon: 0, altitude: HIGH_ALTITUDE, azimuth: 0, tilt: 0 };
            const end: CameraEndpoint = { lat: 30, lon: 30, altitude: LOW_ALTITUDE, azimuth: 0, tilt: 0 };
            // 開始直後（低progress）でも位置移動が始まっているはず（startに固定されない）。
            const early = computeCameraFrame(start, end, 0.05, 0, holdAltitude);
            expect(Math.abs(early.lat - start.lat)).toBeGreaterThan(0.01);
            // しきい値高度を下回った後（高progress）は終点に固定されるはず。
            const after = computeCameraFrame(start, end, 0.99, 0, holdAltitude);
            expect(after.lat).toBeCloseTo(end.lat, 3);
            expect(after.lon).toBeCloseTo(end.lon, 3);
        });
    });
});

describe("advanceZoomLoop / cameraFrameForState", () => {
    const config: ZoomLoopConfig = {
        zoomIn: ZOOM_IN,
        zoomOut: ZOOM_OUT,
        moveDurationMs: 60_000,
        holdDurationMs: 3_000,
    };

    it("初期状態(holdZoomIn)ではzoomIn端点のフレームを返す", () => {
        const state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        expect(cameraFrameForState(state, config)).toEqual(ZOOM_IN);
    });

    it("holdDurationMs経過でtoZoomOutへ遷移する", () => {
        const state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        const next = advanceZoomLoop(state, 3_000, config);
        expect(next.phase).toBe("toZoomOut");
        expect(next.elapsedInPhaseMs).toBeCloseTo(0, 6);
    });

    it("moveDurationMs経過でholdZoomOutへ遷移し、フレームはzoomOut端点になる", () => {
        let state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        state = advanceZoomLoop(state, 3_000, config); // -> toZoomOut
        state = advanceZoomLoop(state, 60_000, config); // -> holdZoomOut
        expect(state.phase).toBe("holdZoomOut");
        expect(cameraFrameForState(state, config)).toEqual(ZOOM_OUT);
    });

    it("1往復（hold+move+hold+move）で最初のフェーズへ戻る", () => {
        let state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        const totalCycleMs =
            config.holdDurationMs * 2 + config.moveDurationMs * 2;
        state = advanceZoomLoop(state, totalCycleMs, config);
        expect(state.phase).toBe("holdZoomIn");
        expect(state.elapsedInPhaseMs).toBeCloseTo(0, 6);
    });

    it("大きなdeltaMs（タブ非アクティブ等）でも複数フェーズを正しく跨いで進む", () => {
        const state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        // hold(3s) + move(60s) + hold(3s) + move(30s, 半分) = 96s 経過
        const next = advanceZoomLoop(state, 96_000, config);
        expect(next.phase).toBe("toZoomIn");
        expect(next.elapsedInPhaseMs).toBeCloseTo(30_000, 6);
    });

    it("MAX_ITER(1000)を超える周期数分の巨大なdeltaMsでも正しい位相に収束する（周期での剰余最適化）", () => {
        const state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        const cycleMs =
            config.holdDurationMs * 2 + config.moveDurationMs * 2; // 126_000ms
        // 1周期 = 4フェーズなので、MAX_ITER=1000 の素朴な実装では 250 周期分
        // （1000 フェーズ遷移）までしか進められない。10,000 周期分 + 96s の
        // 端数を与え、剰余最適化が無いと辿り着けない位相まで正しく進むことを確認する。
        const deltaMs = cycleMs * 10_000 + 96_000;
        const next = advanceZoomLoop(state, deltaMs, config);
        expect(next.phase).toBe("toZoomIn");
        expect(next.elapsedInPhaseMs).toBeCloseTo(30_000, 6);
    });

    it("移動中(toZoomOut)の途中経過は0..1の範囲でズームイン→ズームアウトへ補間される", () => {
        let state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        state = advanceZoomLoop(state, 3_000, config); // -> toZoomOut, elapsed=0
        state = advanceZoomLoop(state, 30_000, config); // 半分経過
        const frame = cameraFrameForState(state, config);
        expect(frame.altitude).toBeGreaterThan(ZOOM_IN.altitude);
        expect(frame.altitude).toBeLessThan(ZOOM_OUT.altitude);
    });

    it("holdDurationMs=0の場合、deltaMs=0でも静止フェーズを即座にスキップする", () => {
        const zeroHoldConfig: ZoomLoopConfig = { ...config, holdDurationMs: 0 };
        const state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        const next = advanceZoomLoop(state, 0, zeroHoldConfig);
        expect(next.phase).toBe("toZoomOut");
        expect(next.elapsedInPhaseMs).toBe(0);
    });

    it("全フェーズが0長の異常設定でもMAX_ITERの安全弁で無限ループにならず終了する", () => {
        const allZeroConfig: ZoomLoopConfig = {
            ...config,
            moveDurationMs: 0,
            holdDurationMs: 0,
        };
        const state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
        expect(() => advanceZoomLoop(state, 0, allZeroConfig)).not.toThrow();
        const next = advanceZoomLoop(state, 0, allZeroConfig);
        expect(next.elapsedInPhaseMs).toBe(0);
    });
});
