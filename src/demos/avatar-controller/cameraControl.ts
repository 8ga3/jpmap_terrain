/**
 * 右ジョイスティックによるカメラ操作ロジック (Issue #289)
 *
 * Game Controller の右スティック入力からカメラの方位角（azimuth）と
 * チルト角（tilt）の変化量を計算する純粋関数群。
 *
 * 規約:
 * - 右スティック X 正 → 方位を時計回り（右回転）
 * - 右スティック Y 正（前入力）→ チルト減少（真上方向へ）
 * - 2D モード時は tilt 変化を 0 にする
 */

import { applyDeadzone, type MoveVector } from "./movement";

/** 方位回転速度（度/秒）。右スティックフル傾倒時の回転速度。 */
export const AZIMUTH_SPEED_DPS = 120;

/** チルト変化速度（度/秒）。右スティックフル傾倒時の変化速度。 */
export const TILT_SPEED_DPS = 60;

/** チルト最小値（度）。camera.lowerBetaLimit ≈ 0.1 rad に対応。 */
export const TILT_MIN_DEG = 6;

/** チルト最大値（度）。camera.upperBetaLimit = π/2 - π/12 ≈ 75° に対応。 */
export const TILT_MAX_DEG = 75;

/** カメラ制御の計算結果 */
export interface CameraControlResult {
    /** 方位角の変化量（度）。本プロジェクト規約に従い、正=反時計回り */
    deltaAzimuth: number;
    /** チルト角の変化量（度）。正=水平方向へ */
    deltaTilt: number;
}

/**
 * 右スティック入力からカメラの方位角・チルト角の変化量を計算する。
 *
 * @param stick - 右スティックの生値 {vx: -1..1, vy: -1..1}
 *   vx 正 = 右方向、vy 正 = 前方向（呼び出し側でBabylon Y反転済みを想定）
 * @param dtSec - フレーム間隔（秒）
 * @param is2D - 2Dモードか（trueならtilt変化を0にする）
 * @param currentTilt - 現在のチルト角（度）。クランプ計算に使用
 * @returns deltaAzimuth, deltaTilt
 */
export const computeCameraControl = (
    stick: MoveVector,
    dtSec: number,
    is2D: boolean,
    currentTilt: number,
): CameraControlResult => {
    if (dtSec <= 0) return { deltaAzimuth: 0, deltaTilt: 0 };

    const dz = applyDeadzone(stick);

    // 方位: vx 正 → 右回転（時計回り）
    // 本プロジェクトの azimuth 規約は「北=0°・反時計回り正」なので、
    // 右スティック右 = 時計回り = azimuth 減少。
    const deltaAzimuth = dz.vx === 0 ? 0 : -dz.vx * AZIMUTH_SPEED_DPS * dtSec;

    // チルト: 2D モード時は無効
    let deltaTilt = 0;
    if (!is2D) {
        // vy 正 = 前（上）→ tilt 減少（真上方向へ）
        // vy 負 = 後（下）→ tilt 増加（水平方向へ）
        const rawDelta = -dz.vy * TILT_SPEED_DPS * dtSec;
        const newTilt = currentTilt + rawDelta;
        // クランプ
        const clampedTilt = Math.max(TILT_MIN_DEG, Math.min(TILT_MAX_DEG, newTilt));
        deltaTilt = clampedTilt - currentTilt;
    }

    return { deltaAzimuth, deltaTilt };
};
