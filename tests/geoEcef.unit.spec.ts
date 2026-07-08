/**
 * geo/ecef の単体テスト。
 *
 * - geodeticToEcef ⇄ ecefToGeodetic の往復精度（mm 級）を検証
 * - 既知の基準点（赤道・本初子午線・北極）で軸規約（X→経度0, Y→東経90°, Z→北極）を固定
 * - geodeticToEcefToRef が ref を書き換えて返す（アロケーション回避）ことを確認
 */

import { describe, it, expect } from "vitest";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

import {
    DEG2RAD,
    RAD2DEG,
    geodeticToEcef,
    geodeticToEcefToRef,
    ecefToGeodetic,
    ecefToGeodeticToRef,
} from "../src/terrain/geo/ecef";

describe("定数", () => {
    it("DEG2RAD / RAD2DEG が逆数関係", () => {
        expect(DEG2RAD * RAD2DEG).toBeCloseTo(1, 12);
        expect(180 * DEG2RAD).toBeCloseTo(Math.PI, 12);
    });
});

describe("軸規約（既知の基準点）", () => {
    it("lat=0,lon=0,alt=0 → X 軸上（semiMajorAxis）", () => {
        const v = geodeticToEcef(0, 0, 0);
        expect(v.x).toBeCloseTo(Wgs84Ellipsoid.semiMajorAxis, 3);
        expect(v.y).toBeCloseTo(0, 3);
        expect(v.z).toBeCloseTo(0, 3);
    });

    it("lat=0,lon=90 → Y 軸上（東経90°）", () => {
        const v = geodeticToEcef(0, 90, 0);
        expect(v.x).toBeCloseTo(0, 3);
        expect(v.y).toBeCloseTo(Wgs84Ellipsoid.semiMajorAxis, 3);
        expect(v.z).toBeCloseTo(0, 3);
    });

    it("北極（lat=90）→ Z 軸上（semiMinorAxis）", () => {
        const v = geodeticToEcef(90, 0, 0);
        expect(v.x).toBeCloseTo(0, 3);
        expect(v.y).toBeCloseTo(0, 3);
        expect(v.z).toBeCloseTo(Wgs84Ellipsoid.semiMinorAxis, 3);
    });
});

describe("往復精度 geodetic → ecef → geodetic", () => {
    const samples: { name: string; lat: number; lon: number; alt: number }[] = [
        { name: "東京", lat: 35.681236, lon: 139.767125, alt: 40 },
        { name: "富士山頂", lat: 35.360833, lon: 138.727500, alt: 3776 },
        { name: "南半球高高度", lat: -33.8688, lon: 151.2093, alt: 12000 },
        { name: "赤道", lat: 0, lon: 0, alt: 0 },
        { name: "高緯度", lat: 80, lon: -170, alt: 500 },
        { name: "海面下", lat: 24.0, lon: 123.0, alt: -50 },
    ];

    for (const s of samples) {
        it(`${s.name} が mm 級で往復する`, () => {
            const ecef = geodeticToEcef(s.lat, s.lon, s.alt);
            const g = ecefToGeodetic(ecef);
            // toBeCloseTo(x, 8) の許容誤差は |Δ| < 0.5e-8 度。緯度では ≒0.5mm 級
            // （0.5e-8 度 × 111320 m/度）、高度は toBeCloseTo(x, 3) で 0.5e-3 m（sub-mm）級。
            expect(g.latDeg).toBeCloseTo(s.lat, 8);
            expect(g.lonDeg).toBeCloseTo(s.lon, 8);
            expect(g.altMeters).toBeCloseTo(s.alt, 3);
        });
    }
});

describe("ecefToGeodeticToRef（in-place 版）", () => {
    it("ecefToGeodetic と同一結果を out に書き込み、out 自身を返す", () => {
        const ecef = geodeticToEcef(35.681236, 139.767125, 40);
        const expected = ecefToGeodetic(ecef);
        const out = { latDeg: 0, lonDeg: 0, altMeters: 0 };
        const ret = ecefToGeodeticToRef(ecef, out);
        expect(ret).toBe(out); // 新規生成せず同一参照を返す
        expect(out.latDeg).toBeCloseTo(expected.latDeg, 9);
        expect(out.lonDeg).toBeCloseTo(expected.lonDeg, 9);
        expect(out.altMeters).toBeCloseTo(expected.altMeters, 6);
    });

    it("同一バッファを使い回しても呼び出しごとに正しく上書きされる", () => {
        const out = { latDeg: 0, lonDeg: 0, altMeters: 0 };
        ecefToGeodeticToRef(geodeticToEcef(0, 0, 0), out);
        expect(out.latDeg).toBeCloseTo(0, 8);
        ecefToGeodeticToRef(geodeticToEcef(80, -170, 500), out);
        expect(out.latDeg).toBeCloseTo(80, 8);
        expect(out.lonDeg).toBeCloseTo(-170, 8);
        expect(out.altMeters).toBeCloseTo(500, 3);
    });
});

describe("極の特異点", () => {
    it("ecefToGeodetic が北極で lat=90 を返す", () => {
        const g = ecefToGeodetic(new Vector3(0, 0, Wgs84Ellipsoid.semiMinorAxis));
        expect(g.latDeg).toBe(90);
        expect(g.altMeters).toBeCloseTo(0, 3);
    });

    it("ecefToGeodetic が南極で lat=-90 を返す", () => {
        const g = ecefToGeodetic(new Vector3(0, 0, -Wgs84Ellipsoid.semiMinorAxis));
        expect(g.latDeg).toBe(-90);
        expect(g.altMeters).toBeCloseTo(0, 3);
    });
});

describe("geodeticToEcefToRef", () => {
    it("ref を書き換えて同一参照を返す", () => {
        const ref = new Vector3(1, 2, 3);
        const ret = geodeticToEcefToRef(35, 139, 0, ref);
        expect(ret).toBe(ref);
        expect(ref.x).not.toBe(1);
    });

    it("geodeticToEcef と同じ値を返す", () => {
        const a = geodeticToEcef(12.34, -56.78, 100);
        const b = geodeticToEcefToRef(12.34, -56.78, 100, new Vector3());
        expect(b.x).toBeCloseTo(a.x, 6);
        expect(b.y).toBeCloseTo(a.y, 6);
        expect(b.z).toBeCloseTo(a.z, 6);
    });
});
