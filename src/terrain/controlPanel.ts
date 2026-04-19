/** 操作UIパネル（緯度・経度）と方位磁針 */

export interface ControlPanelElements {
    panel: HTMLDivElement;
    latInput: HTMLInputElement;
    lonInput: HTMLInputElement;
    updateButton: HTMLButtonElement;
    compass: HTMLDivElement;
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

    document.body.appendChild(container);
    return container;
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
    const latLabel = document.createElement("span");
    latLabel.textContent = "緯度";
    panel.appendChild(latLabel);
    const latInput = numberInput(initialLat, 20, 46, "0.0001");
    panel.appendChild(latInput);

    // 経度
    const lonLabel = document.createElement("span");
    lonLabel.textContent = "経度";
    panel.appendChild(lonLabel);
    const lonInput = numberInput(initialLon, 122, 154, "0.0001");
    panel.appendChild(lonInput);

    // 更新ボタン（3列目に縦並び）
    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.textContent = "✓";
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

    return { panel, latInput, lonInput, updateButton, compass };
};
