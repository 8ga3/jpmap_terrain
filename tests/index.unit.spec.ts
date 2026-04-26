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

import { describe, it, expect } from "@jest/globals";

import { resolveEngine, resolveLatLon } from "../src/index";

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
