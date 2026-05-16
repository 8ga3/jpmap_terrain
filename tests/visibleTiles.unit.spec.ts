/**
 * computeQuadtreeTiles のユニットテスト。
 * Quadtree 探索 + SSE による LOD 判定と視錐台カリングの挙動を検証する。
 */

import { jest, describe, it, expect } from "@jest/globals";
import { computeQuadtreeTiles, isAABBInFrustum } from "../src/terrain/visibleTiles";
import type { FrustumPlane, QuadtreeTilesOptions } from "../src/terrain/visibleTiles";
import type { TileCoord } from "../src/terrain/tileTypes";

/** 全候補を内包する Frustum（6平面とも遠方）。 */
const allVisiblePlanes: FrustumPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, d: 1e9 },
    { normal: { x: -1, y: 0, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: 1, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: -1, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: 0, z: 1 }, d: 1e9 },
    { normal: { x: 0, y: 0, z: -1 }, d: 1e9 },
];

/** 全候補を除外する Frustum（互いに矛盾する平面）。 */
const noneVisiblePlanes: FrustumPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, d: -1e9 },
    { normal: { x: -1, y: 0, z: 0 }, d: -1e9 },
    { normal: { x: 0, y: 1, z: 0 }, d: -1e9 },
    { normal: { x: 0, y: -1, z: 0 }, d: -1e9 },
    { normal: { x: 0, y: 0, z: 1 }, d: -1e9 },
    { normal: { x: 0, y: 0, z: -1 }, d: -1e9 },
];

/** x >= 0 のみ許容する（片側のみ可視）。 */
const halfVisiblePlanes: FrustumPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, d: 0 },        // x >= 0
    { normal: { x: -1, y: 0, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: 1, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: -1, z: 0 }, d: 1e9 },
    { normal: { x: 0, y: 0, z: 1 }, d: 1e9 },
    { normal: { x: 0, y: 0, z: -1 }, d: 1e9 },
];

/** baseCenter は maxZoom 側の中心タイル。 */
const baseCenter: TileCoord = { zoom: 14, x: 14547, y: 6452 };
/** zoom z でのタイルサイズ: 256 / 2^z （テスト用の単純関数） */
const tileSizeForZoom = (z: number): number => 256 / (1 << z);

/** 既定パラメータ。各テストで差分のみ上書きして使う。 */
const baseOpts: QuadtreeTilesOptions = {
    maxZoom: 14,
    minZoom: 10,
    baseCenter,
    tileSizeForZoom,
    frustumPlanes: allVisiblePlanes,
    cameraPosition: { x: 0, y: 0.1, z: 0 },
    verticalFov: Math.PI / 3,
    viewportHeight: 1080,
};

describe("isAABBInFrustum", () => {
    it("全可視 Frustum では AABB が可視と判定される", () => {
        expect(
            isAABBInFrustum(-1, -1, -1, 1, 1, 1, allVisiblePlanes)
        ).toBe(true);
    });

    it("全不可視 Frustum では可視判定されない", () => {
        expect(
            isAABBInFrustum(-1, -1, -1, 1, 1, 1, noneVisiblePlanes)
        ).toBe(false);
    });
});

describe("computeQuadtreeTiles", () => {
    it("視錐台で全方向を外すと空配列を返す", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            frustumPlanes: noneVisiblePlanes,
        });
        expect(result).toHaveLength(0);
    });

    it("片側を外す視錐台では x>=0 側の root のみ残る", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            frustumPlanes: halfVisiblePlanes,
            // 高 sseThreshold で分割を抑止 → root がそのまま採用される
            sseThreshold: 1e9,
            rootSearchRadius: 2,
        });

        const allVisibleCount = computeQuadtreeTiles({
            ...baseOpts,
            sseThreshold: 1e9,
            rootSearchRadius: 2,
        }).length;

        // 全 root は minZoom のまま採用され、半面のみ残るので全件より少ない
        expect(result.length).toBeGreaterThan(0);
        expect(result.length).toBeLessThan(allVisibleCount);
        expect(result.every((e) => e.coord.zoom === baseOpts.minZoom)).toBe(true);
    });

    it("sseThreshold が極小なら全タイルが maxZoom になる", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            sseThreshold: 0.001,
            rootSearchRadius: 0,
        });
        expect(result.length).toBeGreaterThan(0);
        expect(result.every((e) => e.coord.zoom === baseOpts.maxZoom)).toBe(true);
    });

    it("sseThreshold が極大なら全タイルが minZoom になる", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            sseThreshold: 1e9,
            rootSearchRadius: 1,
        });
        expect(result.length).toBeGreaterThan(0);
        expect(result.every((e) => e.coord.zoom === baseOpts.minZoom)).toBe(true);
    });

    it("maxTiles で結果が制限され、先頭はカメラ最接近タイルが来る", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            sseThreshold: 0.001,     // 細かく分割して候補を多くする
            rootSearchRadius: 1,
            maxTiles: 5,
        });
        expect(result.length).toBeLessThanOrEqual(5);
        expect(result.length).toBeGreaterThan(0);
        // 最接近側（カメラの真下）は maxZoom まで分割されている
        expect(result[0].coord.zoom).toBe(baseOpts.maxZoom);
    });

    it("結果集合に親子関係のペアが存在しない", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            sseThreshold: 2.0,
            rootSearchRadius: 1,
        });
        for (let i = 0; i < result.length; i++) {
            for (let j = 0; j < result.length; j++) {
                if (i === j) continue;
                const a = result[i].coord;
                const b = result[j].coord;
                if (a.zoom >= b.zoom) continue;
                // a は b の親候補（a.zoom < b.zoom）
                const diff = b.zoom - a.zoom;
                const parentX = b.x >> diff;
                const parentY = b.y >> diff;
                if (parentX === a.x && parentY === a.y) {
                    throw new Error(
                        `親子関係検出: parent ${a.zoom}/${a.x}/${a.y}, child ${b.zoom}/${b.x}/${b.y}`
                    );
                }
            }
        }
    });

    it("近景は高 zoom、視錐台遠端は低 zoom が採用され、zoom 分布が混在する", () => {
        // 近景: カメラ直下の root は D=0 → 1 にクランプされ分割進行。
        // 遠景: root から離れるほど D が大きくなり早期採用される。
        const result = computeQuadtreeTiles({
            ...baseOpts,
            tileSizeForZoom: (z) => 10 * Math.pow(2, 10 - z),
            viewportHeight: 1,
            cameraPosition: { x: 0, y: 1, z: 0 },
            sseThreshold: 2.0,
            rootSearchRadius: 5,
        });

        expect(result.length).toBeGreaterThan(0);
        const zooms = result.map((e) => e.coord.zoom);
        const zmax = Math.max(...zooms);
        const zmin = Math.min(...zooms);
        expect(zmax).toBeGreaterThan(zmin);
        expect(zmin).toBeGreaterThanOrEqual(baseOpts.minZoom);
        expect(zmax).toBeLessThanOrEqual(baseOpts.maxZoom);
    });

    it("minZoom === maxZoom の場合、全タイルが同一 zoom で返る", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            minZoom: 12,
            maxZoom: 12,
            rootSearchRadius: 1,
        });
        expect(result.length).toBeGreaterThan(0);
        expect(result.every((e) => e.coord.zoom === 12)).toBe(true);
    });

    it("カメラを遠ざけると採用 zoom が全体的に下がる", () => {
        const scaled: Partial<QuadtreeTilesOptions> = {
            tileSizeForZoom: (z) => 1e6 * Math.pow(2, -z),
            rootSearchRadius: 0,
            // 既定しきい値は大きめに振れるため、感度検証はしきい値を明示固定する
            sseThreshold: 2.0,
        };
        const near = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            cameraPosition: { x: 0, y: 1000, z: 0 },
        });
        const far = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            cameraPosition: { x: 0, y: 1e7, z: 0 },
        });
        const avg = (entries: typeof near): number =>
            entries.reduce((s, e) => s + e.coord.zoom, 0) / Math.max(1, entries.length);
        expect(avg(far)).toBeLessThan(avg(near));
    });

    it("viewportHeight を大きくすると同じタイルが 1 段深く分割される", () => {
        const scaled: Partial<QuadtreeTilesOptions> = {
            tileSizeForZoom: (z) => 1e6 * Math.pow(2, -z),
            cameraPosition: { x: 0, y: 1e5, z: 0 },
            rootSearchRadius: 0,
            // 既定しきい値は 3x3 想定で大きいので、感度検証はしきい値を小さく固定する
            sseThreshold: 2.0,
        };
        const low = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            viewportHeight: 500,
        });
        const high = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            viewportHeight: 1000,
        });
        const maxZoomLow = Math.max(...low.map((e) => e.coord.zoom));
        const maxZoomHigh = Math.max(...high.map((e) => e.coord.zoom));
        // ビューポートが高いほど SSE が大きくなり、より深く分割される
        expect(maxZoomHigh).toBeGreaterThan(maxZoomLow);
    });

    it("rootSearchRadius=0 では単一 root から派生する子孫のみ返す", () => {
        const result = computeQuadtreeTiles({
            ...baseOpts,
            rootSearchRadius: 0,
            sseThreshold: 0.001, // 最深まで分割
        });
        expect(result.length).toBeGreaterThan(0);
        expect(result.every((e) => e.coord.zoom === baseOpts.maxZoom)).toBe(true);

        // 全タイルが単一 root の子孫（minZoom へ落としたときの親 x/y が一致）
        const diff = baseOpts.maxZoom - baseOpts.minZoom;
        const parentXs = new Set(result.map((e) => e.coord.x >> diff));
        const parentYs = new Set(result.map((e) => e.coord.y >> diff));
        expect(parentXs.size).toBe(1);
        expect(parentYs.size).toBe(1);
    });

    it("カメラが AABB 内部にある root では D が 1 にクランプされ maxZoom まで分割される", () => {
        // カメラ位置を baseCenter ローカル原点に置く → AABB 内部で距離 0。
        const result = computeQuadtreeTiles({
            ...baseOpts,
            cameraPosition: { x: 0, y: 0, z: 0 },
            rootSearchRadius: 0,
            sseThreshold: 2.0,
        });
        expect(result.length).toBeGreaterThan(0);
        // D が 1 にクランプされると SSE が大きく、maxZoom まで分割される。
        expect(result.every((e) => e.coord.zoom === baseOpts.maxZoom)).toBe(true);
    });

    it("maxVisited 超過時にタイルが黙って破棄されず粗い LOD で強制採用される", () => {
        // _maxVisited を極端に小さく設定して上限を意図的に踏ませる。
        // sseThreshold を極小にし全ノードが maxZoom まで分割されようとする設定。
        const lowBudget = 5;
        const result = computeQuadtreeTiles({
            ...baseOpts,
            sseThreshold: 0.001,
            rootSearchRadius: 0,
            _maxVisited: lowBudget,
        });
        // 上限がなければすべて maxZoom になるが、上限到達後は途中の zoom で強制採用される。
        expect(result.length).toBeGreaterThan(0);
        // maxZoom より粗い zoom（強制採用ノード）が含まれていること。
        const hasCoarser = result.some((e) => e.coord.zoom < baseOpts.maxZoom);
        expect(hasCoarser).toBe(true);
    });

    it("maxVisited 超過時に console.warn が出力される", () => {
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            computeQuadtreeTiles({
                ...baseOpts,
                sseThreshold: 0.001,
                rootSearchRadius: 0,
                _maxVisited: 3,
            });
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("maxVisited limit"),
            );
        } finally {
            warnSpy.mockRestore();
        }
    });

    it("maxVisited に達しない通常ケースでは console.warn が出ない", () => {
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            computeQuadtreeTiles({
                ...baseOpts,
                sseThreshold: 1e9, // 全ノード即座に採用 → 分割なし
                rootSearchRadius: 0,
            });
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    it("lodBias > 0 で粗いタイル（低 zoom）が選ばれやすくなる", () => {
        // 中遠距離カメラで zoom 分布が混在する条件。
        // lodBias=2 は effectiveSseThreshold を4倍にし、早期に採用される。
        const scaled: Partial<QuadtreeTilesOptions> = {
            tileSizeForZoom: (z) => 1e6 * Math.pow(2, -z),
            rootSearchRadius: 0,
            sseThreshold: 2.0,
            cameraPosition: { x: 0, y: 1e5, z: 0 },
            viewportHeight: 500,
        };
        const noBias = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            lodBias: 0,
        });
        const withBias = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            lodBias: 2,
        });
        const avg = (entries: typeof noBias): number =>
            entries.reduce((s, e) => s + e.coord.zoom, 0) / Math.max(1, entries.length);

        expect(noBias.length).toBeGreaterThan(0);
        expect(withBias.length).toBeGreaterThan(0);
        // noBias は深く分割されるが、withBias は途中で採用される
        expect(avg(withBias)).toBeLessThan(avg(noBias));
    });

    it("lodBias=0 は lodBias 省略と同じ結果になる", () => {
        const scaled: Partial<QuadtreeTilesOptions> = {
            tileSizeForZoom: (z) => 1e6 * Math.pow(2, -z),
            rootSearchRadius: 0,
            sseThreshold: 2.0,
            cameraPosition: { x: 0, y: 1e5, z: 0 },
            viewportHeight: 500,
        };
        const omitted = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
        });
        const explicit = computeQuadtreeTiles({
            ...baseOpts,
            ...scaled,
            lodBias: 0,
        });
        expect(omitted.length).toBe(explicit.length);
        const keys = (entries: typeof omitted): string[] =>
            entries.map((e) => `${e.coord.zoom}/${e.coord.x}/${e.coord.y}`).sort();
        expect(keys(omitted)).toEqual(keys(explicit));
    });
});
