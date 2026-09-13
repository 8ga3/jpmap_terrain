import { defineConfig } from "tsdown";

export default defineConfig({
    entry: { index: "src/__ci_failure_check__.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2021",
    outDir: "dist",
    deps: {
        neverBundle: [/^@babylonjs\//],
    },
    tsconfig: "./tsconfig.lib.json",
});
