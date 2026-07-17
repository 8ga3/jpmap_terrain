import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { demoRewritePlugin } from "./vite.rewrites";

/**
 * `package.json` の `version` をビルド時定数 `__APP_VERSION__` として埋め込むために読み込む。
 * TS の JSON module 解決設定を増やさないよう、`fs` 経由で読み込む。
 */
const { version: APP_VERSION } = JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

/**
 * Vite 設定。
 */

/**
 * エントリ HTML を格納するディレクトリ（Vite の `root`）。
 * リポジトリルートを HTML で散らかさないため `public/` に集約する。
 * `root` を `public/` にすることで、配信 URL はルート基準（`/`, `/viewer.html` ...）を維持する。
 */
const PAGES_DIR = "public";

/**
 * 多エントリ構成。
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
    "gpx",
    "model",
    "avatar",
    "avatar-controller",
    "boids",
    "flight",
    "artillery",
    "geospatial",
    "zoomloop",
    "roiorbit",
];

const input = Object.fromEntries(
    HTML_ENTRIES.map((name) => [
        name,
        resolve(__dirname, PAGES_DIR, `${name}.html`),
    ]),
);

/** アセットを data URI 化する inline 閾値（8192B）。 */
const ASSET_INLINE_LIMIT = 8192;

export default defineConfig({
    base: "/",
    // デモポータルのフッターにビルド時のバージョンを埋め込むためのグローバル定数。
    // 型は `src/global.d.ts` の `declare const __APP_VERSION__` を参照。
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
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
    // 開発サーバーのポート（8080）。
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
        // 公開デモサイト（`dist/`）の配信サイズを抑えるため、既定（本番ビルド）では
        // sourcemap を無効化する（`babylonBundle` の map は単体で JS 本体の約4倍あり、
        // 公開OSSでソース隠蔽のメリットもないため）。ローカルのデバッグ用ビルド
        // （`npm run build:dev`）では `cross-env VITE_SOURCEMAP=true` を介して
        // 明示的に有効化する（`cross-env` は Windows でも同じスクリプトが動くように
        // するため。素の `VITE_SOURCEMAP=true cmd` は POSIX シェル専用の構文）。
        // （`defineConfig` のコールバック形式は `mergeConfig`（vitest.config.ts 等）と
        // 互換しないため、mode ではなく環境変数で分岐する）。
        sourcemap: process.env.VITE_SOURCEMAP === "true",
        // `babylonBundle`（Babylon.js コア本体）は圧縮後 3MB 弱あり、既定の
        // 500kB 警告閾値を常に超える。3D エンジン本体のサイズが原因で
        // sourcemap の有無とは無関係（分割してもデモ1件あたりの総ダウンロード量は
        // 変わらない）ため、実態に合わせて閾値を引き上げノイズを抑える。
        chunkSizeWarningLimit: 3000,
        // 8192B 以下のアセットはインライン化（Base64 data URI）する。
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
                // 共有依存（Babylon.js やシェーダー）を分離するチャンク分割。
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
