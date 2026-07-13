/**
 * ROI（Region of Interest）周回デモのカメラ経路計算。
 *
 * DOM / Babylon Scene に依存しない純粋関数群として実装し、vitest で単体テスト可能にする。
 * - 位置（lat/lon）: `circularOrbitPosition`（`../avatar/orbit`）を再利用し、ROI 中心から
 *   固定半径・時計回りの円周上を移動する座標を算出する（flight/avatar デモで実績のある式）。
 * - 向き: カメラは常に ROI 中心（の ECEF 絶対位置）を向く。Babylon の `FreeCamera.setTarget`
 *   に一任するため、本モジュールでは方位角・チルトは算出しない
 *   （コンパス UI 同期用の方位角のみ `headingForRoiOrbit` として提供する）。
 * - 高度: 周回中はカメラの絶対高度（WGS84 楕円体面からの真の高さ）を一定に保つ。
 *   `viewer.altitude`（カメラ注視点からの距離 = radius）を使うと、低高度では地形へ
 *   追従する「seat-on-terrain」機構の影響で起伏に沿って高度が揺らいでしまうため、
 *   本デモは `viewer.lat/lon/altitude` を使わず、真の ECEF 座標で外部カメラ
 *   （FreeCamera）を直接配置する方式を採る（ECEF 変換・カメラ適用は index.ts 側で行う）。
 * - ループ進行: `elapsedMs` を `requestAnimationFrame` の delta で積算するステートマシンとし、
 *   1周（`360 / angularSpeedDegPerSec` 秒）ごとに剰余を取ることで、長時間実行時の
 *   浮動小数点誤差の蓄積を防ぐ（zoomloop の `advanceZoomLoop` と同方針）。
 */
import { circularOrbitPosition } from "../avatar/orbit";

/** ROI 周回の設定（中心・半径・カメラ高度・角速度）。 */
export interface RoiOrbitConfig {
    /** 周回中心（ROI）の緯度経度。 */
    center: { lat: number; lon: number };
    /** 周回半径 [m]。 */
    radiusM: number;
    /** カメラの絶対高度 [m]（WGS84 楕円体面からの真の高さ。周回中は一定）。 */
    cameraAltitudeM: number;
    /** 角速度 [deg/s]。正の値で時計回りに周回する。 */
    angularSpeedDegPerSec: number;
}

/** ROI 周回の進行状態。 */
export interface RoiOrbitState {
    /** ループ開始からの経過時間 [ms]（1周期で剰余を取り無限には増加しない）。 */
    elapsedMs: number;
}

/** 周回中のカメラ位置（緯度経度・絶対高度）。 */
export interface OrbitCameraPosition {
    lat: number;
    lon: number;
    /** 絶対高度 [m]（`config.cameraAltitudeM` と同値。ECEF 変換の呼び出し元に併せて返す）。 */
    altitudeM: number;
}

/** [0,360) に正規化する。 */
const normalizeDeg = (deg: number): number => ((deg % 360) + 360) % 360;

/** 1周にかかる時間 [ms]。角速度が0以下（異常値）の場合は Infinity（周回しない）。 */
const cyclePeriodMs = (config: RoiOrbitConfig): number =>
    config.angularSpeedDegPerSec > 0 ? (360 / config.angularSpeedDegPerSec) * 1000 : Infinity;

/**
 * 経過時間 `deltaMs` を進めて周回ステートマシンの状態を更新する。
 * 1周期分の `elapsedMs` を剰余で差し引き、長時間実行してもフレームごとの
 * `elapsedMs` が無限に増加しないようにする（浮動小数点誤差対策）。
 */
export const advanceRoiOrbit = (
    state: RoiOrbitState,
    deltaMs: number,
    config: RoiOrbitConfig,
): RoiOrbitState => {
    const period = cyclePeriodMs(config);
    let elapsedMs = state.elapsedMs + Math.max(0, deltaMs);
    if (Number.isFinite(period) && period > 0) {
        elapsedMs %= period;
    }
    return { elapsedMs };
};

/**
 * 現在の周回ステートマシンの状態から、円周上の外向き方位角 [deg]（0-360, 0=北, +=東回り）を
 * 算出する。角速度が0以下（異常値）の場合は角度0（周回開始位置）に固定する。
 */
export const angleForRoiOrbit = (state: RoiOrbitState, config: RoiOrbitConfig): number =>
    config.angularSpeedDegPerSec > 0
        ? normalizeDeg((state.elapsedMs / 1000) * config.angularSpeedDegPerSec)
        : 0;

/** 現在の周回ステートマシンの状態からカメラ位置（緯度経度・絶対高度）を算出する。 */
export const cameraPositionForRoiOrbit = (
    state: RoiOrbitState,
    config: RoiOrbitConfig,
): OrbitCameraPosition => {
    const angleDeg = angleForRoiOrbit(state, config);
    const { lat, lon } = circularOrbitPosition(
        config.center.lat,
        config.center.lon,
        config.radiusM,
        angleDeg,
    );
    return { lat, lon, altitudeM: config.cameraAltitudeM };
};

/**
 * コンパス UI 同期用に、円周上の位置から ROI 中心への方位角 [deg] を算出する
 * （= 中心から見た外向き方位 `angleDeg` の逆方向）。
 * カメラ自体の向きは `FreeCamera.setTarget` に一任するため、レンダリングには使わない。
 */
export const headingForRoiOrbit = (state: RoiOrbitState, config: RoiOrbitConfig): number =>
    normalizeDeg(angleForRoiOrbit(state, config) + 180);
