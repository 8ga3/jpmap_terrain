// @vitest-environment jsdom
/**
 * `webXrArSession.ts` のunit test。
 *
 * @remarks
 * jsdom には WebXR API (`navigator.xr`) が実装されていないため、
 * `isImmersiveArSupported` / `setupDioramaWebXrArButton` の「非対応環境」分岐は
 * 実際に `navigator.xr` が存在しない状態で検証できる（Babylon.js のモックは不要）。
 * WebXRセッション自体（Babylon Scene/XR依存の分岐。実機カメラ姿勢に基づく箱庭配置を
 * 含む）は、実機・ブラウザでの手動確認と `feature/533-webxr-vr-viewer` PoC
 * (`webXrVrSession.ts`) の前例に倣い、本ファイルでは対象外とする。
 */
import { describe, it, expect } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { DioramaViewController } from "../src/demos/diorama/dioramaViewController";
import type { DioramaOrientationController } from "../src/demos/diorama/dioramaOrientationController";
import type { DioramaTileModeController } from "../src/demos/diorama/dioramaTileModeController";
import type { DioramaTouchControls } from "../src/demos/diorama/dioramaTouchControls";
import { isImmersiveArSupported, setupDioramaWebXrArButton } from "../src/demos/diorama/webXrArSession";

describe("isImmersiveArSupported", () => {
    it("navigator.xr が存在しない環境（jsdom既定）では false を返す", async () => {
        expect("xr" in navigator).toBe(false);
        await expect(isImmersiveArSupported()).resolves.toBe(false);
    });
});

describe("setupDioramaWebXrArButton", () => {
    it("非対応環境ではボタンを追加せず、no-opのcleanupを返す", async () => {
        const mount = document.createElement("div");
        // 非対応分岐では scene/dioramaRoot/tableRadiusM/viewController/
        // orientationController/tileModeController/touchControls に一切アクセス
        // しないため、型を満たすだけのダミー値で十分。
        const scene = {} as Scene;
        const dioramaRoot = {} as TransformNode;
        const tableRadiusM = 0.35;
        const viewController = {} as DioramaViewController;
        const orientationController = {} as DioramaOrientationController;
        const tileModeController = {} as DioramaTileModeController;
        const touchControls = {} as DioramaTouchControls;

        const cleanup = await setupDioramaWebXrArButton(
            mount,
            scene,
            dioramaRoot,
            tableRadiusM,
            viewController,
            orientationController,
            tileModeController,
            touchControls,
        );

        expect(mount.childElementCount).toBe(0);
        expect(() => cleanup()).not.toThrow();
    });
});
