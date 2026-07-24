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
    /**
     * 指定したタイル種別へ明示的に切り替える（ホストアプリからの直接指定用、
     * `JpmapDiorama.setTileMode` が使う）。`cycle()` と同じ「適用中は最新の要求のみ
     * 保持する」キューイングを共有するが、呼び出し元が完了（失敗時はエラー）を
     * 待てるよう `Promise` を返す。
     */
    setTileMode(tileMode: DioramaTileMode): Promise<void>;
    /**
     * タイル種別が変化した後に呼ばれるリスナーを登録する
     * （`JpmapDiorama.onTileModeChange` が使う）。
     * @returns 購読解除関数。
     */
    onChange(listener: (tileMode: DioramaTileMode) => void): () => void;
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
    // 追加の要求は、この値を上書きするだけで（＝最後の要求のみが有効）、
    // キューには積まない。
    let pendingTileMode: DioramaTileMode | null = null;
    // 現在進行中の適用（`runApply`）のPromise。`null` なら適用中でない。
    let inFlight: Promise<void> | null = null;
    const changeListeners: Array<(tileMode: DioramaTileMode) => void> = [];
    const notifyChange = (): void => {
        for (const listener of changeListeners.slice()) {
            try {
                listener(currentTileMode);
            } catch (err) {
                console.error("[jpmap-terrain diorama] onChange listener threw:", err);
            }
        }
    };

    /**
     * `target` を実際に適用する。`async` 関数の `finally` は、その関数自身が
     * 返す Promise が解決する **前** に必ず実行し終える（JS の仕様上の保証）ため、
     * `apply()` 側で「解決後に `inFlight` を読み直す」ことで、連打時に上書きされた
     * 後続の適用まで正しく待ち合わせられる。
     */
    const runApply = async (target: DioramaTileMode): Promise<void> => {
        inFlightTileMode = target;
        try {
            await dioramaTerrain.setTileMode(target);
            currentTileMode = target;
            notifyChange();
        } finally {
            inFlightTileMode = null;
            if (pendingTileMode !== null) {
                const next = pendingTileMode;
                pendingTileMode = null;
                inFlight = runApply(next);
            } else {
                inFlight = null;
            }
        }
    };

    const apply = (target: DioramaTileMode): Promise<void> => {
        if (inFlight) {
            pendingTileMode = target;
            // `inFlight` が解決した時点で `runApply` の `finally` は実行済みのため、
            // 再度 `inFlight` を読み直せば、連打で上書きされた最新の要求（またはさらに
            // その先）まで正しく合流できる。
            const waitForConvergence = (): Promise<void> => inFlight ?? Promise.resolve();
            return inFlight.then(waitForConvergence, waitForConvergence);
        }
        inFlight = runApply(target);
        return inFlight;
    };

    return {
        getTileMode: () => currentTileMode,
        cycle: (): void => {
            // 予約済みの目標（連打で既に上書き済みの値）→ 適用中の目標 → 現在値、の
            // 優先順位で巡回元を決める（冒頭のコメント参照。連打時に常に最新の
            // 「これから適用される値」を基準にする）。
            const base = pendingTileMode ?? inFlightTileMode ?? currentTileMode;
            apply(nextDioramaTileMode(base)).catch((err: unknown) => {
                console.error("[jpmap-terrain diorama] setTileMode failed:", err);
            });
        },
        setTileMode: (tileMode: DioramaTileMode): Promise<void> => apply(tileMode),
        onChange: (listener: (tileMode: DioramaTileMode) => void): (() => void) => {
            changeListeners.push(listener);
            let removed = false;
            return (): void => {
                if (removed) return;
                removed = true;
                const idx = changeListeners.indexOf(listener);
                if (idx !== -1) changeListeners.splice(idx, 1);
            };
        },
    };
};
