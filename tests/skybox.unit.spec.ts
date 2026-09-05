/**
 * skybox のユニットテスト。
 * 高度連動の宇宙度計算（`computeSpaceFactor`）を検証する。
 */

import { describe, expect, it } from "vitest";
import {
    computeSpaceFactor,
    SPACE_FADE_END_M,
    SPACE_FADE_START_M,
} from "../src/terrain/skybox";

describe("computeSpaceFactor", () => {
    it("開始高度以下では 0（青空）", () => {
        expect(computeSpaceFactor(0)).toBe(0);
        expect(computeSpaceFactor(SPACE_FADE_START_M)).toBe(0);
        expect(computeSpaceFactor(-100)).toBe(0);
    });

    it("終了高度以上では 1（ほぼ黒）", () => {
        expect(computeSpaceFactor(SPACE_FADE_END_M)).toBe(1);
        expect(computeSpaceFactor(SPACE_FADE_END_M + 10000)).toBe(1);
    });

    it("中間高度では 0..1 で単調増加する", () => {
        const mid = (SPACE_FADE_START_M + SPACE_FADE_END_M) / 2;
        const v = computeSpaceFactor(mid);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
        const lower = computeSpaceFactor(mid - 5000);
        const upper = computeSpaceFactor(mid + 5000);
        expect(lower).toBeLessThan(v);
        expect(upper).toBeGreaterThan(v);
    });

    it("非有限値は 0 を返す", () => {
        expect(computeSpaceFactor(Number.NaN)).toBe(0);
        expect(computeSpaceFactor(Number.POSITIVE_INFINITY)).toBe(0);
    });
});
