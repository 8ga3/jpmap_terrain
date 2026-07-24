/**
 * diorama デモの「現在のタイル種別（標準地図/写真/ワイヤーフレーム）」を単独で保持し、
 * 単発の切替入力（入力源を問わない、A/Xボタン・GUIタイル切替ボタン・KeyTキー等）を
 * `dioramaTerrain.setTileMode` へ橋渡しする。
 *
 * @remarks
 * `DioramaViewController`/`DioramaOrientationController` と同じ「AR中のコントローラー/
 * GUI操作とデスクトップのキーボード操作の両方から共有される、単独の状態保持者」という
 * 設計方針を踏襲する。ただしタイル種別切替は継続入力（スティック/トリガー）ではなく
 * 単発のタップ/ボタン押下で駆動するため、`feedAxes` ではなく `cycle()`（巡回）という
 * 単発アクションのAPIにする。
 *
 * `setTileMode`（`dioramaTerrain.setTileMode`が内部で使う）は非同期の地形rebuild
 * （ラスタタイル再取得を伴う。ワイヤーフレーム切替時はスキップされるが、
 * std/photo間の切替では発生する）のため、`DioramaViewController` と同様に
 * 「前回の適用が完了するまで、直近の要求のみを保持し完了後にまとめて送る」方式にする。
 * 例えば `cycle()` を短時間に連打された場合、途中の状態を経由せず最終的な目標
 * タイル種別のみが適用される（キューに全連打分を積んで順番に適用するのではない）。
 */
import type { DioramaTerrain, DioramaTileMode } from "../../../terrain/diorama/dioramaTerrain";
import { nextDioramaTileMode } from "./dioramaControllerMapping";

export interface DioramaTileModeController {
    /** 現在のタイル種別（読み取り専用スナップショット）。 */
    getTileMode(): DioramaTileMode;
    /** 巡回順序（std→photo→wireframe→std…）で次のタイル種別へ切り替える。 */
    cycle(): void;
}

/**
 * `DioramaTileModeController` を生成する。
 * @param initialTileMode 初期のタイル種別（デモ既定値）。
 */
export const createDioramaTileModeController = (
    dioramaTerrain: DioramaTerrain,
    initialTileMode: DioramaTileMode,
): DioramaTileModeController => {
    let currentTileMode = initialTileMode;
    // 現在 `dioramaTerrain.setTileMode` 呼び出し中（rebuild完了待ち）の目標タイル種別。
    // `currentTileMode` はその呼び出しが成功するまで更新されないため、`cycle()` の
    // 巡回元をこちらから決める（さもないと、1回目の適用完了前に連打された `cycle()` が
    // 古い `currentTileMode` を基準に同じ次の値を繰り返し計算してしまい、連打回数と
    // 最終結果が食い違う）。
    let inFlightTileMode: DioramaTileMode | null = null;
    // 次に適用したい目標タイル種別。前回の `setTileMode` 完了待ちの間に発生した
    // 追加の `cycle()` 呼び出しは、この値を上書きするだけで（＝最後の要求のみが有効）、
    // キューには積まない。
    let pendingTileMode: DioramaTileMode | null = null;
    let applying = false;

    const apply = (target: DioramaTileMode): void => {
        if (applying) {
            pendingTileMode = target;
            return;
        }
        applying = true;
        inFlightTileMode = target;
        dioramaTerrain
            .setTileMode(target)
            .then(
                () => {
                    currentTileMode = target;
                },
                (err: unknown) => {
                    console.error("[jpmap-terrain diorama demo] setTileMode failed:", err);
                },
            )
            .finally(() => {
                applying = false;
                inFlightTileMode = null;
                if (pendingTileMode !== null) {
                    const next = pendingTileMode;
                    pendingTileMode = null;
                    apply(next);
                }
            });
    };

    return {
        getTileMode: () => currentTileMode,
        cycle: (): void => {
            // 予約済みの目標（連打で既に上書き済みの値）→ 適用中の目標 → 現在値、の
            // 優先順位で巡回元を決める（冒頭のコメント参照。連打時に常に最新の
            // 「これから適用される値」を基準にする）。
            const base = pendingTileMode ?? inFlightTileMode ?? currentTileMode;
            apply(nextDioramaTileMode(base));
        },
    };
};
