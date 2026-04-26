/**
 * @jest-environment node
 */
/**
 * `src/demos/timelapse/timelapseClock.ts` の純粋関数 unit test (Issue #147)。
 */
import { describe, it, expect } from "@jest/globals";

import {
    MS_PER_DAY,
    computeSimulatedDate,
    parseTimelapseQuery,
    sanitizeTimelapseOptions,
} from "../src/demos/timelapse/timelapseClock";

const isoUtc = (iso: string): Date => new Date(iso);

describe("sanitizeTimelapseOptions", () => {
    it("既定値: 全部未指定なら 60s/未停止/フォールバック日時", () => {
        const r = sanitizeTimelapseOptions({});
        expect(r.periodSec).toBe(60);
        expect(r.paused).toBe(false);
        expect(r.startUtc.getUTCFullYear()).toBe(2025);
    });

    it("periodSec が 0 や非有限値なら 60s に倒す", () => {
        expect(sanitizeTimelapseOptions({ periodSec: 0 }).periodSec).toBe(60);
        expect(sanitizeTimelapseOptions({ periodSec: -1 }).periodSec).toBe(60);
        expect(sanitizeTimelapseOptions({ periodSec: NaN }).periodSec).toBe(60);
        expect(
            sanitizeTimelapseOptions({ periodSec: Infinity }).periodSec,
        ).toBe(60);
    });

    it("Invalid Date はフォールバックに置換する", () => {
        const r = sanitizeTimelapseOptions({ startUtc: new Date("invalid") });
        expect(Number.isNaN(r.startUtc.getTime())).toBe(false);
    });
});

describe("computeSimulatedDate", () => {
    const start = isoUtc("2025-06-21T00:00:00Z");
    const opts = sanitizeTimelapseOptions({ startUtc: start, periodSec: 60 });

    it("elapsed=0 なら開始時刻と同値", () => {
        const d = computeSimulatedDate(0, opts);
        expect(d.getTime()).toBe(start.getTime());
    });

    it("半周期 (30s) で 12 時間進む", () => {
        const d = computeSimulatedDate(30, opts);
        expect(d.getTime() - start.getTime()).toBe(MS_PER_DAY / 2);
    });

    it("1 周期 (60s) で 1 周回って同値（位相 0）", () => {
        const d = computeSimulatedDate(60, opts);
        expect(d.getTime()).toBe(start.getTime());
    });

    it("paused=true なら elapsed に依らず開始時刻", () => {
        const paused = sanitizeTimelapseOptions({
            startUtc: start,
            periodSec: 60,
            paused: true,
        });
        const d = computeSimulatedDate(99999, paused);
        expect(d.getTime()).toBe(start.getTime());
    });

    it("負値・非有限値の elapsed は 0 として扱う", () => {
        expect(computeSimulatedDate(-5, opts).getTime()).toBe(start.getTime());
        expect(computeSimulatedDate(NaN, opts).getTime()).toBe(start.getTime());
    });
});

describe("parseTimelapseQuery", () => {
    const now = isoUtc("2025-06-21T07:30:00Z");

    it("空クエリ: 当日 0 時 UTC / 60s / 未停止", () => {
        const r = parseTimelapseQuery("", now);
        expect(r.periodSec).toBe(60);
        expect(r.paused).toBe(false);
        expect(r.startUtc.toISOString()).toBe("2025-06-21T00:00:00.000Z");
    });

    it("?start=ISO8601 を採用", () => {
        const r = parseTimelapseQuery("?start=2024-01-01T12:00:00Z", now);
        expect(r.startUtc.toISOString()).toBe("2024-01-01T12:00:00.000Z");
    });

    it("?speed=120 が反映される", () => {
        const r = parseTimelapseQuery("?speed=120", now);
        expect(r.periodSec).toBe(120);
    });

    it("?speed=invalid は 60 にフォールバック", () => {
        expect(parseTimelapseQuery("?speed=abc", now).periodSec).toBe(60);
        expect(parseTimelapseQuery("?speed=-1", now).periodSec).toBe(60);
    });

    it("?paused / ?paused=true は停止扱い、?paused=false は走行", () => {
        expect(parseTimelapseQuery("?paused", now).paused).toBe(true);
        expect(parseTimelapseQuery("?paused=true", now).paused).toBe(true);
        expect(parseTimelapseQuery("?paused=false", now).paused).toBe(false);
        expect(parseTimelapseQuery("?paused=0", now).paused).toBe(false);
    });
});
