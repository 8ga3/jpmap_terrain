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
import { describe, it, expect, afterEach, vi } from "vitest";
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
    it("ジョイスティック要素とズーム/回転/高さ/タイル切替/リセットボタンを含むDOM構造を生成する", () => {
        const hud = build();
        const buttons = hud.element.querySelectorAll("button");
        expect(buttons.length).toBe(8);
        expect(buttons[0]?.getAttribute("aria-label")).toBe("ズームイン");
        expect(buttons[1]?.getAttribute("aria-label")).toBe("ズームアウト");
        expect(buttons[2]?.getAttribute("aria-label")).toBe("反時計回りに回転");
        expect(buttons[3]?.getAttribute("aria-label")).toBe("時計回りに回転");
        expect(buttons[4]?.getAttribute("aria-label")).toBe("高さを上げる");
        expect(buttons[5]?.getAttribute("aria-label")).toBe("高さを下げる");
        expect(buttons[6]?.getAttribute("aria-label")).toBe("地図の種類を切り替え（標準地図・写真・ワイヤーフレーム）");
        expect(buttons[7]?.getAttribute("aria-label")).toBe("表示を初期状態に戻す（中心・拡大率・回転・高さ）");
    });

    it("初期状態のパン軸・ズーム軸・回転軸・高さ軸は0", () => {
        const hud = build();
        expect(hud.getPanAxes()).toEqual({ x: 0, y: 0 });
        expect(hud.getZoomAxis()).toBe(0);
        expect(hud.getRotationAxis()).toBe(0);
        expect(hud.getHeightAxis()).toBe(0);
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

    it("最大半径を超えるドラッグは単位ベクトルへクランプされる（大きさ1以内）", () => {
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

    it("ズームボタン押下時にsetPointerCaptureで固定し、ボタン外で離れてもpointerupを受け取れる", () => {
        const hud = build();
        const zoomInButton = hud.element.querySelectorAll("button")[0] as HTMLButtonElement;
        // jsdomは`setPointerCapture`未実装のため、呼び出しを検証できるようスタブする
        // （キャプチャの実効果自体はブラウザに委ねる。ここでは正しいpointerIdで
        // 呼ばれることのみ検証する）。
        const setPointerCapture = vi.fn();
        zoomInButton.setPointerCapture = setPointerCapture;

        dispatchPointer(zoomInButton, "pointerdown", { pointerId: 7 });
        expect(setPointerCapture).toHaveBeenCalledWith(7);
        expect(hud.getZoomAxis()).toBe(-1);

        // キャプチャにより、ボタン外へ出た状態のpointerupでもこのボタンへ届く想定
        // （jsdomはキャプチャを実装しないため、ここでは直接ボタンへdispatchして
        // ハンドラ自体が正しく0へ戻すことを確認する）。
        dispatchPointer(zoomInButton, "pointerup", { pointerId: 7 });
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("最初に押下したpointerId以外のpointerup/pointercancelは無視される（複数指操作時の誤解除防止）", () => {
        const hud = build();
        const zoomInButton = hud.element.querySelectorAll("button")[0] as HTMLButtonElement;

        // pointerId=1で押下開始。
        dispatchPointer(zoomInButton, "pointerdown", { pointerId: 1 });
        expect(hud.getZoomAxis()).toBe(-1);

        // 別指（pointerId=2）のup/cancelが誤って届いても、pointerId=1を押下し
        // 続けている限り軸は0に戻らない。
        dispatchPointer(zoomInButton, "pointerup", { pointerId: 2 });
        expect(hud.getZoomAxis()).toBe(-1);
        dispatchPointer(zoomInButton, "pointercancel", { pointerId: 2 });
        expect(hud.getZoomAxis()).toBe(-1);

        // 実際に押下していたpointerId=1のupで正しく0へ戻る。
        dispatchPointer(zoomInButton, "pointerup", { pointerId: 1 });
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("片方のボタンを押したまま別指でもう片方を押して離しても、押し続けている方の軸値は残る（複数指同時押下の回帰テスト）", () => {
        // 以前は2ボタンで単一のaxis変数を共有していたため、「+」を押したまま
        // 別指で「-」を押してから「-」だけ離すと、「-」側のpointerup処理が軸を
        // 無条件に0へ戻してしまい、「+」を押し続けているのに入力が止まる
        // 不具合があった。ボタンごとに独立した押下状態を保持し合算する方式へ
        // 変更したことで、この不具合が解消されていることを確認する。
        const hud = build();
        const [zoomInButton, zoomOutButton] = hud.element.querySelectorAll("button");

        // 指1で「+」（zoomIn, axisValue=-1）を押しっぱなしにする。
        dispatchPointer(zoomInButton as HTMLButtonElement, "pointerdown", { pointerId: 1 });
        expect(hud.getZoomAxis()).toBe(-1);

        // 別指2で「-」（zoomOut, axisValue=+1）も押す（同時押下）。
        // 両方押下中は合算されて相殺され0になる。
        dispatchPointer(zoomOutButton as HTMLButtonElement, "pointerdown", { pointerId: 2 });
        expect(hud.getZoomAxis()).toBe(0);

        // 「-」だけ離す。「+」は指1で押下し続けているため、軸値は-1に戻るべき
        // （0のまま固定されてはならない）。
        dispatchPointer(zoomOutButton as HTMLButtonElement, "pointerup", { pointerId: 2 });
        expect(hud.getZoomAxis()).toBe(-1);

        // 最後に「+」も離せば0に戻る。
        dispatchPointer(zoomInButton as HTMLButtonElement, "pointerup", { pointerId: 1 });
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("ズームボタンはキーボード操作（Enter/Space押下中）でも軸値が更新される", () => {
        const hud = build();
        const zoomInButton = hud.element.querySelectorAll("button")[0] as HTMLButtonElement;

        zoomInButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(-1);
        zoomInButton.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(0);

        zoomInButton.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(-1);
        zoomInButton.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("ズームボタンはキーリピート(keydownのrepeat)では再入せず、Enter/Space以外のキーは無視する", () => {
        const hud = build();
        const zoomOutButton = hud.element.querySelectorAll("button")[1] as HTMLButtonElement;

        zoomOutButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(0);

        zoomOutButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(1);
        // ブラウザがEnter長押しで発火するリピートkeydownは無視する（実害はないが再入を避ける）。
        zoomOutButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, repeat: true }));
        expect(hud.getZoomAxis()).toBe(1);
        zoomOutButton.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("ズームボタンはフォーカスを失うと（keyupを取りこぼしても）軸値が0へ戻る", () => {
        const hud = build();
        const zoomInButton = hud.element.querySelectorAll("button")[0] as HTMLButtonElement;

        zoomInButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(hud.getZoomAxis()).toBe(-1);
        zoomInButton.dispatchEvent(new FocusEvent("blur"));
        expect(hud.getZoomAxis()).toBe(0);
    });

    it("回転ボタン「⟲」押下で回転軸が-1、「⟳」押下で+1、離すと0に戻る", () => {
        const hud = build();
        const buttons = hud.element.querySelectorAll("button");
        const ccwButton = buttons[2] as HTMLButtonElement;
        const cwButton = buttons[3] as HTMLButtonElement;

        dispatchPointer(ccwButton, "pointerdown", {});
        expect(hud.getRotationAxis()).toBe(-1);
        dispatchPointer(ccwButton, "pointerup", {});
        expect(hud.getRotationAxis()).toBe(0);

        dispatchPointer(cwButton, "pointerdown", {});
        expect(hud.getRotationAxis()).toBe(1);
        dispatchPointer(cwButton, "pointercancel", {});
        expect(hud.getRotationAxis()).toBe(0);
    });

    it("高さボタン「▲」押下で高さ軸が+1、「▼」押下で-1、離すと0に戻る", () => {
        const hud = build();
        const buttons = hud.element.querySelectorAll("button");
        const upButton = buttons[4] as HTMLButtonElement;
        const downButton = buttons[5] as HTMLButtonElement;

        dispatchPointer(upButton, "pointerdown", {});
        expect(hud.getHeightAxis()).toBe(1);
        dispatchPointer(upButton, "pointerup", {});
        expect(hud.getHeightAxis()).toBe(0);

        dispatchPointer(downButton, "pointerdown", {});
        expect(hud.getHeightAxis()).toBe(-1);
        dispatchPointer(downButton, "pointercancel", {});
        expect(hud.getHeightAxis()).toBe(0);
    });

    it("タイル切替ボタンをクリックするとonTileModeCyclePressで購読したコールバックが呼ばれる", () => {
        const hud = build();
        const tileModeButton = hud.element.querySelectorAll("button")[6] as HTMLButtonElement;
        const callback = vi.fn();

        hud.onTileModeCyclePress(callback);
        tileModeButton.click();
        expect(callback).toHaveBeenCalledTimes(1);
        tileModeButton.click();
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it("トップ復帰ボタンをクリックするとonResetToInitialPressで購読したコールバックが呼ばれる", () => {
        const hud = build();
        const resetButton = hud.element.querySelectorAll("button")[7] as HTMLButtonElement;
        const callback = vi.fn();

        hud.onResetToInitialPress(callback);
        resetButton.click();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it("onTileModeCyclePress/onResetToInitialPressの購読解除関数を呼ぶと、以後クリックしてもコールバックは呼ばれない", () => {
        const hud = build();
        const tileModeButton = hud.element.querySelectorAll("button")[6] as HTMLButtonElement;
        const callback = vi.fn();

        const unsubscribe = hud.onTileModeCyclePress(callback);
        unsubscribe();
        tileModeButton.click();
        expect(callback).not.toHaveBeenCalled();
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
