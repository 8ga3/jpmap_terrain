import { describe, expect, it } from "vitest";
import {
    buildStaticRedirectsFile,
    DEMO_NAMES,
    demoAtPathRewrites,
    STATIC_REDIRECTS_FILENAME,
} from "../vite.rewrites";

/**
 * `_redirects`（Netlify / Cloudflare Pages 互換）生成の純粋関数テスト。
 *
 * `demoAtPathRewrites`（dev/preview サーバーのリライト）と同じ
 * 「デモ識別子付きパス → `<name>.html`」の対応が、静的 CDN 配信向けの
 * `_redirects` 生成でも維持されていることを確認する。
 */
describe("buildStaticRedirectsFile", () => {
    it("各デモ名について `/<name>` と `/<name>/*` の2行を出力する", () => {
        const output = buildStaticRedirectsFile(["viewer", "timelapse"]);
        expect(output).toBe(
            [
                "/viewer /viewer.html 200",
                "/viewer/* /viewer.html 200",
                "/timelapse /timelapse.html 200",
                "/timelapse/* /timelapse.html 200",
                "",
            ].join("\n"),
        );
    });

    it("引数省略時は DEMO_NAMES 全件を対象にする", () => {
        const output = buildStaticRedirectsFile();
        for (const name of DEMO_NAMES) {
            expect(output).toContain(`/${name} /${name}.html 200`);
            expect(output).toContain(`/${name}/* /${name}.html 200`);
        }
    });

    it("demoAtPathRewrites と同じデモ名集合から生成される", () => {
        const output = buildStaticRedirectsFile();
        const lines = output.trim().split("\n");
        expect(lines).toHaveLength(demoAtPathRewrites.length * 2);
    });

    it("ファイル名は _redirects である", () => {
        expect(STATIC_REDIRECTS_FILENAME).toBe("_redirects");
    });
});
