// @vitest-environment jsdom
/**
 * `dioramaKeyboardControls.ts` のunit test。
 *
 * @remarks
 * `Scene`は`onBeforeRenderObservable.add/remove`と`getEngine().getDeltaTime()`
 * のみを使うため、実Babylon Engineは使わず軽量なフェイクで代替する
 * （deltaTimeを任意に制御でき、レンダーループの1フレーム分を明示的に
 * トリガーできるようにするため）。
 * `ArcRotateCamera`も同様に`getDirection`のみを使うため、指定した向き
 * （headingDeg）を返す軽量なフェイクで代替する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { DioramaViewController } from "../src/lib/internal/diorama/dioramaViewController";
import type { DioramaOrientationController } from "../src/lib/internal/diorama/dioramaOrientationController";
import type { DioramaTileModeController } from "../src/lib/internal/diorama/dioramaTileModeController";
import { setupDioramaKeyboardControls } from "../src/lib/internal/diorama/dioramaKeyboardControls";

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

/**
 * `headingDeg=0` は forward=(0,0,1)（北）・right=(1,0,0)（東）という既定の向き
 * （回転補正なしの従来挙動と一致）。`headingDeg`が増えるとカメラが時計回りに
 * 回転した状態を模す。
 */
const makeCamera = (headingDeg = 0): ArcRotateCamera => {
    const rad = (headingDeg * Math.PI) / 180;
    const forward = { x: Math.sin(rad), z: Math.cos(rad) };
    const right = { x: Math.cos(rad), z: -Math.sin(rad) };
    return {
        getDirection: (localAxis: Vector3): Vector3 =>
            localAxis.z !== 0 ? new Vector3(forward.x, 0, forward.z) : new Vector3(right.x, 0, right.z),
    } as unknown as ArcRotateCamera;
};

const makeViewController = (): {
    vc: DioramaViewController;
    feedAxes: ReturnType<typeof vi.fn>;
} => {
    const feedAxes = vi.fn();
    const vc = {
        getCenter: vi.fn(),
        getFootprintHalfSizeM: vi.fn(),
        feedAxes,
    } as unknown as DioramaViewController;
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

const makeTileModeController = (): {
    tc: DioramaTileModeController;
    cycle: ReturnType<typeof vi.fn>;
} => {
    const cycle = vi.fn();
    const tc = { getTileMode: vi.fn(), cycle } as unknown as DioramaTileModeController;
    return { tc, cycle };
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
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        tick(16);

        expect(feedAxes).toHaveBeenCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("矢印キーはパンに割り当てない（Babylon既定のカメラ回転と衝突するため無視される）", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "ArrowRight");
        dispatchKey("keydown", "ArrowUp");
        tick(16);

        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("カメラが既定の向き（北向き）のとき、D/Wで想定通りのパン軸になる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(0), vc, oc, tc));

        dispatchKey("keydown", "KeyD");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 1, y: 0 }, 0, 0.016);

        dispatchKey("keydown", "KeyW");
        tick(16);
        // D(東, x=+1) + W(北, y=-1) → 正規化される
        const [axes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(axes.x).toBeCloseTo(1 / Math.SQRT2, 6);
        expect(axes.y).toBeCloseTo(-1 / Math.SQRT2, 6);
    });

    it("カメラを90°回転させると、Wキーの移動方向もカメラの向き基準で回転する", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        // headingDeg=90: forward=(1,0,0)（東）になる。
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(90), vc, oc, tc));

        dispatchKey("keydown", "KeyW");
        tick(16);

        const [axes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        // 北向き(heading=0)なら{x:0,y:-1}だったが、東向き(heading=90)では東(x軸プラス)へ動く。
        expect(axes.x).toBeCloseTo(1, 6);
        expect(axes.y).toBeCloseTo(0, 6);
    });

    it("keyupで押下状態が解除される", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyA");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: -1, y: 0 }, 0, 0.016);

        dispatchKey("keyup", "KeyA");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("PageUp/KeyRでズームイン(-1)、PageDown/KeyFでズームアウト(+1)になる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

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
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyR", { ctrlKey: true });
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("dtSecondsが0以下ならfeedAxesを呼ばない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        tick(0);
        expect(feedAxes).not.toHaveBeenCalled();
    });

    it("破棄関数を呼ぶとイベントリスナー・レンダーオブザーバーが解除される", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const dispose = setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc);

        dispose();
        dispatchKey("keydown", "KeyD");
        tick(16);
        // オブザーバーが除去されているため、tick()を呼んでもfeedAxesは呼ばれない。
        expect(feedAxes).not.toHaveBeenCalled();
    });

    it("windowのblurで押下状態がクリアされる", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyD");
        window.dispatchEvent(new Event("blur"));
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("Qで負方向、Eで正方向の回転軸がorientationController.feedAxesへ渡される", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyE");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith(1, 0, 0, 0.016);

        dispatchKey("keyup", "KeyE");
        dispatchKey("keydown", "KeyQ");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith(-1, 0, 0, 0.016);
    });

    it("Zで下降(leftTrigger=1)、Xで上昇(rightTrigger=1)がorientationController.feedAxesへ渡される", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyZ");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith(0, 1, 0, 0.016);

        dispatchKey("keyup", "KeyZ");
        dispatchKey("keydown", "KeyX");
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith(0, 0, 1, 0.016);
    });

    it("dtSecondsが0以下ならorientationController.feedAxesも呼ばない", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        tick(0);
        expect(feedAxes).not.toHaveBeenCalled();
    });

    it("KeyTでtileModeController.cycle()が呼ばれる（押しっぱなしでは連続実行しない）", () => {
        const { scene } = createFakeScene();
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc, cycle } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyT");
        expect(cycle).toHaveBeenCalledTimes(1);

        // キーリピート（同じキーが離されずに発火し続けるkeydown）では再実行しない。
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyT", bubbles: true, cancelable: true, repeat: true }));
        expect(cycle).toHaveBeenCalledTimes(1);

        dispatchKey("keyup", "KeyT");
        dispatchKey("keydown", "KeyT");
        expect(cycle).toHaveBeenCalledTimes(2);
    });

    it("Homeキーは処理されない（AR終了専用の操作であり、キーボード導線には割り当てない）", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "Home");
        tick(16);

        // Homeは`HANDLED_CODES`に含まれないため、パン等の他のキー処理にも影響しない。
        expect(viewFeedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });

    it("KeyTは他の移動系キーと異なりpressedセットに積まれず、feedAxesの軸には影響しない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        cleanups.push(setupDioramaKeyboardControls(scene, makeCamera(), vc, oc, tc));

        dispatchKey("keydown", "KeyT");
        tick(16);

        expect(viewFeedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);
    });
});
