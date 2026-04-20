/** 操作UIパネル（緯度・経度）と方位磁針 */

import { JAPAN_BOUNDS } from "./gsiTile";

export interface ControlPanelElements {
    panel: HTMLDivElement;
    latInput: HTMLInputElement;
    lonInput: HTMLInputElement;
    updateButton: HTMLButtonElement;
    compass: HTMLDivElement;
    zoomIn: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
    mapToggle: HTMLButtonElement;
}

const css = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void => {
    Object.assign(el.style, styles);
};

const numberInput = (
    value: number,
    min: number,
    max: number,
    step: string
): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = step;
    css(input, { width: "90px", fontSize: "10px" });
    return input;
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
    zoomIn: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
} => {
    const container = document.createElement("div");
    css(container, {
        position: "absolute",
        bottom: "12px",
        right: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
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

    const zoomIn = makeBtn("+", "ズームイン");
    const zoomOut = makeBtn("−", "ズームアウト");
    container.appendChild(zoomIn);
    container.appendChild(zoomOut);
    document.body.appendChild(container);

    return { zoomIn, zoomOut };
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

export const createControlPanel = (
    initialLat: number,
    initialLon: number
): ControlPanelElements => {
    const panel = document.createElement("div");
    css(panel, {
        position: "absolute",
        top: "8px",
        left: "8px",
        padding: "4px 6px",
        borderRadius: "6px",
        background: "rgba(9,18,32,0.72)",
        color: "#f2f7ff",
        display: "grid",
        gridTemplateColumns: "auto auto auto",
        gap: "2px 4px",
        alignItems: "center",
        fontFamily: "'Helvetica Neue',Helvetica,Arial,sans-serif",
        fontSize: "10px",
        backdropFilter: "blur(6px)",
        zIndex: "10",
    });
    document.body.appendChild(panel);

    // 緯度
    const latLabel = document.createElement("label");
    latLabel.htmlFor = "cp-lat";
    latLabel.textContent = "緯度";
    css(latLabel, { gridColumn: "1", gridRow: "1" });
    panel.appendChild(latLabel);
    const latInput = numberInput(initialLat, JAPAN_BOUNDS.minLat, JAPAN_BOUNDS.maxLat, "0.0001");
    latInput.id = "cp-lat";
    css(latInput, { gridColumn: "2", gridRow: "1" });
    panel.appendChild(latInput);

    // 経度
    const lonLabel = document.createElement("label");
    lonLabel.htmlFor = "cp-lon";
    lonLabel.textContent = "経度";
    css(lonLabel, { gridColumn: "1", gridRow: "2" });
    panel.appendChild(lonLabel);
    const lonInput = numberInput(initialLon, JAPAN_BOUNDS.minLon, JAPAN_BOUNDS.maxLon, "0.0001");
    lonInput.id = "cp-lon";
    css(lonInput, { gridColumn: "2", gridRow: "2" });
    panel.appendChild(lonInput);

    // 更新ボタン（3列目に縦並び）
    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.textContent = "✓";
    updateButton.setAttribute("aria-label", "地形を更新");
    css(updateButton, {
        cursor: "pointer",
        padding: "1px 6px",
        gridRow: "1 / 3",
        gridColumn: "3",
        alignSelf: "stretch",
        fontSize: "12px",
        lineHeight: "1",
    });
    panel.appendChild(updateButton);

    // 方位磁針（画面右上に独立配置）
    const compass = createCompass();

    // ズームボタン（画面右下に独立配置）
    const { zoomIn, zoomOut } = createZoomButtons();

    // 地図切替ボタン（画面左下に配置）
    const mapToggle = createMapToggleButton();

    return { panel, latInput, lonInput, updateButton, compass, zoomIn, zoomOut, mapToggle };
};
