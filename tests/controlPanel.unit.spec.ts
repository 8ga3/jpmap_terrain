/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createControlPanel,
    formatScale,
    pickScaleWithin,
    SCALE_STEPS,
    showToast,
    snapScale,
} from "../src/terrain/controlPanel";

function cleanupDOM(): void {
    document.body.innerHTML = "";
    document.head.querySelectorAll("#cp-focus-style").forEach((el) => {
        el.remove();
    });
    document.head.querySelectorAll("#cp-responsive-style").forEach((el) => {
        el.remove();
    });
}

describe("createControlPanel locateMe ボタン", () => {
    afterEach(cleanupDOM);

    it("locateMe ボタンが存在する", () => {
        const panel = createControlPanel();
        expect(panel.locateMe).toBeInstanceOf(HTMLButtonElement);
    });

    it("locateMe の aria-label が '現在地を表示' である", () => {
        const panel = createControlPanel();
        expect(panel.locateMe.getAttribute("aria-label")).toBe("現在地を表示");
    });

    it("locateMe が zoomIn の前に配置されている", () => {
        const panel = createControlPanel();
        const parent = panel.locateMe.parentElement;
        if (parent === null) throw new Error("unreachable");
        const children = Array.from(parent.children);
        const locateIdx = children.indexOf(panel.locateMe);
        const zoomInIdx = children.indexOf(panel.zoomIn);
        expect(locateIdx).toBeLessThan(zoomInIdx);
    });

    it("locateMe に SVG アイコンが含まれている", () => {
        const panel = createControlPanel();
        const svg = panel.locateMe.querySelector("svg");
        expect(svg).not.toBeNull();
    });

    it("locateMe のサイズが 32×32px である", () => {
        const panel = createControlPanel();
        expect(panel.locateMe.style.width).toBe("32px");
        expect(panel.locateMe.style.height).toBe("32px");
    });
});

describe("createControlPanel attribution", () => {
    afterEach(cleanupDOM);

    it("scaleBar.attribution が地理院タイルへのリンクである", () => {
        const panel = createControlPanel();
        const link = panel.scaleBar.attribution;
        expect(link.tagName).toBe("A");
        expect(link.textContent).toBe("地理院タイル");
        expect(link.getAttribute("href")).toBe(
            "https://maps.gsi.go.jp/development/ichiran.html",
        );
        expect(link.target).toBe("_blank");
        expect(link.relList.contains("noopener")).toBe(true);
        expect(link.relList.contains("noreferrer")).toBe(true);
    });

    it("attribution が scaleContainer の先頭子要素である", () => {
        const panel = createControlPanel();
        const firstChild = panel.scaleBar.container.firstElementChild;
        expect(firstChild).toBe(panel.scaleBar.attribution);
    });

    it("attribution に pointerEvents: auto が設定されている", () => {
        const panel = createControlPanel();
        expect(panel.scaleBar.attribution.style.pointerEvents).toBe("auto");
    });
});

describe("createControlPanel pointerEvents 透過", () => {
    afterEach(cleanupDOM);

    it("ズームボタンのコンテナ div に pointerEvents: none が設定されている", () => {
        const panel = createControlPanel();
        const container = panel.zoomIn.parentElement;
        if (container === null) throw new Error("unreachable");
        expect(container.style.pointerEvents).toBe("none");
    });

    it("zoomIn ボタンに pointerEvents: auto が設定されている", () => {
        const panel = createControlPanel();
        expect(panel.zoomIn.style.pointerEvents).toBe("auto");
    });

    it("zoomOut ボタンに pointerEvents: auto が設定されている", () => {
        const panel = createControlPanel();
        expect(panel.zoomOut.style.pointerEvents).toBe("auto");
    });

    it("locateMe ボタンに pointerEvents: auto が設定されている", () => {
        const panel = createControlPanel();
        expect(panel.locateMe.style.pointerEvents).toBe("auto");
    });
});

describe("createControlPanel レスポンシブ対応", () => {
    afterEach(cleanupDOM);

    it("coarse pointer 用のレスポンシブスタイルが head に注入される", () => {
        createControlPanel();
        const style = document.getElementById("cp-responsive-style");
        if (style === null) throw new Error("unreachable");
        expect(style.tagName).toBe("STYLE");
        expect(style.textContent).toContain("(pointer: coarse)");
    });

    it("レスポンシブスタイルは複数回呼んでも 1 つだけ注入される", () => {
        createControlPanel();
        cleanupDOM();
        createControlPanel();
        createControlPanel();
        const styles = document.head.querySelectorAll("#cp-responsive-style");
        expect(styles.length).toBe(1);
    });

    it("ズームボタンに cp-zoombtn クラスが付与される（タップ領域拡大対象）", () => {
        const panel = createControlPanel();
        expect(panel.zoomIn.classList.contains("cp-zoombtn")).toBe(true);
        expect(panel.zoomOut.classList.contains("cp-zoombtn")).toBe(true);
        expect(panel.locateMe.classList.contains("cp-zoombtn")).toBe(true);
    });

    it("地図切替/視点切替ボタンに識別クラスが付与される", () => {
        const panel = createControlPanel();
        expect(panel.mapToggle.classList.contains("cp-maptoggle")).toBe(true);
        expect(panel.viewModeButton.classList.contains("cp-viewmode")).toBe(
            true,
        );
    });

    it("ボタンに touch-action: manipulation が適用される（ダブルタップズーム抑止）", () => {
        createControlPanel();
        const style = document.getElementById("cp-focus-style");
        if (style === null) throw new Error("unreachable");
        expect(style.textContent).toContain("touch-action: manipulation");
    });

    it("スケールバーのテキスト要素に cp-scale-text クラスが付与される", () => {
        const panel = createControlPanel();
        expect(panel.scaleBar.label.classList.contains("cp-scale-text")).toBe(
            true,
        );
        expect(
            panel.scaleBar.attribution.classList.contains("cp-scale-text"),
        ).toBe(true);
    });
});

describe("snapScale", () => {
    it("小さい値は最小ステップ (1) にスナップされる", () => {
        expect(snapScale(0.5)).toBe(1);
    });

    it("ちょうどステップ値の場合はその値を返す", () => {
        expect(snapScale(100)).toBe(100);
        expect(snapScale(1000)).toBe(1000);
    });

    it("ステップ間の値は次のステップにスナップされる", () => {
        expect(snapScale(3)).toBe(5);
        expect(snapScale(7)).toBe(10);
        expect(snapScale(15)).toBe(20);
        expect(snapScale(30)).toBe(50);
        expect(snapScale(150)).toBe(200);
        expect(snapScale(600)).toBe(1000);
        expect(snapScale(3000)).toBe(5000);
    });

    it("最大ステップを超える値は最大ステップを返す", () => {
        expect(snapScale(200_000)).toBe(SCALE_STEPS[SCALE_STEPS.length - 1]);
    });

    it("全ステップが昇順である", () => {
        for (let i = 1; i < SCALE_STEPS.length; i++) {
            expect(SCALE_STEPS[i]).toBeGreaterThan(SCALE_STEPS[i - 1]);
        }
    });
});

describe("pickScaleWithin", () => {
    it("maxBarPx が十分大きいときは snapScale と同じきれいな値を選ぶ", () => {
        // metersPerPx=2, basePx=100 → rawMeters=200 → snapped=200, barPx=100
        const r = pickScaleWithin(2, 100, 10_000);
        expect(r.meters).toBe(200);
        expect(r.barPx).toBe(100);
    });

    it("切り上げでバーが広がるケースでも上限内に収める（段階を下げる）", () => {
        // metersPerPx=2.01, basePx=100 → rawMeters≈201 → snapped=500 → barPx≈249
        const wide = pickScaleWithin(2.01, 100, 10_000);
        expect(wide.meters).toBe(500);
        expect(wide.barPx).toBeGreaterThan(200);
        // 上限 120px を与えると 1 段階下げて 200m（barPx≈100）に収まる
        const capped = pickScaleWithin(2.01, 100, 120);
        expect(capped.meters).toBe(200);
        expect(capped.barPx).toBeLessThanOrEqual(120);
    });

    it("最小ステップでも上限を超える場合は最小ステップを返す", () => {
        // metersPerPx=1, smallest step=1 → barPx=1。maxBarPx=0.5 でも 1m を返す
        const r = pickScaleWithin(1, 100, 0.5);
        expect(r.meters).toBe(SCALE_STEPS[0]);
    });

    it("round 後のバー幅が maxBarPx を超えないよう段階を下げる", () => {
        // 100m / mpp ≈ 100.55px。Math.round で 101px となり、上限 100.6px を
        // 超えてしまう（小数判定だけでは見逃すケース）。round 後の幅で判定し、
        // 1 段下げて上限以下に収まることを検証する。
        const mpp = 100 / 100.55;
        const max = 100.6;
        const r = pickScaleWithin(mpp, 100, max);
        expect(r.barPx).toBeLessThanOrEqual(max);
    });

    it("metersPerPx が不正（0/NaN）なら barPx 0 を返す", () => {
        expect(pickScaleWithin(0, 100, 100).barPx).toBe(0);
        expect(pickScaleWithin(Number.NaN, 100, 100).barPx).toBe(0);
    });

    it("選んだバー幅は可能な限り maxBarPx 以下に収まる", () => {
        for (const mpp of [0.3, 1, 3.7, 50, 1234]) {
            const r = pickScaleWithin(mpp, 100, 90);
            // 最小ステップで超過する場合を除き上限以下
            if (r.meters !== SCALE_STEPS[0]) {
                expect(r.barPx).toBeLessThanOrEqual(90);
            }
        }
    });
});

describe("formatScale", () => {
    it("1000m 未満は m 表記", () => {
        expect(formatScale(1)).toBe("1 m");
        expect(formatScale(500)).toBe("500 m");
        expect(formatScale(999)).toBe("999 m");
    });

    it("1000m 以上は km 表記", () => {
        expect(formatScale(1000)).toBe("1 km");
        expect(formatScale(5000)).toBe("5 km");
        expect(formatScale(10_000)).toBe("10 km");
        expect(formatScale(100_000)).toBe("100 km");
    });

    it("2000m は 2 km と表示", () => {
        expect(formatScale(2000)).toBe("2 km");
    });
});

describe("showToast", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = "";
    });

    afterEach(() => {
        vi.useRealTimers();
        cleanupDOM();
    });

    it("DOM にトースト要素が追加される", () => {
        showToast("テストメッセージ");
        const toast = document.querySelector("[role='status']");
        if (toast === null) throw new Error("unreachable");
        expect(toast.textContent).toBe("テストメッセージ");
    });

    it("aria-live=polite が設定されている", () => {
        showToast("テスト");
        const toast = document.querySelector("[role='status']");
        if (toast === null) throw new Error("unreachable");
        expect(toast.getAttribute("aria-live")).toBe("polite");
    });

    it("指定時間後に opacity が 0 になる", () => {
        showToast("テスト", 2000);
        const toast = document.querySelector("[role='status']") as HTMLElement;
        vi.advanceTimersByTime(2000);
        expect(toast.style.opacity).toBe("0");
    });

    it("transitionend 発火後に要素が DOM から除去される", () => {
        showToast("テスト", 1000);
        const toast = document.querySelector("[role='status']") as HTMLElement;
        vi.advanceTimersByTime(1000);
        toast.dispatchEvent(new Event("transitionend"));
        expect(document.querySelector("[role='status']")).toBeNull();
    });

    it("複数呼び出し時に前のトーストが除去される", () => {
        showToast("1つ目");
        showToast("2つ目");
        const toasts = document.querySelectorAll("[role='status']");
        expect(toasts.length).toBe(1);
        expect(toasts[0].textContent).toBe("2つ目");
    });

    it("置き換え時に古いタイマーが発火しない", () => {
        showToast("古い", 1000);
        vi.advanceTimersByTime(500);
        showToast("新しい", 1000);
        // 古い setTimeout の残り 500ms を経過させても新しいトーストは残る
        vi.advanceTimersByTime(500);
        const current = document.querySelector(
            "[role='status']",
        ) as HTMLElement;
        expect(current.textContent).toBe("新しい");
        expect(current.style.opacity).toBe("1");
    });

    it("transitionend が来ない場合でもフォールバックタイマーで除去される", () => {
        showToast("テスト", 1000);
        const toast = document.querySelector("[role='status']") as HTMLElement;
        // フェードアウト開始
        vi.advanceTimersByTime(1000);
        expect(toast.style.opacity).toBe("0");
        // transitionend を発火させず、フォールバック 500ms を経過
        vi.advanceTimersByTime(500);
        expect(document.querySelector("[role='status']")).toBeNull();
    });
});
