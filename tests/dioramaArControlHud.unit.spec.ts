// @vitest-environment jsdom
/**
 * `dioramaArControlHud.ts` のunit test。
 *
 * @remarks
 * jsdom は `getBoundingClientRect` が常にゼロ矩形を返すため、ジョイスティックの
 * ドラッグ量計算（`clientX - centerX`）は実質 `clientX` そのものになる。
 * `setPointerCapture` は jsdom 未実装のため、実装側でオプショナル呼び出し
 * （`?.()`）にしてある前提でテストする。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createDioramaArControlHud, type DioramaArControlHud } from "../src/demos/diorama/dioramaArControlHud";

const dispatchPointer = (
    target: HTMLElement,
    type: string,
    props: { pointerId?: number; clientX?: number; clientY?: number },
): void => {
    target.dispatchEvent(
        new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            clientX: 0,
            clientY: 0,
            ...props,
        }),
    );
};

const huds: DioramaArControlHud[] = [];
const build = (): DioramaArControlHud => {
    const hud = createDioramaArControlHud();
    document.body.appendChild(hud.element);
    huds.push(hud);
    return hud;
};

afterEach(() => {
    for (const hud of huds.splice(0)) hud.dispose();
});

describe("createDioramaArControlHud", () => {
    it("ジョイスティック要素とズームボタン(+/-)を含むDOM構造を生成する", () => {
        const hud = build();
        const buttons = hud.element.querySelectorAll("button");
        expect(buttons.length).toBe(2);
        expect(buttons[0]?.getAttribute("aria-label")).toBe("ズームイン");
        expect(buttons[1]?.getAttribute("aria-label")).toBe("ズームアウト");
    });

    it("初期状態のパン軸・ズーム軸は0", () => {
        const hud = build();
        expect(hud.getPanAxes()).toEqual({ x: 0, y: 0 });
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("ジョイスティックをドラッグするとパン軸が更新され、離すと0に戻る", () => {
        const hud = build();
        const joystick = hud.element.children[0] as HTMLElement;

        dispatchPointer(joystick, "pointerdown", { clientX: 20, clientY: -10 });
        const axes = hud.getPanAxes();
        expect(axes.x).toBeGreaterThan(0);
        expect(axes.y).toBeLessThan(0);

        dispatchPointer(joystick, "pointerup", {});
        expect(hud.getPanAxes()).toEqual({ x: 0, y: 0 });
    });

    it("最大半径を超えるドラッグは単位ベクトルへクランプされる（磁気1以内）", () => {
        const hud = build();
        const joystick = hud.element.children[0] as HTMLElement;

        // 最大オフセット(28px)より大きく倒す。
        dispatchPointer(joystick, "pointerdown", { clientX: 1000, clientY: 0 });
        const axes = hud.getPanAxes();
        const magnitude = Math.hypot(axes.x, axes.y);
        expect(magnitude).toBeCloseTo(1, 5);
    });

    it("ドラッグ中に別のpointerIdの操作は無視される（同時2本指操作を避ける）", () => {
        const hud = build();
        const joystick = hud.element.children[0] as HTMLElement;

        dispatchPointer(joystick, "pointerdown", { pointerId: 1, clientX: 20, clientY: 0 });
        const firstAxes = hud.getPanAxes();
        dispatchPointer(joystick, "pointermove", { pointerId: 2, clientX: -20, clientY: 0 });
        // pointerId=2 は無視されるため軸は変わらない。
        expect(hud.getPanAxes()).toEqual(firstAxes);
    });

    it("ズームボタン「+」押下でズーム軸が-1、離すと0に戻る", () => {
        const hud = build();
        const zoomInButton = hud.element.querySelectorAll("button")[0] as HTMLButtonElement;

        dispatchPointer(zoomInButton, "pointerdown", {});
        expect(hud.getZoomAxis()).toBe(-1);
        dispatchPointer(zoomInButton, "pointerup", {});
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("ズームボタン「-」押下でズーム軸が+1、離すと0に戻る", () => {
        const hud = build();
        const zoomOutButton = hud.element.querySelectorAll("button")[1] as HTMLButtonElement;

        dispatchPointer(zoomOutButton, "pointerdown", {});
        expect(hud.getZoomAxis()).toBe(1);
        dispatchPointer(zoomOutButton, "pointercancel", {});
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("dispose()はHUD要素をDOMから除去する", () => {
        const hud = build();
        expect(document.body.contains(hud.element)).toBe(true);
        hud.dispose();
        expect(document.body.contains(hud.element)).toBe(false);
        // afterEachで二重disposeされてもエラーにならないことを確認するため配列から外す。
        huds.pop();
    });
});
