/**
 * `dioramaTileModeController.ts` のunit test。
 *
 * @remarks
 * `DioramaTerrain`（`setTileMode`のみ使用）をモックし、Babylon/DOMに依存せず
 * 純粋にロジックを検証する（`dioramaViewController.unit.spec.ts` と同じ方針）。
 */
import { describe, it, expect, vi } from "vitest";
import type { DioramaTerrain } from "../src/terrain/diorama/dioramaTerrain";
import { createDioramaTileModeController } from "../src/lib/internal/diorama/dioramaTileModeController";

const makeTerrain = (): { terrain: DioramaTerrain; setTileMode: ReturnType<typeof vi.fn> } => {
    const setTileMode = vi.fn(() => Promise.resolve());
    const terrain = { setTileMode } as unknown as DioramaTerrain;
    return { terrain, setTileMode };
};

describe("createDioramaTileModeController", () => {
    it("初期状態はコンストラクタに渡したタイル種別を返す", () => {
        const { terrain } = makeTerrain();
        const tc = createDioramaTileModeController(terrain, "std");
        expect(tc.getTileMode()).toBe("std");
    });

    it("cycle()でsetTileModeが次のタイル種別（std→photo）で呼ばれる", () => {
        const { terrain, setTileMode } = makeTerrain();
        const tc = createDioramaTileModeController(terrain, "std");

        tc.cycle();

        expect(setTileMode).toHaveBeenCalledTimes(1);
        expect(setTileMode).toHaveBeenCalledWith("photo");
    });

    it("cycle()を繰り返すと、setTileMode成功後にstd→photo→wireframe→stdと巡回する", async () => {
        const { terrain, setTileMode } = makeTerrain();
        const tc = createDioramaTileModeController(terrain, "std");

        tc.cycle();
        await Promise.resolve();
        await Promise.resolve();
        expect(tc.getTileMode()).toBe("photo");

        tc.cycle();
        await Promise.resolve();
        await Promise.resolve();
        expect(tc.getTileMode()).toBe("wireframe");

        tc.cycle();
        await Promise.resolve();
        await Promise.resolve();
        expect(tc.getTileMode()).toBe("std");

        expect(setTileMode).toHaveBeenNthCalledWith(1, "photo");
        expect(setTileMode).toHaveBeenNthCalledWith(2, "wireframe");
        expect(setTileMode).toHaveBeenNthCalledWith(3, "std");
    });

    it("前回のsetTileModeが完了するまで次のsetTileModeを発行せず、完了後に最後の要求のみ反映される（完了待ち合流）", async () => {
        const { terrain, setTileMode } = makeTerrain();
        let resolveFirst: (() => void) | undefined;
        setTileMode.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirst = resolve;
                }),
        );
        const tc = createDioramaTileModeController(terrain, "std");

        tc.cycle(); // std -> photo (未解決のまま)
        expect(setTileMode).toHaveBeenCalledTimes(1);
        expect(setTileMode).toHaveBeenLastCalledWith("photo");

        // 完了待ちの間にさらに2回連打する。キューには積まれず、最終目標のみ保持される。
        tc.cycle(); // 目標: wireframe（pendingを基準に巡回）
        tc.cycle(); // 目標: std（さらに1つ進む）
        expect(setTileMode).toHaveBeenCalledTimes(1); // まだ2回目は発行されない

        resolveFirst?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // 1回目完了後、連打で最後に確定した目標（std）のみが2回目として発行される。
        expect(setTileMode).toHaveBeenCalledTimes(2);
        expect(setTileMode).toHaveBeenLastCalledWith("std");
    });

    it("setTileModeが失敗してもcurrentTileModeは更新されないが、エラーはコンソールに出力され例外は投げない", async () => {
        const { terrain, setTileMode } = makeTerrain();
        setTileMode.mockRejectedValueOnce(new Error("network error"));
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const tc = createDioramaTileModeController(terrain, "std");

        tc.cycle();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(tc.getTileMode()).toBe("std");
        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    describe("setTileMode", () => {
        it("指定したタイル種別が適用されるまで待てる", async () => {
            const { terrain, setTileMode } = makeTerrain();
            const tc = createDioramaTileModeController(terrain, "std");

            await tc.setTileMode("wireframe");

            expect(setTileMode).toHaveBeenCalledWith("wireframe");
            expect(tc.getTileMode()).toBe("wireframe");
        });

        it("失敗時はcycle()と異なり、呼び出し元へエラーがrejectされる（コンソールには出さない）", async () => {
            const { terrain, setTileMode } = makeTerrain();
            setTileMode.mockRejectedValueOnce(new Error("network error"));
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            const tc = createDioramaTileModeController(terrain, "std");

            await expect(tc.setTileMode("photo")).rejects.toThrow("network error");
            expect(tc.getTileMode()).toBe("std");
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });

        it("cycle()の適用中に呼ばれた場合、要求を上書きしつつ最終的な収束を待てる", async () => {
            const { terrain, setTileMode } = makeTerrain();
            let resolveFirst: (() => void) | undefined;
            setTileMode.mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolveFirst = resolve;
                    }),
            );
            const tc = createDioramaTileModeController(terrain, "std");

            tc.cycle(); // std -> photo（未解決のまま）
            const setTileModePromise = tc.setTileMode("wireframe");

            resolveFirst?.();
            await setTileModePromise;

            expect(tc.getTileMode()).toBe("wireframe");
            expect(setTileMode).toHaveBeenLastCalledWith("wireframe");
        });
    });

    describe("onChange", () => {
        it("cycle()での変化後に呼ばれる", async () => {
            const { terrain } = makeTerrain();
            const tc = createDioramaTileModeController(terrain, "std");
            const listener = vi.fn();
            tc.onChange(listener);

            tc.cycle();
            await Promise.resolve();
            await Promise.resolve();

            expect(listener).toHaveBeenCalledWith("photo");
        });

        it("setTileMode()での変化後にも呼ばれる", async () => {
            const { terrain } = makeTerrain();
            const tc = createDioramaTileModeController(terrain, "std");
            const listener = vi.fn();
            tc.onChange(listener);

            await tc.setTileMode("wireframe");

            expect(listener).toHaveBeenCalledWith("wireframe");
        });

        it("購読解除後は呼ばれない", async () => {
            const { terrain } = makeTerrain();
            const tc = createDioramaTileModeController(terrain, "std");
            const listener = vi.fn();
            const unsubscribe = tc.onChange(listener);
            unsubscribe();

            await tc.setTileMode("photo");

            expect(listener).not.toHaveBeenCalled();
        });
    });
});
