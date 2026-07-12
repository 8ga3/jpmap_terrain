/**
 * ズームループ デモのカメラ経路計算。
 *
 * DOM / Babylon Scene に依存しない純粋関数群として実装し、vitest で単体テスト可能にする。
 * - 位置（lat/lon）: 区間が小さい（数度程度）ため単純な線形補間で十分。
 * - 高度（altitude）: 2570m ⇔ 3,176,946m と桁違いに変化するため、対数空間で補間して
 *   一定速度に見える「ズーム」にする（線形補間だと終盤にしか変化を感じられない）。
 * - 向き（azimuth/tilt）: `Quaternion.Slerp` で補間する。azimuth の単純な数値線形補間は
 *   0°/360° 境界（本デモの端点は 0.35° と 359.83° で実質 0.52° しか離れていない）で
 *   最短方向ではなく長い方向へ回転してしまう不具合が起きるため、回転として補間する
 *   Quaternion Slerp（最短回転経路を自動で選ぶ）を採用する。
 */
import { Quaternion } from "@babylonjs/core/Maths/math.vector";

import { uiToYawPitch, yawPitchToUi } from "../../terrain/geo/cameraMapping";

/** カメラ姿勢の端点（緯度経度＋高度＋向き）。 */
export interface CameraEndpoint {
    lat: number;
    lon: number;
    altitude: number;
    /** 方位角 [deg]（0-360, 0=北, +=東回り）。 */
    azimuth: number;
    /** チルト角 [deg]（0=直下, 90=水平）。 */
    tilt: number;
}

/** 補間結果として適用するカメラフレーム。 */
export type CameraFrame = CameraEndpoint;

/** ズームループの4状態。往復を無限に繰り返す。 */
export type LoopPhase = "holdZoomIn" | "toZoomOut" | "holdZoomOut" | "toZoomIn";

/** ズームループの設定（端点・移動時間・静止時間）。 */
export interface ZoomLoopConfig {
    zoomIn: CameraEndpoint;
    zoomOut: CameraEndpoint;
    /** 片道の移動時間 [ms]。 */
    moveDurationMs: number;
    /** 各端点での静止時間 [ms]。 */
    holdDurationMs: number;
}

/** ズームループの進行状態。 */
export interface ZoomLoopState {
    phase: LoopPhase;
    /** 現在のフェーズに入ってからの経過時間 [ms]。 */
    elapsedInPhaseMs: number;
}

/** イージング関数（加減速して滑らかに見せる）。 */
export const easeInOutCubic = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** [0,1] にクランプする。 */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 緯度経度を線形補間する。
 * 本デモの端点間距離（数度程度）では大圏補間との視覚差はほぼ無いため、単純な線形補間を採用する。
 */
export const interpolatePosition = (
    start: Pick<CameraEndpoint, "lat" | "lon">,
    end: Pick<CameraEndpoint, "lat" | "lon">,
    t: number,
): { lat: number; lon: number } => ({
    lat: start.lat + (end.lat - start.lat) * t,
    lon: start.lon + (end.lon - start.lon) * t,
});

/**
 * 高度を対数空間で補間する（`altitude(t) = start * (end/start)^t`）。
 * 一方が 0 以下（本来ありえないが防御的に）の場合は線形補間へフォールバックする。
 */
export const interpolateAltitude = (
    startAlt: number,
    endAlt: number,
    t: number,
): number => {
    if (startAlt <= 0 || endAlt <= 0) {
        return startAlt + (endAlt - startAlt) * t;
    }
    return startAlt * Math.pow(endAlt / startAlt, t);
};

/**
 * 向き（azimuth/tilt）を Quaternion Slerp で補間する。
 * `uiToYawPitch`/`yawPitchToUi`（`terrain/geo/cameraMapping.ts`）と同じ規約
 * （yaw=azimuth[rad], pitch=tilt[rad], roll=0）でクォータニオンを構築するため、
 * 実際のカメラ（`GeospatialCamera`）の yaw/pitch 表現と整合する。
 */
export const interpolateOrientation = (
    start: Pick<CameraEndpoint, "azimuth" | "tilt">,
    end: Pick<CameraEndpoint, "azimuth" | "tilt">,
    t: number,
): { azimuth: number; tilt: number } => {
    const s = uiToYawPitch(start.azimuth, start.tilt);
    const e = uiToYawPitch(end.azimuth, end.tilt);
    const q0 = Quaternion.RotationYawPitchRoll(s.yaw, s.pitch, 0);
    const q1 = Quaternion.RotationYawPitchRoll(e.yaw, e.pitch, 0);
    const qt = Quaternion.Slerp(q0, q1, clamp01(t));
    const euler = qt.toEulerAngles();
    const { azimuthDeg, tiltDeg } = yawPitchToUi(euler.y, euler.x);
    return { azimuth: azimuthDeg, tilt: tiltDeg };
};

/**
 * 2端点間・進行度（0..1, イージング適用前）からカメラフレームを算出する。
 */
export const computeCameraFrame = (
    start: CameraEndpoint,
    end: CameraEndpoint,
    progress: number,
): CameraFrame => {
    const t = easeInOutCubic(clamp01(progress));
    const { lat, lon } = interpolatePosition(start, end, t);
    const altitude = interpolateAltitude(start.altitude, end.altitude, t);
    const { azimuth, tilt } = interpolateOrientation(start, end, t);
    return { lat, lon, altitude, azimuth, tilt };
};

/** 現フェーズの次に遷移するフェーズ（無限往復）。 */
const nextPhase = (phase: LoopPhase): LoopPhase => {
    switch (phase) {
        case "holdZoomIn":
            return "toZoomOut";
        case "toZoomOut":
            return "holdZoomOut";
        case "holdZoomOut":
            return "toZoomIn";
        case "toZoomIn":
            return "holdZoomIn";
    }
};

/** フェーズの目標時間 [ms]（0 以下・NaN は即座に次のフェーズへ進めるため 0 として扱う）。 */
const phaseDurationMs = (phase: LoopPhase, config: ZoomLoopConfig): number => {
    const raw =
        phase === "holdZoomIn" || phase === "holdZoomOut"
            ? config.holdDurationMs
            : config.moveDurationMs;
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
};

/**
 * 経過時間 `deltaMs` を進めてループ状態を更新する。
 * タブが非アクティブだった場合等、`deltaMs` がフェーズ長より大きくても、
 * ループを回してフェーズを正しく複数回進める（フレームスキップに強い実装）。
 */
export const advanceZoomLoop = (
    state: ZoomLoopState,
    deltaMs: number,
    config: ZoomLoopConfig,
): ZoomLoopState => {
    let phase = state.phase;
    let elapsedInPhaseMs = state.elapsedInPhaseMs + Math.max(0, deltaMs);

    // 無限ループ防止のための安全弁（全フェーズ長が 0 のような異常設定時に抜ける）。
    const MAX_ITER = 1000;
    for (let i = 0; i < MAX_ITER; i++) {
        const duration = phaseDurationMs(phase, config);
        if (duration <= 0) {
            // 長さ 0 のフェーズは即座に次へ（1回だけ進めて無限ループを避ける）。
            if (elapsedInPhaseMs <= 0) break;
            phase = nextPhase(phase);
            elapsedInPhaseMs = 0;
            continue;
        }
        if (elapsedInPhaseMs < duration) break;
        elapsedInPhaseMs -= duration;
        phase = nextPhase(phase);
    }

    return { phase, elapsedInPhaseMs };
};

/** 現在のループ状態からカメラフレームを算出する。 */
export const cameraFrameForState = (
    state: ZoomLoopState,
    config: ZoomLoopConfig,
): CameraFrame => {
    switch (state.phase) {
        case "holdZoomIn":
            return { ...config.zoomIn };
        case "holdZoomOut":
            return { ...config.zoomOut };
        case "toZoomOut": {
            const progress =
                config.moveDurationMs > 0
                    ? state.elapsedInPhaseMs / config.moveDurationMs
                    : 1;
            return computeCameraFrame(config.zoomIn, config.zoomOut, progress);
        }
        case "toZoomIn": {
            const progress =
                config.moveDurationMs > 0
                    ? state.elapsedInPhaseMs / config.moveDurationMs
                    : 1;
            return computeCameraFrame(config.zoomOut, config.zoomIn, progress);
        }
    }
};
