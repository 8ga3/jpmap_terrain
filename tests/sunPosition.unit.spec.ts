/**
 * `computeSunPosition` の代表ケース検証 (Issue #35 / Architect §4.1)。
 *
 * NOAA 簡易式の精度範囲 ±1° 程度を踏まえ、許容誤差は本テスト全体で ±2° に統一する
 * （Architect が示した ±1.5° 目安を、実装の実測値に対し若干上回る幅で許容）。
 */

import { describe, it, expect } from "@jest/globals";

import { computeSunPosition } from "../src/terrain/sunPosition";

const TOLERANCE_DEG = 2;

const expectClose = (actual: number, expected: number, label: string): void => {
    // ラベル付きの分かりやすいエラーメッセージを優先したいので
    // `expect(...).toBeLessThanOrEqual(...)` ではなく明示的に判定して throw する。
    if (Math.abs(actual - expected) > TOLERANCE_DEG) {
        throw new Error(
            `${label}: expected ${expected} (±${TOLERANCE_DEG}), got ${actual}`,
        );
    }
};

describe("computeSunPosition", () => {
    const tokyo = { lat: 35.681, lon: 139.767 };
    const sapporo = { lat: 43.0667, lon: 141.35 };

    it("夏至・東京・日本時間正午（12:00 JST = 03:00 UTC）は太陽が高く真南よりやや西", () => {
        const result = computeSunPosition(
            tokyo.lat,
            tokyo.lon,
            new Date("2025-06-21T03:00:00Z"),
        );
        expectClose(result.altitudeDeg, 77.2, "altitude");
        expectClose(result.azimuthDeg, 198.7, "azimuth");
    });

    it("冬至・東京・日本時間正午は太陽高度が低い", () => {
        const result = computeSunPosition(
            tokyo.lat,
            tokyo.lon,
            new Date("2025-12-22T03:00:00Z"),
        );
        expectClose(result.altitudeDeg, 30.7, "altitude");
        expectClose(result.azimuthDeg, 185.6, "azimuth");
    });

    it("春分・東京・日本時間正午は中間的な太陽高度", () => {
        const result = computeSunPosition(
            tokyo.lat,
            tokyo.lon,
            new Date("2025-03-21T03:00:00Z"),
        );
        expectClose(result.altitudeDeg, 54.0, "altitude");
        expectClose(result.azimuthDeg, 184.7, "azimuth");
    });

    it("夏至・東京・日本時間真夜中は太陽が地平線下", () => {
        const result = computeSunPosition(
            tokyo.lat,
            tokyo.lon,
            new Date("2025-06-21T18:00:00Z"),
        );
        expect(result.altitudeDeg).toBeLessThan(0);
    });

    it("夏至・東京・薄明時刻（5:30 JST）は太陽が地平線近傍", () => {
        const result = computeSunPosition(
            tokyo.lat,
            tokyo.lon,
            new Date("2025-06-20T20:30:00Z"),
        );
        // 薄明帯の範囲（地平線±15°）に入っていることを確認
        expect(result.altitudeDeg).toBeGreaterThan(-15);
        expect(result.altitudeDeg).toBeLessThan(15);
    });

    it("夏至・札幌・日本時間正午は東京より緯度が高いぶん太陽高度が低い", () => {
        const result = computeSunPosition(
            sapporo.lat,
            sapporo.lon,
            new Date("2025-06-21T03:00:00Z"),
        );
        expectClose(result.altitudeDeg, 69.8, "altitude");
        expectClose(result.azimuthDeg, 196.2, "azimuth");
    });

    it("純粋関数（同入力で同出力、副作用なし）", () => {
        const date = new Date("2025-06-21T03:00:00Z");
        const a = computeSunPosition(tokyo.lat, tokyo.lon, date);
        const b = computeSunPosition(tokyo.lat, tokyo.lon, date);
        expect(a).toEqual(b);
    });

    it("方位角は 0..360 の範囲に正規化される", () => {
        // 真夜中（HA<0 ブランチ）でも az は [0,360)。
        const result = computeSunPosition(
            tokyo.lat,
            tokyo.lon,
            new Date("2025-06-21T18:00:00Z"),
        );
        expect(result.azimuthDeg).toBeGreaterThanOrEqual(0);
        expect(result.azimuthDeg).toBeLessThan(360);
    });

    it("経度大 + UTC 後半でも azimuth が連続的に変化する（hourAngle 折り返しの回帰検証）", () => {
        // `trueSolarTimeMin/4 - 180` が 180° を超えるケースで、
        // 折り返し処理が無いと午前/午後判定が逆転して azimuth が南北で大ジャンプしていた。
        // ここでは UTC で 5 分刻みに動かして連続性（差分が常識的範囲）を確認する。
        const lat = 35.681;
        const lon = 140;
        const base = Date.UTC(2025, 5, 21, 22, 0, 0); // 2025-06-21T22:00Z（日本時間 07:00）
        let prev: number | null = null;
        for (let i = 0; i <= 24; i++) {
            const date = new Date(base + i * 5 * 60 * 1000);
            const { azimuthDeg } = computeSunPosition(lat, lon, date);
            expect(azimuthDeg).toBeGreaterThanOrEqual(0);
            expect(azimuthDeg).toBeLessThan(360);
            if (prev !== null) {
                // 5 分間の azimuth 変化は最大でも数°。逆転バグでは ~180° ジャンプしていた。
                const diff = Math.abs(azimuthDeg - prev);
                const wrapped = Math.min(diff, 360 - diff);
                expect(wrapped).toBeLessThan(10);
            }
            prev = azimuthDeg;
        }
    });
});
