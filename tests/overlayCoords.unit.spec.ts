/**
 * overlayCoords ユーティリティの単体テスト。
 *
 * globe 単一バックエンド化後は `assertLatLonInBounds` のみを検証する。
 * - assertLatLonInBounds: bounds 外で throw、prefix がメッセージに含まれる
 */

import { describe, it, expect } from "vitest";

import { assertLatLonInBounds } from "../src/terrain/overlayCoords";

describe("assertLatLonInBounds", () => {
    it("範囲内なら例外を投げない", () => {
        expect(() => assertLatLonInBounds(35.681, 139.767, "test")).not.toThrow();
    });
    it("範囲外で prefix を含むメッセージで throw", () => {
        expect(() => assertLatLonInBounds(0, 0, "addPolygon")).toThrow(
            /addPolygon: lat\/lon out of JAPAN_BOUNDS/,
        );
    });
});
