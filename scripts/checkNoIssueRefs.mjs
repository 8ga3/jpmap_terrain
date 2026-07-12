#!/usr/bin/env node
/**
 * Git管理下のソース/ドキュメントに issue 番号・phase 番号の参照
 * （例: `Issue #123` / `(#123)` / `Phase 1` / `P4-0` / `Slice 2a`）が
 * 含まれていないかを検知するスクリプト。
 *
 * agent instruction（30_coder.md 等）に「参照を書かない」ルールを
 * 追記するだけでは遵守されない実績があったため、機械的な検知で
 * 補強する（`npm run lint` から実行される）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TARGET_EXTENSIONS = [".ts", ".tsx", ".md"];

// このスクリプト自身とそのUnit testは、検知対象パターンの実例を
// 文字列として保持する必要があるため、スキャン対象から除外する。
const SELF_EXCLUDE = new Set([
    "scripts/checkNoIssueRefs.mjs",
    "tests/checkNoIssueRefs.unit.spec.ts",
]);

export const PATTERNS = [
    { name: "issue-ref", regex: /\bissue\s*#\d+/gi },
    // 半角括弧 `(#123)` だけでなく全角括弧 `（#123）` や、番号の後に
    // 説明文が続くケース（例: `（#465 applyBaseAppearance）`）も検知する。
    // 括弧内に別の丸括弧が入れ子になっている場合は範囲を広げすぎないよう、
    // `[^)）]*` で対象の閉じ括弧以外の文字に限定する。
    // 既知の制限（トレードオフ）:
    // - 1行内で閉じる括弧のみ対象。開き括弧と閉じ括弧が別行にまたがる場合は検知できない。
    // - 括弧内で `#` に続く文字列が全て数字のケース（hexカラーコード等、
    //   例: `（#003366）`）も issue番号参照として誤検知し得る。回避するには
    //   コード内のhexカラーはこのパターンに隣接させず、バッククォート等で
    //   区切って記述すること。
    { name: "paren-issue-ref", regex: /[(（]#\d+[^)）]*[)）]/g },
    { name: "phase-ref", regex: /\bphase\s*#?\d+\b/gi },
    { name: "phase-slice-code", regex: /\bp\d+-\d+[a-z]?\b/gi },
    { name: "slice-ref", regex: /\bslice\s*\d+[a-z]?\b/gi },
];

/**
 * 1ファイル分のテキストから違反箇所（行番号・種別・一致文字列）を抽出する。
 */
export function findViolations(content) {
    const violations = [];
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
        for (const { name, regex } of PATTERNS) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(line)) !== null) {
                violations.push({ line: idx + 1, name, text: match[0] });
                // 空文字マッチによる無限ループを防止する（本パターン群では通常発生しないが念のため）。
                if (match.index === regex.lastIndex) regex.lastIndex++;
            }
        }
    });
    return violations;
}

/**
 * `git ls-files` でGit管理下のファイル一覧を取得する
 * （node_modules/dist/.tmp 等の未追跡ディレクトリは自動的に除外される）。
 * git コマンド自体が失敗する場合（未インストール・Git管理外ディレクトリ等）は、
 * 生の例外ではなく原因を含む分かりやすいエラーで失敗させる。
 */
export function listTrackedFiles() {
    try {
        const output = execFileSync("git", ["ls-files"], { encoding: "utf8" });
        return output.split("\n").filter(Boolean);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`[check-no-issue-refs] failed to list git-tracked files: ${reason}`);
    }
}

export function collectAllViolations(files, readFile = readFileSync) {
    const results = [];
    for (const file of files) {
        if (SELF_EXCLUDE.has(file)) continue;
        if (!TARGET_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
        let content;
        try {
            content = readFile(file, "utf8");
        } catch (error) {
            // シンボリックリンク切れ等で読めないファイルはスキップするが、チェックが
            // 部分的にしか行われていないことに気づけるよう警告は必ず出す。
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[check-no-issue-refs] failed to read file, skipped: ${file} (${reason})`);
            continue;
        }
        for (const violation of findViolations(content)) {
            results.push({ file, ...violation });
        }
    }
    return results;
}

function main() {
    let files;
    try {
        files = listTrackedFiles();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
    }
    const violations = collectAllViolations(files);
    if (violations.length > 0) {
        for (const v of violations) {
            console.error(`[check-no-issue-refs] ${v.file}:${v.line}: "${v.text}" (${v.name})`);
        }
        console.error(
            "[check-no-issue-refs] found issue/phase number references. Summarize the background instead of referencing issue/phase numbers.",
        );
        process.exitCode = 1;
    }
}

// このファイルが直接実行された場合のみチェックを走らせる（Unit testからのimport時は実行しない）。
if (process.argv[1] && process.argv[1].endsWith("checkNoIssueRefs.mjs")) {
    main();
}
