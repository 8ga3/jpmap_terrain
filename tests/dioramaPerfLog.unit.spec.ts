/**
 * terrain/diorama/dioramaPerfLog の単体テスト。
 *
 * - `fn` の戻り値をそのまま解決する
 * - `fn` が失敗した場合はそのエラーをそのまま伝播する
 * - 開発時（`NODE_ENV !== "production"`）は `console.debug` へ計測結果を出力する
 * - 本番ビルド（`NODE_ENV === "production"`）では計測・ログ出力を行わない
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { measureAsync } from "../src/terrain/diorama/dioramaPerfLog";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
});

describe("measureAsync", () => {
    it("fnの戻り値をそのまま解決する", async () => {
        const result = await measureAsync("test-label", async () => 42);
        expect(result).toBe(42);
    });

    it("fnが失敗した場合はそのエラーをそのまま伝播する", async () => {
        const err = new Error("boom");
        await expect(
            measureAsync("test-label", async () => {
                throw err;
            }),
        ).rejects.toBe(err);
    });

    it("開発時はconsole.debugへラベルと経過時間を出力する", async () => {
        process.env.NODE_ENV = "test";
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
        await measureAsync("my-phase", async () => "ok");
        expect(debugSpy).toHaveBeenCalledTimes(1);
        expect(debugSpy.mock.calls[0][0]).toMatch(/^\[diorama-perf\] my-phase: \d+(\.\d+)?ms$/);
    });

    it("本番ビルドでは計測・ログ出力を行わずfnをそのまま呼び出す", async () => {
        process.env.NODE_ENV = "production";
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
        const fn = vi.fn(async () => "prod-value");
        const result = await measureAsync("my-phase", fn);
        expect(result).toBe("prod-value");
        expect(fn).toHaveBeenCalledTimes(1);
        expect(debugSpy).not.toHaveBeenCalled();
    });
});
