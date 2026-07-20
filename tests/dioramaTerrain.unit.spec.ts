/**
 * terrain/diorama/dioramaTerrain の単体テスト。
 *
 * Babylon.js の GPU 系（Scene/Mesh/VertexData/TransformNode/StandardMaterial/Color3）と
 * dioramaGrid/dioramaElevation/dioramaTexture/dioramaSkirt をモックし、
 * 実際のWebGL/DOM無しで純粋にロジックのみを検証する:
 * - resolveOptions の入力検証（tableRadiusM/footprintRadiusM/demZoom/textureZoom/
 *   heightScaleFactor/baseDepthRatio が不正な場合は RangeError で reject）
 * - setFootprintRadius の入力検証（不正値は同期例外ではなく Promise 拒否になる）
 * - setCenter/setFootprintRadius/setMapType の並行呼び出しが rebuild キューにより
 *   直列化され、後続の rebuild が直前の rebuild 適用後の最新状態を引き継ぐこと
 *   （呼び出し時点ではなく実行時点の状態を基準にすること）
 * - あるrebuildが失敗してもキューは止まらず、後続のrebuildは実行されること
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@babylonjs/core/scene", () => ({ Scene: class {} }));

vi.mock("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: vi.fn<(name: string) => unknown>().mockImplementation(function (name) {
        return {
            name,
            material: null as unknown,
            parent: null as unknown,
            dispose: vi.fn(),
        };
    }),
}));

vi.mock("@babylonjs/core/Meshes/mesh.vertexData", () => ({
    VertexData: class {
        positions: unknown;
        indices: unknown;
        normals: unknown;
        uvs: unknown;
        applyToMesh = vi.fn();
        static ComputeNormals: Mock = vi.fn();
    },
}));

vi.mock("@babylonjs/core/Meshes/transformNode", () => ({
    TransformNode: vi.fn<(name: string) => unknown>().mockImplementation(function (name) {
        return {
            name,
            scaling: {
                x: 1,
                y: 1,
                z: 1,
                setAll(v: number): void {
                    this.x = v;
                    this.y = v;
                    this.z = v;
                },
            },
            dispose: vi.fn(),
        };
    }),
}));

vi.mock("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: vi.fn().mockImplementation(function () {
        return {
            diffuseTexture: null as unknown,
            diffuseColor: null as unknown,
            specularColor: null as unknown,
            backFaceCulling: true,
            dispose: vi.fn(),
        };
    }),
}));

vi.mock("@babylonjs/core/Maths/math.color", () => {
    class Color3Mock {
        r: number;
        g: number;
        b: number;
        constructor(r = 0, g = 0, b = 0) {
            this.r = r;
            this.g = g;
            this.b = b;
        }
        static Black(): Color3Mock {
            return new Color3Mock(0, 0, 0);
        }
    }
    return { Color3: Color3Mock };
});

vi.mock("../src/terrain/diorama/dioramaGrid", () => ({
    buildDioramaGridPoints: vi.fn(
        (
            center: { lat: number; lon: number },
            footprintRadiusM: number,
        ): { x: number; z: number; lat: number; lon: number; ring: number; segment: number }[] =>
            Array.from({ length: 5 }, (_, i) => ({
                x: i,
                z: i,
                lat: center.lat,
                lon: center.lon,
                ring: i === 0 ? 0 : 1,
                segment: 0,
                // テストの都合上 footprintRadiusM も参照する（未使用警告回避）。
                _footprintRadiusM: footprintRadiusM,
            })),
    ),
    buildDioramaGridIndices: vi.fn(() => new Uint32Array([0, 1, 2])),
}));

const callTimestamps: { fetchElevationsStart: number[]; buildTextureStart: number[] } = {
    fetchElevationsStart: [],
    buildTextureStart: [],
};

let elevationDelayMs = 0;
vi.mock("../src/terrain/diorama/dioramaElevation", () => ({
    fetchDioramaElevations: vi.fn(async (points: readonly unknown[]) => {
        callTimestamps.fetchElevationsStart.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, elevationDelayMs));
        return new Float32Array(points.length);
    }),
}));

let textureDelayMs = 0;

vi.mock("../src/terrain/diorama/dioramaTexture", () => ({
    computeDioramaTextureLayout: vi.fn(
        (points: readonly unknown[]): {
            zoom: number;
            mosaicWidthPx: number;
            mosaicHeightPx: number;
            tiles: unknown[];
            uvs: { u: number; v: number }[];
        } => ({
            zoom: 16,
            mosaicWidthPx: 256,
            mosaicHeightPx: 256,
            tiles: [],
            uvs: points.map(() => ({ u: 0, v: 0 })),
        }),
    ),
    buildDioramaMosaicTexture: vi.fn(async () => {
        callTimestamps.buildTextureStart.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, textureDelayMs));
        return { dispose: vi.fn() };
    }),
}));

vi.mock("../src/terrain/diorama/dioramaSkirt", () => ({
    buildDioramaSkirtGeometry: vi.fn(() => ({
        positions: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
        normals: new Float32Array(9),
    })),
}));

import { createDioramaTerrain } from "../src/terrain/diorama/dioramaTerrain";
import { fetchDioramaElevations } from "../src/terrain/diorama/dioramaElevation";
import { buildDioramaGridPoints } from "../src/terrain/diorama/dioramaGrid";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

const mockFetchElevations = vi.mocked(fetchDioramaElevations);
const mockBuildGridPoints = vi.mocked(buildDioramaGridPoints);
const mockMesh = vi.mocked(Mesh);
const mockTransformNode = vi.mocked(TransformNode);

const baseOptions = {
    center: { lat: 35, lon: 139 },
    footprintRadiusM: 800,
    tableRadiusM: 0.35,
};

// `Scene` はモック済みだが本実装は使わないため、コンストラクタ引数を要求しないダミーで足りる。
const dummyScene = {} as Parameters<typeof createDioramaTerrain>[0];

beforeEach(() => {
    elevationDelayMs = 0;
    textureDelayMs = 0;
    callTimestamps.fetchElevationsStart = [];
    callTimestamps.buildTextureStart = [];
    mockFetchElevations.mockClear();
    mockBuildGridPoints.mockClear();
    mockMesh.mockClear();
    mockTransformNode.mockClear();
});

describe("createDioramaTerrain の入力検証", () => {
    it("tableRadiusM <= 0 はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, tableRadiusM: 0 }),
        ).rejects.toThrow(RangeError);
    });

    it("footprintRadiusM <= 0 はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, footprintRadiusM: 0 }),
        ).rejects.toThrow(RangeError);
    });

    it("demZoom が非整数の場合はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, demZoom: 14.5 }),
        ).rejects.toThrow(RangeError);
    });

    it("demZoom が負数の場合はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, demZoom: -1 }),
        ).rejects.toThrow(RangeError);
    });

    it("textureZoom が非整数の場合はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, textureZoom: 16.5 }),
        ).rejects.toThrow(RangeError);
    });

    it("heightScaleFactor が0以下の場合はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, heightScaleFactor: 0 }),
        ).rejects.toThrow(RangeError);
    });

    it("baseDepthRatio が負数の場合はRangeErrorでreject", async () => {
        await expect(
            createDioramaTerrain(dummyScene, { ...baseOptions, baseDepthRatio: -0.1 }),
        ).rejects.toThrow(RangeError);
    });

    it("正常な値では正常に構築できる", async () => {
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);
        expect(terrain.mesh).toBeDefined();
        terrain.dispose();
    });

    it("初回構築でbuildMeshが失敗した場合、rootは生成されない（シーンへのリークを防ぐ）", async () => {
        mockFetchElevations.mockRejectedValueOnce(new Error("boom"));
        await expect(createDioramaTerrain(dummyScene, baseOptions)).rejects.toThrow("boom");
        expect(mockTransformNode).not.toHaveBeenCalled();
    });

    it("DEM取得とテクスチャ取得が並列に開始される（直列にならない）", async () => {
        elevationDelayMs = 30;
        textureDelayMs = 30;
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);
        expect(callTimestamps.fetchElevationsStart.length).toBe(1);
        expect(callTimestamps.buildTextureStart.length).toBe(1);
        // 直列であれば片方の開始がもう片方の遅延(30ms)ぶん遅れるはずだが、
        // 並列であれば両者はほぼ同時（数ms以内）に開始される。
        const gap = Math.abs(
            callTimestamps.fetchElevationsStart[0] - callTimestamps.buildTextureStart[0],
        );
        expect(gap).toBeLessThan(20);
        terrain.dispose();
    });
});

describe("setFootprintRadius の入力検証", () => {
    it("radiusM <= 0 は同期例外ではなくRangeErrorでreject", async () => {
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);
        // 同期的に throw されると Promise を返す関数として呼び出し側が catch し損ねるため、
        // 「呼び出し自体が例外を投げない」ことも合わせて確認する。
        let synchronousThrow = false;
        let result: Promise<void>;
        try {
            result = terrain.setFootprintRadius(0);
        } catch {
            synchronousThrow = true;
            result = Promise.resolve();
        }
        expect(synchronousThrow).toBe(false);
        await expect(result).rejects.toThrow(RangeError);
        terrain.dispose();
    });
});

describe("並行呼び出しのrebuildキュー直列化", () => {
    it("setCenter → setFootprintRadius を並行に呼んでも、後続rebuildは直前の変更を引き継ぐ", async () => {
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);
        mockBuildGridPoints.mockClear(); // 初回構築分の呼び出しを除外する

        // setCenter 側のタイル取得を遅延させ、setFootprintRadius が「後から呼ばれたのに
        // 先に完了しようとする」状況を作る。キューによる直列化が無ければ、
        // setFootprintRadius 側の rebuild が setCenter の変更前の古い状態を基準に
        // 構築されてしまう。
        elevationDelayMs = 30;
        const p1 = terrain.setCenter(36, 140);
        elevationDelayMs = 0;
        const p2 = terrain.setFootprintRadius(500);

        await Promise.all([p1, p2]);

        expect(mockBuildGridPoints).toHaveBeenCalledTimes(2);
        const [firstCallArgs, secondCallArgs] = mockBuildGridPoints.mock.calls;
        // 1回目（setCenter分）は新しい中心・元のフットプリント半径で呼ばれる。
        expect(firstCallArgs[0]).toEqual({ lat: 36, lon: 140 });
        expect(firstCallArgs[1]).toBe(baseOptions.footprintRadiusM);
        // 2回目（setFootprintRadius分）は、1回目で適用済みの新しい中心を引き継いだ
        // 状態を基準に呼ばれる（呼び出し時点の古い中心ではない）。
        expect(secondCallArgs[0]).toEqual({ lat: 36, lon: 140 });
        expect(secondCallArgs[1]).toBe(500);

        terrain.dispose();
    });

    it("あるrebuildが失敗しても、キューは止まらず後続のrebuildは実行される", async () => {
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);

        mockFetchElevations.mockRejectedValueOnce(new Error("network error"));
        const p1 = terrain.setCenter(36, 140);
        const p2 = terrain.setMapType("photo");

        await expect(p1).rejects.toThrow("network error");
        await expect(p2).resolves.toBeUndefined();

        terrain.dispose();
    });
});

describe("dispose後のrebuildガード", () => {
    it("dispose後にキュー待ちだったrebuildは何もせず、新規メッシュも生成しない", async () => {
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);
        mockBuildGridPoints.mockClear();

        terrain.dispose();
        // dispose後に呼ばれたsetCenterは例外を投げず、静かに何もしない。
        await expect(terrain.setCenter(36, 140)).resolves.toBeUndefined();
        expect(mockBuildGridPoints).not.toHaveBeenCalled();
    });

    it("buildMesh実行中にdisposeされた場合、新規生成物はそのまま破棄され、破棄済みrootへparentされない", async () => {
        const terrain = await createDioramaTerrain(dummyScene, baseOptions);
        mockMesh.mockClear();

        // fetchDioramaElevations（buildMesh内部）を意図的に遅延させ、rebuildが
        // 「実行中（buildMesh awaitの最中）」の状態を作る。
        elevationDelayMs = 30;
        const p1 = terrain.setCenter(36, 140);
        // run() が buildMesh の await まで進むのを待つ（rebuildが実行中の状態にする）。
        await new Promise((resolve) => setTimeout(resolve, 5));

        terrain.dispose();

        // p1 は例外を投げずに解決する（生成物を静かに破棄するだけ）。
        await expect(p1).resolves.toBeUndefined();

        // このrebuildで新規生成された Mesh（地形メッシュ + 側面壁メッシュの2つ）は
        // 破棄済みの root へ parent 設定されず、即座に dispose される。
        const createdInThisRebuild = mockMesh.mock.results.map((r) => r.value as {
            parent: unknown;
            dispose: ReturnType<typeof vi.fn>;
        });
        expect(createdInThisRebuild.length).toBeGreaterThan(0);
        for (const created of createdInThisRebuild) {
            expect(created.parent).toBeNull();
            expect(created.dispose).toHaveBeenCalled();
        }
    });
});
