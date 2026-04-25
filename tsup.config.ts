import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/lib.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2021",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
    external: [/^@babylonjs\//],
    tsconfig: "./tsconfig.lib.json",
});
