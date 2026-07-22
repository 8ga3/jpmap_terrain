/**
 * `dioramaArControls.ts` の `trackControllerSticks` のunit test。
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
    onAxisValueChangedObservable: FakeObservable<{ x: number; y: number }>;
}

interface FakeMotionController {
    hasThumbstick: boolean;
    hasTrigger: boolean;
    thumbstick: FakeThumbstickComponent;
    trigger: FakeTriggerComponent;
    getComponentOfType(type: string): FakeThumbstickComponent | FakeTriggerComponent | undefined;
}

const makeMotionController = (opts: { hasThumbstick: boolean; hasTrigger: boolean }): FakeMotionController => {
    const thumbstick: FakeThumbstickComponent = { onAxisValueChangedObservable: new FakeObservable() };
    const trigger: FakeTriggerComponent = { value: 0, onButtonStateChangedObservable: new FakeObservable() };
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
