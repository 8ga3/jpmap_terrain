/**
 * geo/overlayPlacement の単体テスト (Issue #275 Phase 3)。
 *
 * - groundPlacementToRef: 位置が球面上（地心距離≈標高+曲率半径）・up が地心方向の単位ベクトル
 * - computeOverlayDistanceScale: 距離比例・下限 0.1
 * - computeOverlayLineHeight: 距離比例・[100,10000] クランプ
 */

import { describe, it, expect } from "@jest/globals";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { geodeticToEcef } from "../src/terrain/geo/ecef";
import {
    groundPlacementToRef,
    computeOverlayDistanceScale,
    computeOverlayDistanceScaleFromDistance,
    computeOverlayLineHeight,
    buildDrapedPolygonPaths,
    OVERLAY_REF_DISTANCE_M,
} from "../src/terrain/geo/overlayPlacement";

describe("groundPlacementToRef", () => {
    it("位置は geodeticToEcef と一致し、up は地心方向の単位ベクトル", () => {
        const pos = new Vector3();
        const up = new Vector3();
        groundPlacementToRef(35.3606, 138.7274, 3776, pos, up);
        const expected = geodeticToEcef(35.3606, 138.7274, 3776);
        expect(pos.x).toBeCloseTo(expected.x, 3);
        expect(pos.y).toBeCloseTo(expected.y, 3);
        expect(pos.z).toBeCloseTo(expected.z, 3);
        // up は単位ベクトルで position と同方向（地心 up）。
        expect(up.length()).toBeCloseTo(1, 9);
        const posDir = pos.clone().normalize();
        expect(Vector3.Dot(up, posDir)).toBeCloseTo(1, 9);
    });

    it("赤道本初子午線・標高0 では +X 方向、up=+X", () => {
        const pos = new Vector3();
        const up = new Vector3();
        groundPlacementToRef(0, 0, 0, pos, up);
        expect(up.x).toBeCloseTo(1, 9);
        expect(up.y).toBeCloseTo(0, 9);
        expect(up.z).toBeCloseTo(0, 9);
    });
});

describe("computeOverlayDistanceScale", () => {
    it("距離 = 基準距離 で scale=1", () => {
        const cam = new Vector3(0, 0, 0);
        const pos = new Vector3(OVERLAY_REF_DISTANCE_M, 0, 0);
        expect(computeOverlayDistanceScale(cam, pos)).toBeCloseTo(1, 9);
    });

    it("距離 2倍 で scale=2", () => {
        const cam = new Vector3(0, 0, 0);
        const pos = new Vector3(2 * OVERLAY_REF_DISTANCE_M, 0, 0);
        expect(computeOverlayDistanceScale(cam, pos)).toBeCloseTo(2, 9);
    });

    it("近距離は下限 0.1 にクランプ", () => {
        const cam = new Vector3(0, 0, 0);
        const pos = new Vector3(1, 0, 0); // 1m
        expect(computeOverlayDistanceScale(cam, pos)).toBe(0.1);
    });

    it("refDistanceM が 0 以下なら既定値へフォールバック（Infinity 防止）", () => {
        const cam = new Vector3(0, 0, 0);
        const pos = new Vector3(OVERLAY_REF_DISTANCE_M, 0, 0);
        // ref=0 / 負値 → 既定 OVERLAY_REF_DISTANCE_M 扱いで scale=1（Infinity にならない）。
        expect(computeOverlayDistanceScale(cam, pos, 0)).toBeCloseTo(1, 9);
        expect(computeOverlayDistanceScale(cam, pos, -100)).toBeCloseTo(1, 9);
        expect(Number.isFinite(computeOverlayDistanceScale(cam, pos, 0))).toBe(true);
    });
});

describe("computeOverlayDistanceScaleFromDistance", () => {
    it("距離からスケールを算出（基準で1・2倍で2・下限0.1）", () => {
        expect(computeOverlayDistanceScaleFromDistance(OVERLAY_REF_DISTANCE_M)).toBeCloseTo(1, 9);
        expect(computeOverlayDistanceScaleFromDistance(2 * OVERLAY_REF_DISTANCE_M)).toBeCloseTo(2, 9);
        expect(computeOverlayDistanceScaleFromDistance(1)).toBe(0.1);
    });
    it("computeOverlayDistanceScale と一致する", () => {
        const cam = new Vector3(0, 0, 0);
        const pos = new Vector3(3 * OVERLAY_REF_DISTANCE_M, 0, 0);
        expect(computeOverlayDistanceScaleFromDistance(Vector3.Distance(cam, pos))).toBeCloseTo(
            computeOverlayDistanceScale(cam, pos),
            9,
        );
    });
    it("refDistanceM<=0 は既定値フォールバック", () => {
        expect(computeOverlayDistanceScaleFromDistance(OVERLAY_REF_DISTANCE_M, 0)).toBeCloseTo(1, 9);
    });
});

describe("computeOverlayLineHeight", () => {
    it("距離比例（×0.1）", () => {
        expect(computeOverlayLineHeight(20000)).toBeCloseTo(2000, 6);
    });
    it("下限 100m", () => {
        expect(computeOverlayLineHeight(100)).toBe(100); // 100*0.1=10 → 下限 100
    });
    it("上限 10000m", () => {
        expect(computeOverlayLineHeight(1_000_000)).toBe(10000); // 100000 → 上限
    });
});

describe("buildDrapedPolygonPaths", () => {
    const pts = [
        { lat: 35.3, lon: 138.7 },
        { lat: 35.4, lon: 138.8 },
        { lat: 35.3, lon: 138.9 },
    ];

    it("top は地形標高・bottom は楕円体面（alt=0）の ECEF", () => {
        const elevs = [1000, 2000, 1500];
        const { top, bottom } = buildDrapedPolygonPaths(pts, elevs, false);
        expect(top.length).toBe(3);
        expect(bottom.length).toBe(3);
        for (let i = 0; i < 3; i++) {
            // top は bottom より地心距離が標高ぶん大きい。
            expect(top[i].length()).toBeGreaterThan(bottom[i].length());
            expect(top[i].length() - bottom[i].length()).toBeCloseTo(elevs[i], 0);
            // bottom は楕円体面の既知点と一致。
            const b = geodeticToEcef(pts[i].lat, pts[i].lon, 0);
            expect(Vector3.Distance(bottom[i], b)).toBeLessThan(1e-3);
        }
    });

    it("closed=true は先頭頂点を末尾へ複製して輪を閉じる", () => {
        const { top, bottom } = buildDrapedPolygonPaths(pts, [0, 0, 0], true);
        expect(top.length).toBe(4);
        expect(bottom.length).toBe(4);
        expect(Vector3.Distance(top[0], top[3])).toBeLessThan(1e-6);
        expect(Vector3.Distance(bottom[0], bottom[3])).toBeLessThan(1e-6);
    });

    it("elevs が欠損（undefined）でも 0 扱いで落ちない", () => {
        const { top } = buildDrapedPolygonPaths(pts, [], false);
        expect(top.length).toBe(3);
        expect(Number.isFinite(top[0].length())).toBe(true);
    });
});
