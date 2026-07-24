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
});
