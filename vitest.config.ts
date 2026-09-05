import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vite.config";

/**
 * Vitest 設定。
 *
 * `vite.config.ts` を `mergeConfig` で継承し、dev/build と同じ変換パイプライン
 * （TypeScript/ESM 変換・アセット解決）を単体テストでも利用する。
 * `root` は dev/build 用の `public/` ではなく、`tests/` を含むリポジトリルートを
 * 明示的に指定する（未指定だと継承元の `root: "public"` が使われ、
 * `tests/**` が解決できなくなるため）。
 */
export default mergeConfig(
    baseConfig,
    defineConfig({
        root: __dirname,
        test: {
            include: ["tests/**/*.unit.spec.ts"],
            // 既定値は node。`@vitest-environment jsdom` pragma を付与した
            // ファイルのみ jsdom で実行する。
            environment: "node",
            globals: false,
        },
    }),
);
