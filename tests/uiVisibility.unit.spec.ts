/**
 * @jest-environment jsdom
 */
/**
 * UI visibility controller のユニットテスト (T6)。
 *
 * controlPanel の各要素が初期状態で `display: flex` 等のインライン style を持つ場合、
 * 単純に `style.display = ""` で復元すると元のレイアウトが失われる。
 * このテストでは「初期 display を保持しているか」「false → true で元の値に戻るか」を検証する。
 */

import { describe, it, expect, beforeEach } from "@jest/globals";

import {
    createUiVisibilityController,
    UiVisibilityElements,
} from "../src/terrain/uiVisibility";

describe("createUiVisibilityController (T6)", () => {
    const setupElements = (): UiVisibilityElements => {
        const make = (display: string): HTMLDivElement => {
            const el = document.createElement("div");
            if (display) el.style.display = display;
            return el;
        };
        return {
            compass: make("flex"),
            locateMe: make("flex"),
            zoomIn: make("flex"),
            zoomOut: make("flex"),
            scaleBarBar: make(""),
            scaleBarLabel: make(""),
            mapToggle: make("flex"),
            viewModeButton: make("flex"),
            attribution: make(""),
        };
    };

    let elements: UiVisibilityElements;
    let setUi: ReturnType<typeof createUiVisibilityController>;

    beforeEach(() => {
        elements = setupElements();
        setUi = createUiVisibilityController(elements);
    });

    it("非表示にすると display=none、再表示で初期 display 値（例: flex）が復元される", () => {
        setUi("compass", false);
        expect(elements.compass.style.display).toBe("none");

        setUi("compass", true);
        expect(elements.compass.style.display).toBe("flex");
    });

    it("初期 display が空の要素は再表示で空文字に戻る（block / inline 等のデフォルト維持）", () => {
        setUi("attribution", false);
        expect(elements.attribution.style.display).toBe("none");

        setUi("attribution", true);
        expect(elements.attribution.style.display).toBe("");
    });

    it("zoomButtons は locateMe / zoomIn / zoomOut すべてに適用される", () => {
        setUi("zoomButtons", false);
        expect(elements.locateMe.style.display).toBe("none");
        expect(elements.zoomIn.style.display).toBe("none");
        expect(elements.zoomOut.style.display).toBe("none");

        setUi("zoomButtons", true);
        expect(elements.locateMe.style.display).toBe("flex");
        expect(elements.zoomIn.style.display).toBe("flex");
        expect(elements.zoomOut.style.display).toBe("flex");
    });

    it("locateMe と zoomButtons は独立に制御でき、表示は両者の AND で合成される", () => {
        // locateMe を個別に非表示 → zoomIn/zoomOut は影響を受けない
        setUi("locateMe", false);
        expect(elements.locateMe.style.display).toBe("none");
        expect(elements.zoomIn.style.display).toBe("flex");
        expect(elements.zoomOut.style.display).toBe("flex");

        // この状態で zoomButtons を true に切り替えても、locateMe は再表示されない
        setUi("zoomButtons", true);
        expect(elements.locateMe.style.display).toBe("none");
        expect(elements.zoomIn.style.display).toBe("flex");

        // locateMe を true に戻すと表示される（両方 true）
        setUi("locateMe", true);
        expect(elements.locateMe.style.display).toBe("flex");

        // zoomButtons を false にすると locateMe も一緒に隠れる
        setUi("zoomButtons", false);
        expect(elements.locateMe.style.display).toBe("none");
    });

    it("scaleBar は bar / label の両方に適用される", () => {
        setUi("scaleBar", false);
        expect(elements.scaleBarBar.style.display).toBe("none");
        expect(elements.scaleBarLabel.style.display).toBe("none");

        setUi("scaleBar", true);
        expect(elements.scaleBarBar.style.display).toBe("");
        expect(elements.scaleBarLabel.style.display).toBe("");
    });

    it("mapToggle / attribution が個別に切り替えできる", () => {
        setUi("mapToggle", false);
        expect(elements.mapToggle.style.display).toBe("none");
        // 他要素は影響を受けない
        expect(elements.compass.style.display).toBe("flex");
        expect(elements.attribution.style.display).toBe("");

        setUi("mapToggle", true);
        expect(elements.mapToggle.style.display).toBe("flex");
    });
});
