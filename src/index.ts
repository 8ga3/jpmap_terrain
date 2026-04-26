/**
 * 開発用デモエントリ (T9 / Issue #123, #136)
 *
 * パッケージ公開 API である `JpmapTerrain` を直接利用してデモを起動する。
 * - URL 形式: `/@lat,lon?engine=webgpu|webgl|webgl2`（`webgl`/`webgl2` は `webgl2` に正規化、既定: 自動）
 * - `#root` 要素にビューアをマウントする。
 * - URL ↔ カメラ同期はパッケージ層から切り離し、デモ層 (本ファイル) で
 *   `parseLatLonFromUrl` で初期値を解決し、`onCameraChange` で URL を更新する。
 *
 * Playwright (tests/validation.spec.ts) と既存の手動デバッグ手段を保つため、
 * NODE_ENV !== "production" のときだけ `window.scene` / `window.viewer` /
 * `window.showToast` を露出する。これらは公開 API ではない。
 */
import { JpmapTerrain } from "./lib/jpmapTerrain";
import type { EngineType, JpmapTerrainOptions } from "./lib/types";
import { showToast } from "./terrain/controlPanel";
import { parseLatLonFromUrl, createUrlUpdater } from "./terrain/urlState";

const DEMO_MOUNT_ID = "root";

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する。
 * - `webgpu` → `"webgpu"`
 * - `webgl` / `webgl2` → `"webgl2"`（旧表記との互換のため正規化）
 * - 上記以外 / 未指定 → `undefined`（自動判定にフォールバック）
 *
 * @param search `location.search` 等のクエリ文字列（先頭 `?` 任意）
 */
export const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/**
 * URL から初期表示の緯度経度を解決する。
 * 内部的に {@link parseLatLonFromUrl} を再利用する薄いラッパー。
 *
 * @param url 解析対象 URL（`location.href` 等）
 * @returns 取得できた場合は `{ lat, lon }`、取得できない場合は `undefined`
 */
export const resolveLatLon = (
    url: string,
): { lat: number; lon: number } | undefined =>
    parseLatLonFromUrl(url) ?? undefined;

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }
    const engine = resolveEngine(location.search);
    const latLon = resolveLatLon(location.href);
    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        ...(latLon ?? {}),
    };
    const viewer = await JpmapTerrain.create(mount, opts);

    // URL 同期: カメラ変化のたびに `/@lat,lon` 形式へ反映する（既存クエリは保持）。
    const urlUpdater = createUrlUpdater(200);
    viewer.onCameraChange((event) => urlUpdater(event.lat, event.lon));

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する。
    // （Playwright の `window.scene.isReady()` 等が依存しているため）
    // `__debugScene` は @internal 扱いの公式デバッグアクセサ（spec/package.md には未記載）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        (window as unknown as { scene: unknown }).scene = viewer.__debugScene;
        (window as unknown as { showToast: typeof showToast }).showToast = showToast;
    }
};

// テスト環境（jest）では副作用としてのデモ起動をスキップする。
// jsdom 環境でも `#root` が無ければ `start()` 内で例外になるため、明示的にガードする。
if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain demo] failed to start:", err);
    });
}
