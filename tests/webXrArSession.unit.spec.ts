// @vitest-environment jsdom
/**
 * `webXrArSession.ts` のunit test。
 *
 * @remarks
 * jsdom には WebXR API (`navigator.xr`) が実装されていないため、
 * `isImmersiveArSupported` / `setupDioramaWebXrArButton` の「非対応環境」分岐は
 * 実際に `navigator.xr` が存在しない状態で検証できる（Babylon.js のモックは不要）。
 * WebXRセッション自体（Babylon Scene/XR依存の分岐）は、実機・ブラウザでの手動確認と
 * `feature/533-webxr-vr-viewer` PoC (`webXrVrSession.ts`) の前例に倣い、
 * 本ファイルでは対象外とする。
 */
import { describe, it, expect } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import {
    isImmersiveArSupported,
    setupDioramaWebXrArButton,
    computeArPlacementOffset,
} from "../src/demos/diorama/webXrArSession";

describe("computeArPlacementOffset", () => {
    it("diorama デモの既定シーン（左手系）では前方 = +Z のオフセットを返す", () => {
        // 実機検証で発覚した回帰（-Z を使うと箱庭がユーザーの背後に配置され見えない）を
        // 再発させないよう、符号を固定する。
        const [x, y, z] = computeArPlacementOffset();
        expect(x).toBe(0);
        expect(y).toBe(0);
        expect(z).toBeGreaterThan(0);
    });
});

describe("isImmersiveArSupported", () => {
    it("navigator.xr が存在しない環境（jsdom既定）では false を返す", async () => {
        expect("xr" in navigator).toBe(false);
        await expect(isImmersiveArSupported()).resolves.toBe(false);
    });
});

describe("setupDioramaWebXrArButton", () => {
    it("非対応環境ではボタンを追加せず、no-opのcleanupを返す", async () => {
        const mount = document.createElement("div");
        // 非対応分岐では scene/dioramaRoot に一切アクセスしないため、
        // 型を満たすだけのダミー値で十分。
        const scene = {} as Scene;
        const dioramaRoot = {} as TransformNode;

        const cleanup = await setupDioramaWebXrArButton(mount, scene, dioramaRoot);

        expect(mount.childElementCount).toBe(0);
        expect(() => cleanup()).not.toThrow();
    });
});
