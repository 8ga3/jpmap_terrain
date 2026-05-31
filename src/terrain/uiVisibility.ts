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
    // locateMe ボタンは視覚的にズーム操作群の一部であり、`zoomButtons` を
    // 非表示にしたときは一緒に隠す必要がある。一方で `showLocateMe` による
    // 個別制御も保ちたい。そこで両者の状態を別々に保持し、locateMe の実表示は
    // 「zoomButtons と locateMe の両方が true のときだけ表示」に合成する。
    // これにより、片方を切り替えてももう片方の意図が壊れない。
    let zoomButtonsVisible = true;
    let locateMeVisible = true;
    const applyLocateMe = (): void => {
        apply("locateMe", zoomButtonsVisible && locateMeVisible);
    };
    return (target, visible) => {
        switch (target) {
            case "compass":
                apply("compass", visible);
                break;
            case "zoomButtons":
                zoomButtonsVisible = visible;
                apply("zoomIn", visible);
                apply("zoomOut", visible);
                applyLocateMe();
                break;
            case "locateMe":
                locateMeVisible = visible;
                applyLocateMe();
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
