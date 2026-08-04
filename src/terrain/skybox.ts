import { smoothstep } from "./mathUtils";

/**
 * 空が暗化し始める高度（メートル）。現実の大気では成層圏付近からレイリー散乱が
 * 急速に弱まり空が暗い青へ転じるため、約 12km を開始点とする。
 */
export const SPACE_FADE_START_M = 12000;
/**
 * 空がほぼ黒（宇宙空間）になる高度（メートル）。カメラ高度上限（75km）に合わせる。
 * 現実のカーマンライン（100km）には届かないが、上限で「ほぼ黒」へ収束させる。
 */
export const SPACE_FADE_END_M = 75000;

/**
 * カメラ高度（メートル）から「宇宙度」を導く純関数。
 * 0=低高度の青空、1=高高度でほぼ黒。`SPACE_FADE_START_M`〜`SPACE_FADE_END_M` を
 * smoothstep で連続補間する。
 */
export function computeSpaceFactor(altitudeMeters: number): number {
    if (!Number.isFinite(altitudeMeters)) return 0;
    return smoothstep(SPACE_FADE_START_M, SPACE_FADE_END_M, altitudeMeters);
}
