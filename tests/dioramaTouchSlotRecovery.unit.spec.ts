// @vitest-environment jsdom
/**
 * `dioramaTouchSlotRecovery.ts` / `dioramaPressedPointerTracker.ts` のunit test。
 *
 * @remarks
 * 実機（Meta Quest Browser）で「操作しているうちに3D画面をドラッグしても
 * カメラが回転しなくなる」不具合が報告された。原因は Babylon.js の
 * `WebDeviceInputSystem` がタッチを固定数のスロット（`_activeTouchIds`）で
 * 管理しており、空きが無いと `pointerdown` を**処理せず破棄する**ことにある。
 * スロットはホバー中の `pointermove` でも確保されるが、その場合は対応する
 * `pointerup` が来ないため永久に解放されず、やがて枯渇する。
 *
 * 実ブラウザでの検証で、スロットが埋まった状態の `pointerdown` は Babylon が
 * `Max number of touches exceeded` を出して破棄し、カメラに一切届かないことを
 * 確認済み。本テストは、その枯渇状態からの回復処理を検証する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import {
    readActiveTouchIds,
    reclaimTouchSlotsForPointer,
    setupDioramaTouchSlotRecovery,
} from "../src/lib/internal/diorama/dioramaTouchSlotRecovery";
import { createPressedPointerTracker } from "../src/lib/internal/diorama/dioramaPressedPointerTracker";

/** Babylonの `engine._deviceSourceManager._deviceInputSystem` の形だけを模したフェイク。 */
const makeEngine = (activeTouchIds: unknown): AbstractEngine =>
    ({ _deviceSourceManager: { _deviceInputSystem: { _activeTouchIds: activeTouchIds } } }) as unknown as AbstractEngine;

const dispatch = (type: string, pointerId: number, buttons: number, pointerType = "touch"): void => {
    document.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, buttons, pointerType }));
};

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("readActiveTouchIds", () => {
    it("タッチスロットの配列を取得できる", () => {
        expect(readActiveTouchIds(makeEngine([1, -1]))).toEqual([1, -1]);
    });

    it("取得できない形（Babylonのバージョン差等）ではnullを返す", () => {
        expect(readActiveTouchIds(makeEngine(undefined))).toBeNull();
        expect(readActiveTouchIds({} as AbstractEngine)).toBeNull();
    });
});

describe("reclaimTouchSlotsForPointer", () => {
    it("空きスロットがあるときは何もしない（Babylonが破棄しないため）", () => {
        const slots = [11, -1];
        expect(reclaimTouchSlotsForPointer(slots, new Set([11]), 12)).toEqual([]);
        expect(slots).toEqual([11, -1]);
    });

    it("既にスロットを持つポインタでは何もしない", () => {
        const slots = [11, 12];
        expect(reclaimTouchSlotsForPointer(slots, new Set([11, 12]), 11)).toEqual([]);
        expect(slots).toEqual([11, 12]);
    });

    it("枯渇時、押下されていない（ホバー由来の）ポインタが占有するスロットを解放する", () => {
        const slots = [11, 12];
        // 11/12 はホバーで確保されただけで、実際には押されていない。
        expect(reclaimTouchSlotsForPointer(slots, new Set([13]), 13)).toEqual([11, 12]);
        expect(slots).toEqual([-1, -1]);
    });

    it("枯渇時でも、実際に押下中のポインタのスロットは奪わない（2本指操作を壊さない）", () => {
        const slots = [11, 12];
        expect(reclaimTouchSlotsForPointer(slots, new Set([11, 12, 13]), 13)).toEqual([]);
        expect(slots).toEqual([11, 12]);
    });

    it("押下中と未押下が混在する場合、未押下の分だけ解放する", () => {
        const slots = [11, 12];
        expect(reclaimTouchSlotsForPointer(slots, new Set([11, 13]), 13)).toEqual([12]);
        expect(slots).toEqual([11, -1]);
    });
});

describe("createPressedPointerTracker", () => {
    it("pointerdown/pointerupで押下状態を追跡する", () => {
        const listener = vi.fn();
        const tracker = createPressedPointerTracker(listener);
        cleanups.push(tracker.dispose);

        dispatch("pointerdown", 3, 1);
        expect(Array.from(tracker.pressedPointerIds)).toEqual([3]);
        dispatch("pointerup", 3, 0);
        expect(Array.from(tracker.pressedPointerIds)).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("pointerupが届かなくても、buttons=0の移動で押下状態を補正する", () => {
        const tracker = createPressedPointerTracker(vi.fn());
        cleanups.push(tracker.dispose);

        dispatch("pointerdown", 3, 1);
        dispatch("pointermove", 3, 1);
        expect(Array.from(tracker.pressedPointerIds)).toEqual([3]);

        dispatch("pointermove", 3, 0);
        expect(Array.from(tracker.pressedPointerIds)).toEqual([]);
    });

    it("dispose()すると以後のイベントを追跡しない", () => {
        const tracker = createPressedPointerTracker(vi.fn());
        tracker.dispose();

        dispatch("pointerdown", 3, 1);
        expect(Array.from(tracker.pressedPointerIds)).toEqual([]);
    });
});

describe("setupDioramaTouchSlotRecovery", () => {
    it("ホバーで枯渇したスロットを、次のpointerdownの直前に解放する（実機不具合の回帰テスト）", () => {
        const slots = [501, 502];
        cleanups.push(setupDioramaTouchSlotRecovery(makeEngine(slots)));

        dispatch("pointerdown", 503, 1);

        expect(slots).toEqual([-1, -1]);
    });

    it("マウスはBabylonが専用スロットで扱うため対象外", () => {
        const slots = [501, 502];
        cleanups.push(setupDioramaTouchSlotRecovery(makeEngine(slots)));

        dispatch("pointerdown", 503, 1, "mouse");

        expect(slots).toEqual([501, 502]);
    });

    it("スロットを取得できない場合でも例外を投げない（Babylonのバージョン差等への保険）", () => {
        cleanups.push(setupDioramaTouchSlotRecovery(makeEngine(undefined)));
        expect(() => dispatch("pointerdown", 503, 1)).not.toThrow();
    });

    it("dispose()すると以後のpointerdownでスロットを解放しない（後始末の回帰テスト）", () => {
        const slots = [501, 502];
        setupDioramaTouchSlotRecovery(makeEngine(slots))();

        dispatch("pointerdown", 503, 1);

        expect(slots).toEqual([501, 502]);
    });
});
