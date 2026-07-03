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
    projectToViewport,
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

const FOV_Y = 0.8;
const METERS_PER_DEG = 111320;

describe("projectToViewport", () => {
    it("真上(tilt=0)・中心一致は (0,0)・behind=false", () => {
        const p = projectToViewport(0, 0, 0, 1000, 0, 0, FOV_Y, 1);
        expect(p.rx).toBeCloseTo(0, 6);
        expect(p.ry).toBeCloseTo(0, 6);
        expect(p.behind).toBe(false);
    });

    it("真上・北オフセットは ry>0(rx≈0)、東オフセットは rx>0(ry≈0)", () => {
        const north = projectToViewport(0, 200, 0, 1000, 0, 0, FOV_Y, 1);
        expect(north.ry).toBeGreaterThan(0);
        expect(north.rx).toBeCloseTo(0, 6);
        const east = projectToViewport(200, 0, 0, 1000, 0, 0, FOV_Y, 1);
        expect(east.rx).toBeGreaterThan(0);
        expect(east.ry).toBeCloseTo(0, 6);
    });

    it("真上・北方向 dNorth=R*tan(fov/2) で ry≈1（画面端）", () => {
        const R = 1000;
        const edge = R * Math.tan(FOV_Y / 2);
        const p = projectToViewport(0, edge, 0, R, 0, 0, FOV_Y, 1);
        expect(p.ry).toBeCloseTo(1, 3);
    });

    it("アスペクト比が大きいほど同じ東オフセットの rx は小さい（横に広い）", () => {
        const a1 = projectToViewport(200, 0, 0, 1000, 0, 0, FOV_Y, 1);
        const a2 = projectToViewport(200, 0, 0, 1000, 0, 0, FOV_Y, 2);
        expect(Math.abs(a2.rx)).toBeLessThan(Math.abs(a1.rx));
    });

    it("チルト時、標高が高いアバターほど画面上方（ry 増加）へずれる（勾配地形補正）", () => {
        const flat = projectToViewport(0, 200, 0, 1000, 60, 0, FOV_Y, 1);
        const high = projectToViewport(0, 200, 300, 1000, 60, 0, FOV_Y, 1);
        expect(high.ry).toBeGreaterThan(flat.ry);
    });

    it("カメラ背面の点は behind=true", () => {
        // tilt=80(ほぼ水平)・北向き。カメラは中心の南側かつ上空にあり、真南遠方はカメラ背後。
        const p = projectToViewport(0, -5000, 0, 1000, 80, 0, FOV_Y, 1);
        expect(p.behind).toBe(true);
    });

    it("方位90度(東向き)では北オフセットが主に横方向(rx)へ写る", () => {
        const p = projectToViewport(0, 200, 0, 1000, 0, 90, FOV_Y, 1);
        expect(Math.abs(p.rx)).toBeGreaterThan(Math.abs(p.ry));
    });
});

describe("computeAutoScroll (projection: 実スクリーン射影ベース)", () => {
    const projBase = {
        avatarLat: 35.0,
        avatarLon: 139.0,
        cameraLat: 35.0,
        cameraLon: 139.0,
        cameraAltitude: 1000,
        cameraTilt: 45,
        deadzoneRatio: DEFAULT_DEADZONE_RATIO,
        scrollLerp: DEFAULT_SCROLL_LERP,
        projection: {
            cameraAzimuth: 0,
            fovYRad: FOV_Y,
            aspect: 1.5,
            avatarGroundElevation: 0,
            cameraGroundElevation: 0,
        },
    };

    it("アバターがカメラ中心・同標高なら scrolled=false", () => {
        const r = computeAutoScroll(projBase);
        expect(r.scrolled).toBe(false);
        expect(r.lat).toBe(projBase.cameraLat);
        expect(r.lon).toBe(projBase.cameraLon);
    });

    it("北へ大きく離れると scrolled=true でカメラは北へ寄る（アバターを越えない）", () => {
        const r = computeAutoScroll({
            ...projBase,
            avatarLat: 35.0 + 2000 / METERS_PER_DEG,
        });
        expect(r.scrolled).toBe(true);
        expect(r.lat).toBeGreaterThan(projBase.cameraLat);
        expect(r.lat).toBeLessThan(35.0 + 2000 / METERS_PER_DEG);
    });

    it("scrollLerp=0 ならカメラを動かさない", () => {
        const r = computeAutoScroll({
            ...projBase,
            avatarLat: 35.0 + 2000 / METERS_PER_DEG,
            scrollLerp: 0,
        });
        expect(r.scrolled).toBe(false);
    });

    it("同じ水平位置でも、標高の高いアバターは画面上方へずれてスクロールが発動する（勾配地形）", () => {
        // 平坦(標高差0)ではデッドゾーン内に収まる 200m 北のオフセットを使う。
        const avatarLat = 35.0 + 200 / METERS_PER_DEG;
        const flat = computeAutoScroll({ ...projBase, avatarLat });
        expect(flat.scrolled).toBe(false);
        // アバターが 300m 高い斜面上にいると画面上方へずれ、デッドゾーン外→スクロール発動。
        const onSlope = computeAutoScroll({
            ...projBase,
            avatarLat,
            projection: { ...projBase.projection, avatarGroundElevation: 300 },
        });
        expect(onSlope.scrolled).toBe(true);
        expect(onSlope.lat).toBeGreaterThan(projBase.cameraLat);
    });

    it("大きく画面外へ外れても数フレームで画面内(EDGE_LIMIT内)へ収束する", () => {
        let camLat = 35.0;
        const camLon = 139.0;
        const avatarLat = 35.0 + 3000 / METERS_PER_DEG;
        for (let i = 0; i < 40; i++) {
            const r = computeAutoScroll({
                ...projBase,
                avatarLat,
                cameraLat: camLat,
                cameraLon: camLon,
            });
            camLat = r.lat;
        }
        const p = projectToViewport(
            0,
            (avatarLat - camLat) * METERS_PER_DEG,
            0,
            1000,
            45,
            0,
            FOV_Y,
            1.5,
        );
        const rmax = Math.max(Math.abs(p.rx), Math.abs(p.ry));
        expect(rmax).toBeLessThanOrEqual(0.96);
    });

    it("背面（射影不能）でも1フレームで全ワープせず scrollLerp で緩やかに寄せる", () => {
        // tilt=80(ほぼ水平)・北向きでアバターが真南遠方 → 投影上カメラ背面(behind)。
        const avatarLat = 35.0 - 5000 / METERS_PER_DEG;
        const scrollLerp = 0.3;
        const r = computeAutoScroll({
            ...projBase,
            avatarLat,
            cameraTilt: 80,
            scrollLerp,
            projection: { ...projBase.projection, cameraAzimuth: 0 },
        });
        expect(r.scrolled).toBe(true);
        // アバター位置へ 100% スナップしない（= avatarLat ではない）。
        expect(r.lat).not.toBeCloseTo(avatarLat, 6);
        // scrollLerp 分だけ寄る。
        const expected = 35.0 + scrollLerp * (avatarLat - 35.0);
        expect(r.lat).toBeCloseTo(expected, 6);
    });

    it("追従後はアバターのスクリーンはみ出しが縮む（1フレームで rmax 減少）", () => {
        const avatarLat = 35.0 + 3000 / METERS_PER_DEG;
        const before = projectToViewport(
            0,
            (avatarLat - 35.0) * METERS_PER_DEG,
            0,
            1000,
            45,
            0,
            FOV_Y,
            1.5,
        );
        const r = computeAutoScroll({ ...projBase, avatarLat });
        const after = projectToViewport(
            0,
            (avatarLat - r.lat) * METERS_PER_DEG,
            0,
            1000,
            45,
            0,
            FOV_Y,
            1.5,
        );
        const rmaxBefore = Math.max(Math.abs(before.rx), Math.abs(before.ry));
        const rmaxAfter = Math.max(Math.abs(after.rx), Math.abs(after.ry));
        expect(rmaxAfter).toBeLessThan(rmaxBefore);
    });
});
