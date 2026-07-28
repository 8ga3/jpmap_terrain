#!/usr/bin/env node
/**
 * エージェント定義ドキュメントのドリフトを検知するスクリプト。
 *
 * 役割定義の正本は `.github/agents/` 配下であり、`.claude/agents/` 配下は
 * Claude Code が要求する frontmatter と正本への参照のみを持つ。しかし
 * 「複製しない」というルールを instruction に書くだけでは、時間の経過とともに
 * 片側だけが更新され内容が食い違う（＝ドリフトする）。
 *
 * 過去に同様の理由で `check:no-issue-refs` を導入した先例があるため、
 * ここでも機械的な検知で補強する（`npm run lint` から実行される）。
 *
 * 検査内容:
 *  1. `.claude/agents/<name>.md` が対応する正本へのリンクを含むこと
 *  2. 本文が十分に薄いこと（役割内容を複製していないこと）
 *  3. frontmatter の `model` / `description` が正本と一致すること
 *  4. エージェント関連ドキュメント内の相対リンク先が実在すること
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `.claude/agents/<name>.md` と `.github/agents/<file>` の対応。 */
export const AGENT_PAIRS = [
    { name: "planner", canonical: "10_planner.md" },
    { name: "architect", canonical: "20_architect.md" },
    { name: "coder", canonical: "30_coder.md" },
    { name: "tester", canonical: "40_tester.md" },
    { name: "reviewer", canonical: "50_reviewer.md" },
    { name: "security", canonical: "60_security.md" },
];

/** 参照専用ファイルとして許容する本文の最大行数（空行を除く）。 */
export const MAX_MIRROR_BODY_LINES = 20;

/** frontmatter を単純な key-value として取り出す（ネストは扱わない）。 */
export function parseFrontMatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match === null) return null;
    const result = {};
    for (const line of match[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (kv === null) continue;
        result[kv[1]] = kv[2].trim();
    }
    return result;
}

/** frontmatter を除いた本文のうち、空行でない行を返す。 */
export function bodyLines(content) {
    const withoutFrontMatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    return withoutFrontMatter.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** Markdown 中の相対リンク（アンカーのみ・外部URLを除く）を列挙する。 */
export function relativeLinks(content) {
    const links = [];
    for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const path = target.split("#")[0];
        if (path === "") continue;
        links.push(path);
    }
    return links;
}

/**
 * ミラー（`.claude/agents/*.md`）が正本と整合しているか検査し、問題を返す。
 * 純粋関数として扱えるよう、ファイル内容は引数で受け取る。
 */
export function checkMirror({ name, canonical, mirrorContent, canonicalContent }) {
    const problems = [];
    const mirrorFront = parseFrontMatter(mirrorContent);
    const canonicalFront = parseFrontMatter(canonicalContent);

    if (mirrorFront === null) {
        problems.push(`.claude/agents/${name}.md has no front matter`);
        return problems;
    }
    if (canonicalFront === null) {
        problems.push(`.github/agents/${canonical} has no front matter`);
        return problems;
    }

    if (!mirrorContent.includes(`.github/agents/${canonical}`)) {
        problems.push(
            `.claude/agents/${name}.md does not reference its canonical file .github/agents/${canonical}`,
        );
    }

    const lines = bodyLines(mirrorContent);
    if (lines.length > MAX_MIRROR_BODY_LINES) {
        problems.push(
            `.claude/agents/${name}.md body has ${lines.length} lines (max ${MAX_MIRROR_BODY_LINES}); role rules must live in .github/agents/${canonical} only`,
        );
    }

    for (const key of ["model", "description"]) {
        if (mirrorFront[key] !== canonicalFront[key]) {
            problems.push(
                `.claude/agents/${name}.md front matter '${key}' differs from .github/agents/${canonical}`,
            );
        }
    }

    return problems;
}

/** 相対リンクの解決先が存在しない場合に問題として返す。 */
export function checkLinks(filePath, content, exists) {
    const problems = [];
    for (const link of relativeLinks(content)) {
        const resolved = normalize(join(dirname(filePath), link));
        if (!exists(resolved)) {
            problems.push(`${filePath} has a broken relative link: ${link}`);
        }
    }
    return problems;
}

function collectDocPaths() {
    const paths = [
        "AGENTS.md",
        ".github/copilot-instructions.md",
        ".claude/skills/orchestrator/SKILL.md",
    ];
    for (const dir of [".github/agents", ".claude/agents"]) {
        for (const file of readdirSync(resolve(REPO_ROOT, dir))) {
            if (file.endsWith(".md")) paths.push(`${dir}/${file}`);
        }
    }
    return paths;
}

function main() {
    const problems = [];

    for (const pair of AGENT_PAIRS) {
        const mirrorPath = resolve(REPO_ROOT, `.claude/agents/${pair.name}.md`);
        const canonicalPath = resolve(REPO_ROOT, `.github/agents/${pair.canonical}`);
        if (!existsSync(mirrorPath) || !existsSync(canonicalPath)) {
            problems.push(`missing agent definition for '${pair.name}'`);
            continue;
        }
        problems.push(
            ...checkMirror({
                ...pair,
                mirrorContent: readFileSync(mirrorPath, "utf8"),
                canonicalContent: readFileSync(canonicalPath, "utf8"),
            }),
        );
    }

    for (const docPath of collectDocPaths()) {
        const content = readFileSync(resolve(REPO_ROOT, docPath), "utf8");
        problems.push(
            ...checkLinks(docPath, content, (candidate) => existsSync(resolve(REPO_ROOT, candidate))),
        );
    }

    if (problems.length > 0) {
        for (const problem of problems) {
            console.error(`[check-agent-docs] ${problem}`);
        }
        console.error(
            "[check-agent-docs] role definitions must not be duplicated. Edit .github/agents/ (source of truth) and keep .claude/agents/ as thin references.",
        );
        process.exitCode = 1;
    }
}

// このファイルが直接実行された場合のみチェックを走らせる（Unit testからのimport時は実行しない）。
if (process.argv[1] && process.argv[1].endsWith("checkAgentDocs.mjs")) {
    main();
}
