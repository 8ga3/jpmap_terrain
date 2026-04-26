/**
 * ArcRotateCamera のターゲット付け替え結果。
 * カメラのワールド位置を不変に保ったまま新ターゲットに対する (alpha, beta, radius)
 * を算出する。limit 逸脱や退化ケースでは "skip" を返し、真上/真下付近の特異点では
 * alpha に currentAlpha を採用した "apply" を返す。
 */
export type RetargetResult =
    | { action: "apply"; alpha: number; beta: number; radius: number }
    | { action: "skip"; reason: "degenerate" | "betaOutOfRange" | "radiusOutOfRange" };

export interface RetargetLimits {
    lowerBeta: number;
    upperBeta: number;
    lowerRadius: number;
    upperRadius: number;
}

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** degenerate 判定の距離しきい値（メートル） */
const MIN_RADIUS_EPSILON = 1e-3;
/** alpha 保持判定の sin(beta) しきい値（極近傍） */
const SIN_BETA_EPSILON = 1e-4;

/**
 * カメラワールド位置 P を固定したまま新ターゲット newTarget に付け替える際の
 * (alpha, beta, radius) を計算する。
 *
 * Babylon ArcRotateCamera の規約:
 *   P = T + r * (sin(beta)*cos(alpha), cos(beta), sin(beta)*sin(alpha))
 * から V = P - newTarget とおくと:
 *   radius = |V|
 *   beta   = acos(V.y / radius)
 *   alpha  = atan2(V.z, V.x)
 *
 * @param camPos       現在のカメラワールド位置
 * @param newTarget    新しいターゲット座標
 * @param currentAlpha 特異点（真上/真下視点）時に保持するための現 alpha
 * @param limits       適用可否判定に使う limit 値
 */
export function computePoseForNewTarget(
    camPos: Vec3,
    newTarget: Vec3,
    currentAlpha: number,
    limits: RetargetLimits,
): RetargetResult {
    // 入力に NaN/Infinity が紛れ込むと acos/atan2 が破綻し、以降のカメラ状態が
    // 全て不正値で汚染される（Issue #151）。早期に skip して直前状態を維持する。
    if (
        !Number.isFinite(camPos.x) ||
        !Number.isFinite(camPos.y) ||
        !Number.isFinite(camPos.z) ||
        !Number.isFinite(newTarget.x) ||
        !Number.isFinite(newTarget.y) ||
        !Number.isFinite(newTarget.z)
    ) {
        return { action: "skip", reason: "degenerate" };
    }

    const vx = camPos.x - newTarget.x;
    const vy = camPos.y - newTarget.y;
    const vz = camPos.z - newTarget.z;
    const radius = Math.sqrt(vx * vx + vy * vy + vz * vz);

    if (radius < MIN_RADIUS_EPSILON) {
        return { action: "skip", reason: "degenerate" };
    }
    if (radius < limits.lowerRadius || radius > limits.upperRadius) {
        return { action: "skip", reason: "radiusOutOfRange" };
    }

    // 浮動小数誤差で acos の定義域を外れないようクランプ
    const cosBeta = Math.max(-1, Math.min(1, vy / radius));
    const beta = Math.acos(cosBeta);

    if (beta < limits.lowerBeta || beta > limits.upperBeta) {
        return { action: "skip", reason: "betaOutOfRange" };
    }

    const sinBeta = Math.sqrt(Math.max(0, 1 - cosBeta * cosBeta));
    const alpha = sinBeta < SIN_BETA_EPSILON ? currentAlpha : Math.atan2(vz, vx);

    return { action: "apply", alpha, beta, radius };
}
