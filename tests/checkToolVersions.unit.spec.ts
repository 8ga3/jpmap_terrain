import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isSatisfied, parseToolVersion } from "../scripts/checkToolVersions.mjs";

describe("checkToolVersions", () => {
    describe("parseToolVersion", () => {
        it("指定ツールのバージョンを取り出す", () => {
            expect(parseToolVersion("nodejs 24.18.0\n", "nodejs")).toBe("24.18.0");
        });

        it("複数ツールが列挙されていても対象ツールのみを取り出す", () => {
            const content = "pnpm 10.27.0\nnodejs 24.18.0\n";
            expect(parseToolVersion(content, "nodejs")).toBe("24.18.0");
        });

        it("コメント行と行末コメントを無視する", () => {
            const content = "# nodejs 22.0.0\nnodejs 24.18.0 # CI と揃える\n";
            expect(parseToolVersion(content, "nodejs")).toBe("24.18.0");
        });

        it("複数バージョンが列挙されている場合は先頭を採用する", () => {
            expect(parseToolVersion("nodejs 24.18.0 22.21.1\n", "nodejs")).toBe("24.18.0");
        });

        it("対象ツールの記述が無い場合は null を返す", () => {
            expect(parseToolVersion("pnpm 10.27.0\n", "nodejs")).toBeNull();
        });
    });

    describe("isSatisfied", () => {
        it("先頭の v の有無に関わらず一致を判定する", () => {
            expect(isSatisfied("24.18.0", "v24.18.0")).toBe(true);
            expect(isSatisfied("24.18.0", "24.18.0")).toBe(true);
        });

        it("パッチ版が異なる場合は不一致とする（npm の同梱版が変わるため）", () => {
            expect(isSatisfied("24.18.0", "v24.12.0")).toBe(false);
        });
    });

    // .tool-versions を書き換えたのにテストが素通りしないよう、実ファイルとの整合も検証する。
    it("リポジトリの .tool-versions に nodejs の指定が存在する", () => {
        const content = readFileSync(new URL("../.tool-versions", import.meta.url), "utf8");
        expect(parseToolVersion(content, "nodejs")).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
