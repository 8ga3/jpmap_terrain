/**
 * geo/globeLod の単体テスト。
 *
 * - tileKey の形式
 * - maxZoom < minZoom で空配列
 * - root 集合の選択と maxTiles 打ち切り
 * - SSE: カメラが近いほど深い zoom が選ばれる
 * - 地平線カリング: しきい値を上げると裏側タイルが除外され件数が減る
 */

import { describe, it, expect } from "vitest";
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { ComputeLookAtFromYawPitchToRef } from "@babylonjs/core/Cameras/geospatialCamera";
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

import { tileCenterLatLon, toTileXY } from "../src/terrain/gsiTile";
import { geodeticToEcef, ecefToGeodetic } from "../src/terrain/geo/ecef";
import { geographicTangentBasisToRef } from "../src/terrain/geo/cameraMapping";
import {
    selectGlobeRootTiles,
    selectGlobeTiles,
    tileKey,
    viewForwardFromFrustumPlanes,
    viewForwardFromFrustumPlanesToRef,
    type GlobeLodOptions,
} from "../src/terrain/geo/globeLod";
import { GLOBE_SCENE_DEFAULTS } from "../src/scenes/globe";
import type { FrustumPlane } from "../src/terrain/visibleTiles";

const CENTER_LAT = 35.3606;
const CENTER_LON = 138.7274;

/** 中心の真上・高度 alt[m] にカメラを置いた基本オプション。 */
const baseOpts = (
    altMeters: number,
    overrides: Partial<GlobeLodOptions> = {},
): GlobeLodOptions => ({
    cameraEcef: geodeticToEcef(CENTER_LAT, CENTER_LON, altMeters),
    centerLat: CENTER_LAT,
    centerLon: CENTER_LON,
    minZoom: 11,
    maxZoom: 15,
    viewportHeight: 1080,
    viewportWidth: 1920,
    verticalFov: 0.8,
    sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
    maxTiles: 200,
    rootSearchRadius: 2,
    maxRootTiles: 256,
    horizonDotThreshold: 0.1,
    referenceAltitude: 0,
    ...overrides,
});

describe("tileKey", () => {
    it("z/x/y 形式", () => {
        expect(tileKey(12, 3, 4)).toBe("12/3/4");
    });
});

describe("selectGlobeTiles", () => {
    it("maxZoom < minZoom は空配列", () => {
        const tiles = selectGlobeTiles(baseOpts(60000, { minZoom: 15, maxZoom: 11 }));
        expect(tiles).toEqual([]);
    });

    it("minZoom===maxZoom では分割されず全タイルが root ズーム（中心を被覆）", () => {
        // 高度は HIGH_ALT_ZOOM_CAP_M(190km) 未満にする。以上だと高高度 zoom キャップ(z8)が
        // 効いて minZoom=maxZoom=11 でも z8 になり、本テストの「root ズームがそのまま出る」意図と
        // ずれるため（キャップ自体は専用テストで検証）。
        const tiles = selectGlobeTiles(
            baseOpts(60000, { minZoom: 11, maxZoom: 11, rootSearchRadius: 0 }),
        );
        // 分割上限 == root なので全タイル z11。視野フットプリント分の少数タイルで中心を覆う。
        expect(tiles.length).toBeGreaterThan(0);
        for (const t of tiles) expect(t.zoom).toBe(11);
        const c = toTileXY(CENTER_LAT, CENTER_LON, 11);
        expect(tiles.some((t) => t.x === c.x && t.y === c.y)).toBe(true);
    });

    it("遠いカメラは root(minZoom) で受容される", () => {
        const tiles = selectGlobeTiles(
            baseOpts(5_000_000, { minZoom: 11, maxZoom: 15, rootSearchRadius: 1 }),
        );
        expect(tiles.length).toBeGreaterThan(0);
        const maxZ = Math.max(...tiles.map((t) => t.zoom));
        expect(maxZ).toBe(11);
    });

    it("近いカメラほど深い zoom が選ばれる", () => {
        const far = selectGlobeTiles(baseOpts(200000));
        const near = selectGlobeTiles(baseOpts(3000));
        const farMax = Math.max(...far.map((t) => t.zoom));
        const nearMax = Math.max(...near.map((t) => t.zoom));
        expect(nearMax).toBeGreaterThan(farMax);
    });

    it("高高度（190km以上）では root/タイル zoom を z8 以下に抑え、さらに高いほど粗くする（無駄な高レベル・被覆欠けを防ぐ）", () => {
        // 本番同様 rootZoomFloor を指定（globe.ts は常に 2 を渡す）。maxZoom=15 でも高高度キャップで
        // z8 以下、かつ距離累進で高度が上がるほど粗くなる（対数的）。
        const at = (alt: number) =>
            selectGlobeTiles(baseOpts(alt, { maxZoom: 15, rootZoomFloor: 2 }));
        const a200 = at(200000);
        const a803 = at(803531);
        const low = at(60000);
        expect(a200.length).toBeGreaterThan(0);
        // 200km 以上は全タイル z8 以下（地図の字が読めない高度では詳細不要）。
        for (const t of a200) expect(t.zoom).toBeLessThanOrEqual(8);
        for (const t of a803) expect(t.zoom).toBeLessThanOrEqual(8);
        // 803km は 200km よりさらに粗い（floorZoom で張り付かず距離累進が効くこと）。
        const maxZ = (ts: ReturnType<typeof selectGlobeTiles>) =>
            Math.max(...ts.map((t) => t.zoom));
        expect(maxZ(a803)).toBeLessThan(maxZ(a200));
        // 低高度（190km 未満）は従来どおり詳細（z8 超）を維持する。
        expect(maxZ(low)).toBeGreaterThan(8);
        // rootZoomFloor 未指定でも高高度の距離累進は同じ（floorZoom=minZoom で z8 に張り付かず、
        // 遠方タイルは 8 未満へ粗化される）。
        const a803NoFloor = selectGlobeTiles(baseOpts(803531, { maxZoom: 15 }));
        for (const t of a803NoFloor) expect(t.zoom).toBeLessThanOrEqual(8);
        expect(Math.min(...a803NoFloor.map((t) => t.zoom))).toBeLessThan(8);
    });

    it("maxTiles を超えない", () => {
        const tiles = selectGlobeTiles(
            baseOpts(3000, { maxTiles: 10, rootSearchRadius: 3 }),
        );
        expect(tiles.length).toBeLessThanOrEqual(10);
    });

    it("結果はカメラ距離の昇順", () => {
        const tiles = selectGlobeTiles(baseOpts(50000, { rootSearchRadius: 3 }));
        for (let i = 1; i < tiles.length; i++) {
            expect(tiles[i].distance).toBeGreaterThanOrEqual(tiles[i - 1].distance);
        }
    });

    it("地平線カリングしきい値を上げると件数が減る", () => {
        // 低 zoom・広い root 探索で角度方向に大きく広がる root 集合を作り、
        // しきい値による裏側カリングの効きを検証する（高 zoom では中心付近に密集して効かない）。
        const wide = {
            minZoom: 5,
            maxZoom: 5,
            rootSearchRadius: 5,
        } as const;
        const loose = selectGlobeTiles(
            baseOpts(2_000_000, { ...wide, horizonDotThreshold: -1 }),
        );
        const strict = selectGlobeTiles(
            baseOpts(2_000_000, { ...wide, horizonDotThreshold: 0.9 }),
        );
        expect(strict.length).toBeLessThan(loose.length);
    });

    it("各タイルは正の tileSizeMeters を持つ", () => {
        const tiles = selectGlobeTiles(baseOpts(60000));
        expect(tiles.length).toBeGreaterThan(0);
        for (const t of tiles) expect(t.tileSizeMeters).toBeGreaterThan(0);
    });

    describe("視錐台カリング（frustumPlanes, #463）", () => {
        // 「normal·p + d < 0 なら外側」の判定式を使い、ECEF スケール(~6.4e6)を無視できる
        // 巨大な d で「常に外側」「常に内側」の半空間を作る（実カメラ幾何は使わず判定式のみ検証）。
        const ALWAYS_OUTSIDE: FrustumPlane[] = Array.from({ length: 6 }, () => ({
            normal: { x: 1, y: 0, z: 0 },
            d: -1e15,
        }));
        const ALWAYS_INSIDE: FrustumPlane[] = Array.from({ length: 6 }, () => ({
            normal: { x: 1, y: 0, z: 0 },
            d: 1e15,
        }));

        it("root自体は視錐台カリングを免除される（帯モデルの到達距離計算を信頼、地平線際の誤判定対策）", () => {
            // root（帯モデルが選ぶ traverse 開始点）は SSE がそのまま受容（分割不要）すれば
            // 視錐台が全タイルを外側と判定しても除外されない。root シード自体は距離・FOV に基づく
            // 球面幾何で慎重に到達距離を計算済みで、frustum の AABB 近似より信頼できるため
            // （地平線際のグレージング角度で誤判定し被覆が縮む回帰を防ぐ、#463 フォローアップ）。
            // maxZoom: minZoom を明示し「root がそのまま受容される（分割されない）」前提を固定する
            // （sseThreshold/viewport 設定の変化で意図せず分割される不安定さを避ける, レビュー指摘）。
            const withFrustum = selectGlobeTiles(
                baseOpts(60000, { maxZoom: 11, frustumPlanes: ALWAYS_OUTSIDE }),
            );
            const withoutFrustum = selectGlobeTiles(baseOpts(60000, { maxZoom: 11 }));
            expect(withFrustum).toEqual(withoutFrustum);
        });

        it("root が分割（SSE細分化）した先の子タイルには免除が継承されず視錐台カリングされる", () => {
            // 近距離カメラは SSE が「分割が必要」と判定し root から子タイルへ細分化する。
            // 免除は root 呼び出し自体にのみ効き子孫には継承しないため、画面外への過剰な精細化
            // （視錐台カリングにより解消済みの無駄）は引き続き frustum で防げることを確認する。
            const withFrustum = selectGlobeTiles(
                baseOpts(3000, { maxZoom: 15, frustumPlanes: ALWAYS_OUTSIDE }),
            );
            const withoutFrustum = selectGlobeTiles(baseOpts(3000, { maxZoom: 15 }));
            // 分割が起きる近距離では、免除されない子タイルが視錐台外と判定され除外される
            // （centerのpinned安全網はminZoomのみに効くため、より深いzoomの精細化には及ばない）。
            expect(withFrustum.length).toBeLessThan(withoutFrustum.length);
        });

        it("pinnedPoints指定地点も、視錐台が全タイル外側でも最粗rootが残る", () => {
            const pinned = { lat: 40, lon: 140 };
            const tiles = selectGlobeTiles(
                baseOpts(60000, { frustumPlanes: ALWAYS_OUTSIDE, pinnedPoints: [pinned] }),
            );
            const p = toTileXY(pinned.lat, pinned.lon, 11);
            expect(tiles.some((t) => t.zoom === 11 && t.x === p.x && t.y === p.y)).toBe(true);
        });

        it("日本テクスチャ域外の pinnedPoints も、視錐台が全タイル外側で最粗rootが残る（WORLD_TEXTURE_MAX_ZOOM丸め分岐, #463 レビュー指摘）", () => {
            // 域外（例: 太平洋 lat=0/lon=-140）は minZoom(11)>WORLD_TEXTURE_MAX_ZOOM(8) のため
            // traverse 開始が WORLD_TEXTURE_MAX_ZOOM へ丸められる分岐に入る。この開始ノードに
            // exempt を渡さないと zoom≠minZoom で pinnedRootKeys 免除も効かず、視錐台外判定で
            // pinned 保険タイルが除外される（回帰）。丸め先の WORLD_TEXTURE_MAX_ZOOM タイルが
            // 残ることを確認する。
            const pinned = { lat: 0, lon: -140 };
            const tiles = selectGlobeTiles(
                baseOpts(60000, {
                    minZoom: 11,
                    maxZoom: 15,
                    frustumPlanes: ALWAYS_OUTSIDE,
                    pinnedPoints: [pinned],
                }),
            );
            const pMin = toTileXY(pinned.lat, pinned.lon, 11);
            const dz = 11 - 8; // WORLD_TEXTURE_MAX_ZOOM=8 への丸め。
            expect(
                tiles.some(
                    (t) => t.zoom === 8 && t.x === pMin.x >> dz && t.y === pMin.y >> dz,
                ),
            ).toBe(true);
        });

        it("視錐台が全タイルを内包するなら frustumPlanes 未指定と同じ結果になる", () => {
            const withFrustum = selectGlobeTiles(
                baseOpts(60000, { frustumPlanes: ALWAYS_INSIDE }),
            );
            const withoutFrustum = selectGlobeTiles(baseOpts(60000));
            expect(withFrustum).toEqual(withoutFrustum);
        });

        it("frustumPlanes 省略時は視錐台カリングを行わない（後方互換）", () => {
            const tiles = selectGlobeTiles(baseOpts(60000, { frustumPlanes: undefined }));
            expect(tiles.length).toBeGreaterThan(0);
        });
    });

    describe("textureQualityFloorZoom（遠方の低解像度混在を防ぐ）", () => {
        it("指定時、遠方の root zoom が指定値より粗くならない", () => {
            // 高チルト・低高度で地平線付近まで見渡す構図（テクスチャ境界の混在が起きやすい状況）。
            const nadirLat = CENTER_LAT - 0.4; // 高チルト相当。
            const alt = 564;
            const opts = baseOpts(alt, {
                cameraEcef: geodeticToEcef(nadirLat, CENTER_LON, alt),
                minZoom: 11,
                maxZoom: 18,
                rootZoomFloor: 2,
            });
            const withoutFloor = selectGlobeTiles(opts);
            const withFloor = selectGlobeTiles({ ...opts, textureQualityFloorZoom: 9 });
            // 指定なしでは floor(z2) まで粗化しうる一方、指定時は z9 未満が一切現れない。
            expect(Math.min(...withFloor.map((t) => t.zoom))).toBeGreaterThanOrEqual(9);
            expect(withFloor.every((t) => t.zoom >= 9)).toBe(true);
            // 後方互換: 未指定時の挙動そのものは変えない（同一 opts で再現できる）。
            expect(selectGlobeTiles(opts)).toEqual(withoutFloor);
        });

        it("全球モード（超高高度）には適用されない（タイル数爆発を避ける）", () => {
            const alt = 15_000_000;
            const tiles = selectGlobeTiles(
                baseOpts(alt, {
                    maxZoom: 18,
                    rootZoomFloor: 2,
                    maxTiles: 384,
                    maxRootTiles: 384,
                    textureQualityFloorZoom: 9,
                }),
            );
            // 全球モードは effectively rootZoomFloor(=2) の一様種付けのまま、z9 へは上げない。
            expect(Math.min(...tiles.map((t) => t.zoom))).toBeLessThanOrEqual(3);
        });
    });

    describe("高チルト（水平気味）でも可視地表を欠けなく被覆する（地平線カリング）", () => {
        // `geodeticToEcef`/`ecefToGeodetic` は WGS84 楕円体（赤道半径 a）基準のため、
        // 地表判定の球近似も平均半径ではなく a に揃える（レビュー指摘: 半径不整合による
        // 交点ズレ・被覆率誤判定の防止）。
        const EARTH_R = Wgs84Ellipsoid.semiMajorAxis;
        const DEG = Math.PI / 180;
        const V_FOV = 0.8;
        const ASPECT = 1920 / 1080;

        /**
         * 注視点(center)を地表に固定し、方位 az・チルト tilt・視距離 radius から
         * `globe.ts` と同じ手順（`ComputeLookAtFromYawPitchToRef`）でカメラ ECEF を組む。
         * tilt は 0=直下、90=水平。
         */
        const cameraFor = (
            tiltDeg: number,
            radius: number,
            azDeg = 0,
        ): Vector3 => {
            const centerEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, 0);
            const lookAt = new Vector3();
            ComputeLookAtFromYawPitchToRef(
                azDeg * DEG,
                tiltDeg * DEG,
                centerEcef,
                true,
                lookAt,
            );
            return centerEcef.clone().subtract(lookAt.scale(radius));
        };

        /** 原点 O から単位方向 Dn のレイと地心半径 R の球の最近交点。無交差なら null（＝空を向く）。 */
        const raySphereHit = (O: Vector3, Dn: Vector3): Vector3 | null => {
            const b = 2 * Vector3.Dot(O, Dn);
            const c = Vector3.Dot(O, O) - EARTH_R * EARTH_R;
            const disc = b * b - 4 * c;
            if (disc < 0) return null;
            const t = (-b - Math.sqrt(disc)) / 2;
            if (t < 0) return null;
            return O.add(Dn.scale(t));
        };

        /**
         * 視錐台がとらえる地表領域を N×N グリッドでレイキャストし、地表に当たる各サンプルが
         * いずれかの選択タイルに含まれる割合を返す。地平線カリングが可視タイルを取りこぼすと
         * 100% を下回り、地球ベースレイヤ（フォールバック背景）が露出することを検知できる。
         */
        const groundCoverageRatio = (
            cameraEcef: Vector3,
            tiles: ReturnType<typeof selectGlobeTiles>,
        ): number => {
            const centerEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, 0);
            const forward = centerEcef.subtract(cameraEcef).normalize();
            const upApprox = cameraEcef.clone().normalize();
            const right = Vector3.Cross(forward, upApprox).normalize();
            const up = Vector3.Cross(right, forward).normalize();
            const tanY = Math.tan(V_FOV / 2);
            const tanX = tanY * ASPECT;
            const isCovered = (lat: number, lon: number): boolean =>
                tiles.some((t) => {
                    const c = toTileXY(lat, lon, t.zoom);
                    return c.x === t.x && c.y === t.y;
                });
            let ground = 0;
            let covered = 0;
            const N = 12;
            for (let iy = 0; iy <= N; iy++) {
                for (let ix = 0; ix <= N; ix++) {
                    const ny = ((iy / N) * 2 - 1) * tanY;
                    const nx = ((ix / N) * 2 - 1) * tanX;
                    const dir = forward
                        .add(right.scale(nx))
                        .add(up.scale(ny))
                        .normalize();
                    const hit = raySphereHit(cameraEcef, dir);
                    if (!hit) continue; // 空（地平線より上）を向くサンプルは対象外。
                    ground++;
                    const g = ecefToGeodetic(hit);
                    if (isCovered(g.latDeg, g.lonDeg)) covered++;
                }
            }
            return ground === 0 ? 1 : covered / ground;
        };

        const highTiltOpts = (
            tiltDeg: number,
            radius: number,
            overrides: Partial<GlobeLodOptions> = {},
        ): GlobeLodOptions => {
            const cameraEcef = cameraFor(tiltDeg, radius);
            const alt = ecefToGeodetic(cameraEcef).altMeters;
            return baseOpts(alt, {
                cameraEcef,
                centerLat: CENTER_LAT,
                centerLon: CENTER_LON,
                maxZoom: GLOBE_SCENE_DEFAULTS.maxZoom,
                sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
                maxTiles: GLOBE_SCENE_DEFAULTS.maxTiles,
                rootSearchRadius: GLOBE_SCENE_DEFAULTS.rootSearchRadius,
                maxRootTiles: GLOBE_SCENE_DEFAULTS.maxRootTiles,
                horizonDotThreshold: GLOBE_SCENE_DEFAULTS.horizonDotThreshold,
                rootZoomFloor: GLOBE_SCENE_DEFAULTS.rootZoomFloor,
                ...overrides,
            });
        };

        // tilt 80〜89°・複数の視距離で視錐台の地表被覆が 100%（ベースレイヤ露出なし）であること。
        for (const [tilt, radius] of [
            [80, 60000],
            [85, 60000],
            [88, 120000],
            [89, 60000],
            [89, 300000],
        ] as const) {
            it(`tilt=${tilt}° radius=${radius}m で視錐台の地表を全面被覆する`, () => {
                const opts = highTiltOpts(tilt, radius);
                const tiles = selectGlobeTiles(opts);
                expect(tiles.length).toBeGreaterThan(0);
                // 地平線付近まで含め、視錐台がとらえる地表がすべてタイルで覆われる。
                expect(groundCoverageRatio(opts.cameraEcef, tiles)).toBe(1);
            });
        }

        it("高標高の注視点（富士山頂相当）でも高チルトで地表を全面被覆する", () => {
            // 注視点標高を上げると遠景タイルの評価位置がずれるが、被覆は維持されること。
            const opts = highTiltOpts(89, 60000, { referenceAltitude: 3776 });
            const tiles = selectGlobeTiles(opts);
            expect(groundCoverageRatio(opts.cameraEcef, tiles)).toBe(1);
        });

        it("高チルトでもタイル数が maxTiles 予算を超えない（リクエスト暴発なし）", () => {
            for (const [tilt, radius] of [
                [85, 60000],
                [89, 60000],
                [89, 300000],
            ] as const) {
                const opts = highTiltOpts(tilt, radius);
                const tiles = selectGlobeTiles(opts);
                expect(tiles.length).toBeLessThanOrEqual(GLOBE_SCENE_DEFAULTS.maxTiles);
            }
        });
    });

    it("全球視点（高高度）は粗タイルで可視キャップ全体を欠けなく被覆する（全球モード）", () => {
        // 高度 15,000km の直下視＝地球の大部分が見える。視線方向に沿う 1 次元帯では 2 次元キャップを
        // 覆い切れないため全球モード（floorZoom 一様種付け＋タイルサイズ考慮の地平線カリング）に切替。
        const alt = 15_000_000;
        const tiles = selectGlobeTiles(
            baseOpts(alt, { maxZoom: 18, rootZoomFloor: 2, maxTiles: 384, maxRootTiles: 384 }),
        );
        // 少数の粗タイルで足りる（z5 を ~200 枚並べる旧挙動ではない）。
        expect(tiles.length).toBeLessThanOrEqual(40);
        expect(Math.min(...tiles.map((t) => t.zoom))).toBeLessThanOrEqual(3);
        // 可視キャップ（地平線中心角 acos(R/r)）内の地表点をすべて何らかのタイルが被覆する。
        const R = 6371000;
        const r = R + alt;
        const capRad = Math.acos(R / r);
        const DEG = Math.PI / 180;
        const isCov = (lat: number, lon: number): boolean =>
            tiles.some((t) => {
                const c = toTileXY(lat, lon, t.zoom);
                return c.x === t.x && c.y === t.y;
            });
        // sub-camera（中心）から各方位・各角度（キャップの 95% まで）でサンプル。
        for (let ang = 0; ang <= capRad * 0.95; ang += 5 * DEG) {
            for (let az = 0; az < 360; az += 30) {
                const th = az * DEG;
                const lat1 = CENTER_LAT * DEG;
                const lat2 = Math.asin(
                    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(th),
                );
                const lon2 =
                    CENTER_LON * DEG +
                    Math.atan2(
                        Math.sin(th) * Math.sin(ang) * Math.cos(lat1),
                        Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
                    );
                expect(isCov(lat2 / DEG, lon2 / DEG)).toBe(true);
            }
        }
    });

    it("高チルトで rootZoomFloor を効かせると遠景がより遠くまで被覆される", () => {
        // nadir を注視点の南 3°（≒333km）に置く＝高チルト。遠景は地平線（~870km）まで広がる。
        const highTiltCam = geodeticToEcef(CENTER_LAT - 3, CENTER_LON, 60000);
        const common = {
            cameraEcef: highTiltCam,
            centerLat: CENTER_LAT,
            centerLon: CENTER_LON,
            maxZoom: 15,
        } as const;
        const noFloor = selectGlobeTiles(baseOpts(60000, common)); // rootZoomFloor 既定=minZoom
        const withFloor = selectGlobeTiles(baseOpts(60000, { ...common, rootZoomFloor: 8 }));
        const maxDist = (ts: { distance: number }[]) =>
            ts.reduce((m, t) => Math.max(m, t.distance), 0);
        // 距離適応ルートレベルにより、同じ maxTiles 予算でより遠くの地表まで被覆できる。
        expect(maxDist(withFloor)).toBeGreaterThan(maxDist(noFloor));
        // 遠景には minZoom より粗い zoom のタイルが含まれる。
        expect(withFloor.some((t) => t.zoom < 11)).toBe(true);
    });

    it("選択結果に重複タイル（z/x/y）がない（デデュプ）", () => {
        const tiles = selectGlobeTiles(
            baseOpts(60000, {
                cameraEcef: geodeticToEcef(CENTER_LAT - 3, CENTER_LON, 60000),
                rootZoomFloor: 8,
                maxZoom: 15,
            }),
        );
        const keys = tiles.map((t) => tileKey(t.zoom, t.x, t.y));
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("チルト時は視錐台の奥（上端＝注視点の先）と左右端まで被覆する（カバレッジ）", () => {
        // nadir を注視点の南 0.5°（≒55km）に置く＝チルト ~42°。視錐台は注視点を越えて奥まで、
        // かつ画面幅（左右）に広がる。旧実装は前方 2*dirLen・横 ±固定で奥/両端が欠けていた。
        const nadirLat = CENTER_LAT - 0.5;
        const tiles = selectGlobeTiles(
            baseOpts(60000, {
                cameraEcef: geodeticToEcef(nadirLat, CENTER_LON, 60000),
                centerLat: CENTER_LAT,
                centerLon: CENTER_LON,
                maxZoom: 18,
                rootZoomFloor: 5,
            }),
        );
        const lats = tiles.map((t) => tileCenterLatLon(t.x, t.y, t.zoom).lat);
        const lons = tiles.map((t) => tileCenterLatLon(t.x, t.y, t.zoom).lon);
        // 奥（北）: 注視点（center）を越えた先のタイルが含まれる。
        expect(Math.max(...lats)).toBeGreaterThan(CENTER_LAT);
        // 左右: 東西どちらにも広がる（画面幅の被覆）。
        expect(Math.max(...lons)).toBeGreaterThan(CENTER_LON + 0.1);
        expect(Math.min(...lons)).toBeLessThan(CENTER_LON - 0.1);
    });

    it("高チルト＋低高度でも近景の詳細が保たれる（過粗化で潰れない, #335）", () => {
        // nadir を注視点の南 1°（≒111km）・高度 8km＝高チルト(~86°)。遠景は粗く張るが、巨大な
        // 遠景タイルが近景を内包して quadtree 整形で近景を消す「全面潰れ」が起きないこと。
        const tiles = selectGlobeTiles(
            baseOpts(8000, {
                cameraEcef: geodeticToEcef(CENTER_LAT - 1, CENTER_LON, 8000),
                centerLat: CENTER_LAT,
                centerLon: CENTER_LON,
                maxZoom: 18,
                rootZoomFloor: 5,
            }),
        );
        const zooms = tiles.map((t) => t.zoom);
        // 近景は細かい（高 zoom が残る）かつ遠景は粗い（zoom に十分な幅）。潰れると数枚の粗
        // タイルのみになり max が小さくなる。
        expect(Math.max(...zooms)).toBeGreaterThanOrEqual(13);
        expect(Math.max(...zooms) - Math.min(...zooms)).toBeGreaterThanOrEqual(3);
        // 近傍（カメラ直下付近）に細かいタイルが存在する。
        const nearFine = tiles.some(
            (t) => t.zoom >= 13 && Math.abs(tileCenterLatLon(t.x, t.y, t.zoom).lat - (CENTER_LAT - 1)) < 0.3,
        );
        expect(nearFine).toBe(true);
    });

    it("斜め見（grazing 高チルト）でも奥が地平線近くまで被覆される（球面 dFar）", () => {
        // nadir を注視点の南 ~0.39°（≒43km）・高度 20km＝tilt ~65°。視錐台上端は地平線近くを
        // 掠めるため、真の可視遠端は平面 h·tan の過小評価ではなく地平線（~500km）付近まで伸びる。
        const nadirLat = CENTER_LAT - 0.39;
        const alt = 20000;
        const tiles = selectGlobeTiles(
            baseOpts(alt, {
                cameraEcef: geodeticToEcef(nadirLat, CENTER_LON, alt),
                centerLat: CENTER_LAT,
                centerLon: CENTER_LON,
                maxZoom: 18,
                rootZoomFloor: 5,
                maxTiles: 384,
                maxRootTiles: 384,
            }),
        );
        const R = 6371000;
        const horizonKm = (R * Math.acos(R / (R + alt))) / 1000;
        // 北端タイルの nadir からの地表距離が地平線の 8 割以上（grazing で奥まで到達）。
        const maxNorthKm = Math.max(
            ...tiles.map((t) => (tileCenterLatLon(t.x, t.y, t.zoom).lat - nadirLat) * 111),
        );
        expect(maxNorthKm).toBeGreaterThan(horizonKm * 0.8);
    });

    it("選択結果は正しい quadtree カット（祖先-子孫の重なりがない, #335）", () => {
        // 高高度＋チルトで root の zoom が位置ごとに変わり、遷移の継ぎ目で粗タイルと
        // その子孫（細タイル）が二重に重なりやすいケース。整形後は重なりが無いこと。
        const tiles = selectGlobeTiles(
            baseOpts(200000, {
                cameraEcef: geodeticToEcef(CENTER_LAT - 2, CENTER_LON, 200000),
                rootZoomFloor: 5,
                maxZoom: 18,
            }),
        );
        const keys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));
        for (const t of tiles) {
            // より粗い祖先が同時に選択されていないこと（包含＝二重描画の除去）。
            for (let z = t.zoom - 1; z >= 5; z--) {
                const dz = t.zoom - z;
                expect(keys.has(tileKey(z, t.x >> dz, t.y >> dz))).toBe(false);
            }
        }
    });

    it("低高度・斜め見で nadir↔center が 1 タイル未満でも帯が視線方向を向く（分数方位）", () => {
        // ユーザー報告ケース: radius~11km・tilt67°・az~175° の低高度で、nadir↔center の水平距離が
        // 1 minZoom タイル（~16km）未満。整数タイル方位だと t0==t1 で方向が失われ、帯が軸整列に
        // 落ちて視線（前方＝地平線方向）の地表が欠ける。分数タイル方位で帯が正しく前方を向き、
        // center から視線方向（az）へ伸ばした地表点が連続被覆されることを保証する。
        const DEG = Math.PI / 180;
        const R = 6371000;
        const az = 50; // 格子非整列の斜め方位（対角）でも欠けないこと。
        const tilt = 67;
        const radius = 11000;
        const lookAt = new Vector3();
        const centerEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, 0);
        ComputeLookAtFromYawPitchToRef(az * DEG, tilt * DEG, centerEcef, true, lookAt);
        const cameraEcef = centerEcef.clone().subtract(lookAt.scale(radius));
        const camGeo = ecefToGeodetic(cameraEcef);
        const tiles = selectGlobeTiles(
            baseOpts(camGeo.altMeters, {
                cameraEcef,
                maxZoom: 18,
                rootZoomFloor: 5,
                maxTiles: 384,
                maxRootTiles: 384,
            }),
        );
        const isCov = (lat: number, lon: number): boolean =>
            tiles.some((t) => {
                const c = toTileXY(lat, lon, t.zoom);
                return c.x === t.x && c.y === t.y;
            });
        // center から方位 az へ大円で 10..120km の地表点をすべて被覆する（前方＝地平線方向）。
        const lat1 = CENTER_LAT * DEG;
        const lon1 = CENTER_LON * DEG;
        const theta = az * DEG;
        for (let arc = 10000; arc <= 120000; arc += 5000) {
            const dlt = arc / R;
            const lat2 = Math.asin(
                Math.sin(lat1) * Math.cos(dlt) + Math.cos(lat1) * Math.sin(dlt) * Math.cos(theta),
            );
            const lon2 =
                lon1 +
                Math.atan2(
                    Math.sin(theta) * Math.sin(dlt) * Math.cos(lat1),
                    Math.cos(dlt) - Math.sin(lat1) * Math.sin(lat2),
                );
            expect(isCov(lat2 / DEG, lon2 / DEG)).toBe(true);
        }
    });

    it("水平チルトでカメラ直下（nadir）の前景タイルが選択される", () => {
        // カメラ直下点を注視点の南 ~0.8°（≒88km）に置く＝水平気味のチルト。
        const nadirLat = CENTER_LAT - 0.8;
        const tiles = selectGlobeTiles(
            baseOpts(60000, {
                cameraEcef: geodeticToEcef(nadirLat, CENTER_LON, 60000),
                centerLat: CENTER_LAT,
                centerLon: CENTER_LON,
                maxZoom: 15,
            }),
        );
        // 前景（nadir 付近, 注視点より十分南）のタイルが少なくとも 1 枚含まれること。
        // 旧来の注視点中心アンカーでは生成されず、欠落していた領域。
        const hasForeground = tiles.some((t) => {
            const { lat } = tileCenterLatLon(t.x, t.y, t.zoom);
            return lat < CENTER_LAT - 0.5;
        });
        expect(hasForeground).toBe(true);
    });

    describe("低高度・高チルト・高 DPI で地平線側の被覆が予算超過で欠けない", () => {
        // 富士山頂付近をアップ（低高度・高チルト）にすると、近景の細タイルが maxTiles 予算を
        // 食い切り、素朴な「距離昇順 slice」では最遠（地平線側）のタイルが丸ごと捨てられて青の
        // ベースレイヤが露出した（sseThreshold=384 で顕在化。512 では総数が予算未満で露出しなかった）。
        // 予算超過時は削除ではなく最遠の 4 兄弟を親へ粗化統合して被覆を保つ修正で、地平線側まで
        // 連続被覆される（nadir から地平線までタイルが途切れず張られる不変条件）。再現 URL:
        // @35.361947,138.729267,592,299.31,66.17（radius 592m, azimuth 299.31°, tilt 66.17°）。
        const REPRO_LAT = 35.361947;
        const REPRO_LON = 138.729267;
        const DEG = Math.PI / 180;
        const R = 6371000;

        /** 注視点(REPRO 地点)標高 elev・radius・tilt・az から repro カメラ ECEF を組む。 */
        const reproCamera = (elev: number, radius: number, tiltDeg: number, azDeg: number): Vector3 => {
            const centerEcef = geodeticToEcef(REPRO_LAT, REPRO_LON, elev);
            const lookAt = new Vector3();
            ComputeLookAtFromYawPitchToRef(azDeg * DEG, tiltDeg * DEG, centerEcef, true, lookAt);
            return centerEcef.clone().subtract(lookAt.scale(radius));
        };

        /** 緯度経度がいずれかの選択タイル（その zoom）に含まれるか。 */
        const covered = (
            tiles: ReturnType<typeof selectGlobeTiles>,
            lat: number,
            lon: number,
        ): boolean =>
            tiles.some((t) => {
                const c = toTileXY(lat, lon, t.zoom);
                return c.x === t.x && c.y === t.y;
            });

        /**
         * nadir から視線方位 az の大円に沿って地表を刻み、被覆が始まってから最後に被覆された
         * 地表距離[km] と、被覆開始後に最初に現れた穴の距離[km]（無ければ -1）を返す。
         */
        const coverageAlongView = (
            opts: GlobeLodOptions,
            azDeg: number,
        ): { lastCoveredKm: number; firstGapKm: number; horizonKm: number } => {
            const tiles = selectGlobeTiles(opts);
            const nadir = ecefToGeodetic(opts.cameraEcef);
            const h = Math.max(0, nadir.altMeters);
            const horizonArc = R * Math.acos(R / (R + h));
            const lat1 = nadir.latDeg * DEG;
            const lon1 = nadir.lonDeg * DEG;
            const theta = azDeg * DEG;
            let lastCoveredKm = -1;
            let firstGapKm = -1;
            for (let arc = 0; arc <= horizonArc * 0.9; arc += 1000) {
                const dlt = arc / R;
                const lat2 = Math.asin(
                    Math.sin(lat1) * Math.cos(dlt) + Math.cos(lat1) * Math.sin(dlt) * Math.cos(theta),
                );
                const lon2 =
                    lon1 +
                    Math.atan2(
                        Math.sin(theta) * Math.sin(dlt) * Math.cos(lat1),
                        Math.cos(dlt) - Math.sin(lat1) * Math.sin(lat2),
                    );
                if (covered(tiles, lat2 / DEG, lon2 / DEG)) lastCoveredKm = arc / 1000;
                else if (firstGapKm < 0 && lastCoveredKm >= 0) firstGapKm = arc / 1000;
            }
            return { lastCoveredKm, firstGapKm, horizonKm: horizonArc / 1000 };
        };

        // 高標高の注視点（富士山頂相当 3776m）・radius 592m・tilt 66.17°・az 299.31°、
        // 高 DPI 相当の高い viewportHeight（getRenderHeight はバックバッファ解像度 = DPR 倍）。
        const elev = 3776;
        const az = 299.31;
        const reproOpts = (sse: number): GlobeLodOptions => {
            const cameraEcef = reproCamera(elev, 592, 66.17, az);
            const center = geodeticToEcef(REPRO_LAT, REPRO_LON, elev);
            const cg = ecefToGeodetic(center);
            return baseOpts(ecefToGeodetic(cameraEcef).altMeters, {
                cameraEcef,
                centerLat: cg.latDeg,
                centerLon: cg.lonDeg,
                minZoom: GLOBE_SCENE_DEFAULTS.minZoom,
                maxZoom: GLOBE_SCENE_DEFAULTS.maxZoom,
                viewportHeight: 1600,
                viewportWidth: 2560,
                sseThreshold: sse,
                maxTiles: GLOBE_SCENE_DEFAULTS.maxTiles,
                rootSearchRadius: GLOBE_SCENE_DEFAULTS.rootSearchRadius,
                maxRootTiles: GLOBE_SCENE_DEFAULTS.maxRootTiles,
                horizonDotThreshold: GLOBE_SCENE_DEFAULTS.horizonDotThreshold,
                rootZoomFloor: GLOBE_SCENE_DEFAULTS.rootZoomFloor,
                textureQualityFloorZoom: GLOBE_SCENE_DEFAULTS.textureQualityFloorZoom,
                referenceAltitude: elev,
            });
        };

        it("sseThreshold=384（本番値）で地平線側までベースレイヤ露出の穴がない", () => {
            const opts = reproOpts(GLOBE_SCENE_DEFAULTS.sseThreshold);
            const { lastCoveredKm, firstGapKm, horizonKm } = coverageAlongView(opts, az);
            // 被覆開始後に穴がない（修正前は近景で予算を食い切り最遠が捨てられ数 km 先で穴あき）。
            expect(firstGapKm).toBe(-1);
            // 視線方向の地表が可視遠方（地平線の 7 割超）まで連続被覆される。
            expect(lastCoveredKm).toBeGreaterThan(horizonKm * 0.7);
        });

        it("予算超過時も maxTiles を超えない（粗化統合で枚数を抑える）", () => {
            const tiles = selectGlobeTiles(reproOpts(GLOBE_SCENE_DEFAULTS.sseThreshold));
            expect(tiles.length).toBeLessThanOrEqual(GLOBE_SCENE_DEFAULTS.maxTiles);
        });

        it("粗化統合後も quadtree カットが崩れない（祖先-子孫の二重被覆がない）", () => {
            const tiles = selectGlobeTiles(reproOpts(GLOBE_SCENE_DEFAULTS.sseThreshold));
            const keys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));
            for (const t of tiles) {
                for (let z = t.zoom - 1; z >= GLOBE_SCENE_DEFAULTS.rootZoomFloor; z--) {
                    const dz = t.zoom - z;
                    expect(keys.has(tileKey(z, t.x >> dz, t.y >> dz))).toBe(false);
                }
            }
        });
    });

    describe("日本被覆域外のテクスチャ上限クランプ", () => {
        // 日本外（米ニューヨーク付近）。GSI テクスチャは z9 以上が存在しないため、
        // 近接カメラでも z8 までしか細分化されないこと。
        const NY_LAT = 40.7128;
        const NY_LON = -74.006;

        const overseasOpts = (altMeters: number): GlobeLodOptions => ({
            ...baseOpts(altMeters, {
                cameraEcef: geodeticToEcef(NY_LAT, NY_LON, altMeters),
                centerLat: NY_LAT,
                centerLon: NY_LON,
                minZoom: 11,
                maxZoom: 18,
                rootZoomFloor: 2,
            }),
        });

        it("日本外は近接カメラでも z8 までに制限される（root が minZoom>8 でも丸める）", () => {
            const tiles = selectGlobeTiles(overseasOpts(3000));
            expect(tiles.length).toBeGreaterThan(0);
            const maxZ = Math.max(...tiles.map((t) => t.zoom));
            expect(maxZ).toBeLessThanOrEqual(8);
        });

        it("日本国内は従来通り z8 を超えて細分化される", () => {
            const tiles = selectGlobeTiles(
                baseOpts(3000, { minZoom: 11, maxZoom: 18, rootZoomFloor: 2 }),
            );
            expect(tiles.length).toBeGreaterThan(0);
            const maxZ = Math.max(...tiles.map((t) => t.zoom));
            expect(maxZ).toBeGreaterThan(8);
        });
    });
});

describe("selectGlobeRootTiles", () => {
    const baseRoot = (
        cameraEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, 60000),
        overrides: Partial<Parameters<typeof selectGlobeRootTiles>[0]> = {},
    ) => ({
        cameraEcef,
        centerLat: CENTER_LAT,
        centerLon: CENTER_LON,
        minZoom: 11,
        rootSearchRadius: 2,
        maxRootTiles: 256,
        viewportHeight: 1080,
        viewportWidth: 1920,
        verticalFov: 0.8,
        sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
        ...overrides,
    });

    /** 緯度経度がいずれかの seed タイル（その zoom）に含まれるか。 */
    const isCovered = (
        seeds: { x: number; y: number; zoom: number }[],
        lat: number,
        lon: number,
    ): boolean =>
        seeds.some((s) => {
            const t = toTileXY(lat, lon, s.zoom);
            return t.x === s.x && t.y === s.y;
        });

    it("直下視（nadir≒center）は中心被覆の小さな格子（60km で全 z11）", () => {
        const seeds = selectGlobeRootTiles(baseRoot());
        // 60km 上空・直下では SSE 最適 root は z11。画面被覆相当の少数タイル（視錐台フットプリント＋
        // 16:9 アスペクトの横方向）で中心を覆う。予算（256）には遠く及ばない有界な枚数。
        expect(seeds.length).toBeGreaterThan(0);
        expect(seeds.length).toBeLessThanOrEqual(160);
        for (const s of seeds) expect(s.zoom).toBe(11);
        expect(isCovered(seeds, CENTER_LAT, CENTER_LON)).toBe(true);
    });

    it("高高度ほど root ズームが粗くなる（高度適応, #335）", () => {
        const low = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(CENTER_LAT, CENTER_LON, 60000), { rootZoomFloor: 5 }),
        );
        const high = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(CENTER_LAT, CENTER_LON, 600000), { rootZoomFloor: 5 }),
        );
        const maxZoomOf = (s: { zoom: number }[]) => Math.max(...s.map((x) => x.zoom));
        // 高高度（600km）の最細 root ズームは低高度（60km）より粗い。
        expect(maxZoomOf(high)).toBeLessThan(maxZoomOf(low));
        // 高高度でも中心は被覆される。
        expect(isCovered(high, CENTER_LAT, CENTER_LON)).toBe(true);
    });

    it("チルト時は nadir と center の地点を被覆する（帯）", () => {
        const nadirLat = CENTER_LAT - 0.8;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, 60000)),
        );
        expect(isCovered(seeds, nadirLat, CENTER_LON)).toBe(true);
        expect(isCovered(seeds, CENTER_LAT, CENTER_LON)).toBe(true);
    });

    it("maxRootTiles 予算を超えず、前景（nadir）を残す", () => {
        const nadirLat = CENTER_LAT - 0.8;
        const budget = 5;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, 60000), {
                maxRootTiles: budget,
            }),
        );
        expect(seeds.length).toBeLessThanOrEqual(budget);
        expect(isCovered(seeds, nadirLat, CENTER_LON)).toBe(true);
    });

    it("予算が小さくても nadir と center を最優先で被覆する", () => {
        const nadirLat = CENTER_LAT - 0.8;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, 60000), { maxRootTiles: 2 }),
        );
        expect(seeds.length).toBeLessThanOrEqual(2);
        expect(isCovered(seeds, nadirLat, CENTER_LON)).toBe(true);
        expect(isCovered(seeds, CENTER_LAT, CENTER_LON)).toBe(true);
    });

    it("budget=1 では nadir を優先する", () => {
        const nadirLat = CENTER_LAT - 0.8;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, 60000), { maxRootTiles: 1 }),
        );
        expect(seeds).toHaveLength(1);
        expect(isCovered(seeds, nadirLat, CENTER_LON)).toBe(true);
    });

    it("全球モードで予算が全球枚数に満たなくても nadir/center を最優先で被覆する", () => {
        // 高度 3,000km は全球モード（地球の見かけ角半径が小さい）。floorZoom=4 だと全球 2^4×2^4=256
        // 枚だが予算は 8 枚しかなく、0 起点ラスタ順では北端/日付変更線側で予算が尽き、視界中央の
        // nadir/center 付近へ到達できない。nadir/center を最優先 seed することで視界中央を被覆する。
        const nadirLat = CENTER_LAT - 10; // nadir を center から十分離す
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, 3_000_000), {
                rootZoomFloor: 4,
                maxRootTiles: 8,
            }),
        );
        expect(seeds.length).toBeLessThanOrEqual(8);
        expect(isCovered(seeds, nadirLat, CENTER_LON)).toBe(true);
        expect(isCovered(seeds, CENTER_LAT, CENTER_LON)).toBe(true);
    });

    it("高チルトで nadir→地平線の帯が距離適応 zoom の継ぎ目で途切れず連続被覆する（半刻み歩進）", () => {
        // 高チルト（nadir を注視点の南 ~0.4°, 高度 25km ≒ tilt 65°）で地平線が画面に入る。距離適応で
        // root の zoom が遠方ほど粗くなるが、その遷移の継ぎ目で along-track の global タイルを 1 枚
        // 飛ばすと奥が 1 行欠ける（旧 f-セル歩進の不具合）。nadir から地平線手前まで子午線上を
        // 細かくサンプルし、すべて何らかの seed に被覆されること（＝連続）を保証する。
        const nadirLat = CENTER_LAT - 0.4;
        const alt = 25000;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, alt), {
                centerLat: CENTER_LAT,
                centerLon: CENTER_LON,
                rootZoomFloor: 5,
                maxRootTiles: 384,
                viewportHeight: 2160,
                viewportWidth: 3840,
            }),
        );
        const R = 6371000;
        const horizonArc = R * Math.acos(R / (R + alt));
        const DEG = Math.PI / 180;
        // nadir から北へ地平線の 95% まで 5km 刻みでサンプル（子午線なので lon 一定）。
        for (let arc = 0; arc <= horizonArc * 0.95; arc += 5000) {
            const lat = nadirLat + arc / R / DEG;
            expect(isCovered(seeds, lat, CENTER_LON)).toBe(true);
        }
    });

    it("日付変更線をまたいでも最短方向の帯になり nadir/center を被覆する（x は範囲内）", () => {
        const minZoom = 8;
        const n = 2 ** minZoom;
        // nadir lon=179.9 / center lon=-179.9: 地理的には近接だがタイル x は wrap する。
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(CENTER_LAT, 179.9, 60000), {
                minZoom,
                centerLon: -179.9,
            }),
        );
        const nadirTile = toTileXY(CENTER_LAT, 179.9, minZoom);
        const centerTile = toTileXY(CENTER_LAT, -179.9, minZoom);
        // 前提: 日付変更線をまたいで x が大きく離れている（wrap 発生）。
        expect(Math.abs(nadirTile.x - centerTile.x)).toBeGreaterThan(n / 2);
        // すべて範囲内に正規化される。
        for (const s of seeds) {
            const lim = 2 ** s.zoom;
            expect(s.x).toBeGreaterThanOrEqual(0);
            expect(s.x).toBeLessThan(lim);
            expect(s.y).toBeGreaterThanOrEqual(0);
            expect(s.y).toBeLessThan(lim);
        }
        expect(isCovered(seeds, CENTER_LAT, 179.9)).toBe(true);
        expect(isCovered(seeds, CENTER_LAT, -179.9)).toBe(true);
    });

    it("高チルトで遠景は近景より粗い root ズームになる（距離適応, #335）", () => {
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(CENTER_LAT - 3, CENTER_LON, 60000), {
                rootZoomFloor: 5,
            }),
        );
        const zooms = seeds.map((s) => s.zoom);
        const nadirLat = CENTER_LAT - 3; // カメラ直下の緯度（= geodeticToEcef に渡した緯度）。
        // 距離適応により zoom に幅がある（近景は細かく遠景は粗い）。
        expect(Math.max(...zooms)).toBeGreaterThan(Math.min(...zooms));
        // 最も細かい root は nadir（最近傍）付近、最も粗い root は遠景側にある。
        const finest = seeds.reduce((a, b) => (b.zoom > a.zoom ? b : a));
        const coarsest = seeds.reduce((a, b) => (b.zoom < a.zoom ? b : a));
        const latOf = (s: { x: number; y: number; zoom: number }) =>
            tileCenterLatLon(s.x, s.y, s.zoom).lat;
        expect(Math.abs(latOf(finest) - nadirLat)).toBeLessThan(
            Math.abs(latOf(coarsest) - nadirLat),
        );
        // すべて floor(5) 以上 minZoom(11) 以下。
        for (const s of seeds) {
            expect(s.zoom).toBeGreaterThanOrEqual(5);
            expect(s.zoom).toBeLessThanOrEqual(11);
        }
    });

    it("rootZoomFloor=minZoom では全 root が minZoom（粗化抑止）", () => {
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(CENTER_LAT - 3, CENTER_LON, 60000), {
                rootZoomFloor: 11,
            }),
        );
        for (const s of seeds) expect(s.zoom).toBe(11);
    });

    it("極付近では範囲外 y の root を捨てる（予算を無効タイルに使わない）", () => {
        const minZoom = 6;
        const n = 2 ** minZoom;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(85.0, CENTER_LON, 200000), {
                minZoom,
                centerLat: 85.0,
                rootSearchRadius: 3,
            }),
        );
        expect(seeds.length).toBeGreaterThan(0);
        for (const s of seeds) {
            expect(s.y).toBeGreaterThanOrEqual(0);
            expect(s.y).toBeLessThan(n);
        }
    });

    it("高標高の注視点（富士山頂相当）でも前方到達距離が崩壊せず遠方まで種付けする", () => {
        const DEG = Math.PI / 180;
        const E = 3776; // 富士山頂標高。seat-on-terrain で注視点が山頂に載る状況を模す。
        // グレージング視点（tilt70°）でカメラを山頂相当高度へ持ち上げて配置する。
        const centerEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, E);
        const lookAt = new Vector3();
        ComputeLookAtFromYawPitchToRef(20 * DEG, 70 * DEG, centerEcef, true, lookAt);
        const cam = centerEcef.clone().subtract(lookAt.scale(7919));
        const nadir = ecefToGeodetic(cam);
        const reach = (seeds: { x: number; y: number; zoom: number }[]): number => {
            let max = 0;
            for (const s of seeds) {
                const c = tileCenterLatLon(s.x, s.y, s.zoom);
                const d = Math.hypot(c.lat - nadir.latDeg, c.lon - nadir.lonDeg);
                if (d > max) max = d;
            }
            return max;
        };
        // 注視点を実標高で評価（正）→ tilt が水平寄りに正しく出て前方到達距離が伸びる。
        const withElev = reach(
            selectGlobeRootTiles(
                baseRoot(cam, { referenceAltitude: E, rootZoomFloor: 2, maxRootTiles: 384 }),
            ),
        );
        // 注視点を海面(0m)で評価（旧バグ）→ camera→center が急下向きと誤算出され tilt 過小→到達距離短縮。
        const flat = reach(
            selectGlobeRootTiles(
                baseRoot(cam, { referenceAltitude: 0, rootZoomFloor: 2, maxRootTiles: 384 }),
            ),
        );
        expect(withElev).toBeGreaterThan(flat * 1.5);
        // 負値（海面下）は 0 へ丸め、referenceAltitude=0 と同一挙動（後方互換・異常値ガード）。
        const negative = reach(
            selectGlobeRootTiles(
                baseRoot(cam, { referenceAltitude: -100, rootZoomFloor: 2, maxRootTiles: 384 }),
            ),
        );
        expect(negative).toBe(flat);
    });

    it("高高度キャップは minZoom も超えない（minZoom < z8 でも seed zoom ≤ minZoom, #465続き）", () => {
        // minZoom=6（< HIGH_ALT_MAX_ZOOM=8）を高高度（300km）で使う。上限が z8 のままだと
        // seed zoom が minZoom を超え、addAt の f=2**(minZoom-zoom) が負指数(f<1)になり得る。
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(CENTER_LAT, CENTER_LON, 300000), {
                minZoom: 6,
                rootZoomFloor: 2,
            }),
        );
        expect(seeds.length).toBeGreaterThan(0);
        for (const s of seeds) expect(s.zoom).toBeLessThanOrEqual(6);
    });
});

describe("viewForwardFromFrustumPlanes", () => {
    const V_FOV = 0.8;
    const ASPECT = 1920 / 1080;

    /**
     * flight/index.ts と同一手順で camera 相対（原点=eye、回転のみ）の視錐台6平面を作る。
     * FreeCamera は左手系（LookAtLH / PerspectiveFovLH）。view 行列の並進行を 0 にして
     * projection と合成し、Frustum.GetPlanesToRef で平面を得る。
     */
    const cameraRelativePlanes = (
        eye: Vector3,
        target: Vector3,
        up: Vector3,
    ): FrustumPlane[] => {
        const viewMat = Matrix.LookAtLH(eye, target, up);
        viewMat.setRowFromFloats(3, 0, 0, 0, 1); // 並進を 0（camera 相対化）。
        const projMat = Matrix.PerspectiveFovLH(V_FOV, ASPECT, 1, 400000);
        const transform = Matrix.Identity();
        viewMat.multiplyToRef(projMat, transform);
        const raw: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
        Frustum.GetPlanesToRef(transform, raw);
        return raw.map((p) => ({
            normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
            d: p.d,
        }));
    };

    it("視錐台6平面から実視線 forward を復元する（真の forward と一致）", () => {
        // 東京付近から北・やや下方を見るカメラ。真の forward = normalize(target - eye)。
        const eye = geodeticToEcef(CENTER_LAT, CENTER_LON, 3000);
        const target = geodeticToEcef(CENTER_LAT + 0.05, CENTER_LON, 2000);
        const up = eye.clone().normalize();
        const planes = cameraRelativePlanes(eye, target, up);
        const fwd = viewForwardFromFrustumPlanes(planes);
        expect(fwd).not.toBeNull();
        const trueFwd = target.subtract(eye).normalize();
        expect(Vector3.Dot(fwd as Vector3, trueFwd)).toBeGreaterThan(0.999);
    });

    it("戻り値は単位ベクトル", () => {
        const eye = geodeticToEcef(CENTER_LAT, CENTER_LON, 5000);
        const target = geodeticToEcef(CENTER_LAT + 0.1, CENTER_LON + 0.03, 0);
        const planes = cameraRelativePlanes(eye, target, eye.clone().normalize());
        const fwd = viewForwardFromFrustumPlanes(planes) as Vector3;
        expect(fwd.length()).toBeCloseTo(1, 6);
    });

    it("平面数が6でなければ null", () => {
        expect(viewForwardFromFrustumPlanes([])).toBeNull();
        expect(
            viewForwardFromFrustumPlanes([{ normal: { x: 1, y: 0, z: 0 }, d: 0 }]),
        ).toBeNull();
    });

    it("法線和が零ベクトルなら null（退化）", () => {
        const zero: FrustumPlane[] = Array.from({ length: 6 }, () => ({
            normal: { x: 0, y: 0, z: 0 },
            d: 0,
        }));
        expect(viewForwardFromFrustumPlanes(zero)).toBeNull();
    });

    it("ToRef 版は ref に書き込み true を返す／退化時は false で ref 未変更（アロケーション回避）", () => {
        const eye = geodeticToEcef(CENTER_LAT, CENTER_LON, 3000);
        const target = geodeticToEcef(CENTER_LAT + 0.05, CENTER_LON, 2000);
        const planes = cameraRelativePlanes(eye, target, eye.clone().normalize());
        const ref = new Vector3(1, 2, 3);
        expect(viewForwardFromFrustumPlanesToRef(planes, ref)).toBe(true);
        expect(ref.length()).toBeCloseTo(1, 6);
        const trueFwd = target.subtract(eye).normalize();
        expect(Vector3.Dot(ref, trueFwd)).toBeGreaterThan(0.999);

        // 退化（平面数≠6）: false を返し、ref は元のまま（未変更）。
        const sentinel = new Vector3(7, 8, 9);
        expect(viewForwardFromFrustumPlanesToRef([], sentinel)).toBe(false);
        expect(sentinel.equals(new Vector3(7, 8, 9))).toBe(true);
    });
});

describe("Follow mode 前方到達距離補正（viewForward, #475）", () => {
    // Follow mode の幾何: 機体（高度 alt）の後方 radius・上方 height に追従カメラを置き、機体を見る。
    // cameraEcef=追従カメラ位置、center=機体直下地表（本番の flight/index.ts が渡す値）。
    // 追従カメラはほぼ水平前方を向くのに center=直下地表のため、center 由来 tilt では前方到達距離が
    // 過小になり地平線側が未種付けの穴になる。frustum 由来 viewForward で解消する。
    const V_FOV = 0.8;
    const ASPECT = 1920 / 1080;
    const R = 6371000;
    const DEG = Math.PI / 180;

    /** heading 北・rotationOffset 180（真後ろ）の追従カメラ eye/target/up を組む。 */
    const followRig = (altM: number, radiusM: number, heightM: number) => {
        const plane = geodeticToEcef(CENTER_LAT, CENTER_LON, altM);
        const east = new Vector3();
        const north = new Vector3();
        geographicTangentBasisToRef(plane, east, north);
        const up = plane.clone().normalize();
        // rot=180° → sin=0, cos=-1 → 真北飛行の真後ろ（南）へ radius。
        const eye = plane
            .add(north.scale(-radiusM))
            .add(up.scale(heightM));
        return { eye, target: plane.clone(), up };
    };

    /** flight/index.ts と同手順の camera 相対視錐台平面。 */
    const followPlanes = (eye: Vector3, target: Vector3, up: Vector3): FrustumPlane[] => {
        const viewMat = Matrix.LookAtLH(eye, target, up);
        viewMat.setRowFromFloats(3, 0, 0, 0, 1);
        const projMat = Matrix.PerspectiveFovLH(V_FOV, ASPECT, 1, 400000);
        const transform = Matrix.Identity();
        viewMat.multiplyToRef(projMat, transform);
        const raw: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
        Frustum.GetPlanesToRef(transform, raw);
        return raw.map((p) => ({
            normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
            d: p.d,
        }));
    };

    const followOpts = (
        eye: Vector3,
        planes: FrustumPlane[],
        withViewForward: boolean,
    ): GlobeLodOptions => {
        const vf = withViewForward
            ? (viewForwardFromFrustumPlanes(planes) ?? undefined)
            : undefined;
        return {
            cameraEcef: eye,
            centerLat: CENTER_LAT, // 本番: 機体直下地表点。
            centerLon: CENTER_LON,
            minZoom: GLOBE_SCENE_DEFAULTS.minZoom,
            maxZoom: GLOBE_SCENE_DEFAULTS.maxZoom,
            viewportHeight: 1080,
            viewportWidth: 1920,
            verticalFov: V_FOV,
            sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
            maxTiles: GLOBE_SCENE_DEFAULTS.maxTiles,
            rootSearchRadius: GLOBE_SCENE_DEFAULTS.rootSearchRadius,
            maxRootTiles: GLOBE_SCENE_DEFAULTS.maxRootTiles,
            horizonDotThreshold: GLOBE_SCENE_DEFAULTS.horizonDotThreshold,
            referenceAltitude: 0,
            rootZoomFloor: GLOBE_SCENE_DEFAULTS.rootZoomFloor,
            frustumPlanes: planes,
            textureQualityFloorZoom: GLOBE_SCENE_DEFAULTS.textureQualityFloorZoom,
            viewForward: vf,
        };
    };

    /** frustum 内の子午線サンプルで最遠被覆距離[km]と最初の穴[km]（無ければ-1）を返す。 */
    const coverageNorth = (opts: GlobeLodOptions) => {
        const tiles = selectGlobeTiles(opts);
        const cam = opts.cameraEcef;
        const inFrustum = (lat: number, lon: number): boolean => {
            const p = geodeticToEcef(lat, lon, 0);
            const rx = p.x - cam.x, ry = p.y - cam.y, rz = p.z - cam.z;
            for (const pl of opts.frustumPlanes ?? []) {
                if (pl.normal.x * rx + pl.normal.y * ry + pl.normal.z * rz + pl.d < 0) {
                    return false;
                }
            }
            return true;
        };
        const covered = (lat: number, lon: number): boolean =>
            tiles.some((t) => {
                const c = toTileXY(lat, lon, t.zoom);
                return c.x === t.x && c.y === t.y;
            });
        const h = Math.max(0, ecefToGeodetic(cam).altMeters);
        const horizonKm = (R * Math.acos(R / (R + h))) / 1000;
        let lastCoveredKm = 0;
        let firstHoleKm = -1;
        for (let km = 0.5; km <= horizonKm; km += 0.5) {
            const lat = CENTER_LAT + (km * 1000) / R / DEG; // 北（機体前方）。
            if (!inFrustum(lat, CENTER_LON)) continue;
            if (covered(lat, CENTER_LON)) lastCoveredKm = km;
            else if (firstHoleKm < 0) firstHoleKm = km;
        }
        return { tiles, lastCoveredKm, firstHoleKm, horizonKm };
    };

    // 追従カメラを引き（radius 3000m・height 15m）水平線が見える構図。alt 2000 / 10000。
    for (const altM of [2000, 10000]) {
        it(`alt=${altM}m: viewForward 無しでは前方が地平線手前で穴、有りで地平線近くまで連続被覆`, () => {
            const { eye, target, up } = followRig(altM, 3000, 15);
            const planes = followPlanes(eye, target, up);

            // 補正なし（現状=バグ）: frustum は地平線まで映すのに被覆が手前で頭打ち→穴が出る。
            const base = coverageNorth(followOpts(eye, planes, false));
            expect(base.firstHoleKm).toBeGreaterThan(0); // 穴がある。
            expect(base.lastCoveredKm).toBeLessThan(base.horizonKm * 0.5);

            // 補正あり（修正）: 前方が地平線の 7 割超まで連続被覆され、穴が消える。
            const fixed = coverageNorth(followOpts(eye, planes, true));
            expect(fixed.firstHoleKm).toBe(-1); // 穴なし。
            expect(fixed.lastCoveredKm).toBeGreaterThan(fixed.horizonKm * 0.7);
            // タイル数は maxTiles 予算内（暴発しない）。
            expect(fixed.tiles.length).toBeLessThanOrEqual(GLOBE_SCENE_DEFAULTS.maxTiles);
        });
    }

    it("viewForward=undefined は明示指定なしと同一結果（後方互換）", () => {
        const { eye, target, up } = followRig(2000, 3000, 15);
        const planes = followPlanes(eye, target, up);
        const withUndef = selectGlobeTiles(followOpts(eye, planes, false));
        const optsNoField = followOpts(eye, planes, false);
        delete optsNoField.viewForward; // フィールド自体を消す。
        const withoutField = selectGlobeTiles(optsNoField);
        expect(withUndef).toEqual(withoutField);
    });

    it("viewForward=normalize(center−camera) は未指定と同一 seed（一致経路で挙動不変）", () => {
        // ビューアのように視線が camera→center と一致する場合、viewForward を渡しても tilt は
        // 同値に収束し seed 集合が変わらないこと（退行なしの担保）。
        const cameraEcef = geodeticToEcef(CENTER_LAT - 0.5, CENTER_LON, 60000);
        const centerEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, 0);
        const common = {
            cameraEcef,
            centerLat: CENTER_LAT,
            centerLon: CENTER_LON,
            minZoom: 11,
            rootSearchRadius: 2,
            maxRootTiles: 256,
            viewportHeight: 1080,
            viewportWidth: 1920,
            verticalFov: V_FOV,
            sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
            rootZoomFloor: 5,
        } as const;
        const seedsNoVf = selectGlobeRootTiles(common);
        const seedsVf = selectGlobeRootTiles({
            ...common,
            viewForward: centerEcef.subtract(cameraEcef).normalize(),
        });
        expect(seedsVf).toEqual(seedsNoVf);
    });

    it("零ベクトル viewForward は camera→center 由来 tilt にフォールバック（例外なし）", () => {
        const cameraEcef = geodeticToEcef(CENTER_LAT - 0.5, CENTER_LON, 60000);
        const common = {
            cameraEcef,
            centerLat: CENTER_LAT,
            centerLon: CENTER_LON,
            minZoom: 11,
            rootSearchRadius: 2,
            maxRootTiles: 256,
            viewportHeight: 1080,
            viewportWidth: 1920,
            verticalFov: V_FOV,
            sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
            rootZoomFloor: 5,
        } as const;
        const seedsBase = selectGlobeRootTiles(common);
        const seedsZero = selectGlobeRootTiles({ ...common, viewForward: new Vector3(0, 0, 0) });
        expect(seedsZero).toEqual(seedsBase);
    });
});
