/**
 * geo/cameraMapping の単体テスト。
 *
 * - uiToYawPitch ⇄ yawPitchToUi の往復精度・azimuth 正規化（[0,360)）
 * - geographicTangentBasisToRef: 東/北接線の直交性・既知点での向き・極の特異点
 * - cameraTangentBasisToRef: 右/前接線の直交性・真下視点の特異点
 * - panCenterOnSphereToRef: 地心距離保存・接線方向への移動
 * - clampRadiusForGroundClearance: 潜り込み補正・既クリアランス・水平視の発散回避
 */

import { describe, it, expect, jest } from "@jest/globals";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

import { DEG2RAD, geodeticToEcef, ecefToGeodetic, type Geodetic } from "../src/terrain/geo/ecef";
import {
    uiToYawPitch,
    yawPitchToUi,
    geographicTangentBasisToRef,
    cameraTangentBasisToRef,
    panCenterOnSphereToRef,
    polePanSpeedMultiplier,
    clampRadiusForGroundClearance,
    stepGroundClearanceRadius,
    rayEllipsoidNearHitToRef,
    resolveTerrainClickElevationToRef,
    resolveRecalcCenterSource,
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

describe("stepGroundClearanceRadius (地形衝突 radius 補正のスムーズ化・復帰)", () => {
    const PUSH = 0.3;
    const RELAX = 0.1;
    const MIN = 50;
    const D = 0.5; // dAltPerRadius

    it("クリアランスに余裕があれば radius/boost は変化しない", () => {
        // camAlt=5000 >> terrain(1000)+MIN。boost=0。
        const s = stepGroundClearanceRadius(60000, 0, 5000, 1000, MIN, D, PUSH, RELAX);
        expect(s.radius).toBeCloseTo(60000, 6);
        expect(s.boost).toBeCloseTo(0, 6);
    });

    it("潜り込み時は 1 フレームで一気に必要 radius へ跳ねず、押し出しは PUSH 補間で緩やか", () => {
        // naturalRadius=1000, camAlt=1100, terrain=1000, MIN=300 → deficit=200,
        // required=1000+200/0.5=1400, targetBoost=400。1フレーム目 boost=400*PUSH=120。
        const s = stepGroundClearanceRadius(1000, 0, 1100, 1000, 300, D, PUSH, RELAX);
        expect(s.boost).toBeCloseTo(120, 6);
        expect(s.radius).toBeCloseTo(1120, 6);
        // 直接代入（1400）より小さい＝一段でジャンプしない。
        expect(s.radius).toBeLessThan(1400);
    });

    it("潜り込みが続くと数フレームで必要 radius へ収束する（振動しない）", () => {
        let radius = 1000;
        let boost = 0;
        // camAlt は radius に線形（camAlt = baseAlt + (radius-baseRadius)*D）と近似して駆動。
        const baseRadius = 1000;
        const baseAlt = 1100;
        for (let i = 0; i < 60; i++) {
            const camAlt = baseAlt + (radius - baseRadius) * D;
            const s = stepGroundClearanceRadius(radius, boost, camAlt, 1000, 300, D, PUSH, RELAX);
            radius = s.radius;
            boost = s.boost;
        }
        // required=1400 相当（deficit を D で割った分）に収束。
        expect(radius).toBeCloseTo(1400, 1);
        expect(boost).toBeCloseTo(400, 1);
    });

    it("水平視ガードで押し出せない潜り込みフレームは現状維持（boost を戻さない）", () => {
        // naturalRadius=1000, boost=400, dAltPerRadius=0(水平視) → naturalAlt=1100。
        // deficit = 1000+300-1100 = 200 > 0 だが clampRadiusForGroundClearance は
        // dAltPerRadius<1e-3 ガードで naturalRadius 据え置き → 押し出せない。
        // このフレームは relax で追加分を戻さず現状維持すべき。
        const s = stepGroundClearanceRadius(1400, 400, 1100, 1000, 300, 0, PUSH, RELAX);
        expect(s.radius).toBe(1400);
        expect(s.boost).toBe(400);
    });

    it("障害が解消すると boost は 0 へ戻り radius は素の値へ復帰する（単調増加しない）", () => {
        // 追加分 400 を持った状態から、地形が十分低くなった（クリアランス余裕）フレーム。
        // naturalRadius=1400-400=1000。camAlt はその radius で余裕あり(5000)。
        let radius = 1400;
        let boost = 400;
        // RELAX=0.1 の指数減衰で 0 へ漸近する。十分なフレーム数で素の値へ戻ることを確認。
        for (let i = 0; i < 200; i++) {
            const s = stepGroundClearanceRadius(radius, boost, 5000, 0, MIN, D, PUSH, RELAX);
            radius = s.radius;
            boost = s.boost;
        }
        expect(boost).toBeCloseTo(0, 3);
        expect(radius).toBeCloseTo(1000, 3);
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
    const R = 6378137; // 球近似（赤道半径a・極半径b とも R。マーチングロジックの検証が目的で楕円率は不要）
    // 赤道直下視（緯度0）。ecefToGeodeticToRef は WGS84 楕円体基準のため、球近似(a=b=R)でも
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

    it("originが標高0楕円体の内側(異常値: 地下/海面下)にある場合、tNear以降で最初の海面交点をtFarに使う", () => {
        // origin半径 R-1000（海面下1000m相当。通常起こらない異常値だが境界ケース確認用）。
        // innerHits(標高0面)は t0<0<t1 になる（origin が内側にいるため）。
        const insideOrigin = new Vector3(R - 1000, 0, 0);
        const dir = new Vector3(1, 0, 0); // 外向き（海面から出る方向）
        // 地形標高を常に-2000m（海面よりさらに深い）にして、tNear〜tFarの間ずっとレイが
        // 地形より上（height>0、地表未検出）になるようにする。
        const terrainElevAt = (): number => -2000;
        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            insideOrigin, dir, R, R, terrainElevAt, 5000, 20, 20, 20, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        // 海面交点（半径R、標高0）にフォールバックするはず。外殻（標高5000）の遠方点に
        // ならない（tFarの選択にt0<0のみを見ていた旧実装だとここが壊れていた）。
        expect(outHit.length()).toBeCloseTo(R, 0);
        expect(geo.altMeters).toBeCloseTo(0, 1);
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
        // 上と同じ狭い尾根だが、min=max=1 かつ stepDistanceM=1,000,000m でステップ数を1に固定
        // した比較用ケース。二段階探索では第2段の細分数も stepDistanceM に依存するため、
        // stepDistanceM を探索区間より桁違いに大きくすると第2段（遠方海面ケースの全域細分を
        // 含む）でも subSteps=ceil(区間/1,000,000)=1 に潰れ、尾根を跨いだまま見逃す。粗い設定
        // では検出できないという回帰デモの意図を維持する（本来は stepDistanceM を地形解像度に
        // 合わせて細かく渡すことで検出する）。
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

    it("近水平視線・長距離探索で第1段の粗格子間隙に隠れた狭い尾根を貫通しない（実測条件）", () => {
        // 実測再現: カメラ高度500m、下向き角0.02rad相当のほぼ水平視線。標高0面到達まで
        // 約28km（探索区間が長大）。実運用定数（stepDistanceM=5, minCoarseSteps=20,
        // maxCoarseSteps=300）では第1段が300ステップで頭打ちし、実効ステップ幅が約93.6mまで
        // 劣化する。幅28m・高さ300mの尾根を探索区間中央付近の「隣り合う粗サンプルの間隙」に
        // 置くと、粗探索はどの粗サンプルの緯度も尾根帯に入らず反転を検出できない。旧実装（単段
        // 粗探索）では反転が一度も起きないまま奥端まで走破し、標高0面（海面）フォールバックで
        // 約28km先の遠方点を採用していた（山を突き抜けた超遠方がカメラ回転中心になる不具合）。
        // 二段階探索では「第1段で反転せず奥端が標高0面」のケースで探索区間全体を細分し直し、
        // 隠れた尾根を捕捉して尾根手前で止まる。
        //
        // 楕円体はR,Rの球近似ではなく実運用どおりWGS84の実楕円体(a,b)を渡す。球近似だと、
        // 標高0(平地)でも探索区間奥端(tFar)でのaltMetersがWGS84実楕円体との離心率差分だけ
        // 正に残留し(このケースで緯度約-0.25°地点で約+0.4m)、粗探索の最終サンプルが
        // heightAboveTerrain<=0を満たさなくなる。これにより「反転なし→全域再細分」分岐に
        // 常に入ってしまい、「粗探索の最終サンプルがtFarそのものであるために反転扱いされる」
        // という実運用WGS84での本来の不具合（このテストが検証したい回帰条件そのもの）を
        // 再現できない。
        const A = Wgs84Ellipsoid.semiMajorAxis;
        const B = Wgs84Ellipsoid.semiMinorAxis;
        const camAlt = 500;
        const camOrigin = new Vector3(A + camAlt, 0, 0);
        const downAngle = 0.02; // ローカル水平（+Z接線）からの下向き角[rad]
        const dir = new Vector3(-Math.sin(downAngle), 0, -Math.cos(downAngle)).normalize();

        // このテストの探索区間（約28km）は idealSteps が全域細分の上限を超えるため、
        // 実装側の one-shot 警告（narrow terrain may be missed）が発火する。想定内の警告
        // でテストログを汚さないよう抑止する。expect失敗時もリークしないよう try/finally で
        // 必ず restore する。
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            // 標高0面到達距離（tFar）を平地で1回解いて幾何を確定し、第1段の粗サンプル格子を再現する。
            const flatHit = new Vector3();
            const flatGeo = emptyGeo();
            const gotFlat = resolveTerrainClickElevationToRef(
                camOrigin, dir, A, B, () => 0, 5000, 5, 20, 300, 16, flatHit, flatGeo,
            );
            expect(gotFlat).toBe(true);
            const tFar = flatHit.subtract(camOrigin).length(); // ≈ 28121m
            expect(tFar).toBeGreaterThan(20000);

            // 第1段の粗サンプル格子（steps=300 で頭打ち）を再現し、区間中央の格子間隙の緯度を求める。
            const steps = 300; // ceil(28121/5)=5625 だが maxCoarseSteps=300 で頭打ち
            const stepT = tFar / steps;
            const iMid = Math.floor(steps / 2);
            const unitDir = dir.clone();
            const geodeticLatAt = (t: number): number =>
                ecefToGeodetic(unitDir.scale(t).add(camOrigin)).latDeg;
            const latSampleA = geodeticLatAt(stepT * iMid); // 尾根手前の粗サンプル
            const latSampleB = geodeticLatAt(stepT * (iMid + 1)); // 尾根奥の粗サンプル
            const gapLat = geodeticLatAt(stepT * iMid + stepT / 2); // 2サンプルの中間（格子間隙）

            // 幅28m相当の尾根帯を格子間隙の緯度に中心を合わせて置く（両隣の粗サンプルは帯の外側）。
            const halfBandDeg = 28 / (A * DEG2RAD) / 2;
            expect(Math.abs(latSampleA - gapLat)).toBeGreaterThan(halfBandDeg); // 手前サンプルは帯外
            expect(Math.abs(latSampleB - gapLat)).toBeGreaterThan(halfBandDeg); // 奥サンプルは帯外
            const ridgeElevM = 300;
            const terrainElevAt = (latDeg: number): number =>
                latDeg > gapLat - halfBandDeg && latDeg < gapLat + halfBandDeg ? ridgeElevM : 0;

            const outHit = new Vector3();
            const geo = emptyGeo();
            const hit = resolveTerrainClickElevationToRef(
                camOrigin, dir, A, B, terrainElevAt, 5000, 5, 20, 300, 16, outHit, geo,
            );
            expect(hit).toBe(true);
            // 尾根を貫通せず尾根近傍で止まること。標高は尾根相当（高さ300m付近まで持ち上がる）で、
            // 平地(0m)ではない。着地距離は尾根位置（中央 ≈ tFar/2）付近で、遠方28km地点まで進んで
            // いない（旧実装のバグ再現＝約28kmを明確に下回る）。
            const hitDist = outHit.subtract(camOrigin).length();
            expect(hitDist).toBeLessThan(tFar * 0.6); // 遠方海面(≈tFar)ではなく尾根手前〜尾根上
            expect(geo.altMeters).toBeGreaterThan(100); // 平地(0m)ではなく尾根の標高に達している
            expect(geo.altMeters).toBeLessThanOrEqual(ridgeElevM + 1);
        } finally {
            warn.mockRestore();
        }
    });

    it("奥端(tFar)近傍の地形標高が実際に0でない場合は最終サンプルの反転も見逃さない", () => {
        // hasSeaLevelFar かつ最終サンプルの「反転」除外は、その地点の地形標高が実際に0（海面・
        // 未ロードのフォールバック含む）の場合に限る必要がある。沿岸・低地等でtFar近傍の地形標高が
        // 0でない場合、そこでの反転は本物の地表検出であり、除外すると地表を検出できず標高0交点
        // （地表より低い位置）を誤って採用してしまう。
        //
        // maxCoarseSteps=200を固定し、idealSteps（後述）がこれを下回るようにして「頭打ちしていない
        // 通常ケース」を作る（頭打ちしている場合は全域再細分が別途走り、この分岐の単体検証にならない）。
        const dir = new Vector3(-1, 0, 0.3).normalize();
        const flatHit = new Vector3();
        const flatGeo = emptyGeo();
        const gotFlat = resolveTerrainClickElevationToRef(
            origin, dir, R, R, () => 0, 5000, 200, 200, 200, 16, flatHit, flatGeo,
        );
        expect(gotFlat).toBe(true);
        const tFar = flatHit.subtract(origin).length();
        const idealSteps = Math.ceil(tFar / 200);
        expect(idealSteps).toBeLessThan(200); // 頭打ちしていないことの前提を確認

        // 第1段最終区間 [t(steps-1), tFar] の中点より奥だけを標高10mにする。手前側の粗サンプル
        // （i=steps-1 以前）は地形標高0のまま＝反転しない。最終サンプル（t=tFar）だけが
        // heightAboveTerrain<=0になる状況を作る。
        const steps = 200;
        const stepT = tFar / steps;
        const secondLastT = stepT * (steps - 1);
        const geodeticLatAt = (t: number): number =>
            ecefToGeodetic(dir.clone().scale(t).add(origin)).latDeg;
        const midLat = (geodeticLatAt(secondLastT) + geodeticLatAt(tFar)) / 2;
        const coastElevM = 10;
        const terrainElevAt = (latDeg: number): number => (latDeg >= midLat ? coastElevM : 0);

        const outHit = new Vector3();
        const geo = emptyGeo();
        const hit = resolveTerrainClickElevationToRef(
            origin, dir, R, R, terrainElevAt, 5000, 200, 200, 200, 16, outHit, geo,
        );
        expect(hit).toBe(true);
        // 標高0交点（地表より低い位置）ではなく、実際の地形標高付近で止まっていること。
        expect(geo.altMeters).toBeGreaterThan(1);
        expect(geo.altMeters).toBeLessThanOrEqual(coastElevM + 1);
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

describe("resolveRecalcCenterSource", () => {
    it("今フレームで地表を検出できたら常に current を使う（保持の有無・鮮度に依らない）", () => {
        expect(resolveRecalcCenterSource(true, false, 0, 100)).toBe("current");
        expect(resolveRecalcCenterSource(true, true, 0, 100)).toBe("current");
        // 保持が古くても成功フレームは current 優先。
        expect(resolveRecalcCenterSource(true, true, 9999, 100)).toBe("current");
    });

    it("検出失敗でも保持点が新しければ held を使い、補正の停止（＝一括スナップ）を避ける", () => {
        expect(resolveRecalcCenterSource(false, true, 0, 100)).toBe("held");
        expect(resolveRecalcCenterSource(false, true, 50, 100)).toBe("held");
        // 境界（経過時間 == 上限）は再利用可。
        expect(resolveRecalcCenterSource(false, true, 100, 100)).toBe("held");
    });

    it("検出失敗で保持が古すぎる/存在しない場合は skip（補正しない）", () => {
        // 保持なし。
        expect(resolveRecalcCenterSource(false, false, 0, 100)).toBe("skip");
        // 保持が上限超過（数フレームを超えて失敗が継続）。古い点の再利用でカメラが的外れに寄るのを防ぐ。
        expect(resolveRecalcCenterSource(false, true, 101, 100)).toBe("skip");
        expect(resolveRecalcCenterSource(false, true, 9999, 100)).toBe("skip");
    });

    it("経過時間・上限が非有限/負なら held を採らず skip（NaN の rest 混入で誤って再利用しない）", () => {
        expect(resolveRecalcCenterSource(false, true, NaN, 100)).toBe("skip");
        expect(resolveRecalcCenterSource(false, true, Infinity, 100)).toBe("skip");
        expect(resolveRecalcCenterSource(false, true, -1, 100)).toBe("skip");
        expect(resolveRecalcCenterSource(false, true, 50, NaN)).toBe("skip");
        expect(resolveRecalcCenterSource(false, true, 50, -1)).toBe("skip");
    });
});
