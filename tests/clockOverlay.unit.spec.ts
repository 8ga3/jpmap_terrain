/**
 * @jest-environment jsdom
 */
/**
 * `src/demos/timelapse/clockOverlay.ts` の純粋関数と DOM マウントの unit test (Issue #147)。
 */
import { describe, it, expect, beforeEach } from "@jest/globals";

import {
    computeClockAngles,
    formatClockLabel,
    mountClock,
    renderClockSvg,
} from "../src/demos/timelapse/clockOverlay";

describe("computeClockAngles", () => {
    it("15:00:00 UTC (= 00:00 JST) で全針 0°", () => {
        const a = computeClockAngles(new Date("2025-01-01T15:00:00Z"));
        expect(a.hourDeg).toBe(0);
        expect(a.minuteDeg).toBe(0);
        expect(a.secondDeg).toBe(0);
    });

    it("21:00:00 UTC (= 06:00 JST) で時針 180°", () => {
        const a = computeClockAngles(new Date("2025-01-01T21:00:00Z"));
        expect(a.hourDeg).toBe(180);
    });

    it("03:30:15 UTC (= 12:30:15 JST) で連続的な角度（時針が小数で進む）", () => {
        const a = computeClockAngles(new Date("2025-01-01T03:30:15Z"));
        // JST 12:30:15 → 時針: (0 + 30/60 + 15/3600) * 30 ≈ 15.125°
        expect(a.hourDeg).toBeCloseTo(15.125, 3);
        expect(a.minuteDeg).toBeCloseTo(30 * 6 + (15 / 60) * 6, 3);
        expect(a.secondDeg).toBeCloseTo(15 * 6, 3);
    });

    it("Invalid Date は全角度 0", () => {
        const a = computeClockAngles(new Date("invalid"));
        expect(a).toEqual({ hourDeg: 0, minuteDeg: 0, secondDeg: 0 });
    });
});

describe("formatClockLabel", () => {
    it("HH:MM JST 形式でゼロ埋め（UTCから+9h）", () => {
        expect(formatClockLabel(new Date("2025-06-21T03:07:00Z"))).toBe(
            "12:07 JST",
        );
    });

    it("日付跨ぎも JST として表示", () => {
        expect(formatClockLabel(new Date("2025-06-21T15:30:00Z"))).toBe(
            "00:30 JST",
        );
    });

    it("Invalid Date は --:--", () => {
        expect(formatClockLabel(new Date("invalid"))).toBe("--:-- JST");
    });
});

describe("renderClockSvg", () => {
    it("rotate(... 50 50) を含む SVG を返す", () => {
        const svg = renderClockSvg({
            hourDeg: 90,
            minuteDeg: 30,
            secondDeg: 6,
        });
        expect(svg).toMatch(/<svg /);
        expect(svg).toContain("rotate(90 50 50)");
        expect(svg).toContain("rotate(30 50 50)");
        expect(svg).toContain("rotate(6 50 50)");
    });
});

describe("mountClock", () => {
    let svg: SVGSVGElement;
    let label: HTMLElement;

    beforeEach(() => {
        document.body.innerHTML =
            '<svg id="c" viewBox="0 0 100 100"></svg><div id="l"></div>';
        svg = document.getElementById("c") as unknown as SVGSVGElement;
        label = document.getElementById("l") as HTMLElement;
    });

    it("マウント後、update で transform 属性が変わる", () => {
        const handle = mountClock(svg, label);
        // 21:00 UTC = 06:00 JST → 時針 180°
        handle.update(new Date("2025-01-01T21:00:00Z"));
        const hour = svg.querySelector("#tl-clock-hand-hour");
        expect(hour?.getAttribute("transform")).toBe("rotate(180 50 50)");
        expect(label.textContent).toBe("06:00 JST");
    });
});
