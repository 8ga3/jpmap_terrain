/**
 * ジャンプ物理モジュール (Issue #288)
 *
 * 純粋関数群。ジャンプの開始・毎フレーム更新・着地判定を提供する。
 *
 * 物理モデル:
 * - 初速: v₀ = √(2 * g * h) — 指定高さ h に到達する鉛直初速
 * - 毎フレーム: altitude += velocity * dt - 0.5 * g * dt² (等加速度の解析解), velocity -= gravity * dt
 * - 着地判定: altitude <= 0 → リセット
 *
 * 座標系:
 * - altitude: 地表からの高さ (m)。0 = 地面。
 * - velocity: 上向きが正 (m/s)。
 */

import type { MoveVector } from "./movement";

/** ジャンプ状態 */
export interface JumpState {
    /** ジャンプ中か */
    readonly active: boolean;
    /** 現在の高度オフセット (m)。地面 = 0 */
    readonly altitude: number;
    /** 鉛直速度 (m/s)。上向き正 */
    readonly velocity: number;
    /** ジャンプ開始時にロックされた移動方向 */
    readonly lockedDirection: MoveVector;
}

/** ジャンプしていない初期状態 */
export const JUMP_IDLE: JumpState = {
    active: false,
    altitude: 0,
    velocity: 0,
    lockedDirection: { vx: 0, vy: 0 },
};

/** デフォルトのジャンプ高さ (MODEL_SCALE=50 のワールドで体感調整済み) */
export const DEFAULT_JUMP_HEIGHT = 100;

/** デフォルトの重力加速度 (9.81 × MODEL_SCALE でワールドスケールに合わせた値) */
export const DEFAULT_GRAVITY = 9.81 * 50;

/**
 * ジャンプを開始する。
 *
 * @param jumpHeight ジャンプの最高到達高さ (m)
 * @param gravity 重力加速度 (m/s²)
 * @param direction ジャンプ開始時の移動入力（ロックされる）
 * @returns 新しい JumpState（active=true、初速計算済み）
 */
export const startJump = (
    jumpHeight: number,
    gravity: number,
    direction: MoveVector,
): JumpState => {
    const h = Math.max(jumpHeight, 0);
    const g = Math.max(gravity, 0.01);
    const v0 = Math.sqrt(2 * g * h);
    return {
        active: true,
        altitude: 0,
        velocity: v0,
        lockedDirection: { vx: direction.vx, vy: direction.vy },
    };
};

/**
 * ジャンプの1フレーム更新。
 *
 * @param state 現在のジャンプ状態
 * @param gravity 重力加速度 (m/s²)
 * @param dtSec フレーム時間 (秒)
 * @returns 更新後の JumpState。着地した場合は active=false。
 */
export const tickJump = (
    state: JumpState,
    gravity: number,
    dtSec: number,
): JumpState => {
    if (!state.active) return state;
    if (dtSec <= 0) return state;

    const g = Math.max(gravity, 0.01);
    // 等加速度の解析解: altitude += velocity * dt - 0.5 * g * dt²
    // これにより任意の dt でも理論上の最高点 h = v₀²/(2g) を正確に再現できる。
    // （velocity * dt のみだと peak で誤差が出る; newVelocity * dt は symplectic Euler で更に低くなる）
    const newAltitude = state.altitude + state.velocity * dtSec - 0.5 * g * dtSec * dtSec;
    const newVelocity = state.velocity - g * dtSec;

    // 着地判定
    if (newAltitude <= 0) {
        return JUMP_IDLE;
    }

    return {
        active: true,
        altitude: newAltitude,
        velocity: newVelocity,
        lockedDirection: state.lockedDirection,
    };
};

/**
 * ジャンプ中かどうかを返す。
 */
export const isJumping = (state: JumpState): boolean => state.active;
