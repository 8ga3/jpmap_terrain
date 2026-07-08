/**
 * Artillery 初期化中断ヘルパー (initCancellation.ts) のユニットテスト。
 *
 * pagehide / popstate による中断遷移、onAbort コールバックの同期実行、
 * dispose 後の監視解除を検証する。
 */
import { describe, it, expect, vi } from "vitest";
import { createInitCancellation } from "../src/demos/artillery/initCancellation";

describe("createInitCancellation", () => {
    it("初期状態では中断していない", () => {
        const target = new EventTarget();
        const cancel = createInitCancellation(undefined, target);
        expect(cancel.isAborted()).toBe(false);
        expect(cancel.signal.aborted).toBe(false);
    });

    it("pagehide で中断状態へ遷移する", () => {
        const target = new EventTarget();
        const cancel = createInitCancellation(undefined, target);
        target.dispatchEvent(new Event("pagehide"));
        expect(cancel.isAborted()).toBe(true);
        expect(cancel.signal.aborted).toBe(true);
    });

    it("popstate で中断状態へ遷移する", () => {
        const target = new EventTarget();
        const cancel = createInitCancellation(undefined, target);
        target.dispatchEvent(new Event("popstate"));
        expect(cancel.isAborted()).toBe(true);
    });

    it("中断時に onAbort を同期実行する", () => {
        const target = new EventTarget();
        const onAbort = vi.fn();
        createInitCancellation(onAbort, target);
        expect(onAbort).not.toHaveBeenCalled();
        target.dispatchEvent(new Event("popstate"));
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it("複数イベントが続けて発火しても onAbort は一度だけ実行する", () => {
        const target = new EventTarget();
        const onAbort = vi.fn();
        createInitCancellation(onAbort, target);
        target.dispatchEvent(new Event("pagehide"));
        target.dispatchEvent(new Event("popstate"));
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it("onAbort が例外を投げても中断状態は確定する", () => {
        const target = new EventTarget();
        const onAbort = vi.fn(() => {
            throw new Error("boom");
        });
        const cancel = createInitCancellation(onAbort, target);
        expect(() => target.dispatchEvent(new Event("pagehide"))).not.toThrow();
        expect(cancel.isAborted()).toBe(true);
    });

    it("dispose 後はイベントが発火しても中断せず onAbort も呼ばれない", () => {
        const target = new EventTarget();
        const onAbort = vi.fn();
        const cancel = createInitCancellation(onAbort, target);
        cancel.dispose();
        target.dispatchEvent(new Event("pagehide"));
        target.dispatchEvent(new Event("popstate"));
        expect(cancel.isAborted()).toBe(false);
        expect(onAbort).not.toHaveBeenCalled();
    });
});
