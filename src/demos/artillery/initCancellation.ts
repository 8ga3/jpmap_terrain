/**
 * 初期化中断（キャンセル）ヘルパー
 *
 * Artillery Game の初期化は地形ロードや物理エンジン初期化など重い処理を伴い、
 * その間は描画ループ等でメインスレッドが飽和しやすい。ブラウザの「戻る」操作が
 * 行われても、メインスレッドが解放されるまでページ遷移が処理されず待たされる。
 *
 * そこで `pagehide`（bfcache 含むページ離脱）と `popstate`（履歴移動）を監視し、
 * 発火した瞬間に同期コールバック（`onAbort`）でレンダーループ停止・リソース破棄を
 * 行えるようにする。これによりメインスレッドを即座に解放し、遷移を速やかに進める。
 * `AbortSignal` も内包するため、対応 API へそのまま渡すこともできる。
 */

/** 初期化中断トークン。 */
export interface InitCancellation {
    /** 内包する AbortSignal。対応 API へ渡せる。 */
    readonly signal: AbortSignal;
    /** 中断済みなら true。 */
    isAborted(): boolean;
    /** 監視を解除する（初期化完了時に呼ぶ）。 */
    dispose(): void;
}

/** 離脱検知に使うイベント名。 */
const ABORT_EVENTS = ["pagehide", "popstate"] as const;

/**
 * 離脱検知用のキャンセルトークンを生成する。
 *
 * @param onAbort 離脱検知時に同期実行するコールバック（描画停止・破棄など）。
 *   例外は内部で握りつぶし、後続のクリーンアップを妨げない。
 * @param target 監視対象（既定: `window`）。テスト時に EventTarget を差し替え可能。
 * @returns 中断状態を参照できる {@link InitCancellation}。
 */
export const createInitCancellation = (
    onAbort?: () => void,
    target: EventTarget = window,
): InitCancellation => {
    const controller = new AbortController();

    const handleAbort = (): void => {
        const firstAbort = !controller.signal.aborted;
        if (firstAbort) {
            controller.abort();
        }
        removeListeners();
        // 戻る操作を即座に反映するため、初回のみ同期でクリーンアップを実行する。
        if (firstAbort && onAbort) {
            try {
                onAbort();
            } catch (err) {
                console.error("[artillery] init abort handler failed", err);
            }
        }
    };

    const removeListeners = (): void => {
        for (const name of ABORT_EVENTS) {
            target.removeEventListener(name, handleAbort);
        }
    };

    for (const name of ABORT_EVENTS) {
        target.addEventListener(name, handleAbort);
    }

    return {
        signal: controller.signal,
        isAborted: () => controller.signal.aborted,
        dispose: removeListeners,
    };
};
