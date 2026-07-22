// @vitest-environment jsdom
/**
 * `dioramaTouchControls.ts` のunit test。
 *
 * @remarks
 * `Scene`は`onBeforeRenderObservable.add/remove`と`getEngine().getDeltaTime()`
 * のみを使うため、実Babylon Engineは使わず軽量なフェイクで代替する
 * （`dioramaKeyboardControls.unit.spec.ts` と同じ方針）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { DioramaViewController } from "../src/demos/diorama/dioramaViewController";
import type { DioramaOrientationController } from "../src/demos/diorama/dioramaOrientationController";
import type { DioramaArControlHud } from "../src/demos/diorama/dioramaArControlHud";
import { setupDioramaTouchControls } from "../src/demos/diorama/dioramaTouchControls";

interface FakeScene {
    scene: Scene;
    tick: (deltaTimeMs: number) => void;
}

const createFakeScene = (): FakeScene => {
    let callback: (() => void) | null = null;
    let deltaTimeMs = 16;
    const scene = {
        onBeforeRenderObservable: {
            add: (fn: () => void) => {
                callback = fn;
                return fn;
            },
            remove: () => {
                callback = null;
            },
        },
        getEngine: () => ({ getDeltaTime: () => deltaTimeMs }),
    } as unknown as Scene;
    return {
        scene,
        tick: (ms: number) => {
            deltaTimeMs = ms;
            callback?.();
        },
    };
};

const makeViewController = (): { vc: DioramaViewController; feedAxes: ReturnType<typeof vi.fn> } => {
    const feedAxes = vi.fn();
    const vc = { getCenter: vi.fn(), getFootprintRadiusM: vi.fn(), feedAxes } as unknown as DioramaViewController;
    return { vc, feedAxes };
};

const makeOrientationController = (): {
    oc: DioramaOrientationController;
    feedAxes: ReturnType<typeof vi.fn>;
} => {
    const feedAxes = vi.fn();
    const oc = {
        getRotationRad: vi.fn(),
        getHeightOffsetM: vi.fn(),
        feedAxes,
    } as unknown as DioramaOrientationController;
    return { oc, feedAxes };
};

const makeHud = (overrides: Partial<DioramaArControlHud> = {}): DioramaArControlHud => {
    const element = document.createElement("div");
    return {
        element,
        getPanAxes: () => ({ x: 0, y: 0 }),
        getZoomAxis: () => 0,
        getRotationAxis: () => 0,
        getHeightAxis: () => 0,
        dispose: vi.fn(),
        ...overrides,
    } as DioramaArControlHud;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("setupDioramaTouchControls", () => {
    it("HUDの軸が全て0ならfeedAxesは{x:0,y:0}・0で呼ばれる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, hud, vc, oc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(viewFeedAxes).toHaveBeenCalledWith({ x: 0, y: 0 }, 0, 0.016);
        expect(orientationFeedAxes).toHaveBeenCalledWith(0, 0, 0, 0.016);
    });

    it("ジョイスティック・ズーム軸をviewControllerへ反映する", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const hud = makeHud({ getPanAxes: () => ({ x: 0.5, y: -0.5 }), getZoomAxis: () => -1 });
        const controls = setupDioramaTouchControls(scene, hud, vc, oc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(viewFeedAxes).toHaveBeenCalledWith({ x: 0.5, y: -0.5 }, -1, 0.016);
    });

    it("回転軸をそのままorientationControllerの第1引数へ反映する", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const hud = makeHud({ getRotationAxis: () => 1 });
        const controls = setupDioramaTouchControls(scene, hud, vc, oc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(orientationFeedAxes).toHaveBeenCalledWith(1, 0, 0, 0.016);
    });

    it("高さ軸が正（上昇）ならrightTriggerValueへ、負（下降）ならleftTriggerValueへ変換する", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();

        const hudUp = makeHud({ getHeightAxis: () => 1 });
        const controlsUp = setupDioramaTouchControls(scene, hudUp, vc, oc);
        tick(16);
        expect(orientationFeedAxes).toHaveBeenLastCalledWith(0, 0, 1, 0.016);
        controlsUp.dispose();

        const hudDown = makeHud({ getHeightAxis: () => -1 });
        const controlsDown = setupDioramaTouchControls(scene, hudDown, vc, oc);
        cleanups.push(controlsDown.dispose);
        tick(16);
        expect(orientationFeedAxes).toHaveBeenLastCalledWith(0, 1, 0, 0.016);
    });

    it("dtSecondsが0以下なら両方のfeedAxesを呼ばない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, hud, vc, oc);
        cleanups.push(controls.dispose);

        tick(0);

        expect(viewFeedAxes).not.toHaveBeenCalled();
        expect(orientationFeedAxes).not.toHaveBeenCalled();
    });

    it("setVisible(false)でHUD要素のdisplayがnoneになり、setVisible(true)で元に戻る", () => {
        const { scene } = createFakeScene();
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, hud, vc, oc);
        cleanups.push(controls.dispose);

        controls.setVisible(false);
        expect(hud.element.style.display).toBe("none");

        controls.setVisible(true);
        expect(hud.element.style.display).toBe("");
    });

    it("dispose()を呼ぶとレンダーオブザーバーが解除され、以後feedAxesは呼ばれない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, hud, vc, oc);

        controls.dispose();
        tick(16);

        expect(viewFeedAxes).not.toHaveBeenCalled();
    });
});
