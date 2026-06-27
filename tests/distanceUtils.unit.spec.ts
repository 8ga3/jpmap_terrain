/**
 * @jest-environment jsdom
 */
/**
 * 距離計測デモの純粋関数ユニットテスト。
 *
 * - haversineDistanceMeters: 既知サンプル (東京駅↔皇居 等) と退化ケース
 * - formatHorizontalDistance: m/km 切替の境界
 * - formatAltitudeDelta: 符号付き整形と 0 m 周辺
 * - formatPointLabel / formatEdgeLabel: 改行区切りの文字列構造
 */
import { describe, it, expect } from "@jest/globals";

import {
    DEFAULT_DISTANCE_DEMO_MODE,
    formatAltitudeDelta,
    formatEdgeLabel,
    formatHorizontalDistance,
    formatPointLabel,
    haversineDistanceMeters,
} from "../src/demos/distance/utils";

describe("haversineDistanceMeters", () => {
    it("同一点は 0 を返す", () => {
        const p = { lat: 35.6812, lon: 139.7671 };
        expect(haversineDistanceMeters(p, p)).toBe(0);
    });

    it("既知の 2 点 (東京駅 ↔ 皇居) は概ね 1.2 km 前後になる", () => {
        const tokyoStation = { lat: 35.6812, lon: 139.7671 };
        const kokyo = { lat: 35.6852, lon: 139.7528 };
        const d = haversineDistanceMeters(tokyoStation, kokyo);
        // 直線距離: ~1.32 km。±200m の余裕で検証。
        expect(d).toBeGreaterThan(1100);
        expect(d).toBeLessThan(1500);
    });

    it("緯度方向 1 度の差は概ね 111 km 程度", () => {
        const a = { lat: 35.0, lon: 139.0 };
        const b = { lat: 36.0, lon: 139.0 };
        const d = haversineDistanceMeters(a, b);
        expect(d).toBeGreaterThan(110_000);
        expect(d).toBeLessThan(112_000);
    });

    it("対称性 d(a,b) === d(b,a)", () => {
        const a = { lat: 35.0, lon: 139.0 };
        const b = { lat: 35.5, lon: 140.0 };
        expect(haversineDistanceMeters(a, b)).toBeCloseTo(
            haversineDistanceMeters(b, a),
            6,
        );
    });

    it("ほぼ対蹠点でも NaN にならず有限な値を返す (#191 Copilot review)", () => {
        // 北極 (90, 0) と南極 (-90, 180) は h が 1 ぴったり〜浮動小数誤差で
        // 1 を僅かに超える領域。クランプで sqrt(1 - h) が NaN にならない。
        const north = { lat: 90, lon: 0 };
        const south = { lat: -90, lon: 180 };
        const d = haversineDistanceMeters(north, south);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThan(0);
    });
});

describe("formatHorizontalDistance", () => {
    it("1000 m 未満は m 単位の整数で表示", () => {
        expect(formatHorizontalDistance(0)).toBe("0 m");
        expect(formatHorizontalDistance(1)).toBe("1 m");
        expect(formatHorizontalDistance(500.4)).toBe("500 m");
        expect(formatHorizontalDistance(999.4)).toBe("999 m");
    });

    it("1000 m 以上は km 単位（小数 2 桁）で表示", () => {
        expect(formatHorizontalDistance(1000)).toBe("1.00 km");
        expect(formatHorizontalDistance(1234.56)).toBe("1.23 km");
        expect(formatHorizontalDistance(15_000)).toBe("15.00 km");
    });

    it("負値や NaN は '-' を返す", () => {
        expect(formatHorizontalDistance(-1)).toBe("-");
        expect(formatHorizontalDistance(Number.NaN)).toBe("-");
        expect(formatHorizontalDistance(Number.POSITIVE_INFINITY)).toBe("-");
    });

    // 境界条件: 999.5m はそのまま m 表示の四捨五入で 1000 m となる
    // （`meters < 1000` 判定が先に評価されるため km 側へ落ちない）。
    it("999.5 m は m 表示の四捨五入で '1000 m' として扱われる（< 1000 の境界）", () => {
        expect(formatHorizontalDistance(999.5)).toBe("1000 m");
    });
});

describe("formatAltitudeDelta", () => {
    it("正の値には + 符号を付ける", () => {
        expect(formatAltitudeDelta(5)).toBe("+5 m");
        expect(formatAltitudeDelta(123.4)).toBe("+123 m");
    });

    it("負の値には - 符号を付ける（Math.round の符号）", () => {
        expect(formatAltitudeDelta(-5)).toBe("-5 m");
        expect(formatAltitudeDelta(-12.3)).toBe("-12 m");
    });

    it("|delta| < 0.5 m は ±0 m として整形", () => {
        expect(formatAltitudeDelta(0)).toBe("±0 m");
        expect(formatAltitudeDelta(0.4)).toBe("±0 m");
        expect(formatAltitudeDelta(-0.4)).toBe("±0 m");
    });

    it("NaN は '-' を返す", () => {
        expect(formatAltitudeDelta(Number.NaN)).toBe("-");
    });
});

describe("formatPointLabel", () => {
    it("3 行の lat / lon / altitude 文字列を返す", () => {
        const out = formatPointLabel({ lat: 35.6812, lon: 139.7671, altitude: 12.6 });
        const lines = out.split("\n");
        expect(lines.length).toBe(3);
        expect(lines[0]).toBe("35.68120");
        expect(lines[1]).toBe("139.76710");
        expect(lines[2]).toBe("13 m");
    });

    it("altitude 未指定なら 0 m として整形", () => {
        const out = formatPointLabel({ lat: 35.0, lon: 139.0 });
        expect(out.endsWith("0 m")).toBe(true);
    });
});

describe("formatEdgeLabel", () => {
    it("水平距離 + 高低差を改行区切りで返す", () => {
        const a = { lat: 35.0, lon: 139.0, altitude: 100 };
        const b = { lat: 35.0, lon: 139.001, altitude: 130 };
        const text = formatEdgeLabel(a, b);
        const lines = text.split("\n");
        expect(lines.length).toBe(2);
        // ~91 m 前後（経度 0.001° ≒ 91m at lat=35）。'm' 単位で出力される。
        expect(lines[0]).toMatch(/^\d+ m$/);
        // 高低差 +30m
        expect(lines[1]).toBe("+30 m");
    });

    it("altitude 未指定の点同士でも 0 として扱う", () => {
        const text = formatEdgeLabel(
            { lat: 35.0, lon: 139.0 },
            { lat: 35.0, lon: 139.0001 },
        );
        const lines = text.split("\n");
        expect(lines.length).toBe(2);
        expect(lines[1]).toBe("±0 m");
    });
});

describe("DEFAULT_DISTANCE_DEMO_MODE", () => {
    it("既定モードは 'add'", () => {
        expect(DEFAULT_DISTANCE_DEMO_MODE).toBe("add");
    });
});
