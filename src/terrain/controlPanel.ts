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
    scaleBar: ScaleBarElement;
}

const css = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void => {
    Object.assign(el.style, styles);
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
    if (!document.getElementById("cp-compass-style")) {
        const style = document.createElement("style");
        style.id = "cp-compass-style";
        style.textContent = [
            ".cp-compass { outline: none; }",
            ".cp-compass:focus { box-shadow: 0 0 0 2px #90caf9; }",
            ".cp-compass:focus:not(:focus-visible) { box-shadow: none; }",
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
        });
        btn.addEventListener("focus", () => {
            if (btn.matches(":focus-visible")) {
                btn.style.boxShadow = "0 0 0 2px #90caf9";
            }
        });
        btn.addEventListener("blur", () => {
            btn.style.boxShadow = "";
        });
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
    btn.addEventListener("focus", () => {
        if (btn.matches(":focus-visible")) {
            btn.style.boxShadow = "0 0 0 2px #90caf9";
        }
    });
    btn.addEventListener("blur", () => {
        btn.style.boxShadow = "";
    });
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

export const createControlPanel = (): ControlPanelElements => {
    // 方位磁針（画面右上に独立配置）
    const compass = createCompass();

    // ズームボタン＋スケールバー（画面右下に独立配置）
    const { locateMe, zoomIn, zoomOut, scaleBar } = createZoomButtons();

    // 地図切替ボタン（画面左下に配置）
    const mapToggle = createMapToggleButton();

    // スケールバー（ズームボタンコンテナ内に統合済み）

    return { compass, locateMe, zoomIn, zoomOut, mapToggle, scaleBar };
};
