import { describe, it, expect } from "vitest";
import { resolveTiltCollision, TILT_MAX_RADIUS_INCREASE_RATIO } from "../src/terrain/cameraCollision";

describe("resolveTiltCollision", () => {
    const ratio = TILT_MAX_RADIUS_INCREASE_RATIO;

    describe("コリジョンなし", () => {
        it("currentRadius >= minRadius なら none を返す", () => {
            const result = resolveTiltCollision(200, 150, 75000, ratio);
            expect(result).toEqual({ action: "none" });
        });

        it("currentRadius == minRadius でも none を返す", () => {
            const result = resolveTiltCollision(200, 200, 75000, ratio);
            expect(result).toEqual({ action: "none" });
        });
    });

    describe("自動ズームアウト", () => {
        it("増加率が閾値内なら zoomOut を返す", () => {
            // radius 200 → minRadius 250 (25% 増加、閾値 50% 以内)
            const result = resolveTiltCollision(200, 250, 75000, ratio);
            expect(result).toEqual({ action: "zoomOut", radius: 250 });
        });

        it("増加率がちょうど閾値なら zoomOut を返す", () => {
            // radius 200 → minRadius 300 (50% 増加、閾値ちょうど)
            const result = resolveTiltCollision(200, 300, 75000, ratio);
            expect(result).toEqual({ action: "zoomOut", radius: 300 });
        });

        it("minRadius が upperRadius を超える場合は upperRadius にクランプ", () => {
            const result = resolveTiltCollision(200, 350, 280, ratio);
            // needed = min(350, 280) = 280, maxAllowed = 300 → 280 <= 300 → zoomOut
            expect(result).toEqual({ action: "zoomOut", radius: 280 });
        });
    });

    describe("チルト中止（revert）", () => {
        it("増加率が閾値を超えたら revert を返す", () => {
            // radius 200 → minRadius 400 (100% 増加、閾値 50% 超過)
            const result = resolveTiltCollision(200, 400, 75000, ratio);
            expect(result).toEqual({ action: "revert" });
        });

        it("壁状の大きな高低差を想定した大幅な増加で revert", () => {
            // radius 100 → minRadius 1000 (900% 増加)
            const result = resolveTiltCollision(100, 1000, 75000, ratio);
            expect(result).toEqual({ action: "revert" });
        });

        it("upperRadius でクランプしても閾値超過なら revert", () => {
            // radius 200, minRadius 500, upper 400
            // needed = min(500, 400) = 400, maxAllowed = 300 → revert
            const result = resolveTiltCollision(200, 500, 400, ratio);
            expect(result).toEqual({ action: "revert" });
        });
    });

    describe("カスタム maxIncreaseRatio", () => {
        it("ratio=0.2 で 25% 増加は revert", () => {
            const result = resolveTiltCollision(200, 250, 75000, 0.2);
            expect(result).toEqual({ action: "revert" });
        });

        it("ratio=1.0 で 80% 増加は zoomOut", () => {
            const result = resolveTiltCollision(200, 360, 75000, 1.0);
            expect(result).toEqual({ action: "zoomOut", radius: 360 });
        });
    });

    describe("TILT_MAX_RADIUS_INCREASE_RATIO 定数", () => {
        it("0.5（50%）であること", () => {
            expect(TILT_MAX_RADIUS_INCREASE_RATIO).toBe(0.5);
        });
    });

    describe("境界値", () => {
        it("currentRadius が 0 のとき minRadius > 0 なら revert（ゼロ除算回避）", () => {
            // maxAllowed = 0 * 1.5 = 0, needed = 100 → revert
            const result = resolveTiltCollision(0, 100, 75000, ratio);
            expect(result).toEqual({ action: "revert" });
        });

        it("currentRadius も minRadius も 0 なら none", () => {
            const result = resolveTiltCollision(0, 0, 75000, ratio);
            expect(result).toEqual({ action: "none" });
        });

        it("非常に小さい差分（1未満の増加）で zoomOut", () => {
            const result = resolveTiltCollision(200, 200.5, 75000, ratio);
            expect(result).toEqual({ action: "zoomOut", radius: 200.5 });
        });
    });
});
