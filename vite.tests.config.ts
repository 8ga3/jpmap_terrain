import { mergeConfig } from "vite";
import baseConfig from "./vite.config";

/**
 * E2E テスト（Playwright）用の Vite 設定。
 *
 * dev 設定（`vite.config.ts`）を継承し、SPA rewrite プラグインを共有することで
 * dev と E2E の挙動の乖離を防ぐ。E2E の安定性のため HMR を無効化する。
 */
export default mergeConfig(baseConfig, {
    // dev (`npm start`) と E2E で依存最適化キャッシュを分離する。
    // 共有すると E2E が一部デモの依存だけをキャッシュした状態で dev を起動した際に
    // 再最適化（504 Outdated Optimize Dep）が誘発され、地形タイル読込が中断される。
    cacheDir: "node_modules/.vite-tests",
    server: {
        port: 8080,
        strictPort: true,
        hmr: false,
    },
});
