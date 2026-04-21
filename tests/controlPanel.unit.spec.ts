/**
 * @jest-environment jsdom
 */
import { snapScale, formatScale, SCALE_STEPS, createControlPanel } from "../src/terrain/controlPanel";

describe("createControlPanel attribution", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        document.head.querySelectorAll("#cp-compass-style").forEach((el) => el.remove());
    });

    it("scaleBar.attribution が地理院タイルへのリンクである", () => {
        const panel = createControlPanel();
        const link = panel.scaleBar.attribution;
        expect(link.tagName).toBe("A");
        expect(link.textContent).toBe("地理院タイル");
        expect(link.getAttribute("href")).toBe("https://maps.gsi.go.jp/development/ichiran.html");
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
