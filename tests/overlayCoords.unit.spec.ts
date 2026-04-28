/**
 * overlayCoords ユーティリティの単体テスト (Issue #170)。
 *
 * - latLonToWorld: origin / gridResidual を加味して既存実装と同じ値を返すか
 * - assertLatLonInBounds: bounds 外で throw、prefix がメッセージに含まれる
 * - computeDistanceScale: 下限 0.1 にクランプされる
 * - computeDynamicLineHeight: 100m 〜 10000m の clamp、sin(beta) 係数 0.3〜1
 */

import { describe, it, expect } from "@jest/globals";

import {
    REF_DISTANCE_M,
    assertLatLonInBounds,
    computeDistanceScale,
    computeDynamicLineHeight,
    latLonToWorld,
    type OverlayContext,
} from "../src/terrain/overlayCoords";

const buildCtx = (overrides?: {
    origin?: {
        lat: number;
        lon: number;
        gridResidualX: number;
        gridResidualZ: number;
    };
    camera?: { x: number; y: number; z: number; radius: number; beta: number };
}): OverlayContext => {
    const origin = overrides?.origin ?? {
        lat: 35.681,
        lon: 139.767,
        gridResidualX: 0,
        gridResidualZ: 0,
    };
    const camera = overrides?.camera ?? {
        x: 0,
        y: 0,
        z: 0,
        radius: 1000,
        beta: Math.PI / 4,
    };
    return {
        scene: {
            onBeforeRenderObservable: {
                add: () => null,
                remove: () => false,
            },
        } as unknown as OverlayContext["scene"],
        tileManager: {
            queryElevationAtWorld: () => 0,
            subscribeTerrainUpdated: () => () => {
                /* no-op */
            },
        },
        getOrigin: () => ({ ...origin }),
        getCameraPosition: () => ({ ...camera }),
    };
};

describe("latLonToWorld", () => {
    it("origin と一致する点は (gridResidualX, gridResidualZ) を返す", () => {
        const ctx = buildCtx({
            origin: {
                lat: 35.681,
                lon: 139.767,
                gridResidualX: 12,
                gridResidualZ: -7,
            },
        });
        const { wx, wz } = latLonToWorld(ctx, 35.681, 139.767);
        expect(wx).toBeCloseTo(12);
        expect(wz).toBeCloseTo(-7);
    });

    it("緯度差に応じて wz が線形に変化する (1 度 ≒ 111320m)", () => {
        const ctx = buildCtx();
        const { wz } = latLonToWorld(ctx, 35.681 + 1, 139.767);
        expect(wz).toBeCloseTo(111320, 0);
    });

    it("経度差は cos(lat) 補正される", () => {
        const ctx = buildCtx();
        const { wx } = latLonToWorld(ctx, 35.681, 139.767 + 1);
        const expected = 111320 * Math.cos((35.681 * Math.PI) / 180);
        expect(wx).toBeCloseTo(expected, 0);
    });
});

describe("assertLatLonInBounds", () => {
    it("範囲内なら例外を投げない", () => {
        expect(() => assertLatLonInBounds(35.681, 139.767, "test")).not.toThrow();
    });
    it("範囲外で prefix を含むメッセージで throw", () => {
        expect(() => assertLatLonInBounds(0, 0, "addPolygon")).toThrow(
            /addPolygon: lat\/lon out of JAPAN_BOUNDS/,
        );
    });
});

describe("computeDistanceScale", () => {
    it("基準距離で 1.0 になる", () => {
        const ctx = buildCtx({
            camera: {
                x: REF_DISTANCE_M,
                y: 0,
                z: 0,
                radius: 1000,
                beta: Math.PI / 4,
            },
        });
        const scale = computeDistanceScale(ctx, 0, 0, 0);
        expect(scale).toBeCloseTo(1);
    });
    it("近距離では 0.1 にクランプされる", () => {
        const ctx = buildCtx({
            camera: { x: 0, y: 0, z: 0, radius: 1000, beta: Math.PI / 4 },
        });
        const scale = computeDistanceScale(ctx, 0, 0, 0);
        expect(scale).toBe(0.1);
    });
});

describe("computeDynamicLineHeight", () => {
    it("100m 下限で clamp", () => {
        const ctx = buildCtx({
            camera: { x: 0, y: 0, z: 0, radius: 1, beta: Math.PI / 2 },
        });
        expect(computeDynamicLineHeight(ctx)).toBe(100);
    });
    it("10000m 上限で clamp", () => {
        const ctx = buildCtx({
            camera: {
                x: 0,
                y: 0,
                z: 0,
                radius: 10_000_000,
                beta: Math.PI / 2,
            },
        });
        expect(computeDynamicLineHeight(ctx)).toBe(10000);
    });
    it("sin(beta) は 0.3 で下限 clamp", () => {
        // beta=0 → sinBeta=0 → factor=0.3、radius=10000 → 10000*0.1*0.3=300
        const ctx = buildCtx({
            camera: { x: 0, y: 0, z: 0, radius: 10000, beta: 0 },
        });
        expect(computeDynamicLineHeight(ctx)).toBeCloseTo(300);
    });
});
