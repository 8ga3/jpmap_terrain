import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    CONFIRMATION_PHRASE,
    computeGuardedFingerprint,
    diffGuardedVersions,
    extractGuardedVersions,
    findConfirmationFingerprints,
    formatConfirmationLine,
    hasVisualsConfirmation,
    isSupportedLockfile,
} from "../scripts/checkVisualsGuard.mjs";

type Lockfile = {
    lockfileVersion: number;
    packages: Record<string, { version?: string }>;
};

function lockfile(packages: Record<string, { version?: string }>): Lockfile {
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

    describe("isSupportedLockfile", () => {
        it("packages を持つ lockfile（v2 以降）は判定可能とする", () => {
            expect(isSupportedLockfile(lockfile({}))).toBe(true);
        });

        it("packages を持たない lockfile（v1 形式など）は判定不能とする", () => {
            expect(
                isSupportedLockfile({
                    lockfileVersion: 1,
                    dependencies: { "@babylonjs/core": { version: "9.27.0" } },
                }),
            ).toBe(false);
            expect(isSupportedLockfile({ packages: null })).toBe(false);
            expect(isSupportedLockfile(null)).toBe(false);
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

    describe("computeGuardedFingerprint", () => {
        const base = lockfile({
            "node_modules/@babylonjs/core": { version: "9.27.0" },
            "node_modules/@playwright/test": { version: "1.63.0" },
            "node_modules/vite": { version: "8.0.0" },
        });

        it("12 桁の16進数を返し、同じ版の組なら同じ値になる", () => {
            const fingerprint = computeGuardedFingerprint(base);
            expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
            expect(computeGuardedFingerprint(structuredClone(base))).toBe(
                fingerprint,
            );
        });

        it("対象パッケージの版が変わると値が変わる", () => {
            const head = structuredClone(base);
            head.packages["node_modules/@babylonjs/core"].version = "9.28.0";
            expect(computeGuardedFingerprint(head)).not.toBe(
                computeGuardedFingerprint(base),
            );
        });

        it("対象外パッケージの版が変わっても値は変わらない", () => {
            const head = structuredClone(base);
            head.packages["node_modules/vite"].version = "8.1.0";
            expect(computeGuardedFingerprint(head)).toBe(
                computeGuardedFingerprint(base),
            );
        });
    });

    describe("hasVisualsConfirmation", () => {
        const fingerprint = "0123456789ab";
        const confirmation = formatConfirmationLine(fingerprint);
        const sentence = confirmation.replace("- [x] ", "");

        it("指紋が一致するチェック済みの実施確認行があれば true", () => {
            expect(
                hasVisualsConfirmation(
                    `## 確認事項\n\n${confirmation}\n`,
                    fingerprint,
                ),
            ).toBe(true);
        });

        it("指紋が異なる（確認後に対象依存が再更新された）場合は false", () => {
            const body = formatConfirmationLine("ba9876543210");
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(false);
            expect(findConfirmationFingerprints(body)).toEqual([
                "ba9876543210",
            ]);
        });

        it("指紋の無い行は実施確認とみなさない", () => {
            const body = confirmation.replace(
                `（対象依存: ${fingerprint}）`,
                "",
            );
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(false);
        });

        it("大文字の X や * 箇条書き、CRLF 改行でも判定する", () => {
            const body = `概要\r\n${confirmation.replace("- [x]", "* [X]")}  \r\n`;
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(true);
        });

        it("否定・未完了の記録は実施確認とみなさない", () => {
            const suffix = `（対象依存: ${fingerprint}）`;
            for (const line of [
                "- [x] npm run test:visuals は実行していない",
                `- [x] \`npm run test:visuals\` は実行していない${suffix}`,
                `- [x] ローカルで \`npm run test:visuals\` を実行した${suffix}`,
                `- [x] ${CONFIRMATION_PHRASE}わけではない${suffix}`,
                `- [x] ${CONFIRMATION_PHRASE}${suffix}`,
                `- [x] 実行していないが、${sentence}`,
                `- [x] 未実施。${sentence}`,
                `${confirmation}わけではない`,
            ]) {
                expect(hasVisualsConfirmation(`${line}\n`, fingerprint)).toBe(
                    false,
                );
            }
        });

        it("未チェックの行は実施確認とみなさない", () => {
            const body = confirmation.replace("[x]", "[ ]");
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(false);
        });

        it("基準画像を更新するコマンドの行は実施確認とみなさない", () => {
            for (const command of [
                "npm run test:visuals:update",
                "npm run test:visuals -- --update-snapshots",
                "npm run test:visuals -- --update-snapshots=all",
                "npm run test:visuals -- -u",
            ]) {
                const line = confirmation.replace(
                    "npm run test:visuals",
                    command,
                );
                expect(hasVisualsConfirmation(`${line}\n`, fingerprint)).toBe(
                    false,
                );
            }
        });

        it("更新オプション付きの行があっても、別の実施確認行があれば true", () => {
            const body = `- [x] \`npm run test:visuals -- -u\` で基準を作成した\n${confirmation}\n`;
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(true);
        });

        it("HTML コメント内の確認行は実施確認とみなさない", () => {
            for (const body of [
                `<!-- ${confirmation} -->`,
                `<!--\n${confirmation}\n-->`,
                `<!-- 以下は記入例\n${confirmation}`,
            ]) {
                expect(hasVisualsConfirmation(body, fingerprint)).toBe(false);
            }
        });

        it("fenced code block 内の確認行は実施確認とみなさない", () => {
            for (const body of [
                `\`\`\`markdown\n${confirmation}\n\`\`\``,
                `~~~\n${confirmation}\n~~~`,
                // 内側の短いフェンスではブロックは閉じない。
                `\`\`\`\`\n\`\`\`\n${confirmation}\n\`\`\`\`\n`,
                // 閉じられていないブロックは本文末まで続く。
                `\`\`\`\n${confirmation}`,
            ]) {
                expect(hasVisualsConfirmation(body, fingerprint)).toBe(false);
            }
        });

        it("インデントコードブロックや引用内の確認行は実施確認とみなさない", () => {
            expect(
                hasVisualsConfirmation(`    ${confirmation}`, fingerprint),
            ).toBe(false);
            expect(
                hasVisualsConfirmation(`> ${confirmation}`, fingerprint),
            ).toBe(false);
        });

        it("閉じたコメント・コードブロックの後にある確認行は実施確認とみなす", () => {
            const body = `<!-- メモ -->\n\`\`\`\nnpm run test:visuals\n\`\`\`\n<!--\n複数行\n-->\n${confirmation}\n`;
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(true);
        });

        it("チェックボックスでない文中の言及は実施確認とみなさない", () => {
            const body = `マージ前に ${sentence} とすること\n`;
            expect(hasVisualsConfirmation(body, fingerprint)).toBe(false);
        });

        it("本文が空・未設定の場合は false", () => {
            expect(hasVisualsConfirmation("", fingerprint)).toBe(false);
            expect(hasVisualsConfirmation(undefined, fingerprint)).toBe(false);
        });
    });

    // テンプレートの文言を変えたのにガードが素通り（常に失敗）しないよう、実ファイルとの整合も検証する。
    it("PR テンプレートの実施確認行は、チェックして指紋を記入すると実施確認とみなされる", () => {
        const fingerprint = "0123456789ab";
        const template = readFileSync(
            new URL("../.github/pull_request_template.md", import.meta.url),
            "utf8",
        );
        const checked = template.replaceAll("- [ ]", "- [x]");
        expect(hasVisualsConfirmation(template, fingerprint)).toBe(false);
        // 指紋のプレースホルダのままでは実施確認とみなさない。
        expect(findConfirmationFingerprints(checked)).toEqual([]);
        expect(
            hasVisualsConfirmation(
                checked.replace(
                    "（対象依存: visuals-guard が出力する値）",
                    `（対象依存: ${fingerprint}）`,
                ),
                fingerprint,
            ),
        ).toBe(true);
    });
});
