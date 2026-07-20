/**
 * diorama デモの実機診断用オーバーレイ。
 *
 * @remarks
 * WebXR実機（Meta Quest 3 / Android Chrome等）でのみ再現する不具合は、
 * PCのdevtoolsが使えない・長いUSBケーブルが無い等の理由でコンソールログを
 * 直接確認できないことが多い。本モジュールは、ページ上（および対応ブラウザでは
 * WebXRの `dom-overlay` feature を通じて没入セッション中も）常時表示される
 * 簡易ログパネルを提供し、実機の画面を直接見るだけで診断情報を確認できるように
 * する。
 *
 * `dom-overlay` はUAが対応している場合のみ機能する（Android Chromeは対応、
 * Quest Browserは記事執筆時点で対応状況が不確実）。非対応環境では通常の2D
 * ページ上の要素として表示され続けるため、少なくとも没入前の状態確認には
 * 常に使える。
 */

/** オーバーレイに保持する最大行数（画面を圧迫しすぎないため）。 */
const MAX_LOG_LINES = 24;

export interface ArDebugOverlay {
    /** `dom-overlay` feature の `element` オプションに渡す実体。 */
    element: HTMLElement;
    /** 診断メッセージを1行追加する（タイムスタンプ付き）。 */
    log(message: string): void;
}

/**
 * 診断用オーバーレイを生成し、`mount` に追加する。
 * グローバルな `error`/`unhandledrejection` イベントも自動的にログへ記録する。
 */
export const createArDebugOverlay = (mount: HTMLElement): ArDebugOverlay => {
    const element = document.createElement("div");
    Object.assign(element.style, {
        position: "absolute",
        top: "60px",
        left: "8px",
        right: "8px",
        maxHeight: "50%",
        overflowY: "auto",
        background: "rgba(0,0,0,0.75)",
        color: "#7CFC7C",
        fontFamily: "monospace",
        fontSize: "11px",
        lineHeight: "1.4",
        padding: "8px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        zIndex: "20",
        pointerEvents: "none",
        borderRadius: "6px",
    } satisfies Partial<CSSStyleDeclaration>);
    mount.appendChild(element);

    const lines: string[] = [];
    const render = (): void => {
        element.textContent = lines.join("\n");
    };

    const log = (message: string): void => {
        const timestamp = new Date().toISOString().slice(11, 23);
        lines.push(`[${timestamp}] ${message}`);
        if (lines.length > MAX_LOG_LINES) lines.shift();
        render();
    };

    window.addEventListener("error", (event) => {
        log(`[window.onerror] ${event.message}`);
    });
    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
        log(`[unhandledrejection] ${reason}`);
    });

    return { element, log };
};
