/**
 * `src/demos/avatar-controller/autoScroll.ts` の unit test (Issue #287)。
 *
 * デッドゾーン方式の自動スクロール判定・追従計算の純粋関数を検証する。
 */
import { describe, it, expect } from "@jest/globals";

import {
    estimateViewExtent,
    viewportOffset,
    computeAutoScroll,
    DEFAULT_DEADZONE_RATIO,
    DEFAULT_SCROLL_LERP,
} from "../src/demos/avatar-controller/autoScroll";

describe("estimateViewExtent", () => {
    it("altitude が大きいほど可視範囲が広い", () => {
        const low = estimateViewExtent(100, 0);
        const high = estimateViewExtent(1000, 0);
        expect(high).toBeGreaterThan(low);
    });

    it("tilt が大きいほど near-side 可視範囲は小さい（保守的推定）", () => {
        const flat = estimateViewExtent(500, 0);
        const tilted = estimateViewExtent(500, 60);
        expect(flat).toBeGreaterThan(tilted);
    });

    it("altitude=0 でも正の値を返す (最小1mクランプ)", () => {
        const extent = estimateViewExtent(0, 0);
        expect(extent).toBeGreaterThan(0);
    });

    it("tilt=90 でも Infinity にならない (85°クランプ)", () => {
        const extent = estimateViewExtent(500, 90);
        expect(Number.isFinite(extent)).toBe(true);
    });
});

describe("viewportOffset", () => {
    it("カメラ中心とアバターが同じ位置なら (0, 0)", () => {
        const { rx, ry } = viewportOffset(35.0, 139.0, 35.0, 139.0, 500, 45);
        expect(rx).toBeCloseTo(0, 5);
        expect(ry).toBeCloseTo(0, 5);
    });

    it("アバターが北にいると ry > 0", () => {
        const { ry } = viewportOffset(35.01, 139.0, 35.0, 139.0, 500, 45);
        expect(ry).toBeGreaterThan(0);
    });

    it("アバターが東にいると rx > 0", () => {
        const { rx } = viewportOffset(35.0, 139.01, 35.0, 139.0, 500, 45);
        expect(rx).toBeGreaterThan(0);
    });

    it("アバターが南にいると ry < 0", () => {
        const { ry } = viewportOffset(34.99, 139.0, 35.0, 139.0, 500, 45);
        expect(ry).toBeLessThan(0);
    });
});

describe("computeAutoScroll", () => {
    const baseParams = {
        avatarLat: 35.0,
        avatarLon: 139.0,
        cameraLat: 35.0,
        cameraLon: 139.0,
        cameraAltitude: 500,
        cameraTilt: 45,
        deadzoneRatio: DEFAULT_DEADZONE_RATIO,
        scrollLerp: DEFAULT_SCROLL_LERP,
    };

    it("アバターがカメラ中心にいるとき scrolled=false", () => {
        const result = computeAutoScroll(baseParams);
        expect(result.scrolled).toBe(false);
        expect(result.lat).toBe(baseParams.cameraLat);
        expect(result.lon).toBe(baseParams.cameraLon);
    });

    it("アバターがデッドゾーン外にいると scrolled=true", () => {
        const result = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.1,
        });
        expect(result.scrolled).toBe(true);
    });

    it("スクロール後のカメラはアバター方向に移動する (北方向)", () => {
        const result = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.1,
        });
        expect(result.lat).toBeGreaterThan(baseParams.cameraLat);
    });

    it("スクロール後のカメラはアバター方向に移動する (東方向)", () => {
        const result = computeAutoScroll({
            ...baseParams,
            avatarLon: 139.1,
        });
        expect(result.lon).toBeGreaterThan(baseParams.cameraLon);
    });

    it("scrollLerp=0 だとカメラは動かない", () => {
        const result = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.1,
            scrollLerp: 0,
        });
        expect(result.lat).toBe(baseParams.cameraLat);
        expect(result.lon).toBe(baseParams.cameraLon);
    });

    it("scrollLerp=1 だと大きく移動する", () => {
        const small = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.1,
            scrollLerp: 0.05,
        });
        const large = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.1,
            scrollLerp: 1.0,
        });
        expect(large.lat - baseParams.cameraLat).toBeGreaterThan(
            small.lat - baseParams.cameraLat,
        );
    });

    it("deadzoneRatio が大きいほどカメラが動きにくい", () => {
        const narrow = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.005,
            deadzoneRatio: 0.3,
        });
        const wide = computeAutoScroll({
            ...baseParams,
            avatarLat: 35.005,
            deadzoneRatio: 0.9,
        });
        // 広いデッドゾーンの方がスクロール量が少ない（or スクロールしない）
        const narrowDelta = narrow.lat - baseParams.cameraLat;
        const wideDelta = wide.lat - baseParams.cameraLat;
        expect(narrowDelta).toBeGreaterThanOrEqual(wideDelta);
    });
});
