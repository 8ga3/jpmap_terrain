#!/usr/bin/env node
/**
 * 描画結果に影響し得る依存（`@babylonjs/*` / Playwright）を更新する PR で、
 * ローカルでの Visual Regression Test（`npm run test:visuals`）の実施記録を
 * 強制するスクリプト。
 *
 * スナップショット画像は地図データの利用規約違反に当たる可能性があるためコミットしておらず、
 * 公開リポジトリの CI では比較基準を持てない（差分画像を artifact に上げることもできない）。
 * そのため比較自体はローカル（macOS）で行い、CI では「実施を確認した」という
 * PR 本文のチェックボックスの有無のみを機械的に検証する。
 *
 * base と head の `package-lock.json` を比較し、対象パッケージの版に差分がある場合に限り
 * チェック済みのチェックボックスを要求する（`.github/workflows/visuals-guard.yml` から実行される）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD_LOCKFILE_PATH = resolve(REPO_ROOT, "package-lock.json");

/**
 * lockfile の `packages` キーのうち、描画結果に影響し得るパッケージを表すもの。
 * ネストした `node_modules` 配下に重複して入った版も対象にするため、末尾の
 * `node_modules/<name>` で判定する。
 * `playwright` / `playwright-core` は `@playwright/test` が依存する本体で、
 * 同梱ブラウザ（chromium-headless-shell）の版を決める。
 */
const GUARDED_PACKAGE_KEY =
    /(?:^|\/)node_modules\/(?:@babylonjs\/[^/]+|@playwright\/test|playwright|playwright-core)$/;

/**
 * PR 本文で実施確認とみなすチェックボックス。
 * PR テンプレートに存在する `npm run test:visuals:update` の行を誤って
 * 実施確認と扱わないよう、`test:visuals` の直後に `:` が続くものは除外する。
 */
const CONFIRMATION_LINE = /^\s*[-*]\s+\[[xX]\]\s+.*npm run test:visuals(?![:\w-])/;

/**
 * 基準画像を更新するオプション。`npm run test:visuals -- --update-snapshots` は
 * 比較ではなく基準の上書きになり差分を検知できないため、実施確認とみなさない。
 */
const UPDATE_SNAPSHOTS_OPTION = /--update-snapshots\b|(?:^|\s)-u(?![\w-])/;

/** PR 本文に追記してもらう行（エラーメッセージとテンプレートで共有する文言）。 */
export const CONFIRMATION_TEMPLATE =
    "- [x] ローカル（macOS）で `npm run test:visuals` を実行し、全スクリーンショットの一致を確認した";

/**
 * lockfile（v2 以降の `packages` 形式）から対象パッケージの版を取り出す。
 * `packages` を持たない（v1 形式や空の）lockfile は対象なしとして扱う。
 */
export function extractGuardedVersions(lockfile) {
    const versions = new Map();
    const packages = lockfile?.packages;
    if (packages === null || typeof packages !== "object") return versions;
    for (const [key, entry] of Object.entries(packages)) {
        if (!GUARDED_PACKAGE_KEY.test(key)) continue;
        versions.set(key, typeof entry?.version === "string" ? entry.version : null);
    }
    return versions;
}

/**
 * base と head の lockfile を比較し、対象パッケージの追加・削除・版変更を列挙する。
 * 追加・削除の場合、存在しない側の版は null とする。
 */
export function diffGuardedVersions(baseLockfile, headLockfile) {
    const base = extractGuardedVersions(baseLockfile);
    const head = extractGuardedVersions(headLockfile);
    const keys = [...new Set([...base.keys(), ...head.keys()])].sort();
    const changes = [];
    for (const key of keys) {
        const before = base.get(key) ?? null;
        const after = head.get(key) ?? null;
        if (before !== after) changes.push({ key, before, after });
    }
    return changes;
}

/** PR 本文にチェック済みの実施確認チェックボックスがあるかを判定する。 */
export function hasVisualsConfirmation(body) {
    if (typeof body !== "string") return false;
    return body
        .split(/\r?\n/)
        .some(
            (line) =>
                CONFIRMATION_LINE.test(line) &&
                !UPDATE_SNAPSHOTS_OPTION.test(line),
        );
}

function formatChange({ key, before, after }) {
    return `${key}: ${before ?? "(none)"} -> ${after ?? "(none)"}`;
}

function readLockfile(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
    const baseLockfilePath = process.env.BASE_LOCKFILE;
    if (!baseLockfilePath) {
        console.error("[check-visuals-guard] BASE_LOCKFILE is not set");
        process.exitCode = 1;
        return;
    }

    let baseLockfile;
    let headLockfile;
    try {
        baseLockfile = readLockfile(baseLockfilePath);
        headLockfile = readLockfile(HEAD_LOCKFILE_PATH);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[check-visuals-guard] failed to read package-lock.json: ${reason}`);
        process.exitCode = 1;
        return;
    }

    const changes = diffGuardedVersions(baseLockfile, headLockfile);
    if (changes.length === 0) {
        console.log("[check-visuals-guard] no rendering-related dependency changes");
        return;
    }

    console.log("[check-visuals-guard] rendering-related dependency changes:");
    for (const change of changes) {
        console.log(`[check-visuals-guard]   ${formatChange(change)}`);
    }

    if (hasVisualsConfirmation(process.env.PR_BODY)) {
        console.log("[check-visuals-guard] local 'npm run test:visuals' confirmation found in PR body");
        return;
    }

    console.error(
        "[check-visuals-guard] run 'npm run test:visuals' locally (macOS) and add the following checked line to the PR body:",
    );
    // PR 本文へそのまま貼り付けられるよう、ログではなく生の出力としてプレフィックスを付けずに書き出す。
    process.stderr.write(`${CONFIRMATION_TEMPLATE}\n`);
    process.exitCode = 1;
}

// このファイルが直接実行された場合のみチェックを走らせる（Unit testからのimport時は実行しない）。
if (process.argv[1] && process.argv[1].endsWith("checkVisualsGuard.mjs")) {
    main();
}
