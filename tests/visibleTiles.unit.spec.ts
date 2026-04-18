import { computeVisibleTiles } from "../src/terrain/visibleTiles";
import type { FrustumPlane } from "../src/terrain/visibleTiles";
import type { TileCoord } from "../src/terrain/tileTypes";

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
});
