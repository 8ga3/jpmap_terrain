/**
 * 標高ダイレクト参照サンプラ（案A）のユニットテスト
 *
 * `createDirectTerrainSampler` の座標変換往復・null フォールバック・地球曲率の
 * 反映を、Scene 非依存の純粋な ENU↔ECEF 変換で検証する。
 */
import { describe, it, expect } from "vitest";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { createDirectTerrainSampler, type StageTransform } from "../src/demos/artillery/terrainSampler";
import { buildEnuFrame, buildEnuWorldMatrix } from "../src/terrain/geo/enu";

/** Scene を使わず、ENU↔ECEF 行列から最小の StageTransform を構築する。 */
const makeStage = (latDeg: number, lonDeg: number): StageTransform => {
    const world = buildEnuWorldMatrix(buildEnuFrame(latDeg, lonDeg, 0));
    const inv = Matrix.Invert(world);
    return {
        localToWorld: (local, ref) =>
            Vector3.TransformCoordinatesToRef(local, world, ref),
        worldToLocal: (w, ref) =>
            Vector3.TransformCoordinatesToRef(w, inv, ref),
    };
};

describe("createDirectTerrainSampler", () => {
    const LAT = 35.22;
    const LON = 139.02;

    it("returns the terrain elevation as local Y at the stage origin", () => {
        const stage = makeStage(LAT, LON);
        const sampler = createDirectTerrainSampler(stage, () => 700);
        // 原点直上の地表点はステージローカルで +700m。ECEF↔測地の往復精度
        // （Bowring 逆変換、サブメートル）の範囲で一致する。
        expect(sampler(0, 0)).toBeCloseTo(700, 0);
    });

    it("returns ~0 at the origin when elevation is 0 (sub-meter round-trip)", () => {
        const stage = makeStage(LAT, LON);
        const sampler = createDirectTerrainSampler(stage, () => 0);
        const y = sampler(0, 0);
        expect(y).not.toBeNull();
        // 往復誤差はサブメートル（案A が許容する曲率落差 ~0.18m 級と同オーダー）。
        expect(Math.abs(y as number)).toBeLessThan(0.5);
    });

    it("maps a change in elevation 1:1 onto local Y (round-trip offset cancels)", () => {
        const stage = makeStage(LAT, LON);
        const yLow = createDirectTerrainSampler(stage, () => 100)(120, -80);
        const yHigh = createDirectTerrainSampler(stage, () => 350)(120, -80);
        expect(yLow).not.toBeNull();
        expect(yHigh).not.toBeNull();
        // 同一 (x,z) で標高だけ 250m 上げれば、ローカル Y も厳密に 250m 増える。
        expect((yHigh as number) - (yLow as number)).toBeCloseTo(250, 3);
    });

    it("returns null when elevAt returns null (unloaded tile / planar)", () => {
        const stage = makeStage(LAT, LON);
        const sampler = createDirectTerrainSampler(stage, () => null);
        expect(sampler(0, 0)).toBeNull();
        expect(sampler(500, -300)).toBeNull();
    });

    it("passes the queried lat/lon derived from the stage offset to elevAt", () => {
        const stage = makeStage(LAT, LON);
        const seen: Array<{ lat: number; lon: number }> = [];
        const sampler = createDirectTerrainSampler(stage, (lat, lon) => {
            seen.push({ lat, lon });
            return 0;
        });
        // 北へ +1000m → 緯度がわずかに増加、経度はほぼ不変。
        sampler(0, 1000);
        expect(seen).toHaveLength(1);
        expect(seen[0].lat).toBeGreaterThan(LAT);
        expect(seen[0].lon).toBeCloseTo(LON, 4);
    });

    it("keeps the horizontal-offset error sub-meter (no large planar bias)", () => {
        const stage = makeStage(LAT, LON);
        // 地表標高 0 の平坦地形でも、接平面から見た楕円体面は水平距離に応じて沈む。
        // 案A の狙いは「レイキャスト同等のサブメートル精度」。大きな平面近似誤差が
        // 出ていないこと（< 1m）を保証する。
        const sampler = createDirectTerrainSampler(stage, () => 0);
        const y = sampler(2000, 0);
        expect(y).not.toBeNull();
        expect(y as number).toBeLessThan(0);
        expect(Math.abs(y as number)).toBeLessThan(1);
    });
});
