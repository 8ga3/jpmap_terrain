/**
 * ArcRotateCamera のターゲット付け替え結果。
 * カメラのワールド位置を不変に保ったまま新ターゲットに対する (alpha, beta, radius)
 * を算出する。limit 逸脱や特異点時は "skip" を返し、呼び出し側で既存値を維持させる。
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
