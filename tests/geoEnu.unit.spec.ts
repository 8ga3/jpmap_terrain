/**
 * geo/enu の単体テスト (Issue #404 P4-4)。
 *
 * - buildEnuFrame の基底ベクトルが正規直交（東京原点）であることを検証
 * - enuToEcef ⇄ ecefToEnu の往復精度を検証
 * - ENU 軸割り当て（X=East, Y=Up, Z=North）が正しいことを既知の方向で固定
 * - 高度方向（Up）が ECEF 法線（geodeticToEcef の差分）と一致することを確認
 */

import { describe, it, expect } from "@jest/globals";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { geodeticToEcef } from "../src/terrain/geo/ecef";
import {
    buildEnuFrame,
    enuToEcefToRef,
    enuVectorToEcefToRef,
    ecefToEnuToRef,
} from "../src/terrain/geo/enu";

const TOKYO = { lat: 35.681236, lon: 139.767125, alt: 40 };

describe("buildEnuFrame の基底", () => {
    it("east / up / north が単位ベクトル", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        expect(f.east.length()).toBeCloseTo(1, 9);
        expect(f.up.length()).toBeCloseTo(1, 9);
        expect(f.north.length()).toBeCloseTo(1, 9);
    });

    it("east / up / north が互いに直交", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        expect(Vector3.Dot(f.east, f.up)).toBeCloseTo(0, 9);
        expect(Vector3.Dot(f.east, f.north)).toBeCloseTo(0, 9);
        expect(Vector3.Dot(f.up, f.north)).toBeCloseTo(0, 9);
    });

    it("右手系（east × north = up）", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        const cross = Vector3.Cross(f.east, f.north);
        expect(cross.x).toBeCloseTo(f.up.x, 9);
        expect(cross.y).toBeCloseTo(f.up.y, 9);
        expect(cross.z).toBeCloseTo(f.up.z, 9);
    });

    it("赤道・本初子午線では East=+Y, North=+Z, Up=+X", () => {
        const f = buildEnuFrame(0, 0, 0);
        expect(f.east.x).toBeCloseTo(0, 9);
        expect(f.east.y).toBeCloseTo(1, 9);
        expect(f.north.z).toBeCloseTo(1, 9);
        expect(f.up.x).toBeCloseTo(1, 9);
    });
});

describe("ENU 軸割り当て", () => {
    it("原点 (0,0,0) は originEcef に一致", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        const ecef = enuToEcefToRef(f, 0, 0, 0, new Vector3());
        expect(ecef.x).toBeCloseTo(f.originEcef.x, 6);
        expect(ecef.y).toBeCloseTo(f.originEcef.y, 6);
        expect(ecef.z).toBeCloseTo(f.originEcef.z, 6);
    });

    it("Up(+Y) 方向は altMeters を増やした ECEF と一致", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        const up100 = enuToEcefToRef(f, 0, 100, 0, new Vector3());
        const expected = geodeticToEcef(TOKYO.lat, TOKYO.lon, TOKYO.alt + 100);
        // 球面の曲率により厳密一致はしないが、100m 程度では mm 級で一致。
        expect(up100.x).toBeCloseTo(expected.x, 2);
        expect(up100.y).toBeCloseTo(expected.y, 2);
        expect(up100.z).toBeCloseTo(expected.z, 2);
    });
});

describe("enu ⇄ ecef 往復", () => {
    const samples: { x: number; y: number; z: number }[] = [
        { x: 0, y: 0, z: 0 },
        { x: 1500, y: 0, z: -1500 },
        { x: -250.5, y: 800, z: 1234.5 },
        { x: 3000, y: -120, z: 0 },
    ];

    for (const s of samples) {
        it(`(${s.x}, ${s.y}, ${s.z}) が往復する`, () => {
            const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
            const ecef = enuToEcefToRef(f, s.x, s.y, s.z, new Vector3());
            const back = ecefToEnuToRef(f, ecef, new Vector3());
            expect(back.x).toBeCloseTo(s.x, 6);
            expect(back.y).toBeCloseTo(s.y, 6);
            expect(back.z).toBeCloseTo(s.z, 6);
        });
    }
});

describe("ref / vector ラッパ", () => {
    it("enuToEcefToRef は ref を書き換えて同一参照を返す", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        const ref = new Vector3(1, 2, 3);
        const ret = enuToEcefToRef(f, 10, 20, 30, ref);
        expect(ret).toBe(ref);
        expect(ref.x).not.toBe(1);
    });

    it("enuVectorToEcefToRef は enuToEcefToRef と同値", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        const a = enuToEcefToRef(f, 12, -34, 56, new Vector3());
        const b = enuVectorToEcefToRef(f, new Vector3(12, -34, 56), new Vector3());
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
        expect(b.z).toBeCloseTo(a.z, 9);
    });

    it("ecefToEnuToRef は ref を書き換えて同一参照を返す", () => {
        const f = buildEnuFrame(TOKYO.lat, TOKYO.lon, TOKYO.alt);
        const ref = new Vector3(1, 2, 3);
        const ret = ecefToEnuToRef(f, f.originEcef, ref);
        expect(ret).toBe(ref);
        expect(ref.x).toBeCloseTo(0, 6);
    });
});
