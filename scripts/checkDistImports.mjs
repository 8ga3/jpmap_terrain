#!/usr/bin/env node
/**
 * ライブラリのビルド成果物（`dist/`）が外部パッケージのサブパスを
 * 拡張子付きで import しているかを検知するスクリプト。
 *
 * `@babylonjs/core` は `"type": "module"` でありながら `exports` フィールドを
 * 持たない。この場合 Node.js はサブパスをファイルパスとして解決するため、
 * 拡張子のない import（`@babylonjs/core/Maths/math.vector`）は
 * `ERR_MODULE_NOT_FOUND` になる。bundler（Vite / webpack）は拡張子を補って
 * 解決するため、デモのビルドやテストが通っていても検知できない。
 *
 * tsdown は peer dependency を外部化する際に `src` 側の import 文をそのまま
 * 出力へ残すため、`src` に拡張子なしの import が1つ混ざるだけで
 * Node ランタイムから直接 import できない成果物が出来上がる。
 * リリースまで気付けないため、機械的な検知で補強する
 * （`npm run build:lib` 後と `prepack` から実行される）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = resolve(REPO_ROOT, "dist");

/** Node.js が ESM として解決できる拡張子。 */
const RESOLVABLE_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".node"];

/**
 * ソース中の静的・動的 import から、外部パッケージの specifier を取り出す。
 * 相対 import（`./` `../`）と絶対 URL は対象外（bundle 済みのため出現しない）。
 */
export function extractBareSpecifiers(source) {
    const specifiers = new Set();
    // `from "x"` / `import "x"` / `import("x")` の3形態を拾う。
    const patterns = [
        /\bfrom\s*["']([^"']+)["']/g,
        /\bimport\s*["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const specifier = match[1];
            if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
            if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) continue;
            specifiers.add(specifier);
        }
    }
    return [...specifiers];
}

/**
 * パッケージ名の部分（scope 付きなら2セグメント）を除いた「サブパス」を持ち、
 * かつ解決可能な拡張子で終わっていない specifier を返す。
 *
 * サブパスを持たないルート import（`@babylonjs/havok` 等）は `main` /
 * `exports` で解決されるため対象外とする。
 */
export function findExtensionlessSubpaths(specifiers) {
    return specifiers.filter((specifier) => {
        const segments = specifier.split("/");
        const nameSegments = specifier.startsWith("@") ? 2 : 1;
        if (segments.length <= nameSegments) return false;
        return !RESOLVABLE_EXTENSIONS.some((ext) => specifier.endsWith(ext));
    });
}

function main() {
    let entries;
    try {
        entries = readdirSync(DIST_DIR).filter((name) => name.endsWith(".mjs"));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[check-dist-imports] failed to read dist: ${reason}`);
        console.error("[check-dist-imports] run 'npm run build:lib' first.");
        process.exitCode = 1;
        return;
    }

    if (entries.length === 0) {
        console.error("[check-dist-imports] no .mjs files found in dist. run 'npm run build:lib' first.");
        process.exitCode = 1;
        return;
    }

    let hasViolation = false;
    for (const entry of entries) {
        const source = readFileSync(join(DIST_DIR, entry), "utf8");
        const offenders = findExtensionlessSubpaths(extractBareSpecifiers(source));
        for (const offender of offenders) {
            hasViolation = true;
            console.error(`[check-dist-imports] dist/${entry} imports '${offender}' without a file extension`);
        }
    }

    if (hasViolation) {
        console.error(
            "[check-dist-imports] Node.js cannot resolve extensionless subpath imports for packages without an 'exports' field. Add the extension to the import in src/ and rebuild.",
        );
        process.exitCode = 1;
    }
}

// このファイルが直接実行された場合のみチェックを走らせる（Unit testからのimport時は実行しない）。
if (process.argv[1] && process.argv[1].endsWith("checkDistImports.mjs")) {
    main();
}
