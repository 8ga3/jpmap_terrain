import { describe, expect, it } from "vitest";
import {
    AGENT_PAIRS,
    MAX_MIRROR_BODY_LINES,
    bodyLines,
    checkLinks,
    checkMirror,
    parseFrontMatter,
    relativeLinks,
} from "../scripts/checkAgentDocs.mjs";

const canonicalContent = [
    "---",
    "title: Coder Agent (Local)",
    "description: 実装する。",
    "role: coder",
    "model: opus",
    "---",
    "# 目的",
    "最小差分で実装する。",
    "",
].join("\n");

const mirrorContent = [
    "---",
    "name: coder",
    "description: 実装する。",
    "model: opus",
    "---",
    "# Coder Agent (Local)",
    "",
    "定義は [.github/agents/30_coder.md](../../.github/agents/30_coder.md) を正本とする。",
    "",
].join("\n");

const pair = { name: "coder", canonical: "30_coder.md" };

describe("checkAgentDocs", () => {
    describe("parseFrontMatter", () => {
        it("frontmatter の key-value を取り出す", () => {
            expect(parseFrontMatter(mirrorContent)).toEqual({
                name: "coder",
                description: "実装する。",
                model: "opus",
            });
        });

        it("frontmatter が無い場合は null を返す", () => {
            expect(parseFrontMatter("# 見出しのみ\n")).toBeNull();
        });
    });

    describe("bodyLines", () => {
        it("frontmatter と空行を除いた本文行のみを返す", () => {
            expect(bodyLines(mirrorContent)).toHaveLength(2);
        });

        it("本文が無い場合は空配列を返す", () => {
            expect(bodyLines("---\nname: x\n---\n")).toEqual([]);
        });
    });

    describe("relativeLinks", () => {
        it("相対リンクのみを抽出する", () => {
            const content = "[a](./a.md) [b](https://example.com) [c](#anchor) [d](../d.md#section)";
            expect(relativeLinks(content)).toEqual(["./a.md", "../d.md"]);
        });

        it("ルート起点の絶対パスは対象外とする", () => {
            expect(relativeLinks("[a](/etc/passwd) [b](./b.md)")).toEqual(["./b.md"]);
        });

        it("スキーム付きリンクは対象外とする", () => {
            const content = "[a](file:///tmp/x.md) [b](mailto:a@example.com) [c](vscode://x) [d](./d.md)";
            expect(relativeLinks(content)).toEqual(["./d.md"]);
        });
    });

    describe("checkMirror", () => {
        it("正本と整合していれば問題を報告しない", () => {
            expect(checkMirror({ ...pair, mirrorContent, canonicalContent })).toEqual([]);
        });

        it("正本へのリンクが無い場合は問題を報告する", () => {
            const broken = mirrorContent.replace("30_coder.md](../../.github/agents/30_coder.md", "x](x");
            const problems = checkMirror({ ...pair, mirrorContent: broken, canonicalContent });
            expect(problems.some((p) => p.includes("does not reference its canonical file"))).toBe(true);
        });

        it("model が正本と食い違う場合は問題を報告する", () => {
            const drifted = mirrorContent.replace("model: opus", "model: sonnet");
            const problems = checkMirror({ ...pair, mirrorContent: drifted, canonicalContent });
            expect(problems.some((p) => p.includes("'model' differs"))).toBe(true);
        });

        it("description が正本と食い違う場合は問題を報告する", () => {
            const drifted = mirrorContent.replace("description: 実装する。", "description: 別の説明。");
            const problems = checkMirror({ ...pair, mirrorContent: drifted, canonicalContent });
            expect(problems.some((p) => p.includes("'description' differs"))).toBe(true);
        });

        it("本文が長すぎる場合は複製とみなして問題を報告する", () => {
            const fat = mirrorContent + Array.from({ length: MAX_MIRROR_BODY_LINES }, (_, i) => `- rule ${i}`).join("\n");
            const problems = checkMirror({ ...pair, mirrorContent: fat, canonicalContent });
            expect(problems.some((p) => p.includes("max"))).toBe(true);
        });

        it("frontmatter が無い場合は問題を報告する", () => {
            const problems = checkMirror({ ...pair, mirrorContent: "# 見出し\n", canonicalContent });
            expect(problems).toEqual([".claude/agents/coder.md has no front matter"]);
        });
    });

    describe("checkLinks", () => {
        it("解決できるリンクは問題を報告しない", () => {
            expect(checkLinks("docs/a.md", "[b](./b.md)", () => true)).toEqual([]);
        });

        it("解決できないリンクは問題を報告する", () => {
            const problems = checkLinks("docs/a.md", "[b](./b.md)", () => false);
            expect(problems).toEqual(["docs/a.md has a broken relative link: ./b.md"]);
        });

        it("リポジトリルート外へ抜けるリンクは存在確認をせず問題として報告する", () => {
            let called = false;
            const problems = checkLinks("docs/a.md", "[b](../../outside.md)", () => {
                called = true;
                return true;
            });
            expect(problems).toEqual([
                "docs/a.md has a link escaping the repository root: ../../outside.md",
            ]);
            expect(called).toBe(false);
        });

        it("ルート起点の絶対パスは検査対象外とする", () => {
            expect(checkLinks("docs/a.md", "[b](/etc/passwd)", () => false)).toEqual([]);
        });
    });

    it("エージェントの対応表が6役割を網羅している", () => {
        expect(AGENT_PAIRS.map((p) => p.name)).toEqual([
            "planner",
            "architect",
            "coder",
            "tester",
            "reviewer",
            "security",
        ]);
    });
});
