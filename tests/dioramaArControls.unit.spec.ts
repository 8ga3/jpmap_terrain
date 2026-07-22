/**
 * `dioramaArControls.ts` の `trackControllerSticks`/`clamp1`/`clamp01` のunit test。
 *
 * @remarks
 * `WebXRInputSource`/モーションコントローラー/コンポーネントのObservableは
 * Babylon.jsの `Observable`（`.add()`が登録したコールバックそのものを返し、
 * `.remove(observer)` にそれを渡すと解除される規約）を模した軽量なフェイクで
 * 代替する。実際のWebXRセッション（`WebXRDefaultExperience`本体）は
 * `webXrArSession.unit.spec.ts` と同じ理由でテスト対象外とし、本ファイルは
 * コントローラーの追加・再初期化・切断に伴う `sticks`/`triggers` の状態遷移
 * ロジックのみを検証する。
 */
import { describe, it, expect } from "vitest";
import type { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";

import {
    trackControllerSticks,
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
}

const makeMotionController = (opts: {
    hasThumbstick: boolean;
    hasTrigger: boolean;
    /** バインド時点（`onMotionControllerInitObservable`発火時）で既に入力されている値。 */
    initialAxes?: { x: number; y: number };
    initialTriggerValue?: number;
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

const makeXr = (
    controllers: FakeController[],
): {
    xr: WebXRDefaultExperience;
    addedObservable: FakeObservable<FakeController>;
    removedObservable: FakeObservable<FakeController>;
} => {
    const addedObservable = new FakeObservable<FakeController>();
    const removedObservable = new FakeObservable<FakeController>();
    const xr = {
        input: {
            controllers,
            onControllerAddedObservable: addedObservable,
            onControllerRemovedObservable: removedObservable,
        },
    } as unknown as WebXRDefaultExperience;
    return { xr, addedObservable, removedObservable };
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
