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
    formatUtcOffsetLabel,
    longitudeToOffsetMs,
    mountClock,
    renderClockSvg,
} from "../src/demos/timelapse/clockOverlay";

const H = 3600000;

describe("longitudeToOffsetMs", () => {
    it("経度0°は UTC（オフセット0）", () => {
        expect(longitudeToOffsetMs(0)).toBe(0);
    });

    it("経度は 15° ごとに 1 時間（東経=正）", () => {
        expect(longitudeToOffsetMs(15)).toBe(H);
        expect(longitudeToOffsetMs(135)).toBe(9 * H);
        expect(longitudeToOffsetMs(-75)).toBe(-5 * H);
    });

    it("東京（経度139.76）は約 +9h19m", () => {
        expect(longitudeToOffsetMs(139.76)).toBeCloseTo(9.317333 * H, -2);
    });

    it("(-180,180] へ正規化する", () => {
        expect(longitudeToOffsetMs(190)).toBe(longitudeToOffsetMs(-170));
        expect(longitudeToOffsetMs(360)).toBe(0);
    });

    it("非有限値は 0", () => {
        expect(longitudeToOffsetMs(NaN)).toBe(0);
    });
});

describe("formatUtcOffsetLabel", () => {
    it("正・負・端数を整形する", () => {
        expect(formatUtcOffsetLabel(0)).toBe("UTC+0");
        expect(formatUtcOffsetLabel(9 * H)).toBe("UTC+9");
        expect(formatUtcOffsetLabel(-5 * H)).toBe("UTC-5");
        expect(formatUtcOffsetLabel(longitudeToOffsetMs(139.76))).toBe(
            "UTC+9:19",
        );
    });
});

describe("computeClockAngles", () => {
    it("offset 既定（UTC）: 00:00 UTC で全針 0°", () => {
        const a = computeClockAngles(new Date("2025-01-01T00:00:00Z"));
        expect(a.hourDeg).toBe(0);
        expect(a.minuteDeg).toBe(0);
    });

    it("offset +9h: 15:00 UTC (= 00:00 地方時) で全針 0°", () => {
        const a = computeClockAngles(new Date("2025-01-01T15:00:00Z"), 9 * H);
        expect(a.hourDeg).toBe(0);
        expect(a.minuteDeg).toBe(0);
    });

    it("offset +9h: 21:00 UTC (= 06:00 地方時) で時針 180°", () => {
        const a = computeClockAngles(new Date("2025-01-01T21:00:00Z"), 9 * H);
        expect(a.hourDeg).toBe(180);
    });

    it("offset +9h: 03:30:15 UTC (= 12:30:15 地方時) で連続的な角度", () => {
        const a = computeClockAngles(new Date("2025-01-01T03:30:15Z"), 9 * H);
        expect(a.hourDeg).toBeCloseTo(15.125, 3);
        expect(a.minuteDeg).toBeCloseTo(30 * 6 + (15 / 60) * 6, 3);
    });

    it("Invalid Date は全角度 0", () => {
        const a = computeClockAngles(new Date("invalid"), 9 * H);
        expect(a).toEqual({ hourDeg: 0, minuteDeg: 0 });
    });
});

describe("formatClockLabel", () => {
    it("offset 既定（UTC）で HH:MM UTC+0", () => {
        expect(formatClockLabel(new Date("2025-06-21T03:07:00Z"))).toBe(
            "03:07 UTC+0",
        );
    });

    it("offset +9h でゼロ埋め・オフセット表示", () => {
        expect(formatClockLabel(new Date("2025-06-21T03:07:00Z"), 9 * H)).toBe(
            "12:07 UTC+9",
        );
    });

    it("日付跨ぎも地方時として表示", () => {
        expect(formatClockLabel(new Date("2025-06-21T15:30:00Z"), 9 * H)).toBe(
            "00:30 UTC+9",
        );
    });

    it("Invalid Date は --:-- とオフセット", () => {
        expect(formatClockLabel(new Date("invalid"), 9 * H)).toBe("--:-- UTC+9");
    });
});

describe("renderClockSvg", () => {
    it("rotate(... 50 50) を含む SVG を返す", () => {
        const svg = renderClockSvg({
            hourDeg: 90,
            minuteDeg: 30,
        });
        expect(svg).toMatch(/<svg /);
        expect(svg).toContain("rotate(90 50 50)");
        expect(svg).toContain("rotate(30 50 50)");
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
        // 21:00 UTC + offset 9h = 06:00 地方時 → 時針 180°
        handle.update(new Date("2025-01-01T21:00:00Z"), 9 * H);
        const hour = svg.querySelector("#tl-clock-hand-hour");
        expect(hour?.getAttribute("transform")).toBe("rotate(180 50 50)");
        expect(label.textContent).toBe("06:00 UTC+9");
    });
});
