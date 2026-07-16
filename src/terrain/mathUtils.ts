/**
 * 汎用の数値補間ユーティリティ。
 * `skybox.ts` / `sunState.ts` など複数箇所で使う純関数をここに集約する。
 */

/** `t` を `[edge0, edge1]` で正規化し Hermite smoothstep で滑らかにする。 */
export const smoothstep = (edge0: number, edge1: number, t: number): number => {
    if (edge1 === edge0) return t < edge0 ? 0 : 1;
    const x = Math.max(0, Math.min(1, (t - edge0) / (edge1 - edge0)));
    return x * x * (3 - 2 * x);
};
