/**
 * `src/demos/avatar-controller/autoScroll.ts` の unit test。
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
        // viewExtentOverride=200 で |ry| が halfDz超〜EDGE_LIMIT未満に収まる距離を使う
        // 80m / 200m = 0.4 → deadzoneRatio=0.3 なら halfDz=0.15 超 / 0.9 なら halfDz=0.45 未満
        const narrow = computeAutoScroll({
            ...baseParams,
            avatarLat: baseParams.cameraLat + 80 / 111320, // 80m北 → |ry|=0.4
            deadzoneRatio: 0.3,
            viewExtentOverride: 200,
        });
        const wide = computeAutoScroll({
            ...baseParams,
            avatarLat: baseParams.cameraLat + 80 / 111320,
            deadzoneRatio: 0.9,
            viewExtentOverride: 200,
        });
        // deadzoneRatio=0.9 → halfDz=0.45 > |ry|=0.4 → デッドゾーン内でスクロールしない
        expect(wide.scrolled).toBe(false);
        // deadzoneRatio=0.3 → halfDz=0.15 < |ry|=0.4 → スクロールする
        expect(narrow.scrolled).toBe(true);
        const narrowDelta = narrow.lat - baseParams.cameraLat;
        const wideDelta = wide.lat - baseParams.cameraLat;
        expect(narrowDelta).toBeGreaterThan(wideDelta);
    });

    it("viewExtentOverride 指定時は estimateViewExtent を使わず指定値で判定する", () => {
        // override=100m: アバターが 60m 離れているので |ry|=0.6 → halfDz=0.3 超→スクロール
        const withOverride = computeAutoScroll({
            ...baseParams,
            avatarLat: baseParams.cameraLat + 60 / 111320, // 約60m北
            viewExtentOverride: 100,
        });
        expect(withOverride.scrolled).toBe(true);

        // override=1000m: 同じ 60m なので |ry|=0.06 → halfDz=0.3 内→スクロールしない
        const withLargeOverride = computeAutoScroll({
            ...baseParams,
            avatarLat: baseParams.cameraLat + 60 / 111320,
            viewExtentOverride: 1000,
        });
        expect(withLargeOverride.scrolled).toBe(false);
    });

    it("viewExtentOverride 指定時の移動量は altitude/tilt に依存しない", () => {
        const params = {
            ...baseParams,
            avatarLat: baseParams.cameraLat + 80 / 111320, // 80m north
            viewExtentOverride: 100,
        };
        const resultA = computeAutoScroll({ ...params, cameraAltitude: 500 });
        const resultB = computeAutoScroll({ ...params, cameraAltitude: 5000 });
        // 両方とも同じ移動量（altitude に依存しない）
        expect(resultA.lat).toBeCloseTo(resultB.lat, 10);
    });

    it("EDGE_LIMIT 超え時はハードクランプで境界内に収まる", () => {
        // viewExtentOverride=100: 200m 離れると |ry|=2.0 >> EDGE_LIMIT=0.95
        // clampY = 2.0 - 0.95 = 1.05 > 通常 lerp なのでクランプが発動
        const result = computeAutoScroll({
            ...baseParams,
            avatarLat: baseParams.cameraLat + 200 / 111320,
            viewExtentOverride: 100,
            scrollLerp: 0.1,
        });
        expect(result.scrolled).toBe(true);
        // クランプ後: カメラが移動した結果、アバターのビューポート比率が EDGE_LIMIT(0.95) に収まる
        const newRy = ((baseParams.cameraLat + 200 / 111320) - result.lat) * 111320 / 100;
        expect(Math.abs(newRy)).toBeCloseTo(0.95, 2);
    });

    it("EDGE_LIMIT クランプ発動確認: 通常 lerp だけでは 0.95 まで下がらない入力", () => {
        // |ry|=2.0, deadzoneRatio=0.6 → overflowY = 2.0 - 0.3 = 1.7
        // 通常 lerp のみ: dLat = 1.7 * 100 * 0.1 / 111320 → newRy ≈ 2.0 - 0.17 = 1.83
        // クランプあり: clampY = 2.0 - 0.95 = 1.05 → dLat = 1.05*100/111320 → newRy = 0.95
        // clamp > lerp なので clamp が勝つ
        const lerpOnly = 2.0 - (2.0 - 0.3) * 0.1; // ≈ 1.83
        expect(lerpOnly).toBeGreaterThan(0.95);
        // 実際の結果は 0.95 に収まる（クランプ発動の証拠）
        const result = computeAutoScroll({
            ...baseParams,
            avatarLat: baseParams.cameraLat + 200 / 111320,
            viewExtentOverride: 100,
            scrollLerp: 0.1,
        });
        const newRy = ((baseParams.cameraLat + 200 / 111320) - result.lat) * 111320 / 100;
        expect(Math.abs(newRy)).toBeCloseTo(0.95, 2);
    });
});
