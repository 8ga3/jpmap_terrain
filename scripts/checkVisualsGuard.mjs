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
 * 実施記録は head 側の対象パッケージの版の指紋に紐付け、確認後の依存の再更新を検知する。
 */
import { createHash } from "node:crypto";
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

/** 実施確認とみなす記録の中核となる肯定形の文言。 */
export const CONFIRMATION_PHRASE =
    "`npm run test:visuals` を実行し、全スクリーンショットの一致を確認した";

/** エラーメッセージで PR 本文への追記を求める行の本文（チェックボックス記号と指紋を除く）。 */
const CONFIRMATION_SENTENCE = `ローカル（macOS）で ${CONFIRMATION_PHRASE}`;

/**
 * PR テンプレートの確認事項にある行の本文。適用条件を前置きしている。
 * テンプレート側の文言を変えた場合は、Unit test のテンプレート整合チェックで検知される。
 */
const TEMPLATE_CONFIRMATION_SENTENCE =
    "`package-lock.json` 上で `@babylonjs/*` / `@playwright/test` / `playwright` / `playwright-core` の版が変わった場合、" +
    CONFIRMATION_SENTENCE;

/**
 * 実施確認とみなすチェック済み行の本文。コマンド名や末尾の文言だけで判定すると、
 * 否定を前置きした行や `npm run test:visuals:update`（基準の上書き）を書いた行まで
 * 通過してしまうため、PR テンプレートとエラーメッセージの正規の行との完全一致に限定する。
 */
const ACCEPTED_CONFIRMATION_SENTENCES = new Set([
    CONFIRMATION_SENTENCE,
    TEMPLATE_CONFIRMATION_SENTENCE,
]);

/**
 * 最上位の task list item として描画されるチェック済み行。
 * 行頭にインデントがある行は、親項目の下の入れ子のタスクやインデントコードブロックに
 * なり得るため受理しない（PR テンプレートとエラーメッセージの正規の行はいずれもインデントなし）。
 */
const CHECKED_CHECKBOX = /^[-*+][ \t]+\[[xX]\][ \t]+(.*?)\s*$/;

/**
 * fenced code block の開始行（CommonMark: 3 個以上の ` または ~、インデント 3 スペースまで）。
 * 確認行を受理する判定ではなく除外する判定に使うため、インデント付きのフェンスも広く拾う。
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** 確認行の末尾に付ける、実施時点の対象依存の版を表す指紋。 */
const FINGERPRINT_SUFFIX = /^(.*)（対象依存: ([0-9a-f]{12})）$/;

const FINGERPRINT_LENGTH = 12;
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
 * 対象パッケージの版を判定できる lockfile（v2 以降の `packages` 形式）かを判定する。
 * v1 形式は `packages` を持たず対象依存の更新を検出できないため、ガードを素通りさせないよう
 * 呼び出し側で失敗として扱う。
 */
export function isSupportedLockfile(lockfile) {
    const packages = lockfile?.packages;
    return packages !== null && typeof packages === "object";
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

/**
 * lockfile 上の対象パッケージの版の組から指紋を計算する。
 * 実施記録をこの指紋に紐付けることで、確認後に対象依存の版を再更新した場合は
 * 記録が無効になり、対象依存と無関係なコミットの追加やリベースでは無効にならない。
 */
export function computeGuardedFingerprint(lockfile) {
    const versions = extractGuardedVersions(lockfile);
    const entries = [...versions.keys()]
        .sort()
        .map((key) => `${key}@${versions.get(key) ?? ""}`);
    return createHash("sha256")
        .update(entries.join("\n"))
        .digest("hex")
        .slice(0, FINGERPRINT_LENGTH);
}

/** PR 本文に追記してもらう行（エラーメッセージで出力する）。 */
export function formatConfirmationLine(fingerprint) {
    return `- [x] ${CONFIRMATION_SENTENCE}（対象依存: ${fingerprint}）`;
}

/**
 * PR 本文のうち、Markdown として描画される行を返す。
 * HTML コメントや fenced code block 内に正規の確認行を書いても GitHub 上には
 * チェックボックスとして表示されず、実施記録なしでガードを通過できてしまうため除外する。
 * 閉じられていないコメント・コードブロックは、描画上も本文末まで続くため末尾まで除外する。
 * コメントの開始・終了を含む行は、行全体が HTML ブロックとして扱われるため行ごと除外する。
 */
export function extractRenderedLines(body) {
    const lines = [];
    let fence = null;
    let inComment = false;
    for (const line of body.split(/\r?\n/)) {
        if (fence !== null) {
            const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
            if (close.test(line)) fence = null;
            continue;
        }
        if (inComment) {
            if (line.includes("-->")) inComment = false;
            continue;
        }
        const open = FENCE_OPEN.exec(line);
        if (open) {
            fence = { char: open[1][0] === "`" ? "`" : "~", length: open[1].length };
            continue;
        }
        const commentStart = line.indexOf("<!--");
        if (commentStart !== -1) {
            inComment = !line.includes("-->", commentStart + 4);
            continue;
        }
        lines.push(line);
    }
    return lines;
}

/** PR 本文のチェック済みの実施確認行から、記録された指紋を列挙する。 */
export function findConfirmationFingerprints(body) {
    if (typeof body !== "string") return [];
    const fingerprints = [];
    for (const line of extractRenderedLines(body)) {
        const text = CHECKED_CHECKBOX.exec(line)?.[1];
        if (text === undefined) continue;
        const match = FINGERPRINT_SUFFIX.exec(text);
        if (match && ACCEPTED_CONFIRMATION_SENTENCES.has(match[1])) {
            fingerprints.push(match[2]);
        }
    }
    return fingerprints;
}

/** PR 本文に、指定した指紋に紐付くチェック済みの実施確認行があるかを判定する。 */
export function hasVisualsConfirmation(body, fingerprint) {
    return findConfirmationFingerprints(body).includes(fingerprint);
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

    for (const [side, lockfile] of [
        ["base", baseLockfile],
        ["head", headLockfile],
    ]) {
        if (!isSupportedLockfile(lockfile)) {
            console.error(
                `[check-visuals-guard] unsupported ${side} package-lock.json (lockfileVersion: ${lockfile?.lockfileVersion ?? "unknown"}): a 'packages' section (lockfileVersion 2+) is required`,
            );
            process.exitCode = 1;
            return;
        }
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

    const fingerprint = computeGuardedFingerprint(headLockfile);
    console.log(`[check-visuals-guard] guarded dependency fingerprint: ${fingerprint}`);

    const recorded = findConfirmationFingerprints(process.env.PR_BODY);
    if (recorded.includes(fingerprint)) {
        console.log("[check-visuals-guard] local 'npm run test:visuals' confirmation found in PR body");
        return;
    }

    if (recorded.length > 0) {
        console.error(
            `[check-visuals-guard] confirmation in PR body was recorded for other dependency versions (${recorded.join(", ")}); re-run 'npm run test:visuals' for the current versions`,
        );
    }
    console.error(
        "[check-visuals-guard] run 'npm run test:visuals' locally (macOS) and add the following checked line to the PR body:",
    );
    // PR 本文へそのまま貼り付けられるよう、ログではなく生の出力としてプレフィックスを付けずに書き出す。
    process.stderr.write(`${formatConfirmationLine(fingerprint)}\n`);
    process.exitCode = 1;
}

// このファイルが直接実行された場合のみチェックを走らせる（Unit testからのimport時は実行しない）。
if (process.argv[1] && process.argv[1].endsWith("checkVisualsGuard.mjs")) {
    main();
}
