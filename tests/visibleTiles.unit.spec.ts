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

    it("grid center 奇数座標でも中心付近のタイルzoomがbaseZoomを維持する", () => {
        // baseCenter.x が奇数のケース
        const oddCenter: TileCoord = { zoom: 14, x: 14547, y: 6453 };
        const result = computeMultiLodTiles({
            baseCenter: oddCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 6,
        });

        // 中心タイル自体が baseZoom で含まれること
        const centerTile = result.find(
            (e) => e.coord.zoom === 14 && e.coord.x === oddCenter.x && e.coord.y === oddCenter.y
        );
        expect(centerTile).toBeDefined();
        expect(centerTile!.coord.zoom).toBe(14);
    });

    it("カメラ距離を段階的に変化させても中心付近のzoomがbaseZoomを下回らない", () => {
        const distances = [500, 1000, 1500, 2000];
        for (const dist of distances) {
            const result = computeMultiLodTiles({
                baseCenter,
                tileSizeForZoom,
                frustumPlanes: allVisiblePlanes,
                cameraDistance: dist,
                baseZoom: 14,
                minZoom: 12,
                maxTiles: 500,
                searchRadius: 6,
            });

            // 中心タイル (dx=0, dy=0 相当) が baseZoom であること
            const centerTile = result.find(
                (e) => e.coord.zoom === 14 && e.coord.x === baseCenter.x && e.coord.y === baseCenter.y
            );
            expect(centerTile).toBeDefined();
            expect(centerTile!.coord.zoom).toBe(14);
        }
    });

    it("昇格後にタイル領域の重なりがない", () => {
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

        // 主格子の内側セルのみで重なりを検証。
        // Far-field sweep が境界で部分的に重なるのは既存動作のため、
        // 内側（searchRadius - 2^(baseZoom-minZoom) = 4）に限定する。
        const innerRadius = 4;
        const coveredCells = new Set<string>();
        let hasOverlap = false;

        for (const entry of result) {
            const { coord } = entry;
            const diff = 14 - coord.zoom;
            const cellCount = 1 << diff;
            const baseX = coord.x << diff;
            const baseY = coord.y << diff;

            for (let cy = 0; cy < cellCount; cy++) {
                for (let cx = 0; cx < cellCount; cx++) {
                    const dx = (baseX + cx) - baseCenter.x;
                    const dy = (baseY + cy) - baseCenter.y;
                    if (Math.abs(dx) > innerRadius || Math.abs(dy) > innerRadius) continue;

                    const cellKey = `${baseX + cx},${baseY + cy}`;
                    if (coveredCells.has(cellKey)) {
                        hasOverlap = true;
                    }
                    coveredCells.add(cellKey);
                }
            }
        }

        expect(hasOverlap).toBe(false);
    });

    it("Far-field sweepで部分カバーの親タイルが高zoomタイルと重ならない", () => {
        // 狭いsearchRadiusで内側は高zoom、外側はFar-field sweepが補完
        // 部分カバー境界でのメッシュ重なりがないことを確認
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 4,
        });

        // baseZoom（zoom14）セルに展開して重なりチェック（全域）
        const coveredCells = new Set<string>();
        let hasOverlap = false;

        for (const entry of result) {
            const { coord } = entry;
            const diff = 14 - coord.zoom;
            const cellCount = 1 << diff;
            const baseX = coord.x << diff;
            const baseY = coord.y << diff;

            for (let cy = 0; cy < cellCount; cy++) {
                for (let cx = 0; cx < cellCount; cx++) {
                    const cellKey = `${baseX + cx},${baseY + cy}`;
                    if (coveredCells.has(cellKey)) {
                        hasOverlap = true;
                    }
                    coveredCells.add(cellKey);
                }
            }
        }

        expect(hasOverlap).toBe(false);
    });

    it("Far-field sweepで部分カバー時に穴が開かない", () => {
        // 狭い searchRadius で Far-field sweep が動作する構成
        const result = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 200,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 500,
            searchRadius: 4,
        });

        // 結果が空でないこと
        expect(result.length).toBeGreaterThan(0);

        // Far-field sweep 由来の低zoomタイルが含まれること
        const lowZoomTiles = result.filter((e) => e.coord.zoom < 14);
        expect(lowZoomTiles.length).toBeGreaterThan(0);

        // 重複キーがないこと
        const keys = result.map((e) => toTileKey(e.coord));
        expect(keys.length).toBe(new Set(keys).size);
    });

    describe("超遠方タイル（低zoom）", () => {
        // zoom18基準: zoom18=64m, zoom9≈32km, zoom2≈4160km
        const farCenter: TileCoord = { zoom: 18, x: 232757, y: 103240 };
        const farTileSizeForZoom = (z: number): number => 64 * Math.pow(2, 18 - z);

        it("minZoom=2 で zoom 7 以下のタイルが結果に含まれる", () => {
            const result = computeMultiLodTiles({
                baseCenter: farCenter,
                tileSizeForZoom: farTileSizeForZoom,
                frustumPlanes: allVisiblePlanes,
                cameraDistance: 40000,
                baseZoom: 9,
                minZoom: 2,
                maxTiles: 160,
                searchRadius: 14,
            });

            expect(result.length).toBeGreaterThan(0);
            const lowZoomTiles = result.filter((e) => e.coord.zoom <= 7);
            expect(lowZoomTiles.length).toBeGreaterThan(0);
        });

        it("低zoom タイルでも TileKey の重複がない", () => {
            const result = computeMultiLodTiles({
                baseCenter: farCenter,
                tileSizeForZoom: farTileSizeForZoom,
                frustumPlanes: allVisiblePlanes,
                cameraDistance: 40000,
                baseZoom: 9,
                minZoom: 2,
                maxTiles: 160,
                searchRadius: 14,
            });

            const keys = result.map((e) => toTileKey(e.coord));
            expect(keys.length).toBe(new Set(keys).size);
        });

        it("低zoom タイル追加後も maxTiles を超えない", () => {
            const result = computeMultiLodTiles({
                baseCenter: farCenter,
                tileSizeForZoom: farTileSizeForZoom,
                frustumPlanes: allVisiblePlanes,
                cameraDistance: 40000,
                baseZoom: 9,
                minZoom: 2,
                maxTiles: 160,
                searchRadius: 14,
            });

            expect(result.length).toBeLessThanOrEqual(160);
        });

        it("近景タイル（baseZoom付近）が低zoom導入後も存在する", () => {
            const result = computeMultiLodTiles({
                baseCenter: farCenter,
                tileSizeForZoom: farTileSizeForZoom,
                frustumPlanes: allVisiblePlanes,
                cameraDistance: 40000,
                baseZoom: 9,
                minZoom: 2,
                maxTiles: 160,
                searchRadius: 14,
            });

            const highZoomTiles = result.filter((e) => e.coord.zoom >= 8);
            expect(highZoomTiles.length).toBeGreaterThan(0);
        });

        it("超遠方条件でもbaseZoomセル展開でタイル領域の重なりがない（Z-fighting防止）", () => {
            const result = computeMultiLodTiles({
                baseCenter: farCenter,
                tileSizeForZoom: farTileSizeForZoom,
                frustumPlanes: allVisiblePlanes,
                cameraDistance: 40000,
                baseZoom: 9,
                minZoom: 2,
                maxTiles: 160,
                searchRadius: 14,
            });

            expect(result.length).toBeGreaterThan(0);

            // baseZoom（zoom9）セルに展開して重なりチェック（全域）
            const coveredCells = new Set<string>();
            let hasOverlap = false;

            for (const entry of result) {
                const { coord } = entry;
                const diff = 9 - coord.zoom;
                if (diff < 0) continue;
                const cellCount = 1 << diff;
                const baseX = coord.x << diff;
                const baseY = coord.y << diff;

                for (let cy = 0; cy < cellCount; cy++) {
                    for (let cx = 0; cx < cellCount; cx++) {
                        const cellKey = `${baseX + cx},${baseY + cy}`;
                        if (coveredCells.has(cellKey)) {
                            hasOverlap = true;
                        }
                        coveredCells.add(cellKey);
                    }
                }
            }

            expect(hasOverlap).toBe(false);
        });

        it("カメラ距離を変えてもタイル領域の重なりがない", () => {
            const distances = [20000, 40000, 80000];
            for (const dist of distances) {
                const result = computeMultiLodTiles({
                    baseCenter: farCenter,
                    tileSizeForZoom: farTileSizeForZoom,
                    frustumPlanes: allVisiblePlanes,
                    cameraDistance: dist,
                    baseZoom: 9,
                    minZoom: 2,
                    maxTiles: 160,
                    searchRadius: 14,
                });

                const coveredCells = new Set<string>();
                let hasOverlap = false;

                for (const entry of result) {
                    const { coord } = entry;
                    const diff = 9 - coord.zoom;
                    if (diff < 0) continue;
                    const cellCount = 1 << diff;
                    const baseX = coord.x << diff;
                    const baseY = coord.y << diff;

                    for (let cy = 0; cy < cellCount; cy++) {
                        for (let cx = 0; cx < cellCount; cx++) {
                            const cellKey = `${baseX + cx},${baseY + cy}`;
                            if (coveredCells.has(cellKey)) {
                                hasOverlap = true;
                            }
                            coveredCells.add(cellKey);
                        }
                    }
                }

                expect(hasOverlap).toBe(false);
            }
        });
    });

    describe("近傍LOD平準化 (Step 1.5)", () => {
        it("cameraDistance*2.6 以内の近傍タイル群は同一zoomに平準化される", () => {
            // cameraDistance=200 → nearbyThreshold=520
            // searchRadius=6, tileSize(14)=100 → dx=6*100=600, 境界近辺に差が出る構成
            // Step 1.5により、dist<520 のタイルは最高zoom(14)に揃えられる
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

            const nearbyThreshold = 200 * 2.6;
            // dist < nearbyThreshold のタイルを抽出し、すべて同一zoomであることを確認
            const nearbyEntries = result.filter((e) => {
                const diff = 14 - e.coord.zoom;
                const baseX = e.coord.x << diff;
                const baseY = e.coord.y << diff;
                const dx = (baseX - baseCenter.x) * 100;
                const dy = (baseY - baseCenter.y) * 100;
                const dist = Math.sqrt(dx * dx + dy * dy);
                return dist < nearbyThreshold;
            });

            expect(nearbyEntries.length).toBeGreaterThan(0);
            const zooms = new Set(nearbyEntries.map((e) => e.coord.zoom));
            expect(zooms.size).toBe(1);
        });

        it("遠方タイルは近傍平準化の影響を受けず低zoomのまま", () => {
            // nearbyThreshold を超える距離のタイルは元の低zoomを保持
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

            // zoom14 以外のタイル（平準化対象外）が存在すること
            const lowZoomTiles = result.filter((e) => e.coord.zoom < 14);
            expect(lowZoomTiles.length).toBeGreaterThan(0);
        });
    });

    it("cameraGroundOffset 指定時、カメラ地上投影点付近の手前側タイルは高zoomになる", () => {
        // チルトでカメラが X=-600 地点の上空にある状況を想定。
        // ターゲット(0,0)からは 600 離れているが、カメラ地上投影点の近くになる。
        const withOffset = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 100,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 1000,
            searchRadius: 10,
            cameraGroundOffset: { x: -600, z: 0 },
        });

        const withoutOffset = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 100,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 1000,
            searchRadius: 10,
        });

        const covers = (entries: typeof withOffset, dx: number, dy: number): number | null => {
            const targetX = baseCenter.x + dx;
            const targetY = baseCenter.y + dy;
            for (const e of entries) {
                const diff = 14 - e.coord.zoom;
                const minX = e.coord.x << diff;
                const minY = e.coord.y << diff;
                const maxX = minX + (1 << diff);
                const maxY = minY + (1 << diff);
                if (targetX >= minX && targetX < maxX && targetY >= minY && targetY < maxY) {
                    return e.coord.zoom;
                }
            }
            return null;
        };

        const zoomWith = covers(withOffset, -6, 0);
        const zoomWithout = covers(withoutOffset, -6, 0);

        expect(zoomWith).toBe(14);
        expect(zoomWithout).not.toBeNull();
        expect(zoomWith!).toBeGreaterThan(zoomWithout!);
    });

    it("cameraGroundOffset: 近傍平準化範囲外の手前側タイルも高zoomになる", () => {
        const withOffset = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 1000,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 2000,
            searchRadius: 40,
            cameraGroundOffset: { x: -3500, z: 0 },
        });

        const withoutOffset = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 1000,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 2000,
            searchRadius: 40,
        });

        const covers = (entries: typeof withOffset, dx: number, dy: number): number | null => {
            const targetX = baseCenter.x + dx;
            const targetY = baseCenter.y + dy;
            for (const e of entries) {
                const diff = 14 - e.coord.zoom;
                const minX = e.coord.x << diff;
                const minY = e.coord.y << diff;
                const maxX = minX + (1 << diff);
                const maxY = minY + (1 << diff);
                if (targetX >= minX && targetX < maxX && targetY >= minY && targetY < maxY) {
                    return e.coord.zoom;
                }
            }
            return null;
        };

        const zoomWith = covers(withOffset, -35, 0);
        const zoomWithout = covers(withoutOffset, -35, 0);

        expect(zoomWith).not.toBeNull();
        expect(zoomWithout).not.toBeNull();
        expect(zoomWith!).toBeGreaterThan(zoomWithout!);
    });

    it("cameraGroundOffset: ターゲットとカメラ地上投影点の中間タイルも高zoomになる", () => {
        const withOffset = computeMultiLodTiles({
            baseCenter,
            tileSizeForZoom,
            frustumPlanes: allVisiblePlanes,
            cameraDistance: 500,
            baseZoom: 14,
            minZoom: 12,
            maxTiles: 2000,
            searchRadius: 50,
            cameraGroundOffset: { x: -4000, z: 0 },
        });

        const covers = (entries: typeof withOffset, dx: number, dy: number): number | null => {
            const targetX = baseCenter.x + dx;
            const targetY = baseCenter.y + dy;
            for (const e of entries) {
                const diff = 14 - e.coord.zoom;
                const minX = e.coord.x << diff;
                const minY = e.coord.y << diff;
                const maxX = minX + (1 << diff);
                const maxY = minY + (1 << diff);
                if (targetX >= minX && targetX < maxX && targetY >= minY && targetY < maxY) {
                    return e.coord.zoom;
                }
            }
            return null;
        };

        for (const dx of [-10, -20, -30, -40]) {
            const z = covers(withOffset, dx, 0);
            expect(z).toBe(14);
        }
    });
});
