/**
 * @jest-environment jsdom
 */
/**
 * `src/demos/portal/index.ts` の純粋関数 unit test (Issue #147)。
 */
import { describe, it, expect } from "@jest/globals";

import { buildPortalHtml } from "../src/demos/portal/index";

describe("buildPortalHtml", () => {
    it("デフォルトで viewer/timelapse へのリンクを含む", () => {
        const html = buildPortalHtml();
        expect(html).toContain('href="viewer.html"');
        expect(html).toContain('href="timelapse.html"');
        expect(html).toContain("<h1>");
    });

    it("引数で渡したデモ一覧をレンダリング", () => {
        const html = buildPortalHtml([
            { title: "T1", description: "D1", href: "x.html" },
        ]);
        expect(html).toContain("T1");
        expect(html).toContain("D1");
        expect(html).toContain('href="x.html"');
    });

    it("HTML 特殊文字をエスケープする", () => {
        const html = buildPortalHtml([
            {
                title: "<script>alert(1)</script>",
                description: "a & b",
                href: "ok.html?x=1&y=2",
            },
        ]);
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain("a &amp; b");
        expect(html).toContain("ok.html?x=1&amp;y=2");
    });
});
