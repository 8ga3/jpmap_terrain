/**
 * geo/globeLod の単体テスト (Issue #275 Phase 1)。
 *
 * - tileKey の形式
 * - maxZoom < minZoom で空配列
 * - root 集合の選択と maxTiles 打ち切り
 * - SSE: カメラが近いほど深い zoom が選ばれる
 * - 地平線カリング: しきい値を上げると裏側タイルが除外され件数が減る
 */

import { describe, it, expect } from "@jest/globals";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ComputeLookAtFromYawPitchToRef } from "@babylonjs/core/Cameras/geospatialCamera";

import { tileCenterLatLon, toTileXY } from "../src/terrain/gsiTile";
import { geodeticToEcef, ecefToGeodetic } from "../src/terrain/geo/ecef";
import {
    selectGlobeRootTiles,
    selectGlobeTiles,
    tileKey,
    type GlobeLodOptions,
} from "../src/terrain/geo/globeLod";

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
    sseThreshold: 256 * 2.5,
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
        const tiles = selectGlobeTiles(
            baseOpts(200000, { minZoom: 11, maxZoom: 11, rootSearchRadius: 0 }),
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

    it("全球視点（高高度）は粗タイルで可視キャップ全体を欠けなく被覆する（#335 全球モード）", () => {
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

    it("高チルトで rootZoomFloor を効かせると遠景がより遠くまで被覆される（#335）", () => {
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

    it("選択結果に重複タイル（z/x/y）がない（#335 デデュプ）", () => {
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

    it("チルト時は視錐台の奥（上端＝注視点の先）と左右端まで被覆する（#335 カバレッジ）", () => {
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

    it("斜め見（grazing 高チルト）でも奥が地平線近くまで被覆される（#335 球面 dFar）", () => {
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

    it("低高度・斜め見で nadir↔center が 1 タイル未満でも帯が視線方向を向く（#335 分数方位）", () => {
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

    it("水平チルトでカメラ直下（nadir）の前景タイルが選択される（#329）", () => {
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
        sseThreshold: 256 * 2.5,
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

    it("チルト時は nadir と center の地点を被覆する（#329 帯）", () => {
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

    it("高チルトで nadir→地平線の帯が距離適応 zoom の継ぎ目で途切れず連続被覆する（#335 半刻み歩進）", () => {
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
});
