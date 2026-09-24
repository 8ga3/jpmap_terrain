import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    CONFIRMATION_TEMPLATE,
    diffGuardedVersions,
    extractGuardedVersions,
    hasVisualsConfirmation,
} from "../scripts/checkVisualsGuard.mjs";

function lockfile(packages: Record<string, { version?: string }>) {
    return { lockfileVersion: 3, packages: { "": {}, ...packages } };
}

describe("checkVisualsGuard", () => {
    describe("extractGuardedVersions", () => {
        it("@babylonjs/* と Playwright 関連パッケージのみを取り出す", () => {
            const versions = extractGuardedVersions(
                lockfile({
                    "node_modules/@babylonjs/core": { version: "9.27.0" },
                    "node_modules/@babylonjs/loaders": { version: "9.27.0" },
                    "node_modules/@playwright/test": { version: "1.63.0" },
                    "node_modules/playwright": { version: "1.63.0" },
                    "node_modules/playwright-core": { version: "1.63.0" },
                    "node_modules/vite": { version: "8.0.0" },
                    "node_modules/@biomejs/biome": { version: "2.5.14" },
                }),
            );
            expect([...versions.keys()].sort()).toEqual([
                "node_modules/@babylonjs/core",
                "node_modules/@babylonjs/loaders",
                "node_modules/@playwright/test",
                "node_modules/playwright",
                "node_modules/playwright-core",
            ]);
        });

        it("ネストした node_modules 配下の版も対象にする", () => {
            const versions = extractGuardedVersions(
                lockfile({
                    "node_modules/foo/node_modules/@babylonjs/core": {
                        version: "9.25.0",
                    },
                }),
            );
            expect(
                versions.get("node_modules/foo/node_modules/@babylonjs/core"),
            ).toBe("9.25.0");
        });

        it("名前が前方一致するだけの別パッケージは対象にしない", () => {
            const versions = extractGuardedVersions(
                lockfile({
                    "node_modules/playwright-extra": { version: "1.0.0" },
                    "node_modules/@babylonjs/core/node_modules/x": {
                        version: "1.0.0",
                    },
                }),
            );
            expect(versions.size).toBe(0);
        });

        it("packages を持たない lockfile は対象なしとして扱う", () => {
            expect(extractGuardedVersions({ lockfileVersion: 1 }).size).toBe(0);
            expect(extractGuardedVersions(null).size).toBe(0);
        });
    });

    describe("diffGuardedVersions", () => {
        it("対象パッケージの版変更を列挙する", () => {
            const base = lockfile({
                "node_modules/@babylonjs/core": { version: "9.25.0" },
                "node_modules/@playwright/test": { version: "1.62.1" },
            });
            const head = lockfile({
                "node_modules/@babylonjs/core": { version: "9.27.0" },
                "node_modules/@playwright/test": { version: "1.62.1" },
            });
            expect(diffGuardedVersions(base, head)).toEqual([
                {
                    key: "node_modules/@babylonjs/core",
                    before: "9.25.0",
                    after: "9.27.0",
                },
            ]);
        });

        it("対象パッケージの追加・削除を null との差分として列挙する", () => {
            const base = lockfile({
                "node_modules/@babylonjs/gui": { version: "9.25.0" },
            });
            const head = lockfile({
                "node_modules/@babylonjs/materials": { version: "9.27.0" },
            });
            expect(diffGuardedVersions(base, head)).toEqual([
                {
                    key: "node_modules/@babylonjs/gui",
                    before: "9.25.0",
                    after: null,
                },
                {
                    key: "node_modules/@babylonjs/materials",
                    before: null,
                    after: "9.27.0",
                },
            ]);
        });

        it("対象外パッケージのみの変更では差分なしとする", () => {
            const base = lockfile({
                "node_modules/@babylonjs/core": { version: "9.27.0" },
                "node_modules/vite": { version: "8.0.0" },
            });
            const head = lockfile({
                "node_modules/@babylonjs/core": { version: "9.27.0" },
                "node_modules/vite": { version: "8.1.0" },
            });
            expect(diffGuardedVersions(base, head)).toEqual([]);
        });
    });

    describe("hasVisualsConfirmation", () => {
        it("チェック済みの実施確認行があれば true", () => {
            expect(
                hasVisualsConfirmation(
                    `## 確認事項\n\n${CONFIRMATION_TEMPLATE}\n`,
                ),
            ).toBe(true);
        });

        it("大文字の X や * 箇条書き、CRLF 改行でも判定する", () => {
            const body =
                "概要\r\n* [X] ローカルで `npm run test:visuals` を実行した\r\n";
            expect(hasVisualsConfirmation(body)).toBe(true);
        });

        it("未チェックの行は実施確認とみなさない", () => {
            const body = CONFIRMATION_TEMPLATE.replace("[x]", "[ ]");
            expect(hasVisualsConfirmation(body)).toBe(false);
        });

        it("test:visuals:update の行は実施確認とみなさない", () => {
            const body =
                "- [x] `npm run test:visuals:update` は毎回実行していない\n";
            expect(hasVisualsConfirmation(body)).toBe(false);
        });

        it("基準画像を更新するオプション付きの行は実施確認とみなさない", () => {
            for (const command of [
                "npm run test:visuals -- --update-snapshots",
                "npm run test:visuals -- --update-snapshots=all",
                "npm run test:visuals -- -u",
            ]) {
                expect(
                    hasVisualsConfirmation(`- [x] \`${command}\` を実行した\n`),
                ).toBe(false);
            }
        });

        it("更新オプション付きの行があっても、別の実施確認行があれば true", () => {
            const body = `- [x] \`npm run test:visuals -- -u\` で基準を作成した\n${CONFIRMATION_TEMPLATE}\n`;
            expect(hasVisualsConfirmation(body)).toBe(true);
        });

        it("チェックボックスでない文中の言及は実施確認とみなさない", () => {
            const body = "マージ前に npm run test:visuals を実行すること\n";
            expect(hasVisualsConfirmation(body)).toBe(false);
        });

        it("本文が空・未設定の場合は false", () => {
            expect(hasVisualsConfirmation("")).toBe(false);
            expect(hasVisualsConfirmation(undefined)).toBe(false);
        });
    });

    // テンプレートの文言を変えたのにガードが素通り（常に失敗）しないよう、実ファイルとの整合も検証する。
    it("PR テンプレートの実施確認行をチェックすると実施確認とみなされる", () => {
        const template = readFileSync(
            new URL("../.github/pull_request_template.md", import.meta.url),
            "utf8",
        );
        expect(hasVisualsConfirmation(template)).toBe(false);
        expect(
            hasVisualsConfirmation(template.replaceAll("- [ ]", "- [x]")),
        ).toBe(true);
    });
});
