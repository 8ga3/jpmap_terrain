/**
 * 箱庭ジオラマの実機パフォーマンス調査用の簡易計測ヘルパー。
 *
 * Meta Quest 3実機でのみ顕在化する、`setView`（地図移動）再構築時の遅延の
 * どのフェーズ（ネットワークフェッチ／canvas合成／PNGエンコード／`<img>`デコード＋
 * GPUアップロード／ミップマップ生成／シェーダーコンパイル等）が主要因かを
 * 切り分けるための一時的な計測コード。`console.debug`（開発ビルドのみ、
 * `globeTileManager.ts` と同じ `process.env.NODE_ENV` ガード）で各フェーズの
 * 所要時間[ms]を出力する。
 *
 * Quest 3実機ではUSBリモートデバッグ（`chrome://inspect`）経由でこのログを確認する。
 */

/** console出力の識別用プレフィックス。他のconsole出力と区別しやすくするため。 */
const PERF_LOG_PREFIX = "[diorama-perf]";

/**
 * 非同期処理 `fn` の実行時間を計測し、`console.debug` へ出力してから結果（または
 * エラー）をそのまま伝播する。本番ビルドでは計測・ログ出力を行わず `fn()` を
 * そのまま呼び出す（`performance.now()` 呼び出し自体のオーバーヘッドも避ける）。
 *
 * @param label 計測対象を識別するラベル（例: "tiles-fetch-compose"）。
 * @param fn    計測対象の非同期処理。
 */
export const measureAsync = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (process.env.NODE_ENV === "production") {
        return fn();
    }
    const start = performance.now();
    try {
        return await fn();
    } finally {
        const elapsedMs = performance.now() - start;
        console.debug(`${PERF_LOG_PREFIX} ${label}: ${elapsedMs.toFixed(1)}ms`);
    }
};
