#!/usr/bin/env node
/**
 * `.tool-versions` で固定した Node バージョンと、実行中の Node バージョンが
 * 一致しているかを検知するスクリプト。
 *
 * `package-lock.json` の生成結果は npm のバージョン（＝Node に同梱される版）に
 * 依存する。npm は optional な依存の peerDependencies をどこまで lock に
 * 記録するかがバージョンごとに異なるため、CI と異なる npm で `npm install` すると
 * CI 側の `npm ci` が `Missing: <pkg> from lock file` で失敗する。
 *
 * ドキュメントに手順を書くだけでは見落とされるため、機械的な検知で補強する
 * （`npm run lint` と、`package-lock.json` をステージした際の pre-commit フックから実行される）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_VERSIONS_PATH = resolve(REPO_ROOT, ".tool-versions");

/**
 * `.tool-versions` の内容から指定ツールのバージョンを取り出す。
 * 記述が無い場合は null を返す（呼び出し側でエラーにする）。
 */
export function parseToolVersion(content, tool) {
    for (const rawLine of content.split(/\r?\n/)) {
        // asdf の `.tool-versions` は `#` 以降をコメントとして扱う。
        const line = rawLine.split("#")[0].trim();
        if (line === "") continue;
        const [name, ...versions] = line.split(/\s+/);
        if (name !== tool) continue;
        // 複数バージョンが列挙され得る形式のため、先頭を採用する。
        return versions[0] ?? null;
    }
    return null;
}

/**
 * `v24.18.0` 形式の実行中バージョンと `.tool-versions` の指定を比較する。
 * パッチ版まで完全一致することを求める（npm の同梱版が変わるため）。
 */
export function isSatisfied(expected, actualProcessVersion) {
    return actualProcessVersion.replace(/^v/, "") === expected;
}

function main() {
    let content;
    try {
        content = readFileSync(TOOL_VERSIONS_PATH, "utf8");
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[check-tool-versions] failed to read .tool-versions: ${reason}`);
        process.exitCode = 1;
        return;
    }

    const expected = parseToolVersion(content, "nodejs");
    if (expected === null) {
        console.error("[check-tool-versions] no 'nodejs' entry found in .tool-versions");
        process.exitCode = 1;
        return;
    }

    if (!isSatisfied(expected, process.version)) {
        console.error(
            `[check-tool-versions] node version mismatch: expected ${expected} (.tool-versions) but running ${process.version.replace(/^v/, "")}`,
        );
        console.error(
            "[check-tool-versions] package-lock.json generated with a different npm breaks 'npm ci' on CI. Run 'asdf install' and retry.",
        );
        process.exitCode = 1;
    }
}

// このファイルが直接実行された場合のみチェックを走らせる（Unit testからのimport時は実行しない）。
if (process.argv[1] && process.argv[1].endsWith("checkToolVersions.mjs")) {
    main();
}
