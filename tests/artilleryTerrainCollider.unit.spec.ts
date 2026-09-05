/**
 * Artillery 地形コライダーのユニットテスト
 *
 * 回帰防止の対象:
 * - `isColliderTerrainMeshName`: 常時表示の粗いベースレイヤ（`base-tile-*`、zoom=2 の
 *   海面平坦メッシュ）をサンプリング対象から除外すること。これを含めると細かい地形タイルが
 *   未ロードの座標でレイがベースレイヤにヒットし、実地形と無関係な Y を非 null で返す。
 * - `fillMissingHeights`: サンプリングできなかった頂点を近傍平均で埋め、走査順の直前値で
 *   埋めていたときに生じた大きな段差を作らないこと。
 * - `shouldRetryColliderBuild` / `rebuild`: サンプリング成功率が低いときに失敗として扱い、
 *   全滅時は頂点を書き戻さないこと（海抜 0m の平面コライダーを作らない）。
 */
import { describe, expect, it, vi } from "vitest";

/** モックメッシュの状態（テストから頂点バッファと更新回数を検証する）。 */
const meshState: { positions: Float32Array; updateCalls: number } = {
    positions: new Float32Array(0),
    updateCalls: 0,
};
/** PhysicsAggregate の生成履歴。全滅時に再生成しないことを検証する。 */
const aggregateCalls: unknown[] = [];

vi.mock("@babylonjs/core/Meshes/Builders/groundBuilder", () => ({
    CreateGround: () => ({
        isVisible: true,
        isPickable: true,
        getVerticesData: () => meshState.positions,
        updateVerticesData: () => {
            meshState.updateCalls++;
        },
        createNormals: () => {},
        refreshBoundingInfo: () => {},
        dispose: () => {},
    }),
}));

vi.mock("@babylonjs/core/Physics/v2/physicsAggregate", () => ({
    PhysicsAggregate: class {
        constructor(...args: unknown[]) {
            aggregateCalls.push(args);
        }
        dispose(): void {}
    },
}));

vi.mock("@babylonjs/core/Physics/v2/IPhysicsEnginePlugin", () => ({
    PhysicsShapeType: { MESH: 4 },
}));

import {
    createTerrainCollider,
    fillMissingHeights,
    isColliderTerrainMeshName,
    MAX_COLLIDER_BUILD_ATTEMPTS,
    MIN_COLLIDER_SAMPLE_RATE,
    shouldRetryColliderBuild,
} from "../src/demos/artillery/terrainCollider";

describe("isColliderTerrainMeshName", () => {
    it("accepts globe LOD terrain tiles", () => {
        expect(isColliderTerrainMeshName("tile-15/29037/12956")).toBe(true);
    });

    it("accepts planar terrain tiles", () => {
        expect(isColliderTerrainMeshName("tile-ground-14/14552/6478")).toBe(
            true,
        );
    });

    it("rejects the always-on coarse base layer", () => {
        // `base-tile-` は `tile-` で始まらないため前方一致だけで除外される。
        // 命名変更でこの前提が崩れると #612 が再発するため、明示的に固定する。
        expect(isColliderTerrainMeshName("base-tile-2/3/1")).toBe(false);
        expect("base-tile-2/3/1".startsWith("tile-")).toBe(false);
    });

    it("rejects non-terrain meshes", () => {
        expect(isColliderTerrainMeshName("artillery-collider")).toBe(false);
        expect(isColliderTerrainMeshName("cannon-red")).toBe(false);
        expect(isColliderTerrainMeshName("")).toBe(false);
    });
});

describe("fillMissingHeights", () => {
    it("returns 0 and leaves values untouched when there is no hole", () => {
        const h = Float32Array.from([1, 2, 3, 4]);
        expect(fillMissingHeights(h, 2, 2)).toBe(0);
        expect(Array.from(h)).toEqual([1, 2, 3, 4]);
    });

    it("keeps all holes when every vertex is missing", () => {
        const h = Float32Array.from([NaN, NaN, NaN, NaN]);
        expect(fillMissingHeights(h, 2, 2)).toBe(4);
        expect(Array.from(h).every(Number.isNaN)).toBe(true);
    });

    it("fills a single hole with the average of its valid neighbors", () => {
        // 中央のみ穴。周囲 8 頂点はすべて 100 → 中央も 100 になる。
        const h = Float32Array.from([
            100,
            100,
            100,
            100,
            NaN,
            100,
            100,
            100,
            100,
        ]);
        expect(fillMissingHeights(h, 3, 3)).toBe(0);
        expect(h[4]).toBeCloseTo(100, 6);
    });

    it("propagates into a hole that is wider than one vertex", () => {
        // 4x4 の内側 2x2 が穴。外周はすべて 50。
        const h = new Float32Array(16).fill(50);
        for (const idx of [5, 6, 9, 10]) h[idx] = NaN;
        expect(fillMissingHeights(h, 4, 4)).toBe(0);
        for (const idx of [5, 6, 9, 10]) expect(h[idx]).toBeCloseTo(50, 6);
    });

    it("does not create the large steps produced by last-valid-value filling", () => {
        // 走査順の直前値で埋めると、行をまたいだ穴の縁で左端と右端の落差がそのまま
        // 段差になる。近傍平均なら穴は両側の値の間へ収まる。
        const width = 5;
        const height = 3;
        const h = new Float32Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                h[y * width + x] = x < 2 ? 1000 : 0;
            }
        }
        // 各行の x=2 を穴にする（1000 と 0 の境界）。
        for (let y = 0; y < height; y++) h[y * width + 2] = NaN;

        expect(fillMissingHeights(h, width, height)).toBe(0);
        for (let y = 0; y < height; y++) {
            const v = h[y * width + 2];
            expect(v).toBeGreaterThan(0);
            expect(v).toBeLessThan(1000);
        }
    });

    it("fills holes that only touch valid vertices diagonally", () => {
        const h = Float32Array.from([10, NaN, NaN, NaN]);
        expect(fillMissingHeights(h, 2, 2)).toBe(0);
        expect(Array.from(h).some(Number.isNaN)).toBe(false);
    });
});

describe("shouldRetryColliderBuild", () => {
    it("requests a retry when the sampling rate is below the threshold", () => {
        expect(shouldRetryColliderBuild(0, 1)).toBe(true);
        expect(
            shouldRetryColliderBuild(MIN_COLLIDER_SAMPLE_RATE - 0.01, 1),
        ).toBe(true);
    });

    it("does not retry when the sampling rate meets the threshold", () => {
        expect(shouldRetryColliderBuild(MIN_COLLIDER_SAMPLE_RATE, 1)).toBe(
            false,
        );
        expect(shouldRetryColliderBuild(1, 1)).toBe(false);
    });

    it("stops retrying once the attempt limit is reached", () => {
        expect(shouldRetryColliderBuild(0, MAX_COLLIDER_BUILD_ATTEMPTS)).toBe(
            false,
        );
        expect(
            shouldRetryColliderBuild(0, MAX_COLLIDER_BUILD_ATTEMPTS - 1),
        ).toBe(true);
        expect(shouldRetryColliderBuild(0, 1, 1)).toBe(false);
    });
});

describe("createTerrainCollider().rebuild", () => {
    const COLLIDER_OPTIONS = {
        areaSize: 100,
        subdivisions: 1, // 2x2 = 4 頂点
        restitution: 0.5,
        friction: 0.6,
    };
    /** 初期 Y。書き戻しの有無を判定するため 0 以外にしておく。 */
    const INITIAL_Y = 5;

    const createCollider = () => {
        meshState.positions = new Float32Array([
            -50,
            INITIAL_Y,
            -50,
            50,
            INITIAL_Y,
            -50,
            -50,
            INITIAL_Y,
            50,
            50,
            INITIAL_Y,
            50,
        ]);
        meshState.updateCalls = 0;
        aggregateCalls.length = 0;
        return createTerrainCollider({} as never, COLLIDER_OPTIONS);
    };

    it("returns 0 and keeps the geometry when every sample fails", async () => {
        const collider = createCollider();
        const rate = await collider.rebuild(() => null);

        expect(rate).toBe(0);
        // 全滅時に書き戻すと全頂点が海抜 0m の平面になり、可視地形と無関係な高さで
        // 砲弾が跳ねる。書き戻しを抑止していることを固定する。
        expect(meshState.updateCalls).toBe(0);
        expect(
            Array.from(meshState.positions).filter((_, i) => i % 3 === 1),
        ).toEqual([INITIAL_Y, INITIAL_Y, INITIAL_Y, INITIAL_Y]);
        expect(aggregateCalls.length).toBe(0);
    });

    it("returns 1 and writes sampled heights when every sample succeeds", async () => {
        const collider = createCollider();
        const rate = await collider.rebuild(() => 123);

        expect(rate).toBe(1);
        expect(meshState.updateCalls).toBe(1);
        expect(
            Array.from(meshState.positions).filter((_, i) => i % 3 === 1),
        ).toEqual([123, 123, 123, 123]);
        expect(aggregateCalls.length).toBe(1);
    });

    it("returns a partial rate and fills holes from valid neighbors", async () => {
        const collider = createCollider();
        const rate = await collider.rebuild((x, z) =>
            x < 0 && z < 0 ? 200 : null,
        );

        expect(rate).toBe(0.25);
        expect(meshState.updateCalls).toBe(1);
        const ys = Array.from(meshState.positions).filter(
            (_, i) => i % 3 === 1,
        );
        expect(ys).toEqual([200, 200, 200, 200]);
    });
});
