/**
 * @jest-environment jsdom
 */
/**
 * デモエントリ (`src/index.ts`) の純粋関数 export ユニットテスト (Issue #136)。
 *
 * - `resolveEngine`: クエリ文字列からエンジン種別を解決する。
 * - `resolveLatLon`: URL から初期表示の緯度経度を解決する（`parseLatLonFromUrl` の薄いラッパー）。
 *
 * `src/index.ts` 内の `start()` は `#root` 要素の存在で発火を抑制しているため、
 * jsdom 環境でも副作用なく `resolveEngine` / `resolveLatLon` だけを検証できる。
 */

import { describe, it, expect, jest } from "@jest/globals";

import {
    resolveEngine,
    resolveLatLon,
    resolveDateTime,
    resolveAutoSunPosition,
} from "../src/index";

describe("resolveEngine", () => {
    it("?engine=webgpu → 'webgpu'", () => {
        expect(resolveEngine("?engine=webgpu")).toBe("webgpu");
    });

    it("?engine=webgl → 'webgl2'（旧表記の正規化）", () => {
        expect(resolveEngine("?engine=webgl")).toBe("webgl2");
    });

    it("?engine=webgl2 → 'webgl2'", () => {
        expect(resolveEngine("?engine=webgl2")).toBe("webgl2");
    });

    it("engine 未指定 → undefined", () => {
        expect(resolveEngine("")).toBeUndefined();
        expect(resolveEngine("?other=1")).toBeUndefined();
    });

    it("不正値 → undefined", () => {
        expect(resolveEngine("?engine=opengl")).toBeUndefined();
        expect(resolveEngine("?engine=")).toBeUndefined();
    });
});

describe("resolveLatLon", () => {
    it("/@lat,lon パスから lat/lon を取り出す", () => {
        const result = resolveLatLon("http://localhost/@35.681236,139.767125");
        expect(result).not.toBeUndefined();
        expect(result?.lat).toBeCloseTo(35.681236);
        expect(result?.lon).toBeCloseTo(139.767125);
    });

    it("URL に lat/lon 情報が無い場合は undefined を返す", () => {
        expect(resolveLatLon("http://localhost/")).toBeUndefined();
    });

    it("クエリパラメータ ?lat=&lon= も解釈する（parseLatLonFromUrl にデリゲート）", () => {
        const result = resolveLatLon(
            "http://localhost/?lat=35.681236&lon=139.767125",
        );
        expect(result).not.toBeUndefined();
        expect(result?.lat).toBeCloseTo(35.681236);
        expect(result?.lon).toBeCloseTo(139.767125);
    });
});

describe("resolveDateTime (Issue #35)", () => {
    it("?dateTime=<ISO 8601 with Z> → Date を返す", () => {
        const result = resolveDateTime("?dateTime=2025-06-21T03:00:00Z");
        expect(result).toBeInstanceOf(Date);
        expect(result?.toISOString()).toBe("2025-06-21T03:00:00.000Z");
    });

    it("dateTime 未指定 → undefined", () => {
        expect(resolveDateTime("")).toBeUndefined();
        expect(resolveDateTime("?other=1")).toBeUndefined();
    });

    it("Invalid Date 文字列 → undefined（silent ignore、警告のみ）", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            expect(resolveDateTime("?dateTime=not-a-date")).toBeUndefined();
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("不正値ログは制御文字 (CR/LF/ESC) を `?` に置換し 64 文字に制限する（ログ汚染対策）", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            // CR/LF/ESC + 100 文字程度の長文
            const payload = `evil\r\n\x1B[31mFAKE\x1B[0m${"A".repeat(100)}`;
            const search = `?dateTime=${encodeURIComponent(payload)}`;
            expect(resolveDateTime(search)).toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(1);
            const msg = String(warn.mock.calls[0][0]);
            // 制御文字が混入していない
            expect(/[\r\n\x1B\x00-\x1F\x7F]/.test(msg)).toBe(false);
            // 64 文字制限が効いている（プレフィックスを除いた raw 部分は最大 64）
            const rawInLog = msg.replace(
                /^\[jpmap-terrain demo\] invalid dateTime param: /,
                "",
            );
            expect(rawInLog.length).toBeLessThanOrEqual(64);
        } finally {
            warn.mockRestore();
        }
    });
});

describe("resolveAutoSunPosition (Issue #35)", () => {
    it("?autoSunPosition=true → true", () => {
        expect(resolveAutoSunPosition("?autoSunPosition=true")).toBe(true);
    });

    it("?autoSunPosition=false → false", () => {
        expect(resolveAutoSunPosition("?autoSunPosition=false")).toBe(false);
    });

    it("未指定 / 不正値 → undefined", () => {
        expect(resolveAutoSunPosition("")).toBeUndefined();
        expect(resolveAutoSunPosition("?autoSunPosition=")).toBeUndefined();
        expect(resolveAutoSunPosition("?autoSunPosition=1")).toBeUndefined();
        expect(resolveAutoSunPosition("?autoSunPosition=TRUE")).toBeUndefined();
    });
});
