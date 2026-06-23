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
        expect(html).toContain('href="viewer"');
        expect(html).toContain('href="timelapse"');
        // ポリゴンデモ (Issue #170) もポータル一覧に並ぶ。
        expect(html).toContain('href="polygon"');
        // 距離計測デモ (Issue #186) もポータル一覧に並ぶ。
        expect(html).toContain('href="distance"');
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

    // 出典表記 (Issue #417)
    it("フッターに出典 3 項目を表示する", () => {
        const html = buildPortalHtml();
        expect(html).toContain('<section class="attribution"');
        expect(html).toContain("出典");
        expect(html).toContain("国土地理院発行 2.5万分1地形図");
        expect(html).toContain("GEBCO Digital Atlas");
        expect(html).toContain("海上保安庁許可第292502号");
        expect(html).toContain("Vector Map Level 0 (VMAP0)");
        // 既存の Source リンクも維持される。
        expect(html).toContain(
            'href="https://github.com/8ga3/jpmap_terrain"',
        );
    });

    it("出典中の URL をリンク化する", () => {
        const html = buildPortalHtml();
        expect(html).toContain(
            '<a href="https://www.gebco.net" target="_blank" rel="noopener noreferrer">https://www.gebco.net</a>',
        );
    });

    it("URL 末尾の括弧・句読点（半角/全角）はリンクへ含めない", () => {
        const html = buildPortalHtml(undefined, [
            "a (https://example.com/a).",
            "b https://example.com/b、",
            "c https://example.com/c。",
            "d https://example.com/d,",
        ]);
        // 半角閉じ括弧 + ピリオドはリンク外へ戻る。
        expect(html).toContain(
            '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>).',
        );
        // 全角読点・句点もリンク外へ戻る。
        expect(html).toContain(
            '<a href="https://example.com/b" target="_blank" rel="noopener noreferrer">https://example.com/b</a>、',
        );
        expect(html).toContain(
            '<a href="https://example.com/c" target="_blank" rel="noopener noreferrer">https://example.com/c</a>。',
        );
        // 半角カンマもリンク外へ戻る。
        expect(html).toContain(
            '<a href="https://example.com/d" target="_blank" rel="noopener noreferrer">https://example.com/d</a>,',
        );
        // href に句読点が混入していないこと。
        expect(html).not.toContain('href="https://example.com/a).');
        expect(html).not.toContain('href="https://example.com/d,');
    });

    it("出典文言の HTML 特殊文字をエスケープする", () => {
        const html = buildPortalHtml(undefined, [
            "<b>x</b> & y http://example.com/?a=1&b=2",
        ]);
        expect(html).not.toContain("<b>x</b>");
        expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
        expect(html).toContain("&amp; y");
        // URL はリンク化され、クエリの & はエスケープ済み。
        expect(html).toContain(
            '<a href="http://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">',
        );
    });
});
