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
    it("t=0/0.5/1 で始点・中点・終点を返す", () => {
        const start = { lat: 10, lon: 20 };
        const end = { lat: 30, lon: 40 };
        expect(interpolatePosition(start, end, 0)).toEqual({ lat: 10, lon: 20 });
        expect(interpolatePosition(start, end, 0.5)).toEqual({ lat: 20, lon: 30 });
        expect(interpolatePosition(start, end, 1)).toEqual({ lat: 30, lon: 40 });
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
