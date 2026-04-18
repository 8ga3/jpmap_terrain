/** 操作UIパネル（緯度・経度・高度・カメラ制御） */

export interface ControlPanelElements {
    panel: HTMLDivElement;
    status: HTMLDivElement;
    latInput: HTMLInputElement;
    lonInput: HTMLInputElement;
    altitudeInput: HTMLInputElement;
    cameraAlphaInput: HTMLInputElement;
    cameraBetaInput: HTMLInputElement;
    cameraRadiusInput: HTMLInputElement;
    updateButton: HTMLButtonElement;
}

const css = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void => {
    Object.assign(el.style, styles);
};

const createLabel = (text: string): HTMLLabelElement => {
    const label = document.createElement("label");
    label.textContent = text;
    css(label, { display: "grid", gap: "4px" });
    return label;
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
    css(input, { width: "100%" });
    return input;
};

const rangeInput = (
    value: number,
    min: number,
    max: number,
    step: string
): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "range";
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = step;
    css(input, { width: "100%" });
    return input;
};

export interface CameraDefaults {
    alpha: number;
    beta: number;
    radius: number;
}

export const createControlPanel = (
    initialLat: number,
    initialLon: number,
    cameraDefaults: CameraDefaults
): ControlPanelElements => {
    const panel = document.createElement("div");
    css(panel, {
        position: "absolute",
        top: "12px",
        left: "12px",
        padding: "12px",
        borderRadius: "8px",
        background: "rgba(9,18,32,0.72)",
        color: "#f2f7ff",
        display: "grid",
        gap: "8px",
        minWidth: "280px",
        fontFamily: "'Helvetica Neue',Helvetica,Arial,sans-serif",
        fontSize: "13px",
        backdropFilter: "blur(6px)",
        zIndex: "10",
    });
    document.body.appendChild(panel);

    // ステータス
    const status = document.createElement("div");
    status.textContent = "タイル読込待機中…";
    css(status, { fontSize: "12px" });
    panel.appendChild(status);

    // 緯度
    const latLabel = createLabel("緯度");
    const latInput = numberInput(initialLat, 20, 46, "0.0001");
    latLabel.appendChild(latInput);
    panel.appendChild(latLabel);

    // 経度
    const lonLabel = createLabel("経度");
    const lonInput = numberInput(initialLon, 122, 154, "0.0001");
    lonLabel.appendChild(lonInput);
    panel.appendChild(lonLabel);

    // 高度オフセット
    const altLabel = createLabel("高度オフセット [m]");
    const altitudeInput = numberInput(0, -2000, 8000, "1");
    altLabel.appendChild(altitudeInput);
    panel.appendChild(altLabel);

    // カメラパン
    const alphaLabel = createLabel("カメラパン（方位）");
    const cameraAlphaInput = rangeInput(
        cameraDefaults.alpha,
        -Math.PI,
        Math.PI,
        "0.01"
    );
    alphaLabel.appendChild(cameraAlphaInput);
    panel.appendChild(alphaLabel);

    // カメラチルト
    const betaLabel = createLabel("カメラチルト");
    const cameraBetaInput = rangeInput(cameraDefaults.beta, 0.2, 1.5, "0.01");
    betaLabel.appendChild(cameraBetaInput);
    panel.appendChild(betaLabel);

    // カメラズーム
    const radiusLabel = createLabel("カメラズーム");
    const cameraRadiusInput = rangeInput(
        cameraDefaults.radius,
        250,
        15000,
        "10"
    );
    radiusLabel.appendChild(cameraRadiusInput);
    panel.appendChild(radiusLabel);

    // 更新ボタン
    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.textContent = "地形を更新";
    css(updateButton, { cursor: "pointer", padding: "8px 10px" });
    panel.appendChild(updateButton);

    return {
        panel,
        status,
        latInput,
        lonInput,
        altitudeInput,
        cameraAlphaInput,
        cameraBetaInput,
        cameraRadiusInput,
        updateButton,
    };
};
