// @vitest-environment jsdom
/**
 * `src/lib/webxr/webXrSessionSupport.ts` のunit test。
 *
 * @remarks
 * jsdom には WebXR API (`navigator.xr`) が実装されていないため、
 * `isWebXrSessionSupported` の「非対応環境」分岐は実際に `navigator.xr` が
 * 存在しない状態で検証できる（Babylon.js のモックは不要）。
 * 対応環境（`WebXRSessionManager.IsSessionSupportedAsync` が解決するケース）は
 * `src/demos/diorama/webXrArSession.ts` の前例に倣い、実機・ブラウザでの手動確認を前提とし、
 * 本ファイルでは対象外とする。
 */
import { describe, it, expect } from "vitest";
import { isWebXrSessionSupported } from "../src/lib/webxr/webXrSessionSupport";

describe("isWebXrSessionSupported", () => {
    it("navigator.xr が存在しない環境（jsdom既定）では false を返す", async () => {
        expect("xr" in navigator).toBe(false);
        await expect(isWebXrSessionSupported("immersive-ar")).resolves.toBe(false);
        await expect(isWebXrSessionSupported("immersive-vr")).resolves.toBe(false);
    });
});
