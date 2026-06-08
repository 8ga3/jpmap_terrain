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

import { tileCenterLatLon, toTileXY } from "../src/terrain/gsiTile";
import { geodeticToEcef } from "../src/terrain/geo/ecef";
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

    it("root のみ選択（minZoom===maxZoom, 半径0）で中心 1 タイル", () => {
        const tiles = selectGlobeTiles(
            baseOpts(200000, { minZoom: 11, maxZoom: 11, rootSearchRadius: 0 }),
        );
        expect(tiles).toHaveLength(1);
        expect(tiles[0].zoom).toBe(11);
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
        ...overrides,
    });

    it("直下視（nadir≒center）は nadir 中心の対称ボックス（一辺 2r+1）", () => {
        const r = 2;
        const seeds = selectGlobeRootTiles(baseRoot(undefined, { rootSearchRadius: r }));
        expect(seeds).toHaveLength((2 * r + 1) ** 2);
        const center = toTileXY(CENTER_LAT, CENTER_LON, 11);
        expect(seeds.some((s) => s.x === center.x && s.y === center.y)).toBe(true);
    });

    it("チルト時は nadir タイルと center タイルの両方を含む（#329 帯）", () => {
        const nadirLat = CENTER_LAT - 0.8;
        const seeds = selectGlobeRootTiles(
            baseRoot(geodeticToEcef(nadirLat, CENTER_LON, 60000)),
        );
        const nadirTile = toTileXY(nadirLat, CENTER_LON, 11);
        const centerTile = toTileXY(CENTER_LAT, CENTER_LON, 11);
        expect(nadirTile.y).not.toBe(centerTile.y); // 前提: 別タイル
        expect(seeds.some((s) => s.x === nadirTile.x && s.y === nadirTile.y)).toBe(true);
        expect(seeds.some((s) => s.x === centerTile.x && s.y === centerTile.y)).toBe(true);
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
        const nadirTile = toTileXY(nadirLat, CENTER_LON, 11);
        expect(seeds.some((s) => s.x === nadirTile.x && s.y === nadirTile.y)).toBe(true);
    });
});
