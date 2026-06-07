import { resolve } from "node:path";
import { defineConfig } from "vite";
import { demoRewritePlugin } from "./vite.rewrites";

/**
 * Vite 設定（Webpack からの移行 / Issue #298）。
 */

/**
 * エントリ HTML を格納するディレクトリ（Vite の `root`）。
 * webpack 時代と同様にリポジトリルートを HTML で散らかさないため `public/` に集約する。
 * `root` を `public/` にすることで、配信 URL はルート基準（`/`, `/viewer.html` ...）を維持する。
 */
const PAGES_DIR = "public";

/**
 * 多エントリ構成 (Issue #147 / #298)。
 * - portal は `/`（public/index.html）として配信する。
 * - その他のデモは `<name>.html` として配信する。
 * 各 HTML は `<script type="module" src="/src/demos/<name>/index.ts">` を読み込む
 *   （`root` が `public/` のため、絶対パス `/src` は `resolve.alias` で実 src へ解決する）。
 */
const HTML_ENTRIES = [
    "index", // portal
    "viewer",
    "timelapse",
    "polygon",
    "distance",
    "circle",
    "plan",
    "model",
    "avatar",
    "avatar-controller",
    "boids",
    "flight",
    "artillery",
    "geospatial",
];

const input = Object.fromEntries(
    HTML_ENTRIES.map((name) => [
        name,
        resolve(__dirname, PAGES_DIR, `${name}.html`),
    ]),
);

/** url-loader の inline 閾値（8192B）を踏襲する。 */
const ASSET_INLINE_LIMIT = 8192;

export default defineConfig({
    base: "/",
    // エントリ HTML は public/ に集約する（ルート直下を散らかさない）。
    root: PAGES_DIR,
    // 静的配信専用ディレクトリは使わない（アセットは import 経由でバンドルする）。
    publicDir: false,
    // root が public/ のため、HTML の `<script src="/src/...">` を実 src へ解決する。
    resolve: {
        alias: {
            "/src": resolve(__dirname, "src"),
        },
    },
    plugins: [demoRewritePlugin()],
    // 全デモ HTML を依存スキャン対象にして起動時にまとめて事前バンドルする。
    // これを設定しないと、デモを開くたびに未スキャンの Babylon 依存が
    // 再最適化され（504 Outdated Optimize Dep）、ページが再読込されて
    // 地形タイルの読み込みが中断される。
    optimizeDeps: {
        entries: ["*.html"],
    },
    // webpack-dev-server のデフォルトポート（8080）を踏襲する。
    server: {
        port: 8080,
        strictPort: true,
    },
    // elevationWorker を `{ type: "module" }` で起動するため、build 時も
    // ESM 形式のワーカーとして出力する（既定の iife との不整合を避ける）。
    worker: {
        format: "es",
    },
    // OBJ/MTL/STL/GLB/glTF/env は Vite のデフォルト assetsInclude に含まれないため明示する
    // （import を URL として解決させる）。
    assetsInclude: [
        "**/*.glb",
        "**/*.gltf",
        "**/*.obj",
        "**/*.mtl",
        "**/*.stl",
        "**/*.env",
    ],
    build: {
        // outDir は root（public/）基準で解決されるため、リポジトリルートの dist を指す。
        outDir: "../dist",
        // outDir が root 外のため明示的に許可する。
        emptyOutDir: true,
        sourcemap: true,
        // url-loader 互換: 8192B 以下はインライン化（Base64 data URI）する。
        // ただし OBJ/MTL/STL は OBJ ローダーが mtllib を rootUrl 相対で取得するため、
        // data URI 化すると解決できない。常にファイルとして出力する。
        assetsInlineLimit: (filePath, content) => {
            if (/\.(obj|mtl|stl)$/i.test(filePath)) return false;
            return content.byteLength <= ASSET_INLINE_LIMIT;
        },
        rollupOptions: {
            input,
            output: {
                // OBJ/MTL/STL は mtllib の相対解決のためハッシュを付けずに
                // 同一ディレクトリ（assets/）へ出力する（file-loader の挙動を踏襲）。
                assetFileNames: (assetInfo) => {
                    const name = assetInfo.names?.[0] ?? "";
                    if (/\.(obj|mtl|stl)$/i.test(name)) {
                        return "assets/[name][extname]";
                    }
                    return "assets/[name]-[hash][extname]";
                },
                // webpack splitChunks.cacheGroups を踏襲したチャンク分割 (#298 / #317)。
                manualChunks(id) {
                    if (/\/ShadersWGSL\//.test(id)) return "webgpu-shaders";
                    if (/\/Shaders\//.test(id)) return "webgl-shaders";
                    if (/\/WebGPU\//.test(id)) return "webgpu-extensions";
                    if (/\/node_modules\/@babylonjs\//.test(id)) return "babylonBundle";
                    return undefined;
                },
            },
        },
    },
});
