// @vitest-environment jsdom
/**
 * `dioramaKeyboardControls.ts` のunit test。
 *
 * @remarks
 * `Scene`は`onBeforeRenderObservable.add/remove`と`getEngine().getDeltaTime()`
 * のみを使うため、実Babylon Engineは使わず軽量なフェイクで代替する
 * （deltaTimeを任意に制御でき、レンダーループの1フレーム分を明示的に
 * トリガーできるようにするため）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { DioramaViewController } from "../src/demos/diorama/dioramaViewController";
import { setupDioramaKeyboardControls } from "../src/demos/diorama/dioramaKeyboardControls";

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

const dispatchKey = (type: "keydown" | "keyup", code: string, modifiers: Partial<KeyboardEventInit> = {}): void => {
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...modifiers }));
};

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("setupDioramaKeyboardControls", () => {
    it("何も押していなければfeedAxesは{x:0,y:0}・zoomAxis:0で呼ばれる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        tick(16);

        expect(feedAxes).toHaveBeenCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("矢印キーRight/Wで想定通りのパン軸になる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        dispatchKey("keydown", "ArrowRight");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 1, y: 0 }, 0, 0.016);

        dispatchKey("keydown", "KeyW");
        tick(16);
        // Right(x=+1) + W(前進, y=-1) → 正規化される
        const [axes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(axes.x).toBeCloseTo(1 / Math.SQRT2, 6);
        expect(axes.y).toBeCloseTo(-1 / Math.SQRT2, 6);
    });

    it("keyupで押下状態が解除される", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        dispatchKey("keydown", "ArrowLeft");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: -1, y: 0 }, 0, 0.016);

        dispatchKey("keyup", "ArrowLeft");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("PageUp/KeyRでズームイン(-1)、PageDown/KeyFでズームアウト(+1)になる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        dispatchKey("keydown", "PageUp");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, -1, 0.016);
        dispatchKey("keyup", "PageUp");

        dispatchKey("keydown", "KeyF");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 1, 0.016);
    });

    it("Ctrl修飾キー併用時は無視する（ブラウザショートカットを奪わない）", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        dispatchKey("keydown", "KeyR", { ctrlKey: true });
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("dtSecondsが0以下ならfeedAxesを呼ばない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        tick(0);
        expect(feedAxes).not.toHaveBeenCalled();
    });

    it("破棄関数を呼ぶとイベントリスナー・レンダーオブザーバーが解除される", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const dispose = setupDioramaKeyboardControls(scene, vc);

        dispose();
        dispatchKey("keydown", "ArrowRight");
        tick(16);
        // オブザーバーが除去されているため、tick()を呼んでもfeedAxesは呼ばれない。
        expect(feedAxes).not.toHaveBeenCalled();
    });

    it("windowのblurで押下状態がクリアされる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        cleanups.push(setupDioramaKeyboardControls(scene, vc));

        dispatchKey("keydown", "ArrowRight");
        window.dispatchEvent(new Event("blur"));
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });
});
