/**
 * geo/cameraMapping の単体テスト。
 *
 * - uiToYawPitch ⇄ yawPitchToUi の往復精度・azimuth 正規化（[0,360)）
 * - geographicTangentBasisToRef: 東/北接線の直交性・既知点での向き・極の特異点
 * - cameraTangentBasisToRef: 右/前接線の直交性・真下視点の特異点
 * - panCenterOnSphereToRef: 地心距離保存・接線方向への移動
 * - clampRadiusForGroundClearance: 潜り込み補正・既クリアランス・水平視の発散回避
 */

import { describe, it, expect } from "@jest/globals";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { DEG2RAD, geodeticToEcef, type Geodetic } from "../src/terrain/geo/ecef";
import {
    uiToYawPitch,
    yawPitchToUi,
    geographicTangentBasisToRef,
    cameraTangentBasisToRef,
    panCenterOnSphereToRef,
    polePanSpeedMultiplier,
    clampRadiusForGroundClearance,
    rayEllipsoidNearHitToRef,
    resolveTerrainClickElevationToRef,
} from "../src/terrain/geo/cameraMapping";

describe("uiToYawPitch / yawPitchToUi", () => {
    it("azimuth/tilt[deg] → yaw/pitch[rad]", () => {
        const { yaw, pitch } = uiToYawPitch(90, 60);
        expect(yaw).toBeCloseTo(90 * DEG2RAD, 12);
        expect(pitch).toBeCloseTo(60 * DEG2RAD, 12);
    });

    it("往復: ui → yawPitch → ui（[0,360) 内）", () => {
        const samples: { az: number; tilt: number }[] = [
            { az: 0, tilt: 0 },
            { az: 45, tilt: 30 },
            { az: 180, tilt: 90 },
            { az: 359.9, tilt: 12.3 },
        ];
        for (const s of samples) {
            const { yaw, pitch } = uiToYawPitch(s.az, s.tilt);
            const { azimuthDeg, tiltDeg } = yawPitchToUi(yaw, pitch);
            expect(azimuthDeg).toBeCloseTo(s.az, 9);
            expect(tiltDeg).toBeCloseTo(s.tilt, 9);
        }
    });

    it("azimuth は [0,360) に正規化（負 yaw / 周回）", () => {
        // yaw = -90deg → 270deg
        expect(yawPitchToUi(-90 * DEG2RAD, 0).azimuthDeg).toBeCloseTo(270, 9);
        // yaw = 450deg → 90deg
        expect(yawPitchToUi(450 * DEG2RAD, 0).azimuthDeg).toBeCloseTo(90, 9);
    });
});

describe("geographicTangentBasisToRef", () => {
    it("東/北/up が互いに直交（赤道本初子午線）", () => {
        const center = geodeticToEcef(0, 0, 0);
        const east = new Vector3();
        const north = new Vector3();
        expect(geographicTangentBasisToRef(center, east, north)).toBe(true);
        const up = center.clone().normalize();
        expect(Vector3.Dot(east, north)).toBeCloseTo(0, 9);
        expect(Vector3.Dot(east, up)).toBeCloseTo(0, 9);
        expect(Vector3.Dot(north, up)).toBeCloseTo(0, 9);
        expect(east.length()).toBeCloseTo(1, 9);
        expect(north.length()).toBeCloseTo(1, 9);
    });

    it("lat=0,lon=0 で東は +Y（東経90°方向）、北は +Z（北極方向）", () => {
        const center = geodeticToEcef(0, 0, 0); // X 軸上
        const east = new Vector3();
        const north = new Vector3();
        geographicTangentBasisToRef(center, east, north);
        expect(east.y).toBeCloseTo(1, 9);
        expect(north.z).toBeCloseTo(1, 9);
    });

    it("極では east が縮退し false", () => {
        const center = geodeticToEcef(90, 0, 0); // ほぼ Z 軸上
        const east = new Vector3();
        const north = new Vector3();
        expect(geographicTangentBasisToRef(center, east, north)).toBe(false);
    });
});

describe("cameraTangentBasisToRef", () => {
    it("right/fwd が center と直交し正規化される", () => {
        const center = geodeticToEcef(35, 139, 0);
        const up = center.clone().normalize();
        // 真下より傾けた視線（up に直交しない適当な lookAt）。
        const lookAt = up.scale(-1).add(new Vector3(0.3, 0, 0)).normalize();
        const right = new Vector3();
        const fwd = new Vector3();
        expect(cameraTangentBasisToRef(center, lookAt, right, fwd)).toBe(true);
        expect(Vector3.Dot(right, up)).toBeCloseTo(0, 9);
        expect(Vector3.Dot(fwd, up)).toBeCloseTo(0, 9);
        expect(Vector3.Dot(right, fwd)).toBeCloseTo(0, 9);
        expect(right.length()).toBeCloseTo(1, 9);
        expect(fwd.length()).toBeCloseTo(1, 9);
    });

    it("真下視点（lookAt ∥ up）では false", () => {
        const center = geodeticToEcef(35, 139, 0);
        const up = center.clone().normalize();
        const lookAt = up.scale(-1); // 真下
        const right = new Vector3();
        const fwd = new Vector3();
        expect(cameraTangentBasisToRef(center, lookAt, right, fwd)).toBe(false);
    });
});

describe("panCenterOnSphereToRef", () => {
    it("地心距離を保ったまま接線方向へ移動する", () => {
        const center = geodeticToEcef(35, 139, 1000);
        const r0 = center.length();
        const east = new Vector3();
        const north = new Vector3();
        geographicTangentBasisToRef(center, east, north);
        const move = east.scale(500); // 東へ 500m
        const ref = new Vector3();
        panCenterOnSphereToRef(center, move, ref);
        // 地心距離は不変。
        expect(ref.length()).toBeCloseTo(r0, 3);
        // 東方向へ進んでいる（元 center との差が東成分正）。
        const delta = ref.subtract(center);
        expect(Vector3.Dot(delta, east)).toBeGreaterThan(0);
    });

    it("移動量ゼロなら center を保つ", () => {
        const center = geodeticToEcef(0, 0, 0);
        const ref = new Vector3();
        panCenterOnSphereToRef(center, Vector3.Zero(), ref);
        expect(ref.x).toBeCloseTo(center.x, 6);
        expect(ref.y).toBeCloseTo(center.y, 6);
        expect(ref.z).toBeCloseTo(center.z, 6);
    });
});

describe("clampRadiusForGroundClearance", () => {
    it("クリアランスを満たしていれば radius 不変", () => {
        // camAlt=5000, terrain=1000, clearance=300 → 余裕あり
        expect(clampRadiusForGroundClearance(60000, 5000, 1000, 300, 0.8)).toBe(60000);
    });

    it("潜り込み（camAlt < terrain+clearance）は radius を増やす", () => {
        // deficit = 1000+300-1100 = 200, dAltPerRadius=0.5 → +400
        const r = clampRadiusForGroundClearance(1000, 1100, 1000, 300, 0.5);
        expect(r).toBeCloseTo(1400, 6);
    });

    it("水平視（dAltPerRadius≈0）では radius を増やさない（発散回避）", () => {
        expect(clampRadiusForGroundClearance(1000, 0, 1000, 300, 0)).toBe(1000);
    });

    it("dAltPerRadius が非有限（NaN/Infinity）でも radius を破壊しない", () => {
        // NaN は < 1e-3 判定を素通りするため明示ガードが必要（camera.radius=NaN 防止）。
        expect(clampRadiusForGroundClearance(1000, 0, 1000, 300, NaN)).toBe(1000);
        expect(clampRadiusForGroundClearance(1000, 0, 1000, 300, Infinity)).toBe(1000);
    });
});

describe("rayEllipsoidNearHitToRef", () => {
    // WGS84 相当の半径（赤道 a、極 b）。
    const A = 6378137;
    const B = 6356752.314245;

    it("球（rx=ry=rz=R）の真上から直下視で半径上の点に当たる", () => {
        const R = 6378137;
        const origin = new Vector3(0, 0, R + 1000); // 面の 1000m 上空
        const dir = new Vector3(0, 0, -1); // 直下
        const ref = new Vector3();
        expect(rayEllipsoidNearHitToRef(origin, dir, R, R, R, ref)).toBe(true);
        expect(ref.z).toBeCloseTo(R, 3); // 手前側（上面）= +Z 側の半径
        expect(ref.x).toBeCloseTo(0, 3);
        expect(ref.y).toBeCloseTo(0, 3);
    });

    it("WGS84 楕円体: 北極直上からの直下視は極半径 b に当たる", () => {
        const origin = new Vector3(0, 0, B + 5000);
        const dir = new Vector3(0, 0, -1);
        const ref = new Vector3();
        expect(rayEllipsoidNearHitToRef(origin, dir, A, A, B, ref)).toBe(true);
        expect(ref.z).toBeCloseTo(B, 2); // 極では極半径
    });

    it("WGS84 楕円体: 赤道上空（+X）からの直下視は赤道半径 a に当たる", () => {
        const origin = new Vector3(A + 5000, 0, 0);
        const dir = new Vector3(-1, 0, 0);
        const ref = new Vector3();
        expect(rayEllipsoidNearHitToRef(origin, dir, A, A, B, ref)).toBe(true);
        expect(ref.x).toBeCloseTo(A, 2); // 赤道では赤道半径
    });

    it("斜めレイでも手前側（origin に近い方）の交点を返す", () => {
        const R = 100;
        const origin = new Vector3(0, 0, 200);
        const dir = new Vector3(0.3, 0, -1).normalize();
        const ref = new Vector3();
        expect(rayEllipsoidNearHitToRef(origin, dir, R, R, R, ref)).toBe(true);
        expect(ref.length()).toBeCloseTo(R, 3); // 球面上
        expect(ref.z).toBeGreaterThan(0); // 手前側（z>0）
    });

    it("楕円体を外す方向（空を指す）は false", () => {
        const R = 100;
        const origin = new Vector3(0, 0, 200);
        const dir = new Vector3(0, 0, 1); // 面から離れる向き
        const ref = new Vector3();
        expect(rayEllipsoidNearHitToRef(origin, dir, R, R, R, ref)).toBe(false);
    });

    it("dir は非正規化でも同一交点を返す（長さは交点に影響しない）", () => {
        const R = 100;
        const origin = new Vector3(0, 0, 200);
        const unitDir = new Vector3(0.3, 0, -1).normalize();
        const scaledDir = unitDir.scale(7.5); // 長さ 7.5 倍
        const refUnit = new Vector3();
        const refScaled = new Vector3();
        expect(rayEllipsoidNearHitToRef(origin, unitDir, R, R, R, refUnit)).toBe(true);
        expect(rayEllipsoidNearHitToRef(origin, scaledDir, R, R, R, refScaled)).toBe(true);
        expect(Vector3.Distance(refUnit, refScaled)).toBeLessThan(1e-6);
    });

    it("半径が非正/非有限なら NaN を書かず false（0除算ガード）", () => {
        const origin = new Vector3(0, 0, 200);
        const dir = new Vector3(0, 0, -1);
        const ref = new Vector3();
        const cases: Array<[number, number, number]> = [
            [0, 100, 100],
            [100, 0, 100],
            [100, 100, 0],
            [-100, 100, 100],
            [NaN, 100, 100],
            [Infinity, 100, 100],
        ];
        for (const [rx, ry, rz] of cases) {
            ref.copyFromFloats(123, 123, 123); // 事前値（書き換わらないこと）
            expect(rayEllipsoidNearHitToRef(origin, dir, rx, ry, rz, ref)).toBe(false);
            expect(ref.x).toBe(123); // ref は変更されない
            expect(Number.isNaN(ref.x)).toBe(false);
        }
    });

    it("origin/dir が非有限なら NaN を書かず false（入力ガード）", () => {
        const ref = new Vector3();
        const R = 100;
        const badInputs: Array<[Vector3, Vector3]> = [
            [new Vector3(NaN, 0, 200), new Vector3(0, 0, -1)],
            [new Vector3(0, Infinity, 200), new Vector3(0, 0, -1)],
            [new Vector3(0, 0, 200), new Vector3(NaN, 0, -1)],
            [new Vector3(0, 0, 200), new Vector3(0, 0, -Infinity)],
        ];
        for (const [origin, dir] of badInputs) {
            ref.copyFromFloats(123, 123, 123);
            expect(rayEllipsoidNearHitToRef(origin, dir, R, R, R, ref)).toBe(false);
            expect(ref.x).toBe(123);
            expect(Number.isNaN(ref.x)).toBe(false);
        }
    });
});

describe("resolveTerrainClickElevationToRef", () => {
    const R = 6378137; // 球近似（半径同一。マーチングロジックの検証が目的で楕円率は不要）
    // 赤道直下視（緯度0）。ecefToGeodeticToRef は WGS84 楕円体基準のため、球近似(R=R=R)でも
    // 赤道なら赤道半径 a=R と一致し altMeters に極半径との差が混入しない。
    const origin = new Vector3(R + 10000, 0, 0);
    const dirDown = new Vector3(-1, 0, 0);

    const emptyGeo = (): Geodetic => ({ latDeg: 0, lonDeg: 0, altMeters: 0 });

    it("標高一定な平地では、その標高分持ち上がった交点に収束する", () => {
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            origin, dirDown, R, R, () => 500, 5000, 20, 20, 20, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        expect(geo.altMeters).toBeCloseTo(500, 1);
        expect(outHit.length()).toBeCloseTo(R + 500, 0);
    });

    it("地形標高が常にnull(未ロード等)なら標高0(海面)の交点にフォールバックする", () => {
        const outHit = new Vector3();
        const geo = emptyGeo();
        let calls = 0;
        const hit = resolveTerrainClickElevationToRef(
            origin, dirDown, R, R,
            () => {
                calls++;
                return null;
            },
            5000, 20, 20, 20, 16, outHit, geo,
        );
        expect(calls).toBeGreaterThan(0);
        expect(hit).toBe(true);
        expect(geo.altMeters).toBeCloseTo(0, 1);
        expect(outHit.length()).toBeCloseTo(R, 0);
    });

    it("レイが地球を完全に外す(空を指す)場合は false を返し outHit/geo を変更しない", () => {
        const spaceOrigin = new Vector3(R + 10000, 0, 0);
        const spaceDir = new Vector3(1, 0, 0); // 地球から離れる向き
        const outHit = new Vector3(123, 456, 789);
        const geo: Geodetic = { latDeg: 111, lonDeg: 222, altMeters: 333 };
        const hit = resolveTerrainClickElevationToRef(
            spaceOrigin, spaceDir, R, R, () => 0, 5000, 20, 20, 20, 16, outHit, geo,
        );
        expect(hit).toBe(false);
        expect(outHit.equals(new Vector3(123, 456, 789))).toBe(true);
        expect(geo).toEqual({ latDeg: 111, lonDeg: 222, altMeters: 333 });
    });

    it("急斜面（緯度依存の標高）でも交点を検出し、探索点の緯度が反復ごとに動く", () => {
        // 赤道付近から少し北向きに傾けたレイ（Z成分を混ぜる）で緯度が探索点ごとに動くようにする。
        const dir = new Vector3(-1, 0, 0.3).normalize();
        const seenLat: number[] = [];
        // 緯度依存で標高が大きく変わる急斜面を模擬。
        const terrainElevAt = (latDeg: number): number => {
            seenLat.push(latDeg);
            return 500 + latDeg * 100000;
        };
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            origin, dir, R, R, terrainElevAt, 5000, 20, 20, 20, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        const distinctLat = new Set(seenLat.map((l) => l.toFixed(8)));
        expect(distinctLat.size).toBeGreaterThan(1); // 交点が探索中に動いている
    });

    it("カメラ高度がmaxTerrainElevM未満（低空視点）でも平地クリックが機能する", () => {
        // カメラ高度100m。maxTerrainElevM(5000)より低い位置からの直下視 — 実際のデモ視点に近い。
        // 想定最大標高面(半径R+5000)は origin(半径R+100)の外側にあり、前方交点は存在しない
        // （地球裏側の遠方点になり得る）ため、tNear は origin(t=0)にフォールバックする必要がある。
        const lowOrigin = new Vector3(R + 100, 0, 0);
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            lowOrigin, dirDown, R, R, () => 50, 5000, 20, 20, 20, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        expect(geo.altMeters).toBeCloseTo(50, 1);
        expect(outHit.length()).toBeCloseTo(R + 50, 0);
    });

    it("手前に山（帯状の障害）があると、山を貫通せず手前側の斜面で交点を検出する", () => {
        // 緯度 [0.02, 0.04) 度の帯だけ標高3000mの山、それ以外は平地(標高0)。
        // レイは緯度が単調増加する方向へ進むため、山の手前側(緯度0.02付近)から先に地表を割る。
        const dir = new Vector3(-1, 0, 0.3).normalize();
        const terrainElevAt = (latDeg: number): number =>
            latDeg >= 0.02 && latDeg < 0.04 ? 3000 : 0;
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            origin, dir, R, R, terrainElevAt, 5000, 20, 200, 200, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        // 山の手前斜面で止まるはず（山を貫通して奥の平地[緯度0.04以降]まで進んでいない）。
        expect(geo.latDeg).toBeLessThan(0.04);
        expect(geo.altMeters).toBeGreaterThan(100); // 平地(0m)ではなく山の斜面上
    });

    it("stepDistanceMベースの動的ステップ数により、幅の狭い尾根も貫通せず検出する", () => {
        // 緯度 [0.02, 0.021) 度（地上距離 約111m）という狭い帯だけ標高3000mの尾根、他は平地。
        // 稜線のような幅の狭い障害は、ステップ幅が粗いと粗い探索がまたいでしまい見逃す
        // （後続の「見逃す」テスト参照）。ステップ間隔を距離ベースで細かくすれば検出できる。
        const dir = new Vector3(-1, 0, 0.3).normalize();
        const terrainElevAt = (latDeg: number): number =>
            latDeg >= 0.02 && latDeg < 0.021 ? 3000 : 0;
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            origin, dir, R, R, terrainElevAt, 5000, 20, 20, 2000, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        expect(geo.latDeg).toBeLessThan(0.021);
        expect(geo.altMeters).toBeGreaterThan(100); // 尾根上で止まっている（平地には着地していない）
    });

    it("ステップ数を1に固定する（動的分割を無効化）と、幅の狭い尾根を見逃して貫通する", () => {
        // 上と同じ狭い尾根だが、min=max=1 でステップ数を1に固定した比較用ケース。
        const dir = new Vector3(-1, 0, 0.3).normalize();
        const terrainElevAt = (latDeg: number): number =>
            latDeg >= 0.02 && latDeg < 0.021 ? 3000 : 0;
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            origin, dir, R, R, terrainElevAt, 5000, 1_000_000, 1, 1, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        // 尾根を検出できず、平地（標高0付近）に着地してしまう。
        expect(geo.altMeters).toBeLessThan(100);
    });

    it("水平線よりわずかに上に高い山の頂上だけが見えるレイでも交点を検出する（貫通せずfalseも返さない）", () => {
        // カメラ高度50km。視線は「標高0楕円体の地平線角度」と「想定最大標高(5000m)楕円体の
        // 地平線角度」のちょうど中間を向く（Pythonで検算した角度）。この視線は標高0面には
        // 当たらないが、想定最大標高面には当たる＝水平線よりわずかに上に高い山の頂上だけが
        // 見えている状況（例: 富士山）。従来はここで「空を指している」と誤判定して false を
        // 返していた。
        const highOrigin = new Vector3(R + 50000, 0, 0);
        const thetaDeg = 83.03278031823208;
        const theta = thetaDeg * (Math.PI / 180);
        const dir = new Vector3(-Math.cos(theta), 0, Math.sin(theta));
        // 緯度 [6.5, 7.5) 度の帯に標高3776m（富士山相当）の山、他は平地。
        const terrainElevAt = (latDeg: number): number =>
            latDeg >= 6.5 && latDeg < 7.5 ? 3776 : 0;
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            highOrigin, dir, R, R, terrainElevAt, 5000, 500, 50, 2000, 20, outHit, geo,
        );
        expect(hit).toBe(true);
        expect(geo.altMeters).toBeGreaterThan(1000); // 山の斜面上（平地=0mではない）
        expect(geo.altMeters).toBeLessThanOrEqual(3777);
    });

    it("水平線より上を見ていて地表(山)が検出できない場合は false を返し、遠方の仮想点を採用しない", () => {
        // 上と同じ「標高0面には当たらない」視線だが、探索範囲内に山が存在しない（平地のみ）。
        // 外殻の奥交点（実際の地形と無関係などこか遠方の点）をそのまま採用すると、ズームや
        // center再計算がその遠方点へ暴走する（実機で center が超遠方になる不具合の原因だった）。
        const highOrigin = new Vector3(R + 50000, 0, 0);
        const thetaDeg = 83.03278031823208;
        const theta = thetaDeg * (Math.PI / 180);
        const dir = new Vector3(-Math.cos(theta), 0, Math.sin(theta));
        const outHit = new Vector3(123, 456, 789);
        const geo: Geodetic = { latDeg: 111, lonDeg: 222, altMeters: 333 };
        const hit = resolveTerrainClickElevationToRef(
            highOrigin, dir, R, R, () => 0, 5000, 500, 50, 2000, 20, outHit, geo,
        );
        expect(hit).toBe(false);
        expect(outHit.equals(new Vector3(123, 456, 789))).toBe(true);
        expect(geo).toEqual({ latDeg: 111, lonDeg: 222, altMeters: 333 });
    });

    it("探索パラメータが非有限・範囲外なら false を返し outHit/geo を変更しない（NaN 混入で steps が壊れる防止）", () => {
        // [maxTerrainElevM, stepDistanceM, minCoarseSteps, maxCoarseSteps, refineIterations]
        const invalidParamSets: Array<[number, number, number, number, number]> = [
            [NaN, 20, 20, 20, 16],
            [-100, 20, 20, 20, 16], // maxTerrainElevM < 0
            [5000, NaN, 20, 20, 16],
            [5000, 0, 20, 20, 16],
            [5000, -20, 20, 20, 16],
            [5000, 20, NaN, 20, 16],
            [5000, 20, 0, 20, 16],
            [5000, 20, 2.5, 20, 16], // minCoarseSteps が非整数
            [5000, 20, 20, NaN, 16],
            [5000, 20, 20, 10, 16], // maxCoarseSteps < minCoarseSteps
            [5000, 20, 20, 20.5, 16], // maxCoarseSteps が非整数
            [5000, 20, 20, 20, NaN],
            [5000, 20, 20, 20, -1],
            [5000, 20, 20, 20, 1.5], // refineIterations が非整数
        ];
        for (const [maxElev, stepDist, minSteps, maxSteps, refine] of invalidParamSets) {
            const outHit = new Vector3(123, 456, 789);
            const geo: Geodetic = { latDeg: 111, lonDeg: 222, altMeters: 333 };
            const hit = resolveTerrainClickElevationToRef(
                origin, dirDown, R, R, () => 500, maxElev, stepDist, minSteps, maxSteps, refine, outHit, geo,
            );
            expect(hit).toBe(false);
            expect(outHit.equals(new Vector3(123, 456, 789))).toBe(true);
            expect(geo).toEqual({ latDeg: 111, lonDeg: 222, altMeters: 333 });
        }
    });
});

describe("polePanSpeedMultiplier", () => {
    const R = 6378137; // WGS84 semi-major axis 相当

    it("赤道では 1.0（減速なし）", () => {
        const center = new Vector3(R, 0, 0);
        expect(polePanSpeedMultiplier(center, R)).toBeCloseTo(1, 12);
    });

    it("高高度では極へ近づくほど 1 未満へ減速する", () => {
        const eq = polePanSpeedMultiplier(new Vector3(R, 0, 0), R);
        const mid = polePanSpeedMultiplier(
            new Vector3(R * Math.cos(Math.PI / 4), 0, R * Math.sin(Math.PI / 4)),
            R,
        );
        const high = polePanSpeedMultiplier(
            new Vector3(R * Math.cos((80 * Math.PI) / 180), 0, R * Math.sin((80 * Math.PI) / 180)),
            R,
        );
        expect(eq).toBeGreaterThan(mid);
        expect(mid).toBeGreaterThan(high);
        expect(high).toBeGreaterThan(0);
        expect(high).toBeLessThan(1);
    });

    it("極（高高度）では 0 へ漸近する", () => {
        const center = new Vector3(0, 0, R);
        expect(polePanSpeedMultiplier(center, R)).toBeCloseTo(0, 12);
    });

    it("地表付近（低高度）では緯度に依らず 1（減速無効）", () => {
        const nearPole = new Vector3(
            R * Math.cos((80 * Math.PI) / 180),
            0,
            R * Math.sin((80 * Math.PI) / 180),
        );
        expect(polePanSpeedMultiplier(nearPole, 1000)).toBeCloseTo(1, 12);
    });

    it("常に [0,1] に収まる / 退化入力は 1", () => {
        const samples: Array<[Vector3, number]> = [
            [new Vector3(R, 0, 0), R],
            [new Vector3(0, 0, R), R],
            [new Vector3(0, 0, R), 1],
            [new Vector3(-R, 0, 0), R * 10],
            [new Vector3(0, 0, -R), R / 100],
        ];
        for (const [center, h] of samples) {
            const m = polePanSpeedMultiplier(center, h);
            expect(m).toBeGreaterThanOrEqual(0);
            expect(m).toBeLessThanOrEqual(1);
        }
        // 原点近傍（地心距離 < 1）は退化として 1 を返す。
        expect(polePanSpeedMultiplier(new Vector3(0, 0, 0), R)).toBe(1);
    });

    it("非有限入力（NaN/Infinity）は NaN を返さず 1（退化扱い）", () => {
        const badSamples: Array<[Vector3, number]> = [
            [new Vector3(R, 0, 0), NaN],
            [new Vector3(R, 0, 0), Infinity],
            [new Vector3(NaN, 0, 0), R],
            [new Vector3(0, 0, NaN), R],
            [new Vector3(Infinity, 0, 0), R],
        ];
        for (const [center, h] of badSamples) {
            const m = polePanSpeedMultiplier(center, h);
            expect(Number.isNaN(m)).toBe(false);
            expect(m).toBe(1);
        }
    });
});
