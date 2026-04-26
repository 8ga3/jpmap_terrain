/**
 * `deriveSunState` のユニットテスト (Issue #35)。
 *
 * 純粋関数だが Babylon.js の `Vector3` を返すため、`@babylonjs/core` を実 import する。
 * （他テストでは Babylon を mock するパターンもあるが、本テストではベクトル成分検証のため実体に依存する）。
 */

import { describe, it, expect } from "@jest/globals";

import { deriveSunState } from "../src/terrain/sunState";

describe("deriveSunState", () => {
    it("真昼（高度 60°）は dayFactor=1、skyLuminance≈1、太陽メッシュ可視", () => {
        const state = deriveSunState(60, 180);
        expect(state.dayFactor).toBeCloseTo(1, 5);
        expect(state.skyLuminance).toBeCloseTo(1, 5);
        expect(state.visibleAboveHorizon).toBe(true);
    });

    it("夜間（高度 -30°）は dayFactor=0、skyLuminance=0.05、太陽メッシュ非表示", () => {
        const state = deriveSunState(-30, 180);
        expect(state.dayFactor).toBe(0);
        expect(state.skyLuminance).toBeCloseTo(0.05, 5);
        expect(state.visibleAboveHorizon).toBe(false);
    });

    it("薄明帯境界 -6° で dayFactor=0", () => {
        const state = deriveSunState(-6, 180);
        expect(state.dayFactor).toBe(0);
    });

    it("薄明帯境界 +6° で dayFactor=1", () => {
        const state = deriveSunState(6, 180);
        expect(state.dayFactor).toBe(1);
    });

    it("薄明帯中央（高度 0°）で dayFactor=0.5", () => {
        const state = deriveSunState(0, 180);
        expect(state.dayFactor).toBeCloseTo(0.5, 5);
    });

    it("dayFactor は薄明帯で単調増加", () => {
        const a = deriveSunState(-3, 180).dayFactor;
        const b = deriveSunState(0, 180).dayFactor;
        const c = deriveSunState(3, 180).dayFactor;
        expect(a).toBeLessThan(b);
        expect(b).toBeLessThan(c);
    });

    it("地平線境界: altitude=-1 でも可視、-1.001 で非表示", () => {
        expect(deriveSunState(-1, 180).visibleAboveHorizon).toBe(false);
        expect(deriveSunState(-0.5, 180).visibleAboveHorizon).toBe(true);
    });

    it("sunDir: 真上（高度 90°）は Y=+1 の単位ベクトル", () => {
        const state = deriveSunState(90, 0);
        expect(state.sunDir.x).toBeCloseTo(0, 5);
        expect(state.sunDir.y).toBeCloseTo(1, 5);
        expect(state.sunDir.z).toBeCloseTo(0, 5);
    });

    it("sunDir: 真南・地平線（高度 0°、方位 180°）は Z=-1", () => {
        const state = deriveSunState(0, 180);
        expect(state.sunDir.x).toBeCloseTo(0, 5);
        expect(state.sunDir.y).toBeCloseTo(0, 5);
        expect(state.sunDir.z).toBeCloseTo(-1, 5);
    });

    it("sunDir: 真東・地平線（高度 0°、方位 90°）は X=+1（左手系）", () => {
        const state = deriveSunState(0, 90);
        expect(state.sunDir.x).toBeCloseTo(1, 5);
        expect(state.sunDir.y).toBeCloseTo(0, 5);
        expect(state.sunDir.z).toBeCloseTo(0, 5);
    });

    it("sunDir は単位長", () => {
        const state = deriveSunState(35, 245);
        const len = Math.hypot(state.sunDir.x, state.sunDir.y, state.sunDir.z);
        expect(len).toBeCloseTo(1, 5);
    });

    it("skyInclination: 天頂で 0、地平線で 0.5、地平線下は 0.5 でクランプ", () => {
        expect(deriveSunState(90, 0).skyInclination).toBeCloseTo(0, 5);
        expect(deriveSunState(0, 0).skyInclination).toBeCloseTo(0.5, 5);
        // 地平線下は Babylon SkyMaterial が想定しない領域のため 0.5 でクランプされる
        expect(deriveSunState(-30, 0).skyInclination).toBeCloseTo(0.5, 5);
        expect(deriveSunState(-90, 0).skyInclination).toBeCloseTo(0.5, 5);
    });

    it("skyInclination: 昼間は高度に対して単調減少（朝→正午で 0 に近づく）", () => {
        const a = deriveSunState(0, 0).skyInclination;
        const b = deriveSunState(30, 0).skyInclination;
        const c = deriveSunState(60, 0).skyInclination;
        const d = deriveSunState(90, 0).skyInclination;
        expect(a).toBeGreaterThan(b);
        expect(b).toBeGreaterThan(c);
        expect(c).toBeGreaterThan(d);
    });

    it("skyVisible / clearColor: 昼は Skybox 表示 + 青空色、夜は Skybox 非表示 + 夜色", () => {
        const noon = deriveSunState(75, 180);
        expect(noon.skyVisible).toBe(true);
        expect(noon.clearColor.r).toBeGreaterThan(0.5);

        const night = deriveSunState(-25, 0);
        expect(night.skyVisible).toBe(false);
        expect(night.clearColor.r).toBeLessThan(0.1);
        expect(night.clearColor.b).toBeLessThan(0.2);
    });

    it("skyVisible 境界: altitudeDeg=-6 で false、-5 で true", () => {
        expect(deriveSunState(-6, 0).skyVisible).toBe(false);
        expect(deriveSunState(-5, 0).skyVisible).toBe(true);
    });

    it("skyAzimuth は [0, 1)", () => {
        expect(deriveSunState(0, 0).skyAzimuth).toBeCloseTo(0, 5);
        expect(deriveSunState(0, 90).skyAzimuth).toBeCloseTo(0.25, 5);
        expect(deriveSunState(0, 359.999).skyAzimuth).toBeLessThan(1);
    });
});
