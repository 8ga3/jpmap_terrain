/**
 * geo/overlayPlacement の単体テスト。
 *
 * - groundPlacementToRef: 位置が球面上（地心距離≈標高+曲率半径）・up が地心方向の単位ベクトル
 * - computeOverlayDistanceScale: 距離比例・下限 0.1
 * - computeOverlayLineHeight: 距離比例・[100,10000] クランプ
 * - computeOverlayPointDiameter: 距離比例・上限クランプ（地形貫通抑制）
 */

import { describe, it, expect } from "vitest";

import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";

import { geodeticToEcef } from "../src/terrain/geo/ecef";
import {
    groundPlacementToRef,
    computeOverlayDistanceScale,
    computeOverlayDistanceScaleFromDistance,
    computeOverlayLineHeight,
    computeOverlayPointDiameter,
    computeScreenUpToRef,
    buildDrapedPolygonPaths,
    generateGeodesicRing,
    surfaceOrientationToRef,
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
    it("minScale=0（2D 正射用）は下限なしで純比例（埋もれ・成長を防ぐ）", () => {
        // 既定（minScale=0.1）では下限に張り付くが、0 指定では距離に純比例する。
        expect(computeOverlayDistanceScaleFromDistance(1)).toBe(0.1);
        expect(
            computeOverlayDistanceScaleFromDistance(1, OVERLAY_REF_DISTANCE_M, 0),
        ).toBeCloseTo(1 / OVERLAY_REF_DISTANCE_M, 12);
        // computeOverlayDistanceScale 経由でも minScale が伝播する。
        const cam = new Vector3(0, 0, 0);
        const pos = new Vector3(50, 0, 0); // 50m（既定なら下限 0.1 に張り付く近距離）
        expect(computeOverlayDistanceScale(cam, pos)).toBe(0.1);
        expect(
            computeOverlayDistanceScale(cam, pos, OVERLAY_REF_DISTANCE_M, 0),
        ).toBeCloseTo(50 / OVERLAY_REF_DISTANCE_M, 12);
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

describe("computeOverlayPointDiameter", () => {
    it("距離比例スケールを反映する（クランプ範囲内）", () => {
        expect(computeOverlayPointDiameter(20, 2)).toBeCloseTo(40, 6);
    });
    it("100m を超えると上限クランプ（地形貫通抑制）", () => {
        expect(computeOverlayPointDiameter(20, 1000)).toBe(100); // 20*1000=20000 → 上限 100
    });
    it("baseDiameterM が 0 以下でも下限 0.001 を使う", () => {
        expect(computeOverlayPointDiameter(0, 1)).toBeCloseTo(0.001, 6);
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

describe("generateGeodesicRing", () => {
    it("segments 個の点を返す", () => {
        expect(generateGeodesicRing(35, 139, 5000, 8).length).toBe(8);
        expect(generateGeodesicRing(35, 139, 5000, 64).length).toBe(64);
    });

    it("各点は中心からほぼ radius の距離（ECEF, 誤差 2% 未満）", () => {
        const radius = 5000;
        const center = geodeticToEcef(35, 139, 0);
        const ring = generateGeodesicRing(35, 139, radius, 32);
        for (const p of ring) {
            const d = Vector3.Distance(center, geodeticToEcef(p.lat, p.lon, 0));
            expect(Math.abs(d - radius) / radius).toBeLessThan(0.02);
        }
    });

    it("θ=0 の始点は中心の真北（lon 不変・lat 増）", () => {
        const ring = generateGeodesicRing(35, 139, 5000, 8);
        expect(ring[0].lon).toBeCloseTo(139, 6);
        expect(ring[0].lat).toBeGreaterThan(35);
    });

    it("radius<=0・非整数/3未満 segments は throw", () => {
        expect(() => generateGeodesicRing(35, 139, 0, 8)).toThrow(/radiusMeters/);
        expect(() => generateGeodesicRing(35, 139, -1, 8)).toThrow(/radiusMeters/);
        expect(() => generateGeodesicRing(35, 139, 5000, 2)).toThrow(/segments/);
        expect(() => generateGeodesicRing(35, 139, 5000, 8.5)).toThrow(/segments/);
    });
});

describe("surfaceOrientationToRef", () => {
    /** クォータニオン q でローカル軸 v を回した世界ベクトルを返す。 */
    const rotate = (q: Quaternion, v: Vector3): Vector3 => {
        const m = new Matrix();
        q.toRotationMatrix(m);
        return Vector3.TransformCoordinates(v, m);
    };

    it("ローカル +Y が地心 up（位置の正規化）へ向く", () => {
        const pos = geodeticToEcef(35, 139, 1000);
        const q = new Quaternion();
        expect(surfaceOrientationToRef(pos, 0, q)).toBe(true);
        const worldUp = rotate(q, new Vector3(0, 1, 0));
        const up = pos.clone().normalize();
        expect(Vector3.Dot(worldUp, up)).toBeCloseTo(1, 6);
    });

    it("heading=0 でローカル +Z が北向き（地心 up と直交・北成分正）", () => {
        const pos = geodeticToEcef(35, 139, 0);
        const q = new Quaternion();
        surfaceOrientationToRef(pos, 0, q);
        const fwd = rotate(q, new Vector3(0, 0, 1));
        const up = pos.clone().normalize();
        // 前方は接線（up と直交）。
        expect(Vector3.Dot(fwd, up)).toBeCloseTo(0, 6);
        // 北半球で「北向き」は +Z 成分が正（北極方向に近い）。
        expect(fwd.z).toBeGreaterThan(0);
    });

    it("極では false（東が定義できない）", () => {
        const pos = geodeticToEcef(90, 0, 0);
        const q = new Quaternion();
        expect(surfaceOrientationToRef(pos, 0, q)).toBe(false);
    });
});

describe("computeScreenUpToRef", () => {
    it("トップダウン（視線=地心 up）でも視線に直交する screen up を返す", () => {
        const point = new Vector3(0, 0, 0);
        // カメラは真上（+Y）から見下ろす。camUp は水平（例: +Z）。
        const camPos = new Vector3(0, 100, 0);
        const camUp = new Vector3(0, 0, 1);
        const ref = new Vector3();
        const ok = computeScreenUpToRef(camPos, camUp, point, ref);
        expect(ok).toBe(true);
        expect(ref.length()).toBeCloseTo(1, 9);
        // 視線（point→cam = +Y）に直交。
        const toCam = camPos.subtract(point).normalize();
        expect(Vector3.Dot(ref, toCam)).toBeCloseTo(0, 6);
    });

    it("点とカメラが一致するときは false（ref 不変）", () => {
        const p = new Vector3(1, 2, 3);
        const ref = new Vector3(9, 9, 9);
        expect(computeScreenUpToRef(p.clone(), new Vector3(0, 1, 0), p, ref)).toBe(
            false,
        );
        expect(ref.x).toBe(9);
    });

    it("camUp が視線と平行のときは false（right が定義できない）", () => {
        const point = new Vector3(0, 0, 0);
        const camPos = new Vector3(0, 100, 0); // 視線 = +Y
        const camUp = new Vector3(0, 1, 0); // camUp ∥ 視線
        const ref = new Vector3();
        expect(computeScreenUpToRef(camPos, camUp, point, ref)).toBe(false);
    });
});
