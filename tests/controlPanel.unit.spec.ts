import { snapScale, formatScale, SCALE_STEPS } from "../src/terrain/controlPanel";

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
