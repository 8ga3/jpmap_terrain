import { computeVisibleTiles, computeMultiLodTiles, computeBaseZoom } from "../src/terrain/visibleTiles";
import type { FrustumPlane } from "../src/terrain/visibleTiles";
import type { TileCoord } from "../src/terrain/tileTypes";
import { toTileKey } from "../src/terrain/tileTypes";

/**
 * 全てを包含する Frustum planes（全候補が可視）。
 * 6平面すべてが十分に遠い位置に設定。
 */
const allVisiblePlanes: FrustumPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, d: 1e9 },
    { normal: { x: -1, y: 0, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: 1, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: -1, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: 0, z: 1 }, d: 1e9 },
    { normal: { x: 0, y: 0, z: -1 }, d: 1e9 },
];

/**
 * 全てを除外する Frustum planes（全候補が不可視）。
 * 互いに矛盾する平面で、どの点も内側にならない。
 */
const noneVisiblePlanes: FrustumPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, d: -1e9 },
    { normal: { x: -1, y: 0, z: 0 }, d: -1e9 },
    { normal: { x: 0, y: 1, z: 0 }, d: -1e9 },
    { normal: { x: 0, y: -1, z: 0 }, d: -1e9 },
    { normal: { x: 0, y: 0, z: 1 }, d: -1e9 },
    { normal: { x: 0, y: 0, z: -1 }, d: -1e9 },
];

const center: TileCoord = { zoom: 14, x: 14547, y: 6452 };

describe("computeVisibleTiles", () => {
    it("全可視の場合、中心タイルを含む結果を返す", () => {
        const result = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: allVisiblePlanes,
            maxTiles: 25,
        });

        expect(result.length).toBeGreaterThan(0);
        expect(result).toContainEqual(center);
    });

    it("全不可視の場合、空配列を返す", () => {
        const result = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: noneVisiblePlanes,
            maxTiles: 25,
        });

        expect(result).toHaveLength(0);
    });

    it("maxTiles で結果を制限する", () => {
        const result = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: allVisiblePlanes,
            maxTiles: 5,
        });

        expect(result.length).toBeLessThanOrEqual(5);
    });

    it("結果はマンハッタン距離の昇順でソートされる", () => {
        const result = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: allVisiblePlanes,
            maxTiles: 50,
            searchRadius: 3,
        });

        // 中心（距離0）が先頭付近にあること
        const centerIdx = result.findIndex(
            (c) => c.x === center.x && c.y === center.y
        );
        expect(centerIdx).toBe(0);

        // 距離が単調非減少であること
        for (let i = 1; i < result.length; i++) {
            const distPrev =
                Math.abs(result[i - 1].x - center.x) +
                Math.abs(result[i - 1].y - center.y);
            const distCurr =
                Math.abs(result[i].x - center.x) +
                Math.abs(result[i].y - center.y);
            expect(distCurr).toBeGreaterThanOrEqual(distPrev);
        }
    });

    it("searchRadius=0 のとき中心タイルのみ返す", () => {
        const result = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: allVisiblePlanes,
            maxTiles: 25,
            searchRadius: 0,
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(center);
    });

    it("maxElevation を指定すると AABB の maxY に反映される", () => {
        // y >= 500 のみ許容する Frustum で maxElevation の差を検証する
        const highFloorPlanes: FrustumPlane[] = [
            { normal: { x: 1, y: 0, z: 0 }, d: 1e9 },
            { normal: { x: -1, y: 0, z: 0 }, d: 1e9 },
            { normal: { x: 0, y: 1, z: 0 }, d: -500 },    // y >= 500
            { normal: { x: 0, y: -1, z: 0 }, d: 1e9 },
            { normal: { x: 0, y: 0, z: 1 }, d: 1e9 },
            { normal: { x: 0, y: 0, z: -1 }, d: 1e9 },
        ];

        // maxElevation=100 → AABB maxY=100, P-vertex y=100, 100-500 = -400 < 0 → 不可視
        const resultLow = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: highFloorPlanes,
            maxElevation: 100,
        });
        expect(resultLow).toHaveLength(0);

        // maxElevation=1000 → AABB maxY=1000, P-vertex y=1000, 1000-500 = 500 >= 0 → 可視
        const resultHigh = computeVisibleTiles({
            center,
            tileSize: 100,
            frustumPlanes: highFloorPlanes,
            maxElevation: 1000,
        });
        expect(resultHigh.length).toBeGreaterThan(0);
    });
});

describe("computeBaseZoom", () => {
    // zoom14=100, zoom13=200, zoom12=400
    const tileSizeForZoom = (z: number): number => 100 * Math.pow(2, 14 - z);

    it("近距離では最高zoomを返す", () => {
        // distance=100, targetTileSize=80 → 全zoom > 80 → return maxZoom=14
        expect(computeBaseZoom(100, tileSizeForZoom, 14, 12)).toBe(14);
    });

    it("中距離では中間zoomを返す", () => {
        // distance=300, targetTileSize=240 → zoom13(200) <= 240 → return 13
        expect(computeBaseZoom(300, tileSizeForZoom, 14, 12)).toBe(13);
    });

    it("遠距離では最低zoomを返す", () => {
        // distance=600, targetTileSize=480 → zoom12(400) <= 480 → return 12
        expect(computeBaseZoom(600, tileSizeForZoom, 14, 12)).toBe(12);
    });
});

describe("computeMultiLodTiles", () => {
    const baseCenter: TileCoord = { zoom: 14, x: 14547, y: 6452 };

    // zoom14=100, zoom13=200, zoom12=400
    const tileSizeForZoom = (z: number): number => 100 * Math.pow(2, 14 - z);

    it("baseZoom < minZoom で空配列を返す", () => {
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 400,
            baseZoom: 12,
            minZoom: 14,
            maxTiles: 100,
        });
        expect(result).toHaveLength(0);
    });

    it("十分な距離では全タイルが同一zoomになる", () => {
        // cameraDistance=4000, threshold=5200
        // searchRadius=3, tileSize=100 → 最遠タイルdist=sqrt(300²+300²)≈424 < 5200
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 4000,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 200,
            searchRadius: 3,
        });

        expect(result.length).toBeGreaterThan(0);
        expect(result.every((e) => e.coord.zoom === 14)).toBe(true);
    });

    it("近距離では複数zoomのタイルが含まれる", () => {
        // cameraDistance=200, threshold=260
        // 近いタイル: dist < 260 → zoom14
        // 遠いタイル: dist >= 260 → zoom13 or zoom12
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 6,
        });

        const zooms = new Set(result.map((e) => e.coord.zoom));
        expect(zooms.size).toBeGreaterThanOrEqual(2);
        expect(zooms.has(14)).toBe(true);
    });

    it("maxTilesで結果を制限する", () => {
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 400,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 10,
            searchRadius: 4,
        });

        expect(result.length).toBeLessThanOrEqual(10);
    });

    it("タイルサイズがzoomレベルに応じて異なる", () => {
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 6,
        });

        const z14Entry = result.find((e) => e.coord.zoom === 14);
        const z13Entry = result.find((e) => e.coord.zoom === 13);

        expect(z14Entry?.tileSize).toBe(100);
        if (z13Entry) {
            expect(z13Entry.tileSize).toBe(200);
        }
    });

    it("全不可視の場合、空配列を返す", () => {
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: noneVisiblePlanes,
            cameraDistance: 400,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 60,
            searchRadius: 4,
        });

        expect(result).toHaveLength(0);
    });

    it("TileKeyの重複がない", () => {
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 6,
        });

        const keys = result.map((e) => toTileKey(e.coord));
        expect(keys.length).toBe(new Set(keys).size);
    });

    it("ターゲットから遠いタイルほど低zoomが割り当てられる", () => {
        // cameraDistance=200 → threshold=260
        // 中心付近のタイルはzoom14、外周はzoom13/12
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 8,
        });

        // ターゲット（原点）から遠いタイルは低zoom
        const z14Tiles = result.filter((e) => e.coord.zoom === 14);
        const z13Tiles = result.filter((e) => e.coord.zoom === 13);

        if (z14Tiles.length > 0 && z13Tiles.length > 0) {
            // zoom14タイルの平均距離 < zoom13タイルの平均距離
            const avgDist = (tiles: typeof z14Tiles) =>
                tiles.reduce((sum, t) => {
                    const dx = t.coord.x - baseCenter.x;
                    const dy = t.coord.y - baseCenter.y;
                    return sum + Math.abs(dx) + Math.abs(dy);
                }, 0) / tiles.length;

            expect(avgDist(z14Tiles)).toBeLessThan(avgDist(z13Tiles));
        }
    });
});
