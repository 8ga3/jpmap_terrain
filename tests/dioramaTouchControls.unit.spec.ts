// @vitest-environment jsdom
/**
 * `dioramaTouchControls.ts` のunit test。
 *
 * @remarks
 * `Scene`は`onBeforeRenderObservable.add/remove`と`getEngine().getDeltaTime()`
 * のみを使うため、実Babylon Engineは使わず軽量なフェイクで代替する
 * （`dioramaKeyboardControls.unit.spec.ts` と同じ方針）。`ArcRotateCamera`も
 * 同様に`getDirection`のみを使うため、指定した向き（headingDeg）を返す
 * 軽量なフェイクで代替する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { DioramaViewController } from "../src/lib/internal/diorama/dioramaViewController";
import type { DioramaOrientationController } from "../src/lib/internal/diorama/dioramaOrientationController";
import type { DioramaTileModeController } from "../src/lib/internal/diorama/dioramaTileModeController";
import type { DioramaArControlHud } from "../src/lib/internal/diorama/dioramaArControlHud";
import { setupDioramaTouchControls } from "../src/lib/internal/diorama/dioramaTouchControls";

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
 * 回転した状態を模す（`dioramaKeyboardControls.unit.spec.ts`と同じ方針）。
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

const makeTileModeController = (): { tc: DioramaTileModeController; cycle: ReturnType<typeof vi.fn> } => {
    const cycle = vi.fn();
    const tc = { getTileMode: vi.fn(), cycle } as unknown as DioramaTileModeController;
    return { tc, cycle };
};

type FakeHud = DioramaArControlHud & {
    triggerTileModeCyclePress: () => void;
    triggerExitArPress: () => void;
};

const makeHud = (overrides: Partial<DioramaArControlHud> = {}): FakeHud => {
    const element = document.createElement("div");
    let tileModeCycleCallback: (() => void) | null = null;
    let exitArCallback: (() => void) | null = null;
    return {
        element,
        getPanAxes: () => ({ x: 0, y: 0 }),
        getZoomAxis: () => 0,
        getRotationAxis: () => 0,
        getHeightAxis: () => 0,
        onTileModeCyclePress: (callback: () => void) => {
            tileModeCycleCallback = callback;
            return () => {
                tileModeCycleCallback = null;
            };
        },
        onExitArPress: (callback: () => void) => {
            exitArCallback = callback;
            return () => {
                exitArCallback = null;
            };
        },
        dispose: vi.fn(),
        triggerTileModeCyclePress: () => tileModeCycleCallback?.(),
        triggerExitArPress: () => exitArCallback?.(),
        ...overrides,
    } as FakeHud;
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
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(viewFeedAxes).toHaveBeenCalledWith({ x: 0, y: 0 }, 0, 0.016);
        expect(orientationFeedAxes).toHaveBeenCalledWith(0, 0, 0, 0.016);
    });

    it("ジョイスティック・ズーム軸をviewControllerへ反映する", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud({ getPanAxes: () => ({ x: 0.5, y: -0.5 }), getZoomAxis: () => -1 });
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(viewFeedAxes).toHaveBeenCalledWith({ x: 0.5, y: -0.5 }, -1, 0.016);
    });

    it("回転軸をそのままorientationControllerの第1引数へ反映する", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud({ getRotationAxis: () => 1 });
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(orientationFeedAxes).toHaveBeenCalledWith(1, 0, 0, 0.016);
    });

    it("高さ軸が正（上昇）ならrightTriggerValueへ、負（下降）ならleftTriggerValueへ変換する", () => {
        const { scene, tick } = createFakeScene();
        const { vc } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();

        const hudUp = makeHud({ getHeightAxis: () => 1 });
        const controlsUp = setupDioramaTouchControls(scene, makeCamera(), hudUp, vc, oc, tc);
        tick(16);
        expect(orientationFeedAxes).toHaveBeenLastCalledWith(0, 0, 1, 0.016);
        controlsUp.dispose();

        const hudDown = makeHud({ getHeightAxis: () => -1 });
        const controlsDown = setupDioramaTouchControls(scene, makeCamera(), hudDown, vc, oc, tc);
        cleanups.push(controlsDown.dispose);
        tick(16);
        expect(orientationFeedAxes).toHaveBeenLastCalledWith(0, 1, 0, 0.016);
    });

    it("dtSecondsが0以下なら両方のfeedAxesを呼ばない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(0);

        expect(viewFeedAxes).not.toHaveBeenCalled();
        expect(orientationFeedAxes).not.toHaveBeenCalled();
    });

    it("setVisible(false)でHUD要素のdisplayがnoneになり、setVisible(true)で元に戻る", () => {
        const { scene } = createFakeScene();
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        controls.setVisible(false);
        expect(hud.element.style.display).toBe("none");

        controls.setVisible(true);
        expect(hud.element.style.display).toBe("");
    });

    it("setVisible(false)の間はHUDの軸値が非ゼロのまま残っていてもfeedAxesを一切呼ばない（回帰テスト）", () => {
        // display:none がHUD内部の押下状態を0へリセットする保証はない
        // （押下中にAR突入したケース等）ため、非表示中は値を読み取り自体しないこと。
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud({
            getPanAxes: () => ({ x: 1, y: 1 }),
            getZoomAxis: () => 1,
            getRotationAxis: () => 1,
            getHeightAxis: () => 1,
        });
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        controls.setVisible(false);
        tick(16);

        expect(viewFeedAxes).not.toHaveBeenCalled();
        expect(orientationFeedAxes).not.toHaveBeenCalled();

        controls.setVisible(true);
        tick(16);

        // {x:1,y:1}は大きさが1を超える対角入力のため、`computePanAxesFromDirectionalInput`
        // により大きさ1へ正規化される（本テストの主眼はfeedAxes呼び出しの有無であり、
        // 正規化自体は`dioramaControllerMapping.unit.spec.ts`で別途検証済み）。
        const [panAxes, zoomAxis, dt] = viewFeedAxes.mock.calls[viewFeedAxes.mock.calls.length - 1] as [
            { x: number; y: number },
            number,
            number,
        ];
        expect(panAxes.x).toBeCloseTo(Math.SQRT1_2);
        expect(panAxes.y).toBeCloseTo(Math.SQRT1_2);
        expect(zoomAxis).toBe(1);
        expect(dt).toBe(0.016);
        expect(orientationFeedAxes).toHaveBeenCalledWith(1, 0, 1, 0.016);
    });

    it("dispose()を呼ぶとレンダーオブザーバーが解除され、以後feedAxesは呼ばれない", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);

        controls.dispose();
        tick(16);

        expect(viewFeedAxes).not.toHaveBeenCalled();
    });

    it("HUDのタイル切替ボタンが押されるとtileModeController.cycle()が呼ばれる", () => {
        const { scene } = createFakeScene();
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc, cycle } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        hud.triggerTileModeCyclePress();
        expect(cycle).toHaveBeenCalledTimes(1);
    });

    it("HUDのAR終了ボタンは購読されない（常時表示インスタンスでは終了すべきARセッションが無いため）", () => {
        const { scene } = createFakeScene();
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        // 本モジュールは`onExitArPress`を購読しないため、押下しても例外なく何も起きない。
        expect(() => hud.triggerExitArPress()).not.toThrow();
    });

    it("dispose()を呼ぶとHUDのタイル切替ボタンの購読が解除される", () => {
        const { scene } = createFakeScene();
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc, cycle } = makeTileModeController();
        const hud = makeHud();
        const controls = setupDioramaTouchControls(scene, makeCamera(), hud, vc, oc, tc);

        controls.dispose();
        hud.triggerTileModeCyclePress();
        expect(cycle).not.toHaveBeenCalled();
    });

    it("カメラが東(90°)を向いている場合、ジョイスティックを前方向へ倒すとpanAxesは東方向（x=1,y=0）になる（回帰テスト）", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        // Gamepad規約: y=-1がジョイスティックを奥（前方向）へ倒した状態。
        const hud = makeHud({ getPanAxes: () => ({ x: 0, y: -1 }) });
        const controls = setupDioramaTouchControls(scene, makeCamera(90), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(16);

        const [panAxes] = viewFeedAxes.mock.calls[viewFeedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(panAxes.x).toBeCloseTo(1);
        expect(panAxes.y).toBeCloseTo(0);
    });

    it("箱庭自体が回転している場合、カメラが同じ向きでもジョイスティックのパン方向は箱庭の回転角分だけ補正される（回帰テスト）", () => {
        // カメラ自体は北向き(heading=0)のまま変えず、箱庭の回転角
        // （回転ボタンで変更される`orientationController.getRotationRad()`）のみを
        // 90°(π/2)に設定する。以前はこの値を一切参照していなかったため、箱庭を
        // 回転させてもジョイスティックは常に世界座標基準（見た目上は箱庭の回転角分
        // ズレた方向）へ動いてしまっていた。
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        oc.getRotationRad = vi.fn(() => Math.PI / 2);
        const { tc } = makeTileModeController();
        // Gamepad規約: y=-1がジョイスティックを奥（前方向）へ倒した状態。
        const hud = makeHud({ getPanAxes: () => ({ x: 0, y: -1 }) });
        const controls = setupDioramaTouchControls(scene, makeCamera(0), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(16);

        const [panAxes] = viewFeedAxes.mock.calls[viewFeedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        // 箱庭を90°回転させた分だけ補正され、見た目の「奥」は西(x=-1)へ移動する
        // （補正が無ければ従来通り{x:0,y:-1}になってしまう）。
        expect(panAxes.x).toBeCloseTo(-1);
        expect(panAxes.y).toBeCloseTo(0);
    });

    it("カメラが北(0°、既定)を向いている場合、ジョイスティックの軸値はそのままpanAxesとして渡される", () => {
        const { scene, tick } = createFakeScene();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud({ getPanAxes: () => ({ x: 0.5, y: -0.5 }) });
        const controls = setupDioramaTouchControls(scene, makeCamera(0), hud, vc, oc, tc);
        cleanups.push(controls.dispose);

        tick(16);

        expect(viewFeedAxes).toHaveBeenCalledWith({ x: 0.5, y: -0.5 }, 0, 0.016);
    });
});
