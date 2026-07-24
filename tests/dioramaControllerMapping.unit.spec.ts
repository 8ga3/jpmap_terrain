/**
 * `dioramaControllerMapping.ts` のunit test。
 *
 * @remarks
 * デッドゾーン処理・パン/ズーム/回転/高さ変更の入力変換は `src/lib/webxr/webXrStickInput.ts`
 * （公開API）へ移設したため、そちらのunit test（`webXrStickInput.unit.spec.ts`）で検証する。
 * 本ファイルでは残存するdiorama固有ロジック（タイル種別の巡回）のみを検証する。
 */
import { describe, it, expect } from "vitest";
import { DIORAMA_TILE_MODE_CYCLE_ORDER, nextDioramaTileMode } from "../src/demos/diorama/dioramaControllerMapping";

describe("DIORAMA_TILE_MODE_CYCLE_ORDER", () => {
    it("std→photo→wireframeの順である", () => {
        expect(DIORAMA_TILE_MODE_CYCLE_ORDER).toEqual(["std", "photo", "wireframe"]);
    });
});

describe("nextDioramaTileMode", () => {
    it("std→photo→wireframe→stdの順に巡回する", () => {
        expect(nextDioramaTileMode("std")).toBe("photo");
        expect(nextDioramaTileMode("photo")).toBe("wireframe");
        expect(nextDioramaTileMode("wireframe")).toBe("std");
    });
});
