/**
 * 開発用デモエントリ (T9 / Issue #123)
 *
 * パッケージ公開 API である `JpmapTerrain` を直接利用してデモを起動する。
 * - `?engine=webgpu|webgl` クエリで描画エンジンを切替（既定: 自動）
 * - `#root` 要素にビューアをマウントする
 *
 * Playwright (tests/validation.spec.ts) と既存の手動デバッグ手段を保つため、
 * NODE_ENV !== "production" のときだけ `window.scene` / `window.viewer` /
 * `window.showToast` を露出する。これらは公開 API ではない。
 */
import { JpmapTerrain } from "./lib/jpmapTerrain";
import type { EngineType } from "./lib/types";
import { showToast } from "./terrain/controlPanel";

const DEMO_MOUNT_ID = "root";

const resolveEngine = (): EngineType | undefined => {
    const value = new URLSearchParams(location.search).get("engine");
    if (value === "webgpu") return "webgpu";
    // 既存デモは "webgl" 表記。新公開 API は "webgl2" に統一。
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }
    const engine = resolveEngine();
    const viewer = await JpmapTerrain.create(mount, engine ? { engine } : {});

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する。
    // （Playwright の `window.scene.isReady()` 等が依存しているため）
    if (process.env.NODE_ENV !== "production") {
        const debugRefs = viewer as unknown as { _scene?: unknown };
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        (window as unknown as { scene: unknown }).scene = debugRefs._scene;
        (window as unknown as { showToast: typeof showToast }).showToast = showToast;
    }
};

start().catch((err) => {
    console.error("[jpmap-terrain demo] failed to start:", err);
});
