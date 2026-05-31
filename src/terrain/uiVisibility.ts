/**
 * UI コントロール（コンパス / ズームボタン / スケールバー / 地図切替 / 出典）の
 * 表示・非表示切替ロジック (T6 / Issue #120)。
 *
 * `controlPanel` は各要素にインライン `display: flex` 等を設定するため、
 * 単純に `style.display = ""` で復元すると元のレイアウトが失われる。
 * このモジュールは要素ごとの初期 `display` 値をスナップショットしておき、
 * 表示時にはその値で復元することでレイアウト崩れを防ぐ。
 */

export type UiVisibilityTarget =
    | "compass"
    | "zoomButtons"
    | "locateMe"
    | "scaleBar"
    | "mapToggle"
    | "viewModeButton"
    | "attribution";

export interface UiVisibilityElements {
    compass: HTMLElement;
    locateMe: HTMLElement;
    zoomIn: HTMLElement;
    zoomOut: HTMLElement;
    scaleBarBar: HTMLElement;
    scaleBarLabel: HTMLElement;
    mapToggle: HTMLElement;
    viewModeButton: HTMLElement;
    attribution: HTMLElement;
}

/**
 * 表示・非表示の切替関数を生成する。
 * 戻り値の関数は `setUiVisibility(target, visible)` の形で呼び出せる。
 */
export const createUiVisibilityController = (
    elements: UiVisibilityElements,
): ((target: UiVisibilityTarget, visible: boolean) => void) => {
    const captureDisplay = (el: HTMLElement): string => el.style.display || "";
    const initial: Record<keyof UiVisibilityElements, string> = {
        compass: captureDisplay(elements.compass),
        locateMe: captureDisplay(elements.locateMe),
        zoomIn: captureDisplay(elements.zoomIn),
        zoomOut: captureDisplay(elements.zoomOut),
        scaleBarBar: captureDisplay(elements.scaleBarBar),
        scaleBarLabel: captureDisplay(elements.scaleBarLabel),
        mapToggle: captureDisplay(elements.mapToggle),
        viewModeButton: captureDisplay(elements.viewModeButton),
        attribution: captureDisplay(elements.attribution),
    };
    const apply = (key: keyof UiVisibilityElements, visible: boolean): void => {
        elements[key].style.display = visible ? initial[key] : "none";
    };
    return (target, visible) => {
        switch (target) {
            case "compass":
                apply("compass", visible);
                break;
            case "zoomButtons":
                apply("locateMe", visible);
                apply("zoomIn", visible);
                apply("zoomOut", visible);
                break;
            case "locateMe":
                apply("locateMe", visible);
                break;
            case "scaleBar":
                apply("scaleBarBar", visible);
                apply("scaleBarLabel", visible);
                break;
            case "mapToggle":
                apply("mapToggle", visible);
                break;
            case "viewModeButton":
                apply("viewModeButton", visible);
                break;
            case "attribution":
                apply("attribution", visible);
                break;
        }
    };
};
