/**
 * `attachResizeRefresh` のユニットテスト (Issue #150 / PR #153)
 *
 * - リサイズ通知が debounce されて 1 回だけ refresh を呼ぶ
 * - dispose / scene.dispose で Observer 解除と保留タイマーのクリアが行われる
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import {
    attachResizeRefresh,
    DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS,
} from "../src/terrain/resizeRefresh";

type Listener = () => void;

interface FakeObservable {
    listeners: Listener[];
    add: jest.Mock<(cb: Listener) => Listener>;
    remove: jest.Mock<(cb: Listener) => boolean>;
    /** テスト用: 登録済み listener を全て呼ぶ */
    notify: () => void;
}

const createFakeObservable = (): FakeObservable => {
    const listeners: Listener[] = [];
    const obs: FakeObservable = {
        listeners,
        add: jest.fn((cb: Listener) => {
            listeners.push(cb);
            return cb;
        }),
        remove: jest.fn((cb: Listener) => {
            const idx = listeners.indexOf(cb);
            if (idx >= 0) {
                listeners.splice(idx, 1);
                return true;
            }
            return false;
        }),
        notify: () => {
            for (const cb of [...listeners]) cb();
        },
    };
    return obs;
};

describe("attachResizeRefresh", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("デフォルト debounce 後に refresh が 1 回呼ばれる", () => {
        const onResize = createFakeObservable();
        const onDispose = createFakeObservable();
        const refresh = jest.fn<() => void>();

        attachResizeRefresh(
            { onResizeObservable: onResize } as never,
            { onDisposeObservable: onDispose } as never,
            refresh,
        );

        onResize.notify();
        expect(refresh).not.toHaveBeenCalled();

        jest.advanceTimersByTime(DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("連続リサイズは debounce され、最後の発火から debounceMs 後に 1 回だけ呼ばれる", () => {
        const onResize = createFakeObservable();
        const onDispose = createFakeObservable();
        const refresh = jest.fn<() => void>();

        attachResizeRefresh(
            { onResizeObservable: onResize } as never,
            { onDisposeObservable: onDispose } as never,
            refresh,
            { debounceMs: 50 },
        );

        onResize.notify();
        jest.advanceTimersByTime(30);
        onResize.notify();
        jest.advanceTimersByTime(30);
        onResize.notify();

        // ここまでは debounce 内で再スケジュールされるため呼ばれていない
        expect(refresh).not.toHaveBeenCalled();

        jest.advanceTimersByTime(50);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("dispose 後はリサイズが来ても refresh が呼ばれず、Observer も解除される", () => {
        const onResize = createFakeObservable();
        const onDispose = createFakeObservable();
        const refresh = jest.fn<() => void>();

        const handle = attachResizeRefresh(
            { onResizeObservable: onResize } as never,
            { onDisposeObservable: onDispose } as never,
            refresh,
        );

        handle.dispose();

        expect(onResize.remove).toHaveBeenCalledTimes(1);
        expect(onResize.listeners.length).toBe(0);

        onResize.notify();
        jest.advanceTimersByTime(DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("保留中タイマーは dispose でキャンセルされる", () => {
        const onResize = createFakeObservable();
        const onDispose = createFakeObservable();
        const refresh = jest.fn<() => void>();

        const handle = attachResizeRefresh(
            { onResizeObservable: onResize } as never,
            { onDisposeObservable: onDispose } as never,
            refresh,
        );

        onResize.notify();
        // debounce 経過前に dispose
        handle.dispose();
        jest.advanceTimersByTime(DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS * 2);

        expect(refresh).not.toHaveBeenCalled();
    });

    it("scene.onDisposeObservable 発火で自動的に dispose される", () => {
        const onResize = createFakeObservable();
        const onDispose = createFakeObservable();
        const refresh = jest.fn<() => void>();

        attachResizeRefresh(
            { onResizeObservable: onResize } as never,
            { onDisposeObservable: onDispose } as never,
            refresh,
        );

        // scene dispose 通知
        onDispose.notify();

        expect(onResize.remove).toHaveBeenCalledTimes(1);

        onResize.notify();
        jest.advanceTimersByTime(DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("dispose を複数回呼んでも安全（remove は 1 回のみ）", () => {
        const onResize = createFakeObservable();
        const onDispose = createFakeObservable();
        const refresh = jest.fn<() => void>();

        const handle = attachResizeRefresh(
            { onResizeObservable: onResize } as never,
            { onDisposeObservable: onDispose } as never,
            refresh,
        );

        handle.dispose();
        handle.dispose();
        onDispose.notify();

        expect(onResize.remove).toHaveBeenCalledTimes(1);
    });
});
