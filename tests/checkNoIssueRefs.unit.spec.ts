import { describe, expect, it } from "vitest";
import { collectAllViolations, findViolations } from "../scripts/checkNoIssueRefs.mjs";

describe("checkNoIssueRefs", () => {
    describe("findViolations", () => {
        it("Issue #NNN 形式の参照を検知する", () => {
            const violations = findViolations("// 補足説明（Issue #123）\n");
            expect(violations).toEqual([{ line: 1, name: "issue-ref", text: "Issue #123" }]);
        });

        it("(#NNN) 形式の参照を検知する", () => {
            const violations = findViolations('describe("foo (#456)", () => {});\n');
            expect(violations).toEqual([
                { line: 1, name: "paren-issue-ref", text: "(#456)" },
            ]);
        });

        it("Phase N 形式の参照を検知する", () => {
            const violations = findViolations("// Phase 2 で対応予定\n");
            expect(violations).toEqual([{ line: 1, name: "phase-ref", text: "Phase 2" }]);
        });

        it("PN-N 形式の参照を検知する", () => {
            const violations = findViolations("// P4-0 slice\n");
            expect(violations).toEqual([{ line: 1, name: "phase-slice-code", text: "P4-0" }]);
        });

        it("Slice N 形式の参照を検知する", () => {
            const violations = findViolations("// Slice 2a で実装済み\n");
            expect(violations).toEqual([{ line: 1, name: "slice-ref", text: "Slice 2a" }]);
        });

        it("複数行にまたがる違反を行番号付きで検知する", () => {
            const content = "line1\nline2 (Issue #1)\nline3\nline4 (#2)\n";
            const violations = findViolations(content);
            expect(violations).toEqual([
                { line: 2, name: "issue-ref", text: "Issue #1" },
                { line: 4, name: "paren-issue-ref", text: "(#2)" },
            ]);
        });

        it("16進カラーコードは誤検知しない", () => {
            const violations = findViolations(
                "既定色 `#ff0000`、壁色 `#000000`（emissive, alpha 0.3）\n",
            );
            expect(violations).toEqual([]);
        });

        it("Markdownの節番号は誤検知しない", () => {
            const violations = findViolations("#### 3.3.5 節の説明\n§3.3.9 を参照\n");
            expect(violations).toEqual([]);
        });

        it("issue/phase参照を含まない通常のコメントは誤検知しない", () => {
            const violations = findViolations(
                "// 山を貫通してはみ出て見える。地形の一般的な起伏より十分小さい値に抑える。\n",
            );
            expect(violations).toEqual([]);
        });
    });

    describe("collectAllViolations", () => {
        it("対象拡張子(.ts/.tsx/.md)のファイルのみをチェックする", () => {
            const files = ["src/a.ts", "spec/b.md", "src/c.png", "src/d.json"];
            const readFile = (file: string): string => {
                if (file === "src/a.ts") return "// Issue #1\n";
                if (file === "spec/b.md") return "Phase 1\n";
                if (file === "src/c.png") return "Issue #999\n"; // 対象拡張子外
                if (file === "src/d.json") return "Issue #999\n"; // 対象拡張子外
                throw new Error("unexpected file");
            };
            const violations = collectAllViolations(files, readFile);
            expect(violations).toEqual([
                { file: "src/a.ts", line: 1, name: "issue-ref", text: "Issue #1" },
                { file: "spec/b.md", line: 1, name: "phase-ref", text: "Phase 1" },
            ]);
        });

        it("チェッカー自身とそのUnit testは除外する", () => {
            const files = [
                "scripts/checkNoIssueRefs.mjs",
                "tests/checkNoIssueRefs.unit.spec.ts",
            ];
            const readFile = () => "Issue #1\n";
            const violations = collectAllViolations(files, readFile);
            expect(violations).toEqual([]);
        });

        it("読み込みに失敗したファイルは読み飛ばす", () => {
            const files = ["src/broken.ts"];
            const readFile = () => {
                throw new Error("ENOENT");
            };
            expect(() => collectAllViolations(files, readFile)).not.toThrow();
            expect(collectAllViolations(files, readFile)).toEqual([]);
        });
    });
});
