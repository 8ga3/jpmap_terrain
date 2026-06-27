/** 操作UI（方位磁針・ズーム・地図切替） */

export interface ScaleBarElement {
    container: HTMLDivElement;
    bar: HTMLDivElement;
    label: HTMLSpanElement;
    attribution: HTMLAnchorElement;
}

export interface ControlPanelElements {
    compass: HTMLDivElement;
    locateMe: HTMLButtonElement;
    zoomIn: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
    mapToggle: HTMLButtonElement;
    viewModeButton: HTMLButtonElement;
    scaleBar: ScaleBarElement;
}

const css = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void => {
    Object.assign(el.style, styles);
};

/**
 * タッチ端末（coarse pointer）向けのレスポンシブ補正スタイルを一度だけ注入する。
 *
 * 操作 UI は固定 px のインラインスタイルで生成されるため、ここでは `@media (pointer: coarse)`
 * + `!important` でインライン値を上書きし、スマートフォン/タブレットでのみタップ領域・文字を
 * 拡大する。マウス/トラックパッド（fine pointer）では何も変えないため、PC の見た目とビジュアル
 * 回帰テストには影響しない。
 */
const injectResponsiveStyle = (): void => {
    if (document.getElementById("cp-responsive-style")) return;
    const style = document.createElement("style");
    style.id = "cp-responsive-style";
    style.textContent = [
        "@media (pointer: coarse) {",
        "  .cp-compass { width: 48px !important; height: 48px !important; top: 16px !important; right: 16px !important; }",
        "  .cp-compass svg { width: 34px; height: 34px; }",
        "  .cp-viewmode { width: 48px !important; height: 48px !important; top: 72px !important; right: 16px !important; font-size: 15px !important; }",
        "  .cp-btn { min-width: 44px; min-height: 44px; }",
        "  .cp-zoombtn { width: 44px !important; height: 44px !important; font-size: 22px !important; }",
        "  .cp-zoombtn svg { width: 22px; height: 22px; }",
        "  .cp-maptoggle { width: 56px !important; height: 44px !important; left: 16px !important; bottom: 16px !important; font-size: 13px !important; }",
        "  .cp-scale-text { font-size: 12px !important; }",
        "}",
    ].join("\n");
    document.head.appendChild(style);
};

const createCompass = (): HTMLDivElement => {
    const container = document.createElement("div");
    css(container, {
        position: "absolute",
        top: "12px",
        right: "12px",
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        background: "rgba(9,18,32,0.72)",
        backdropFilter: "blur(6px)",
        zIndex: "10",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
    });

    // SVG コンパス矢印（北=赤、南=グレー）
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "28");
    svg.setAttribute("viewBox", "0 0 28 28");

    // 北（赤い三角）
    const north = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polygon"
    );
    north.setAttribute("points", "14,2 9,14 19,14");
    north.setAttribute("fill", "#e53935");

    // 南（グレーの三角）
    const south = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polygon"
    );
    south.setAttribute("points", "14,26 9,14 19,14");
    south.setAttribute("fill", "#9e9e9e");

    svg.appendChild(north);
    svg.appendChild(south);
    container.appendChild(svg);

    // アクセシビリティ
    container.setAttribute("role", "button");
    container.tabIndex = 0;
    container.setAttribute("aria-label", "方位磁針: クリックで北向きにリセット");
    container.classList.add("cp-compass");

    // :focus-visible スタイルを CSS で適用（JS の matches() 例外を回避）
    if (!document.getElementById("cp-focus-style")) {
        const style = document.createElement("style");
        style.id = "cp-focus-style";
        style.textContent = [
            ".cp-compass, .cp-btn { outline: none; }",
            ".cp-compass:focus, .cp-btn:focus { box-shadow: 0 0 0 2px #90caf9; }",
            ".cp-compass:focus:not(:focus-visible), .cp-btn:focus:not(:focus-visible) { box-shadow: none; }",
        ].join("\n");
        document.head.appendChild(style);
    }

    document.body.appendChild(container);
    return container;
};

const createZoomButtons = (): {
    locateMe: HTMLButtonElement;
    zoomIn: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
    scaleBar: ScaleBarElement;
} => {
    const container = document.createElement("div");
    css(container, {
        position: "absolute",
        bottom: "12px",
        right: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        alignItems: "flex-end",
        zIndex: "10",
        pointerEvents: "none",
    });

    const makeBtn = (label: string, ariaLabel: string): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.tabIndex = 0;
        btn.setAttribute("aria-label", ariaLabel);
        css(btn, {
            width: "32px",
            height: "32px",
            border: "none",
            borderRadius: "4px",
            background: "rgba(9,18,32,0.72)",
            backdropFilter: "blur(6px)",
            color: "#f2f7ff",
            fontSize: "16px",
            lineHeight: "1",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            outline: "none",
            padding: "0",
            pointerEvents: "auto",
        });
        btn.classList.add("cp-btn");
        btn.classList.add("cp-zoombtn");
        return btn;
    };

    // 現在地ボタン（ズーム＋の上）
    const locateMe = makeBtn("", "現在地を表示");
    const locateSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    locateSvg.setAttribute("width", "18");
    locateSvg.setAttribute("height", "18");
    locateSvg.setAttribute("viewBox", "0 0 24 24");
    locateSvg.setAttribute("fill", "none");
    locateSvg.setAttribute("aria-hidden", "true");
    locateSvg.setAttribute("focusable", "false");
    const locatePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    locatePath.setAttribute("d", "M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z");
    locatePath.setAttribute("fill", "#f2f7ff");
    locateSvg.appendChild(locatePath);
    locateMe.textContent = "";
    locateMe.appendChild(locateSvg);

    const zoomIn = makeBtn("+", "ズームイン");
    const zoomOut = makeBtn("−", "ズームアウト");

    // スケールバー（マイナスボタンの下、横一列）
    const scaleContainer = document.createElement("div");
    css(scaleContainer, {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: "4px",
        marginTop: "4px",
        pointerEvents: "none",
    });

    const scaleLabel = document.createElement("span");
    css(scaleLabel, {
        color: "#222",
        fontSize: "10px",
        fontWeight: "bold",
        lineHeight: "1",
        whiteSpace: "nowrap",
        textShadow:
            "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff",
    });
    scaleLabel.textContent = "";
    scaleLabel.classList.add("cp-scale-text");

    const scaleBar = document.createElement("div");
    css(scaleBar, {
        height: "4px",
        background: "#222",
        borderRadius: "1px",
        boxShadow:
            "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff",
        minWidth: "20px",
        width: "60px",
    });

    const attribution = document.createElement("a");
    attribution.href = "https://maps.gsi.go.jp/development/ichiran.html";
    attribution.target = "_blank";
    attribution.rel = "noopener noreferrer";
    attribution.textContent = "地理院タイル";
    attribution.classList.add("cp-scale-text");
    css(attribution, {
        color: "#222",
        fontSize: "10px",
        fontWeight: "bold",
        lineHeight: "1",
        whiteSpace: "nowrap",
        textDecoration: "none",
        textShadow:
            "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff",
        pointerEvents: "auto",
    });
    attribution.addEventListener("mouseenter", () => {
        attribution.style.textDecoration = "underline";
        attribution.style.textDecorationColor = "#222";
    });
    attribution.addEventListener("mouseleave", () => {
        attribution.style.textDecoration = "none";
    });

    scaleContainer.prepend(attribution);
    scaleContainer.appendChild(scaleLabel);
    scaleContainer.appendChild(scaleBar);

    container.appendChild(locateMe);
    container.appendChild(zoomIn);
    container.appendChild(zoomOut);
    container.appendChild(scaleContainer);
    document.body.appendChild(container);

    return {
        locateMe,
        zoomIn,
        zoomOut,
        scaleBar: { container: scaleContainer, bar: scaleBar, label: scaleLabel, attribution },
    };
};

const createMapToggleButton = (): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "写真";
    btn.tabIndex = 0;
    btn.setAttribute("aria-label", "地図切替: 写真地図に変更");
    css(btn, {
        position: "absolute",
        bottom: "12px",
        left: "12px",
        width: "48px",
        height: "32px",
        border: "none",
        borderRadius: "4px",
        background: "rgba(9,18,32,0.72)",
        backdropFilter: "blur(6px)",
        color: "#f2f7ff",
        fontSize: "11px",
        lineHeight: "1",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        outline: "none",
        padding: "0",
        zIndex: "10",
    });
    btn.classList.add("cp-btn");
    btn.classList.add("cp-maptoggle");
    document.body.appendChild(btn);
    return btn;
};

/**
 * 3D / 2D 視点モード切替ボタン。
 *
 * コンパスボタン（top:12px right:12px の 40×40 円形）の直下に同幅・同色系で配置する。
 * ラベルは「次に切り替える先」を表示する（3D 表示中は `2D`、2D 表示中は `3D`）。
 */
const createViewModeToggleButton = (): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "2D";
    btn.tabIndex = 0;
    btn.setAttribute("aria-label", "視点切替: 2D に変更");
    css(btn, {
        position: "absolute",
        top: "60px",
        right: "12px",
        width: "40px",
        height: "40px",
        border: "none",
        borderRadius: "50%",
        background: "rgba(9,18,32,0.72)",
        backdropFilter: "blur(6px)",
        color: "#f2f7ff",
        fontSize: "13px",
        fontWeight: "bold",
        lineHeight: "1",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        outline: "none",
        padding: "0",
        zIndex: "10",
    });
    btn.classList.add("cp-btn");
    btn.classList.add("cp-viewmode");
    document.body.appendChild(btn);
    return btn;
};

/** きれいな数値にスナップ */
export const SCALE_STEPS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000,
];

export const snapScale = (meters: number): number => {
    for (const step of SCALE_STEPS) {
        if (step >= meters) return step;
    }
    return SCALE_STEPS[SCALE_STEPS.length - 1];
};

export const formatScale = (meters: number): string => {
    if (meters >= 1000) return `${meters / 1000} km`;
    return `${meters} m`;
};

let activeToast: HTMLDivElement | null = null;
let toastFadeTimer: ReturnType<typeof setTimeout> | null = null;
let toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;

const clearToastTimers = (): void => {
    if (toastFadeTimer !== null) {
        clearTimeout(toastFadeTimer);
        toastFadeTimer = null;
    }
    if (toastRemoveTimer !== null) {
        clearTimeout(toastRemoveTimer);
        toastRemoveTimer = null;
    }
};

const removeToastElement = (el: HTMLDivElement): void => {
    el.remove();
    if (activeToast === el) activeToast = null;
};

export const showToast = (message: string, durationMs = 3000): void => {
    clearToastTimers();
    if (activeToast) {
        activeToast.remove();
        activeToast = null;
    }

    const el = document.createElement("div");
    el.textContent = message;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    css(el, {
        position: "fixed",
        bottom: "60px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(9,18,32,0.85)",
        backdropFilter: "blur(6px)",
        color: "#f2f7ff",
        fontSize: "13px",
        lineHeight: "1.4",
        padding: "10px 16px",
        borderRadius: "8px",
        zIndex: "100",
        opacity: "0",
        transition: "opacity 0.3s ease",
        pointerEvents: "none",
        whiteSpace: "nowrap",
    });
    document.body.appendChild(el);
    activeToast = el;

    // フェードイン（強制リフローでトランジションを確実に発火）
    void el.offsetWidth;
    el.style.opacity = "1";

    // フェードアウト → DOM 削除
    toastFadeTimer = setTimeout(() => {
        toastFadeTimer = null;
        el.style.opacity = "0";
        el.addEventListener("transitionend", () => {
            if (toastRemoveTimer !== null) {
                clearTimeout(toastRemoveTimer);
                toastRemoveTimer = null;
            }
            removeToastElement(el);
        }, { once: true });
        // transitionend が発火しない場合のフォールバック（トランジション時間 + 余裕）
        toastRemoveTimer = setTimeout(() => {
            toastRemoveTimer = null;
            removeToastElement(el);
        }, 500);
    }, durationMs);
};

export const createControlPanel = (): ControlPanelElements => {
    // タッチ端末向けのレスポンシブ補正スタイルを注入（fine pointer では無効）。
    injectResponsiveStyle();

    // 方位磁針（画面右上に独立配置）
    const compass = createCompass();

    // 視点モード切替ボタン（コンパス直下に配置）。
    // Tab 順がコンパスの直後になるよう、DOM への追加順をコンパスの直後にする。
    const viewModeButton = createViewModeToggleButton();

    // ズームボタン＋スケールバー（画面右下に独立配置）
    const { locateMe, zoomIn, zoomOut, scaleBar } = createZoomButtons();

    // 地図切替ボタン（画面左下に配置）
    const mapToggle = createMapToggleButton();

    // スケールバー（ズームボタンコンテナ内に統合済み）

    return { compass, locateMe, zoomIn, zoomOut, mapToggle, viewModeButton, scaleBar };
};
