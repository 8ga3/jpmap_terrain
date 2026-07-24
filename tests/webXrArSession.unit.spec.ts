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
import { describe, it, expect, vi } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { DioramaViewController } from "../src/lib/internal/diorama/dioramaViewController";
import type { DioramaOrientationController } from "../src/lib/internal/diorama/dioramaOrientationController";
import type { DioramaTileModeController } from "../src/lib/internal/diorama/dioramaTileModeController";
import type { DioramaTouchControls } from "../src/lib/internal/diorama/dioramaTouchControls";
import {
    isImmersiveArSupported,
    setupDioramaWebXrArButton,
    createDioramaArSessionController,
    attachDioramaArButton,
    type DioramaArSessionController,
} from "../src/lib/internal/diorama/webXrArSession";

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

/** `createDioramaArSessionController` のテスト用の依存一式を生成する。 */
const createControllerDeps = () => {
    const mount = document.createElement("div");
    // `enterAr` は try節に入る前に `dioramaRoot.position.clone()` /
    // `scene.clearColor.a` へ実際にアクセスするため、最低限これらを持つ
    // ダミー値が必要（`scene.createDefaultXRExperienceAsync` 等のXR依存
    // メソッドは未定義のままにし、try節内で意図的に例外を起こしてcatch経路を検証する）。
    const scene = { clearColor: { a: 1 } } as unknown as Scene;
    const dioramaRoot = { position: new Vector3(0, 0, 0) } as unknown as TransformNode;
    const tableRadiusM = 0.35;
    const viewController = {} as DioramaViewController;
    const orientationController = {} as DioramaOrientationController;
    const tileModeController = {} as DioramaTileModeController;
    const touchControls: DioramaTouchControls = {
        setVisible: vi.fn(),
        dispose: vi.fn(),
    };
    return {
        mount,
        scene,
        dioramaRoot,
        tableRadiusM,
        viewController,
        orientationController,
        tileModeController,
        touchControls,
    };
};

describe("createDioramaArSessionController", () => {
    it("初期状態は非アクティブ", () => {
        const deps = createControllerDeps();
        const controller = createDioramaArSessionController(
            deps.mount,
            deps.scene,
            deps.dioramaRoot,
            deps.tableRadiusM,
            deps.viewController,
            deps.orientationController,
            deps.tileModeController,
            deps.touchControls,
        );
        expect(controller.isActive()).toBe(false);
    });

    it("WebXR非対応環境（scene.createDefaultXRExperienceAsyncが無い）でenter()を呼ぶとrejectし、非アクティブのまま復帰する", async () => {
        const deps = createControllerDeps();
        const controller = createDioramaArSessionController(
            deps.mount,
            deps.scene,
            deps.dioramaRoot,
            deps.tableRadiusM,
            deps.viewController,
            deps.orientationController,
            deps.tileModeController,
            deps.touchControls,
        );
        // spec/diorama-api.md §7: enterAr()/exitAr() の失敗はホスト側でハンドリング
        // できるよう reject する。
        await expect(controller.enter()).rejects.toThrow();
        expect(controller.isActive()).toBe(false);
        // enter失敗時もタッチHUDの非表示/再表示が対で呼ばれ、非表示のまま残留しない。
        expect(deps.touchControls.setVisible).toHaveBeenCalledWith(false);
        expect(deps.touchControls.setVisible).toHaveBeenCalledWith(true);
    });

    it("非アクティブ状態でexit()を呼ぶとno-opで解決する", async () => {
        const deps = createControllerDeps();
        const controller = createDioramaArSessionController(
            deps.mount,
            deps.scene,
            deps.dioramaRoot,
            deps.tableRadiusM,
            deps.viewController,
            deps.orientationController,
            deps.tileModeController,
            deps.touchControls,
        );
        await expect(controller.exit()).resolves.toBeUndefined();
    });

    it("dispose()は複数回呼んでも例外を投げない", () => {
        const deps = createControllerDeps();
        const controller = createDioramaArSessionController(
            deps.mount,
            deps.scene,
            deps.dioramaRoot,
            deps.tableRadiusM,
            deps.viewController,
            deps.orientationController,
            deps.tileModeController,
            deps.touchControls,
        );
        expect(() => controller.dispose()).not.toThrow();
        expect(() => controller.dispose()).not.toThrow();
    });

    it("dispose()後のenter()はrejectする", async () => {
        const deps = createControllerDeps();
        const controller = createDioramaArSessionController(
            deps.mount,
            deps.scene,
            deps.dioramaRoot,
            deps.tableRadiusM,
            deps.viewController,
            deps.orientationController,
            deps.tileModeController,
            deps.touchControls,
        );
        controller.dispose();
        await expect(controller.enter()).rejects.toThrow();
    });

    it("onActiveChangeの購読解除関数は複数回呼んでも例外を投げない", () => {
        const deps = createControllerDeps();
        const controller = createDioramaArSessionController(
            deps.mount,
            deps.scene,
            deps.dioramaRoot,
            deps.tableRadiusM,
            deps.viewController,
            deps.orientationController,
            deps.tileModeController,
            deps.touchControls,
        );
        const unsubscribe = controller.onActiveChange(vi.fn());
        expect(() => unsubscribe()).not.toThrow();
        expect(() => unsubscribe()).not.toThrow();
    });
});

describe("attachDioramaArButton", () => {
    /** `onActiveChange` に登録されたリスナーを外部から発火できるモックコントローラー。 */
    const createMockController = (
        initialActive: boolean,
    ): { controller: DioramaArSessionController; fireActiveChange: (active: boolean) => void } => {
        let activeChangeListener: ((active: boolean) => void) | null = null;
        const controller: DioramaArSessionController = {
            isActive: vi.fn(() => initialActive),
            enter: vi.fn(() => Promise.resolve()),
            exit: vi.fn(() => Promise.resolve()),
            onActiveChange: vi.fn((listener) => {
                activeChangeListener = listener;
                return () => {
                    activeChangeListener = null;
                };
            }),
            dispose: vi.fn(),
        };
        return {
            controller,
            fireActiveChange: (active: boolean): void => activeChangeListener?.(active),
        };
    };

    it("ボタンをmountへ追加する", () => {
        const mount = document.createElement("div");
        const { controller } = createMockController(false);
        attachDioramaArButton(mount, controller);
        expect(mount.querySelector("button")).not.toBeNull();
    });

    it("非アクティブ時にクリックするとenter()を呼ぶ", () => {
        const mount = document.createElement("div");
        const { controller } = createMockController(false);
        attachDioramaArButton(mount, controller);
        mount.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(controller.enter).toHaveBeenCalledOnce();
        expect(controller.exit).not.toHaveBeenCalled();
    });

    it("アクティブ時にクリックするとexit()を呼ぶ", () => {
        const mount = document.createElement("div");
        const { controller } = createMockController(true);
        attachDioramaArButton(mount, controller);
        mount.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(controller.exit).toHaveBeenCalledOnce();
        expect(controller.enter).not.toHaveBeenCalled();
    });

    it("活性状態の変化に応じてボタン表示を更新する", () => {
        const mount = document.createElement("div");
        const { controller, fireActiveChange } = createMockController(false);
        attachDioramaArButton(mount, controller);
        const button = mount.querySelector("button") as HTMLButtonElement;
        fireActiveChange(true);
        expect(button.textContent).toBe("終了");
        fireActiveChange(false);
        expect(button.textContent).toBe("AR");
    });

    it("返り値の関数はボタンを除去するが、controller.dispose()は呼ばない（controllerの所有者が別途破棄する）", () => {
        const mount = document.createElement("div");
        const { controller } = createMockController(false);
        const detach = attachDioramaArButton(mount, controller);
        detach();
        expect(mount.childElementCount).toBe(0);
        expect(controller.dispose).not.toHaveBeenCalled();
    });

    it("生成時点で既にアクティブなコントローラーを渡された場合、初期表示から反映する", () => {
        const mount = document.createElement("div");
        const { controller } = createMockController(true);
        attachDioramaArButton(mount, controller);
        const button = mount.querySelector("button") as HTMLButtonElement;
        expect(button.textContent).toBe("終了");
    });

    it("アクティブ時にクリックしexit()が失敗しても、例外にせずコンソールへログ出力する", async () => {
        const mount = document.createElement("div");
        const { controller } = createMockController(true);
        controller.exit = vi.fn(() => Promise.reject(new Error("exit failed")));
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        attachDioramaArButton(mount, controller);
        mount.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[jpmap-terrain diorama] failed to exit WebXR AR session:",
            expect.any(Error),
        );
        consoleErrorSpy.mockRestore();
    });
});
