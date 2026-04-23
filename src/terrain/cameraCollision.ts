/**
 * チルト操作による地形コリジョン解決結果
 * - "none": コリジョンなし（変更不要）
 * - "zoomOut": 自動ズームアウトで解決可能（radius を返す）
 * - "revert": ズームアウト量が過大（チルト中止）
 */
export type TiltCollisionResult =
    | { action: "none" }
    | { action: "zoomOut"; radius: number }
    | { action: "revert" };

/** チルト時の自動ズームアウト: radius 増加率の上限（超えたらチルト中止） */
export const TILT_MAX_RADIUS_INCREASE_RATIO = 0.5;

/**
 * チルト変更後のコリジョンを解決する。
 * @param currentRadius - 現在の camera.radius
 * @param minRadius - 新しい beta での terrainMinRadius
 * @param upperRadius - camera.upperRadiusLimit
 * @param maxIncreaseRatio - radius 増加率の上限（0.5 = 50%）
 */
export function resolveTiltCollision(
    currentRadius: number,
    minRadius: number,
    upperRadius: number,
    maxIncreaseRatio: number,
): TiltCollisionResult {
    if (currentRadius >= minRadius) return { action: "none" };
    const maxAllowed = currentRadius * (1 + maxIncreaseRatio);
    const needed = Math.min(minRadius, upperRadius);
    if (needed > maxAllowed) return { action: "revert" };
    return { action: "zoomOut", radius: needed };
}
