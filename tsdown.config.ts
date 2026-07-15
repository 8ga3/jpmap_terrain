import { defineConfig } from "tsdown";

export default defineConfig({
    entry: { index: "src/lib.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2021",
    outDir: "dist",
    // tsdown はデフォルトで ESM 出力に .d.mts を使うが、spec/package.md の
    // 公開API（dist/index.d.ts）との互換のため .d.ts を明示的に維持する。
    outExtensions: () => ({ js: ".mjs", dts: ".d.ts" }),
    deps: {
        neverBundle: [/^@babylonjs\//],
    },
    tsconfig: "./tsconfig.lib.json",
});
