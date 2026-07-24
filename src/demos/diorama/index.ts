/**
 * 箱庭ジオラマビューア（diorama）デモ。
 *
 * パッケージ公開 API である `JpmapDiorama`（`spec/diorama-api.md`）を直接利用して
 * デモを起動する。地形構築・入力コントロール（キーボード/タッチHUD/AR操作）・
 * WebXR (`immersive-ar`) セッション統合等の実装詳細は `src/lib/jpmapDiorama.ts`
 * 側に集約されており、本ファイルは以下のデモ固有処理のみを担う薄いラッパーである。
 * - `#root` 要素へのマウント
 * - `?engine=` クエリ文字列からの描画エンジン解決（他デモと同じ規約）
 */
import { JpmapDiorama } from "../../lib/jpmapDiorama";
import type { EngineType, JpmapDioramaOptions } from "../../lib/types";

const DEMO_MOUNT_ID = "root";

/** 既定の箱庭中心（富士山・富士宮口五合目付近の山腹。単調な斜面が見える地点）。 */
const DEFAULT_CENTER = { lat: 35.3436, lon: 138.7203 };
/** 既定の実世界フットプリントの半辺長[m]。 */
const DEFAULT_FOOTPRINT_HALF_SIZE_M = 800;
/** 既定の卓上表示半径[m]（手元サイズ）。 */
const DEFAULT_TABLE_RADIUS_M = 0.35;

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する（他デモと同じ規約）。
 * 未指定時は `undefined` を返し、`JpmapDiorama` 既定の `"webgl2"` に委ねる
 * （AR実機互換性を優先した既定値。理由は `spec/diorama-api.md` §5.2 参照）。
 */
const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }
    const engine = resolveEngine(location.search);
    const options: JpmapDioramaOptions = {
        center: DEFAULT_CENTER,
        footprintHalfSizeM: DEFAULT_FOOTPRINT_HALF_SIZE_M,
        tableRadiusM: DEFAULT_TABLE_RADIUS_M,
        // tileMode は明示せず、JpmapDiorama 既定（"std"）に委ねる（PRレビュー指摘対応。
        // デモ側で固定すると将来 JPMAP_DIORAMA_DEFAULTS.tileMode 変更時に乖離するため）。
        ...(engine ? { engine } : {}),
    };
    const diorama = await JpmapDiorama.create(mount, options);

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する（他デモと同じ規約。
    // `viewer/index.ts` の `window.viewer = viewer` 参照）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { diorama: JpmapDiorama }).diorama = diorama;
    }
};

// `#root` が無い環境（テスト環境等）では副作用としてのデモ起動をスキップする。
if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain diorama demo] failed to start:", err);
    });
}
