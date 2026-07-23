/**
 * `dioramaArControls.ts` の `trackControllerSticks`/`trackControllerButtonPresses`/
 * `clamp1`/`clamp01`/`setupDioramaArControls` のunit test。
 *
 * @remarks
 * `WebXRInputSource`/モーションコントローラー/コンポーネントのObservableは
 * Babylon.jsの `Observable`（`.add()`が登録したコールバックそのものを返し、
 * `.remove(observer)` にそれを渡すと解除される規約）を模した軽量なフェイクで
 * 代替する。実際のWebXRセッション（`WebXRDefaultExperience`本体）は
 * `webXrArSession.unit.spec.ts` と同じ理由でテスト対象外とし、本ファイルは
 * コントローラーの追加・再初期化・切断に伴う `sticks`/`triggers` の状態遷移
 * ロジックのみを検証する。`setupDioramaArControls` は、HUD/物理ボタンの
 * タイル切替・トップ復帰イベントが `DioramaTileModeController`/
 * `DioramaViewController`/`DioramaOrientationController` へ正しく橋渡しされる
 * ことを検証する（`Scene`は`dioramaTouchControls.unit.spec.ts`と同じ軽量フェイク、
 * `WebXRDefaultExperience`は本ファイル既存の`makeXr`を使う）。
 */
import { describe, it, expect, vi } from "vitest";
import type { Scene } from "@babylonjs/core/scene";
import type { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { DioramaViewController } from "../src/demos/diorama/dioramaViewController";
import type { DioramaOrientationController } from "../src/demos/diorama/dioramaOrientationController";
import type { DioramaTileModeController } from "../src/demos/diorama/dioramaTileModeController";
import type { DioramaArControlHud } from "../src/demos/diorama/dioramaArControlHud";

import {
    trackControllerSticks,
    trackControllerButtonPresses,
    setupDioramaArControls,
    clamp1,
    clamp01,
    type ControllerStickState,
    type ControllerTriggerState,
} from "../src/demos/diorama/dioramaArControls";

/** Babylon.js `Observable` の規約（add()がコールバックを返し、remove(observer)で解除）を模す。 */
class FakeObservable<T> {
    private observers: Array<(value: T) => void> = [];
    add(callback: (value: T) => void): (value: T) => void {
        this.observers.push(callback);
        return callback;
    }
    remove(observer: (value: T) => void): void {
        const index = this.observers.indexOf(observer);
        if (index >= 0) this.observers.splice(index, 1);
    }
    notifyObservers(value: T): void {
        for (const observer of [...this.observers]) observer(value);
    }
    get observerCount(): number {
        return this.observers.length;
    }
}

interface FakeTriggerComponent {
    value: number;
    onButtonStateChangedObservable: FakeObservable<FakeTriggerComponent>;
}

interface FakeThumbstickComponent {
    axes: { x: number; y: number };
    onAxisValueChangedObservable: FakeObservable<{ x: number; y: number }>;
}

interface FakeMotionController {
    hasThumbstick: boolean;
    hasTrigger: boolean;
    thumbstick: FakeThumbstickComponent;
    trigger: FakeTriggerComponent;
    getComponentOfType(type: string): FakeThumbstickComponent | FakeTriggerComponent | undefined;
    getComponent(id: string): FakeButtonComponent | undefined;
    getAllComponentsOfType(type: string): FakeButtonComponent[];
}

/** ボタンコンポーネント（A/X・B/Yボタン相当）のフェイク。`changes.pressed`は
 *  `WebXRControllerComponent.changes.pressed`（変化があった場合のみ値を持つ）を模す。 */
interface FakeButtonComponent {
    changes: { pressed?: { current: boolean; previous: boolean } };
    onButtonStateChangedObservable: FakeObservable<FakeButtonComponent>;
}

const makeButtonComponent = (): FakeButtonComponent => ({
    changes: {},
    onButtonStateChangedObservable: new FakeObservable(),
});

/** ボタンの押下状態変化（`WebXRControllerComponent.changes.pressed`相当）を発火する。 */
const firePressedChange = (button: FakeButtonComponent, current: boolean): void => {
    button.changes = { pressed: { current, previous: !current } };
    button.onButtonStateChangedObservable.notifyObservers(button);
};

const makeMotionController = (opts: {
    hasThumbstick: boolean;
    hasTrigger: boolean;
    /** バインド時点（`onMotionControllerInitObservable`発火時）で既に入力されている値。 */
    initialAxes?: { x: number; y: number };
    initialTriggerValue?: number;
    /** `getComponent(id)` で名前引きできるボタン（例: `{"a-button": comp}`）。 */
    namedButtons?: Record<string, FakeButtonComponent>;
    /** `getAllComponentsOfType("button")` が返す一覧（名前引き失敗時のフォールバック検証用）。 */
    buttonList?: FakeButtonComponent[];
}): FakeMotionController => {
    const thumbstick: FakeThumbstickComponent = {
        axes: opts.initialAxes ?? { x: 0, y: 0 },
        onAxisValueChangedObservable: new FakeObservable(),
    };
    const trigger: FakeTriggerComponent = {
        value: opts.initialTriggerValue ?? 0,
        onButtonStateChangedObservable: new FakeObservable(),
    };
    return {
        hasThumbstick: opts.hasThumbstick,
        hasTrigger: opts.hasTrigger,
        thumbstick,
        trigger,
        getComponentOfType(type: string) {
            if (type === "thumbstick" && opts.hasThumbstick) return thumbstick;
            if (type === "trigger" && opts.hasTrigger) return trigger;
            return undefined;
        },
        getComponent(id: string) {
            return opts.namedButtons?.[id];
        },
        getAllComponentsOfType(type: string) {
            if (type === "button") return opts.buttonList ?? [];
            return [];
        },
    };
};


interface FakeController {
    inputSource: { handedness: "left" | "right" };
    onMotionControllerInitObservable: FakeObservable<FakeMotionController>;
}

const makeController = (handedness: "left" | "right"): FakeController => ({
    inputSource: { handedness },
    onMotionControllerInitObservable: new FakeObservable(),
});

const fireTrigger = (motionController: FakeMotionController, value: number): void => {
    motionController.trigger.value = value;
    motionController.trigger.onButtonStateChangedObservable.notifyObservers(motionController.trigger);
};

/**
 * ARカメラ（`WebXRCamera`）の位置を模したフェイク。パン方向算出
 * （`computeHorizontalDisplacement`）は `.position.x`/`.position.z` のみを
 * 参照するため、それ以外のプロパティは持たない軽量なフェイクで十分。
 */
const makeFakeCamera = (position: { x: number; z: number }): { position: { x: number; y: number; z: number } } => ({
    position: { x: position.x, y: 0, z: position.z },
});

/**
 * AR配置後の箱庭中心ノード（`placementRoot`）を模したフェイク。
 * `dioramaArControls.ts`は`.position.x`/`.position.z`のみを参照する。
 */
const makeDioramaRoot = (position: { x: number; z: number }): TransformNode =>
    ({ position: { x: position.x, y: 0, z: position.z } }) as unknown as TransformNode;

/** テストで使う既定の卓上表示半径[m]（実アプリの`DEFAULT_TABLE_RADIUS_M`と同じ値）。 */
const TEST_TABLE_RADIUS_M = 0.35;

/**
 * デッドゾーン外（既定: カメラ原点、箱庭はカメラから見て北へ`AR_PLACEMENT_DISTANCE_M`
 * 相当（0.6m、`webXrArSession.ts`のAR配置距離と同じ値）離れた位置）の、
 * `setupDioramaArControls`呼び出しに必要な `dioramaRoot`/`tableRadiusM` の組を返す。
 * パン方向の基準・デッドゾーンの判定自体を検証しないテスト（ボタン押下等）では
 * これで十分。
 */
const makeDefaultPlacement = (): { dioramaRoot: TransformNode; tableRadiusM: number } => ({
    dioramaRoot: makeDioramaRoot({ x: 0, z: 0.6 }),
    tableRadiusM: TEST_TABLE_RADIUS_M,
});

const makeXr = (
    controllers: FakeController[],
    options: { cameraPosition?: { x: number; z: number } } = {},
): {
    xr: WebXRDefaultExperience;
    addedObservable: FakeObservable<FakeController>;
    removedObservable: FakeObservable<FakeController>;
    exitXRAsync: ReturnType<typeof vi.fn>;
} => {
    const addedObservable = new FakeObservable<FakeController>();
    const removedObservable = new FakeObservable<FakeController>();
    const exitXRAsync = vi.fn(() => Promise.resolve());
    const xr = {
        input: {
            controllers,
            onControllerAddedObservable: addedObservable,
            onControllerRemovedObservable: removedObservable,
        },
        baseExperience: {
            exitXRAsync,
            camera: makeFakeCamera(options.cameraPosition ?? { x: 0, z: 0 }),
        },
    } as unknown as WebXRDefaultExperience;
    return { xr, addedObservable, removedObservable, exitXRAsync };
};

const zeroState = (): { sticks: ControllerStickState; triggers: ControllerTriggerState } => ({
    sticks: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
    triggers: { left: 0, right: 0 },
});

describe("trackControllerSticks", () => {
    it("thumbstickのaxis変化・triggerの値変化をsticks/triggersへ反映する", () => {
        const controller = makeController("left");
        const { xr } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        trackControllerSticks(xr, sticks, triggers);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0.5, y: -0.5 });
        fireTrigger(motionController, 0.8);

        expect(sticks.left).toEqual({ x: 0.5, y: -0.5 });
        expect(triggers.left).toBe(0.8);
    });

    it("バインド時点で既にthumbstick/triggerが入力済みの場合、変化イベントを待たず初期値を反映する（回帰テスト）", () => {
        // `onAxisValueChangedObservable`/`onButtonStateChangedObservable` は
        // その後の「変化」でのみ発火するため、初期反映を行わないと、
        // コントローラー接続/再初期化時点で既に入力されていた値
        // （スティックを倒したまま・トリガーを押したままのケース）を
        // 取りこぼし、ユーザーが一旦離して押し直すまで反映されない不具合になる。
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        trackControllerSticks(xr, sticks, triggers);

        const motionController = makeMotionController({
            hasThumbstick: true,
            hasTrigger: true,
            initialAxes: { x: 1, y: 1 },
            initialTriggerValue: 1,
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        // 変化イベント（onAxisValueChangedObservable/onButtonStateChangedObservable）を
        // 一切発火させていない時点で、既にバインド時点の値が反映されていること。
        expect(sticks.right).toEqual({ x: 1, y: 1 });
        expect(triggers.right).toBe(1);
    });

    it("thumbstick/triggerの値に非有限値・範囲外の値が混入しても、格納時点でサニタイズされる（回帰テスト）", () => {
        // sticks/triggersへの格納時点でサニタイズしないと、コントローラー由来の
        // 異常値（NaN等）が setupDioramaArControls 側の `clamp1(sticks... + hud...)`
        // で合算後にまとめて0扱いされ、同時に加算されるHUD側の正常な入力まで
        // 無効化されてしまう（sticks/triggers自体は常に正常範囲であるべき）。
        const controller = makeController("left");
        const { xr } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        trackControllerSticks(xr, sticks, triggers);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: NaN, y: 2 });
        expect(sticks.left).toEqual({ x: 0, y: 1 });

        fireTrigger(motionController, NaN);
        expect(triggers.left).toBe(0);

        fireTrigger(motionController, 1.5);
        expect(triggers.left).toBe(1);
    });

    it("バインド時点で既に入力済みの初期値も、非有限値・範囲外の値が混入していれば格納時点でサニタイズされる（回帰テスト）", () => {
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        trackControllerSticks(xr, sticks, triggers);

        const motionController = makeMotionController({
            hasThumbstick: true,
            hasTrigger: true,
            initialAxes: { x: Infinity, y: -2 },
            initialTriggerValue: Infinity,
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        expect(sticks.right).toEqual({ x: 0, y: -1 });
        expect(triggers.right).toBe(0);
    });

    it("同一コントローラーが再初期化され、新モーションコントローラーにthumbstick/triggerが無い場合、前回値へ固定されず0へリセットする（回帰テスト）", () => {
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        trackControllerSticks(xr, sticks, triggers);

        // 1回目の初期化: thumbstick/trigger有り。入力を与えて非ゼロ値にする。
        const motionController1 = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController1);
        motionController1.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 1, y: 1 });
        fireTrigger(motionController1, 1);
        expect(sticks.right).toEqual({ x: 1, y: 1 });
        expect(triggers.right).toBe(1);

        // 2回目の初期化（差し替え）: thumbstick/trigger無しのモーションコントローラー。
        // リセットしないと、以後どのobserverからも更新されず sticks.right/triggers.right が
        // フルスティック/フルトリガー相当の値のまま残留し、回転/高さが暴走し続けてしまう。
        const motionController2 = makeMotionController({ hasThumbstick: false, hasTrigger: false });
        controller.onMotionControllerInitObservable.notifyObservers(motionController2);

        expect(sticks.right).toEqual({ x: 0, y: 0 });
        expect(triggers.right).toBe(0);

        // 旧モーションコントローラーの購読は解除済みのため、旧observerへ通知しても反映されない。
        motionController1.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: -1, y: -1 });
        fireTrigger(motionController1, 1);
        expect(sticks.right).toEqual({ x: 0, y: 0 });
        expect(triggers.right).toBe(0);
    });

    it("コントローラー切断時にsticks/triggersを0へリセットし、observerを解除する", () => {
        const controller = makeController("left");
        const { xr, removedObservable } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        trackControllerSticks(xr, sticks, triggers);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 1, y: 1 });
        fireTrigger(motionController, 1);
        expect(sticks.left).toEqual({ x: 1, y: 1 });

        removedObservable.notifyObservers(controller);

        expect(sticks.left).toEqual({ x: 0, y: 0 });
        expect(triggers.left).toBe(0);
        expect(motionController.thumbstick.onAxisValueChangedObservable.observerCount).toBe(0);
        expect(motionController.trigger.onButtonStateChangedObservable.observerCount).toBe(0);
    });

    it("返り値の登録解除関数を呼ぶと、追加/削除observerとコントローラーのobserverが解除される", () => {
        const controller = makeController("left");
        const { xr, addedObservable, removedObservable } = makeXr([controller]);
        const { sticks, triggers } = zeroState();

        const untrack = trackControllerSticks(xr, sticks, triggers);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        untrack();

        expect(addedObservable.observerCount).toBe(0);
        expect(removedObservable.observerCount).toBe(0);
        expect(motionController.thumbstick.onAxisValueChangedObservable.observerCount).toBe(0);
        expect(motionController.trigger.onButtonStateChangedObservable.observerCount).toBe(0);

        // 解除後に入力を発火しても状態は変化しない。
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 1, y: 1 });
        expect(sticks.left).toEqual({ x: 0, y: 0 });
    });
});

describe("trackControllerButtonPresses", () => {
    it("右手はa-button=プライマリ、b-button=セカンダリとして押下エッジを検知する", () => {
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const onPrimaryPress = vi.fn();
        const onSecondaryPress = vi.fn();

        trackControllerButtonPresses(xr, onPrimaryPress, onSecondaryPress);

        const aButton = makeButtonComponent();
        const bButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "a-button": aButton, "b-button": bButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        firePressedChange(aButton, true);
        expect(onPrimaryPress).toHaveBeenCalledTimes(1);
        expect(onSecondaryPress).not.toHaveBeenCalled();

        firePressedChange(bButton, true);
        expect(onSecondaryPress).toHaveBeenCalledTimes(1);
    });

    it("左手はx-button=プライマリ、y-button=セカンダリとして押下エッジを検知する", () => {
        const controller = makeController("left");
        const { xr } = makeXr([controller]);
        const onPrimaryPress = vi.fn();
        const onSecondaryPress = vi.fn();

        trackControllerButtonPresses(xr, onPrimaryPress, onSecondaryPress);

        const xButton = makeButtonComponent();
        const yButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "x-button": xButton, "y-button": yButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        firePressedChange(xButton, true);
        expect(onPrimaryPress).toHaveBeenCalledTimes(1);

        firePressedChange(yButton, true);
        expect(onSecondaryPress).toHaveBeenCalledTimes(1);
    });

    it("離した瞬間（pressed:false）ではコールバックを呼ばない（押した瞬間のみの単発トリガー）", () => {
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const onPrimaryPress = vi.fn();
        const onSecondaryPress = vi.fn();

        trackControllerButtonPresses(xr, onPrimaryPress, onSecondaryPress);

        const aButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "a-button": aButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        firePressedChange(aButton, true);
        expect(onPrimaryPress).toHaveBeenCalledTimes(1);
        firePressedChange(aButton, false);
        expect(onPrimaryPress).toHaveBeenCalledTimes(1);
    });

    it("名前付きコンポーネントが見つからないプロファイルでは、getAllComponentsOfType('button')のインデックス0/1へフォールバックする", () => {
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const onPrimaryPress = vi.fn();
        const onSecondaryPress = vi.fn();

        trackControllerButtonPresses(xr, onPrimaryPress, onSecondaryPress);

        const button0 = makeButtonComponent();
        const button1 = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            buttonList: [button0, button1],
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        firePressedChange(button0, true);
        expect(onPrimaryPress).toHaveBeenCalledTimes(1);

        firePressedChange(button1, true);
        expect(onSecondaryPress).toHaveBeenCalledTimes(1);
    });

    it("コントローラー切断時にボタンobserverが解除される", () => {
        const controller = makeController("right");
        const { xr, removedObservable } = makeXr([controller]);
        const onPrimaryPress = vi.fn();
        const onSecondaryPress = vi.fn();

        trackControllerButtonPresses(xr, onPrimaryPress, onSecondaryPress);

        const aButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "a-button": aButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        expect(aButton.onButtonStateChangedObservable.observerCount).toBe(1);

        removedObservable.notifyObservers(controller);
        expect(aButton.onButtonStateChangedObservable.observerCount).toBe(0);

        // 切断後にボタンを発火しても、購読解除済みのためコールバックは呼ばれない。
        firePressedChange(aButton, true);
        expect(onPrimaryPress).not.toHaveBeenCalled();
    });

    it("返り値の登録解除関数を呼ぶと、既存コントローラーのボタンobserverが解除される", () => {
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const onPrimaryPress = vi.fn();
        const onSecondaryPress = vi.fn();

        const untrack = trackControllerButtonPresses(xr, onPrimaryPress, onSecondaryPress);

        const aButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "a-button": aButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        untrack();

        expect(aButton.onButtonStateChangedObservable.observerCount).toBe(0);
        firePressedChange(aButton, true);
        expect(onPrimaryPress).not.toHaveBeenCalled();
    });
});

describe("setupDioramaArControls", () => {
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
        const vc = {
            getCenter: vi.fn(),
            getFootprintRadiusM: vi.fn(),
            feedAxes,
        } as unknown as DioramaViewController;
        return { vc, feedAxes };
    };

    const makeOrientationController = (
        rotationRad = 0,
    ): { oc: DioramaOrientationController; feedAxes: ReturnType<typeof vi.fn> } => {
        const feedAxes = vi.fn();
        const oc = {
            getRotationRad: () => rotationRad,
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

    /** 実DOMを使わない `DioramaArControlHud` フェイク。タイル切替/AR終了の
     *  購読コールバックを保持し、テストから直接発火できるようにする。 */
    type FakeHud = DioramaArControlHud & {
        triggerTileModeCyclePress: () => void;
        triggerExitArPress: () => void;
    };
    const makeHud = (overrides: { panAxes?: { x: number; y: number } } = {}): FakeHud => {
        let tileModeCycleCallback: (() => void) | null = null;
        let exitArCallback: (() => void) | null = null;
        return {
            element: {} as HTMLElement,
            getPanAxes: () => overrides.panAxes ?? { x: 0, y: 0 },
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
        };
    };

    it("HUDのタイル切替ボタン押下でtileModeController.cycle()が呼ばれる", () => {
        const { scene } = createFakeScene();
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc, cycle } = makeTileModeController();
        const hud = makeHud();
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        hud.triggerTileModeCyclePress();
        expect(cycle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it("HUDのAR終了ボタン押下でxr.baseExperience.exitXRAsync()が呼ばれる", () => {
        const { scene } = createFakeScene();
        const controller = makeController("right");
        const { xr, exitXRAsync } = makeXr([controller]);
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        hud.triggerExitArPress();
        expect(exitXRAsync).toHaveBeenCalledTimes(1);

        dispose();
    });

    it("exitXRAsync()が失敗してもunhandled rejectionにならず、コンソールにエラーが出力される（回帰テスト）", async () => {
        const { scene } = createFakeScene();
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const rejection = new Error("exitXRAsync failed");
        (xr.baseExperience.exitXRAsync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(rejection);
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        hud.triggerExitArPress();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[jpmap-terrain diorama demo] failed to exit WebXR AR session:",
            rejection,
        );

        consoleErrorSpy.mockRestore();
        dispose();
    });

    it("物理コントローラーのa-button(プライマリ)押下でtileModeController.cycle()が呼ばれる", () => {
        const { scene } = createFakeScene();
        const controller = makeController("right");
        const { xr } = makeXr([controller]);
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc, cycle } = makeTileModeController();
        const hud = makeHud();
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        const aButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "a-button": aButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        firePressedChange(aButton, true);

        expect(cycle).toHaveBeenCalledTimes(1);

        dispose();
    });

    it("物理コントローラーのb-button(セカンダリ)押下でxr.baseExperience.exitXRAsync()が呼ばれる", () => {
        const { scene } = createFakeScene();
        const controller = makeController("right");
        const { xr, exitXRAsync } = makeXr([controller]);
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc } = makeTileModeController();
        const hud = makeHud();
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        const bButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "b-button": bButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        firePressedChange(bButton, true);

        expect(exitXRAsync).toHaveBeenCalledTimes(1);

        dispose();
    });

    it("dispose()を呼ぶと、以後HUDのタイル切替ボタン押下・物理ボタン押下のいずれもcycle()/exitXRAsync()を呼ばない", () => {
        const { scene } = createFakeScene();
        const controller = makeController("right");
        const { xr, exitXRAsync } = makeXr([controller]);
        const { vc } = makeViewController();
        const { oc } = makeOrientationController();
        const { tc, cycle } = makeTileModeController();
        const hud = makeHud();
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        const aButton = makeButtonComponent();
        const motionController = makeMotionController({
            hasThumbstick: false,
            hasTrigger: false,
            namedButtons: { "a-button": aButton },
        });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);

        dispose();

        hud.triggerTileModeCyclePress();
        hud.triggerExitArPress();
        firePressedChange(aButton, true);

        expect(cycle).not.toHaveBeenCalled();
        expect(exitXRAsync).not.toHaveBeenCalled();
        expect(hud.dispose).toHaveBeenCalledTimes(1);
    });

    it("ユーザーが箱庭の南側に立っている場合、スティックを前方向へ倒すとpanAxesは北方向になる（箱庭回転なし）", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        // ユーザー（カメラ）は原点、箱庭は北（+z）へ0.6m（AR配置距離相当）離れている。
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const dioramaRoot = makeDioramaRoot({ x: 0, z: 0.6 });
        const { vc } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        // Gamepad規約: y=-1がスティックを奥（前方向）へ倒した状態。
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0, y: -1 });

        tick(16);

        const feedAxes = vc.feedAxes as ReturnType<typeof vi.fn>;
        expect(feedAxes).toHaveBeenCalled();
        const [panAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(panAxes.x).toBeCloseTo(0);
        expect(panAxes.y).toBeCloseTo(-1);

        dispose();
    });

    it("ユーザーが箱庭の西側に立っている場合、スティックを前方向へ倒すとpanAxesは東方向になる（『ユーザーから見て奥』基準）", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        // ユーザーは原点、箱庭は東（+x）へ0.6m離れている（ユーザーは箱庭の西側に立つ）。
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const dioramaRoot = makeDioramaRoot({ x: 0.6, z: 0 });
        const { vc } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0, y: -1 });

        tick(16);

        const feedAxes = vc.feedAxes as ReturnType<typeof vi.fn>;
        const [panAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(panAxes.x).toBeCloseTo(1);
        expect(panAxes.y).toBeCloseTo(0);

        dispose();
    });

    it("箱庭を90°回転させると、同じ立ち位置・同じスティック入力でもpanAxesの方角が変わる（回帰テスト）", () => {
        // Issue報告: 「ジオラマを回転したあとの方向が反映されない」への対応確認。
        // ユーザーの立ち位置（箱庭の南側）は1つ目のテストと同じだが、箱庭自体を
        // 90°回転させた状態では、同じ「前方向へ倒す」操作が異なる方角（西）へ
        // パンすることを検証する。
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const dioramaRoot = makeDioramaRoot({ x: 0, z: 0.6 });
        const { vc } = makeViewController();
        const { oc } = makeOrientationController(Math.PI / 2);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0, y: -1 });

        tick(16);

        const feedAxes = vc.feedAxes as ReturnType<typeof vi.fn>;
        const [panAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(panAxes.x).toBeCloseTo(-1);
        expect(panAxes.y).toBeCloseTo(0);

        dispose();
    });

    it("HUDの仮想ジョイスティック入力も同じ位置・回転基準で東西・南北へ変換される", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const dioramaRoot = makeDioramaRoot({ x: 0.6, z: 0 });
        const { vc } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        // ユーザーは箱庭の西側に立ち、HUDの仮想ジョイスティックを前方向へ倒す。
        const hud = makeHud({ panAxes: { x: 0, y: -1 } });

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);
        tick(16);

        const feedAxes = vc.feedAxes as ReturnType<typeof vi.fn>;
        const [panAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(panAxes.x).toBeCloseTo(1);
        expect(panAxes.y).toBeCloseTo(0);

        dispose();
    });

    it("ユーザーが箱庭に重なるように立っている（デッドゾーン内）場合、スティック入力があってもpanAxesは常に{x:0,y:0}になる", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        // ユーザーと箱庭中心の水平距離0.1mはtableRadiusM(0.35m)未満＝デッドゾーン内。
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const dioramaRoot = makeDioramaRoot({ x: 0, z: 0.1 });
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 1, y: -1 });

        tick(16);

        expect(feedAxes).toHaveBeenCalledWith({ x: 0, y: 0 }, 0, 0.016);

        dispose();
    });

    it("デッドゾーンにはヒステリシスがあり、境界ちょうど付近では有効/無効が頻繁に切り替わらない", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        // 距離0.1m（デッドゾーン内、tableRadiusM=0.35m）から始める。
        const dioramaRoot = makeDioramaRoot({ x: 0, z: 0.1 });
        const { vc, feedAxes } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0, y: -1 });

        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);

        // tableRadiusM(0.35) + 既定ヒステリシス(0.05) = 0.4m以内はまだデッドゾーン内。
        dioramaRoot.position.z = 0.39;
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);

        // 0.4mを超えたのでデッドゾーンを抜け、パンが有効になる。
        dioramaRoot.position.z = 0.45;
        tick(16);
        const [panAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];
        expect(panAxes).not.toEqual({ x: 0, y: 0 });

        dispose();
    });

    it("複数フレームにわたりユーザーの立ち位置が微小に揺らいでも、8方位スナップによりpanAxesが安定する", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        // 北からわずか(≈2.9°)ずれた位置（デッドゾーン外）。
        const headingRad = 0.05;
        const distanceM = 0.6;
        const dioramaX = distanceM * Math.sin(headingRad);
        const dioramaZ = distanceM * Math.cos(headingRad);
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const dioramaRoot = makeDioramaRoot({ x: dioramaX, z: dioramaZ });
        const { vc } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0, y: -1 });

        tick(16);
        const feedAxes = vc.feedAxes as ReturnType<typeof vi.fn>;
        const [firstPanAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];

        // 0.05rad(≈2.9°)は45°スナップ・5°ヒステリシスの範囲内の揺らぎのため、
        // 北(0°)のバケットに留まり続けpanAxesは変化しないはず。
        tick(16);
        const [secondPanAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [{ x: number; y: number }];

        expect(firstPanAxes.x).toBeCloseTo(0);
        expect(firstPanAxes.y).toBeCloseTo(-1);
        expect(secondPanAxes.x).toBeCloseTo(firstPanAxes.x);
        expect(secondPanAxes.y).toBeCloseTo(firstPanAxes.y);

        dispose();
    });

    it("デッドゾーンへ入ると向きスナップの基準がリセットされ、抜けた直後に古い基準の固着（ヒステリシスの誤適用）が起きない（回帰テスト）", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("left");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        // 1. 北(0°)の位置から開始し、previousSnappedHeadingRadを0（北）で確立する。
        const dioramaRoot = makeDioramaRoot({ x: 0, z: 0.6 });
        const { vc } = makeViewController();
        const { oc } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, TEST_TABLE_RADIUS_M, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0, y: -1 });

        tick(16);
        const feedAxes = vc.feedAxes as ReturnType<typeof vi.fn>;
        const [beforeDeadZonePanAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [
            { x: number; y: number },
        ];
        expect(beforeDeadZonePanAxes.x).toBeCloseTo(0);
        expect(beforeDeadZonePanAxes.y).toBeCloseTo(-1);

        // 2. デッドゾーン内へ移動する（previousSnappedHeadingRadが更新されなくなる）。
        dioramaRoot.position.x = 0;
        dioramaRoot.position.z = 0.1;
        tick(16);
        expect(feedAxes).toHaveBeenLastCalledWith({ x: 0, y: 0 }, 0, 0.016);

        // 3. デッドゾーンを抜け、新しい向き（0.4rad≈22.9°、北(0°)とNE(45°)の
        //    ちょうど中間よりNE寄り＝最寄りバケットはNE(45°)）へ移動する。
        //    修正前（previousSnappedHeadingRadをリセットしない）だと、古い基準
        //    （北=0）からの差分(0.4rad)がヒステリシス閾値（22.5°+5°=27.5°
        //    ≈0.48rad）以内のため誤って北のまま固着してしまう回帰があった。
        const headingRad = 0.4;
        const distanceM = 0.6;
        dioramaRoot.position.x = distanceM * Math.sin(headingRad);
        dioramaRoot.position.z = distanceM * Math.cos(headingRad);
        tick(16);

        const [afterDeadZonePanAxes] = feedAxes.mock.calls[feedAxes.mock.calls.length - 1] as [
            { x: number; y: number },
        ];
        // 修正後は北への固着ではなく、最寄りバケットNE(45°)へ即座にスナップする。
        expect(afterDeadZonePanAxes.x).toBeCloseTo(Math.SQRT1_2);
        expect(afterDeadZonePanAxes.y).toBeCloseTo(-Math.SQRT1_2);

        dispose();
    });

    it("右スティックを下方向へ倒しつつわずかに左右へドリフトしても、ズームのみ発火し回転は発火しない（回帰テスト）", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("right");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        // 下方向(y=-0.9)への入力に、わずかな左右ドリフト(x=0.2)が混ざったケース。
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0.2, y: -0.9 });

        tick(16);

        // ズーム（viewController.feedAxesの第2引数）は発火するが、回転
        // （orientationController.feedAxesの第1引数）は0のまま（発火しない）。
        const [, zoomAxisY] = viewFeedAxes.mock.calls[viewFeedAxes.mock.calls.length - 1] as [
            { x: number; y: number },
            number,
            number,
        ];
        expect(zoomAxisY).not.toBe(0);
        const [rotationAxisX] = orientationFeedAxes.mock.calls[orientationFeedAxes.mock.calls.length - 1] as [
            number,
            number,
            number,
        ];
        expect(rotationAxisX).toBe(0);

        dispose();
    });

    it("右スティックを左右へ倒しつつわずかに上下へドリフトしても、回転のみ発火しズームは発火しない（回帰テスト）", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("right");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        const hud = makeHud();

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);

        const motionController = makeMotionController({ hasThumbstick: true, hasTrigger: true });
        controller.onMotionControllerInitObservable.notifyObservers(motionController);
        // 右方向(x=0.9)への入力に、わずかな上下ドリフト(y=0.2)が混ざったケース。
        motionController.thumbstick.onAxisValueChangedObservable.notifyObservers({ x: 0.9, y: 0.2 });

        tick(16);

        const [, zoomAxisY] = viewFeedAxes.mock.calls[viewFeedAxes.mock.calls.length - 1] as [
            { x: number; y: number },
            number,
            number,
        ];
        expect(zoomAxisY).toBe(0);
        const [rotationAxisX] = orientationFeedAxes.mock.calls[orientationFeedAxes.mock.calls.length - 1] as [
            number,
            number,
            number,
        ];
        expect(rotationAxisX).not.toBe(0);

        dispose();
    });

    it("GUIのズーム/回転ボタン（もともと個別で排他的）は十字ボタンゲートの影響を受けない", () => {
        const { scene, tick } = createFakeScene();
        const controller = makeController("right");
        const { xr } = makeXr([controller], { cameraPosition: { x: 0, z: 0 } });
        const { dioramaRoot, tableRadiusM } = makeDefaultPlacement();
        const { vc, feedAxes: viewFeedAxes } = makeViewController();
        const { oc, feedAxes: orientationFeedAxes } = makeOrientationController(0);
        const { tc } = makeTileModeController();
        // 物理スティックの入力は無し。GUIのズームボタンのみ操作する。
        const hud = makeHud({});
        hud.getZoomAxis = () => 1;

        const dispose = setupDioramaArControls(scene, xr, dioramaRoot, tableRadiusM, hud, vc, oc, tc);
        tick(16);

        const [, zoomAxisY] = viewFeedAxes.mock.calls[viewFeedAxes.mock.calls.length - 1] as [
            { x: number; y: number },
            number,
            number,
        ];
        expect(zoomAxisY).toBe(1);
        const [rotationAxisX] = orientationFeedAxes.mock.calls[orientationFeedAxes.mock.calls.length - 1] as [
            number,
            number,
            number,
        ];
        expect(rotationAxisX).toBe(0);

        dispose();
    });
});


describe("clamp1", () => {
    it("範囲内の値はそのまま返す", () => {
        expect(clamp1(0.5)).toBe(0.5);
        expect(clamp1(-0.5)).toBe(-0.5);
    });

    it("範囲外の値は[-1,1]へクランプする", () => {
        expect(clamp1(2)).toBe(1);
        expect(clamp1(-2)).toBe(-1);
    });

    it("非有限値（NaN/Infinity）は0へフォールバックする（回帰テスト）", () => {
        expect(clamp1(NaN)).toBe(0);
        expect(clamp1(Infinity)).toBe(0);
        expect(clamp1(-Infinity)).toBe(0);
    });
});

describe("clamp01", () => {
    it("範囲内の値はそのまま返す", () => {
        expect(clamp01(0.5)).toBe(0.5);
    });

    it("範囲外の値は[0,1]へクランプする", () => {
        expect(clamp01(2)).toBe(1);
        expect(clamp01(-1)).toBe(0);
    });

    it("非有限値（NaN/Infinity）は0へフォールバックする（回帰テスト）", () => {
        expect(clamp01(NaN)).toBe(0);
        expect(clamp01(Infinity)).toBe(0);
        expect(clamp01(-Infinity)).toBe(0);
    });
});
