/**
 * tileManager のユニットテスト。
 * Babylon.js 依存をモックし、TileManager のロジックを検証する。
 */

import { jest, describe, it, expect } from "@jest/globals";

const mockMeshInstance = () => ({
    material: {
        specularColor: null,
        diffuseTexture: null,
        dispose: jest.fn(),
    },
    setEnabled: jest.fn(),
    dispose: jest.fn(),
    scaling: { x: 1, y: 1, z: 1 },
    position: { x: 0, y: 0, z: 0 },
    getVerticesData: jest.fn(() => new Float32Array(3 * 129 * 129)),
    getIndices: jest.fn(() => new Uint32Array(6 * 128 * 128)),
    updateVerticesData: jest.fn(),
    refreshBoundingInfo: jest.fn(),
});

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/groundBuilder", () => ({
    CreateGround: jest.fn(() => mockMeshInstance()),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: jest.fn<(...args: unknown[]) => unknown>().mockImplementation(() => ({
        specularColor: null,
        diffuseTexture: null,
        dispose: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/Textures/texture", () => {
    const TextureMock = jest.fn<(...args: unknown[]) => unknown>().mockImplementation(
        () => ({
            dispose: jest.fn(),
            uScale: 1,
            vScale: 1,
            uOffset: 0,
            vOffset: 0,
        })
    ) as jest.Mock & { TRILINEAR_SAMPLINGMODE: number };
    TextureMock.TRILINEAR_SAMPLINGMODE = 3;
    return { Texture: TextureMock };
});

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color3: {
        Black: jest.fn(() => ({ r: 0, g: 0, b: 0 })),
    },
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/mesh.vertexData", () => ({
    VertexData: {
        ComputeNormals: jest.fn(),
    },
}));

jest.unstable_mockModule("@babylonjs/core/Buffers/buffer", () => ({
    VertexBuffer: {
        PositionKind: "position",
        NormalKind: "normal",
    },
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.frustum", () => ({
    Frustum: {
        GetPlanesToRef: jest.fn((_transform: unknown, planes: Array<{ normal: { x: number; y: number; z: number }; d: number }>) => {
            // 事前に Plane インスタンスが入っている前提で上書き
            for (let i = 0; i < 6; i++) {
                planes[i].normal.x = 0;
                planes[i].normal.y = 0;
                planes[i].normal.z = 0;
                planes[i].d = 1e9;
            }
        }),
    },
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.vector", () => ({
    Matrix: {
        Identity: jest.fn(() => ({
            m: new Float32Array(16),
        })),
    },
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.plane", () => ({
    Plane: jest.fn<(...args: unknown[]) => unknown>().mockImplementation(() => ({
        normal: { x: 0, y: 0, z: 0 },
        d: 0,
    })),
}));

jest.unstable_mockModule("../src/terrain/gsiTile", () => ({
    TILE_SIZE: 256,
    clamp: jest.fn((v: number, min: number, max: number) =>
        Math.min(Math.max(v, min), max)
    ),
    toTileXY: jest.fn(() => ({ x: 14547, y: 6452 })),
    tileEdgeMeters: jest.fn(() => 1000),
    loadElevationTile: jest.fn(
        () => Promise.resolve(new Float32Array(256 * 256))
    ),
    isAllNaN: jest.fn((data: Float32Array) => {
        for (let i = 0; i < data.length; i++) {
            if (!Number.isNaN(data[i])) return false;
        }
        return true;
    }),
    stdTextureUrl: jest.fn(() => "https://example.com/tile.png"),
    photoTextureUrl: jest.fn(() => "https://example.com/photo.jpg"),
    textureUrl: jest.fn(() => "https://example.com/tile.png"),
}));

const { createTileManager, extractSubTileElevation, computeTextureUvParams } = await import("../src/terrain/tileManager");
const gsiTileMock = await import("../src/terrain/gsiTile");

const createMockCamera = () => {
    const observers: Array<() => void> = [];
    return {
        alpha: 0,
        beta: 0,
        radius: 4000,
        position: { x: 0, y: 4000, z: 0 },
        getScene: jest.fn(() => ({
            getEngine: jest.fn(() => ({})),
        })),
        getViewMatrix: jest.fn(() => ({
            multiplyToRef: jest.fn(),
        })),
        getProjectionMatrix: jest.fn(() => ({})),
        onViewMatrixChangedObservable: {
            add: jest.fn((cb: () => void) => {
                observers.push(cb);
                return cb;
            }),
            remove: jest.fn(),
        },
        _observers: observers,
    } as never;
};

describe("createTileManager", () => {
    it("setCenter でタイルがロードされる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
        });

        await tm.setCenter(35.68, 139.77);
        expect(tm.activeTileCount).toBeGreaterThan(0);
    });

    it("onStatusChange コールバックが呼ばれる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 3,
        });

        const statuses: string[] = [];
        tm.onStatusChange = (s) => statuses.push(s);

        await tm.setCenter(35.68, 139.77);
        expect(statuses.length).toBeGreaterThan(0);
    });

    it("dispose 後に activeTileCount が 0 になる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
        });

        await tm.setCenter(35.68, 139.77);
        expect(tm.activeTileCount).toBeGreaterThan(0);

        tm.dispose();
        expect(tm.activeTileCount).toBe(0);
    });

    it("attachCamera/detachCamera が正常に動作する", () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
        });

        // attachCamera でオブザーバが追加される
        tm.attachCamera();
        expect(
            (camera as any).onViewMatrixChangedObservable.add
        ).toHaveBeenCalled();

        // detachCamera でオブザーバが削除される
        tm.detachCamera();
        expect(
            (camera as any).onViewMatrixChangedObservable.remove
        ).toHaveBeenCalled();
    });
});

/* ================================================================
 * extractSubTileElevation 単体テスト
 * ================================================================ */
describe("extractSubTileElevation", () => {
    /**
     * tileSize=4 の親タイル（4×4）を使い、zoom+1 の子タイル切り出しを検証。
     * 親データ配置:
     *   [ 0,  1,| 2,  3 ]   ← row0
     *   [ 4,  5,| 6,  7 ]   ← row1
     *   --------------------
     *   [ 8,  9,|10, 11 ]   ← row2
     *   [12, 13,|14, 15 ]   ← row3
     * 左上(0,0)={0,1,4,5}  右上(1,0)={2,3,6,7}
     * 左下(0,1)={8,9,12,13} 右下(1,1)={10,11,14,15}
     */
    const tileSize = 4;
    const parent = new Float32Array([
        0, 1, 2, 3,
        4, 5, 6, 7,
        8, 9, 10, 11,
        12, 13, 14, 15,
    ]);
    const parentZoom = 14;

    it("zoom+1 子タイル(0,0)は親の左上領域のみ参照する", () => {
        // parentX = 100 → child (200, 200) → subX=0, subY=0
        const child = { zoom: 15, x: 200, y: 200 };
        const result = extractSubTileElevation(parent, child, parentZoom, tileSize);

        expect(result.length).toBe(tileSize * tileSize);
        const values = new Set(result);
        // 左上 2×2 の値 {0,1,4,5} のみ含むこと
        for (const v of values) {
            expect([0, 1, 4, 5]).toContain(v);
        }
        // 右半分・下半分の値を含まないこと
        expect(values.has(2)).toBe(false);
        expect(values.has(3)).toBe(false);
        expect(values.has(6)).toBe(false);
        expect(values.has(7)).toBe(false);
        expect(values.has(10)).toBe(false);
        expect(values.has(14)).toBe(false);
    });

    it("zoom+1 子タイル(1,1)は親の右下領域のみ参照する", () => {
        // parentX=100, parentY=100 → child (201,201) → subX=1, subY=1
        const child = { zoom: 15, x: 201, y: 201 };
        const result = extractSubTileElevation(parent, child, parentZoom, tileSize);

        expect(result.length).toBe(tileSize * tileSize);
        const values = new Set(result);
        // 右下 2×2 の値 {10,11,14,15} のみ含むこと
        for (const v of values) {
            expect([10, 11, 14, 15]).toContain(v);
        }
        // 左半分・上半分の値を含まないこと
        expect(values.has(0)).toBe(false);
        expect(values.has(1)).toBe(false);
        expect(values.has(4)).toBe(false);
        expect(values.has(5)).toBe(false);
        expect(values.has(8)).toBe(false);
        expect(values.has(9)).toBe(false);
    });

    it("zoom+1 子タイル(1,0)の境界ピクセルが左半分を参照しない", () => {
        // parentX=100 → child (201, 200) → subX=1, subY=0
        const child = { zoom: 15, x: 201, y: 200 };
        const result = extractSubTileElevation(parent, child, parentZoom, tileSize);

        const values = new Set(result);
        // 右上 2×2 の値 {2,3,6,7} のみ含むこと
        for (const v of values) {
            expect([2, 3, 6, 7]).toContain(v);
        }
        // 左半分の値を含まないこと（境界ブリード無し）
        expect(values.has(0)).toBe(false);
        expect(values.has(1)).toBe(false);
        expect(values.has(4)).toBe(false);
        expect(values.has(5)).toBe(false);
    });

    it("zoom差2（4分の1タイル）でも正しく切り出す", () => {
        // tileSize=4, diff=2, scale=4, subSize=1
        // child (401, 401) → subX=1, subY=1 (parentX=100, shift=2: 401 - (401>>2)<<2 = 401-400=1)
        const child = { zoom: 16, x: 401, y: 401 };
        const result = extractSubTileElevation(parent, child, parentZoom, tileSize);

        expect(result.length).toBe(tileSize * tileSize);
        // subSize=1, originX=1, originY=1 → 全ピクセルが parent[1*4+1]=5 を参照
        const values = new Set(result);
        expect(values.size).toBe(1);
        expect(values.has(5)).toBe(true);
    });

    it("zoom差2で右下端の子タイルが正しい値のみ参照する", () => {
        // child (403, 403) → subX=3, subY=3 (parentX=100<<2=400, 403-400=3)
        const child = { zoom: 16, x: 403, y: 403 };
        const result = extractSubTileElevation(parent, child, parentZoom, tileSize);

        // subSize=1, originX=3, originY=3 → 全ピクセルが parent[3*4+3]=15 を参照
        const values = new Set(result);
        expect(values.size).toBe(1);
        expect(values.has(15)).toBe(true);
    });

    it("TILE_SIZE=256 相当でも境界に隣接領域の値が混入しない", () => {
        const size = 256;
        const big = new Float32Array(size * size);
        // 左半分=100, 右半分=200
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                big[y * size + x] = x < size / 2 ? 100 : 200;
            }
        }

        // 右上子タイル (subX=1, subY=0)
        const child = { zoom: 15, x: 201, y: 200 };
        const result = extractSubTileElevation(big, child, 14, size);

        // 右半分（200）のみ参照すること
        for (let i = 0; i < result.length; i++) {
            expect(result[i]).toBe(200);
        }
    });
});

/* ================================================================
 * LOD連携テスト（computeBaseZoom / computeMultiLodTiles 経由）
 * ================================================================ */
describe("LOD連携", () => {
    beforeEach(() => {
        (gsiTileMock.textureUrl as jest.Mock).mockClear();
        (gsiTileMock.loadElevationTile as jest.Mock).mockClear();
    });

    afterEach(() => {
        // モック実装を元に戻す
        (gsiTileMock.tileEdgeMeters as jest.Mock).mockImplementation(
            () => 1000
        );
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(new Float32Array(256 * 256))
        );
    });

    it("camera.radiusが同じならtargetオフセットしてもLODは変化しない", async () => {
        const camera1 = createMockCamera();
        (camera1 as any).radius = 200;
        (camera1 as any).position = { x: 0, y: 200, z: 0 };

        const tm1 = createTileManager({
            scene: {} as never,
            camera: camera1,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 60,
            minZoom: 12,
        });
        await tm1.setCenter(35.68, 139.77);
        const count1 = tm1.activeTileCount;
        tm1.dispose();

        // 同じ radius で異なるカメラ位置
        const camera2 = createMockCamera();
        (camera2 as any).radius = 200;
        (camera2 as any).position = { x: 5000, y: 200, z: 5000 };

        const tm2 = createTileManager({
            scene: {} as never,
            camera: camera2,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 60,
            minZoom: 12,
        });
        await tm2.setCenter(35.68, 139.77);
        const count2 = tm2.activeTileCount;
        tm2.dispose();

        // camera.radius が同じなら position に依存せず同じタイル数
        expect(count1).toBe(count2);
    });

    it("camera.radiusが変わるとロードされるタイルのzoomレベルが変化する", async () => {
        // zoom依存の tileEdgeMeters: z14=1000, z13=2000, z12=4000
        (gsiTileMock.tileEdgeMeters as jest.Mock<(lat: number, zoom: number) => number>).mockImplementation(
            (_lat, zoom) => 1000 * Math.pow(2, 14 - zoom)
        );

        // 近距離: radius=2400 → baseZoom=14, 中心付近にzoom14タイルが残る
        // (threshold=3120で近傍セルが zoom14 に収まり、zoom12親との共有が起きない)
        const cameraNear = createMockCamera();
        (cameraNear as any).radius = 2400;

        const tmNear = createTileManager({
            scene: {} as never,
            camera: cameraNear,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 200,
            minZoom: 12,
        });
        await tmNear.setCenter(35.68, 139.77);

        const zoomsNear = (gsiTileMock.textureUrl as jest.Mock).mock.calls
            .map((c) => (c as number[])[1]);
        tmNear.dispose();

        (gsiTileMock.textureUrl as jest.Mock).mockClear();

        // 遠距離: radius=6000 → baseZoom=12, 全タイルzoom12
        const cameraFar = createMockCamera();
        (cameraFar as any).radius = 6000;

        const tmFar = createTileManager({
            scene: {} as never,
            camera: cameraFar,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 60,
            minZoom: 12,
        });
        await tmFar.setCenter(35.68, 139.77);

        const zoomsFar = (gsiTileMock.textureUrl as jest.Mock).mock.calls
            .map((c) => (c as number[])[1]);
        tmFar.dispose();

        // 近距離ではzoom14が含まれる
        expect(zoomsNear).toContain(14);
        // 遠距離ではzoom12のみ
        expect(zoomsFar.every((z: number) => z <= 12)).toBe(true);
    });
});

/* ================================================================
 * 標高ズーム段階フォールバック
 * ================================================================ */
describe("標高ズーム段階フォールバック", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(new Float32Array(256 * 256))
        );
        (gsiTileMock.tileEdgeMeters as jest.Mock).mockImplementation(
            () => 1000
        );
    });

    it("最高zoomで失敗すると低いzoomにフォールバックする", async () => {
        // zoom 14 は失敗、zoom 13以下は成功
        const elevData13 = new Float32Array(256 * 256).fill(500);
        (gsiTileMock.loadElevationTile as jest.Mock<(zoom: number, x: number, y: number) => Promise<Float32Array>>).mockImplementation(
            (zoom) => {
                if (zoom >= 14) return Promise.reject(new Error("not available"));
                return Promise.resolve(elevData13);
            }
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
            maxElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // フォールバックしてもタイルはロードされる
        expect(tm.activeTileCount).toBeGreaterThan(0);
        // zoom 13以下で loadElevationTile が呼ばれたことを確認
        const calls = (gsiTileMock.loadElevationTile as jest.Mock).mock.calls;
        const successZooms = calls.filter(
            (c) => (c as number[])[0] < 14
        );
        expect(successZooms.length).toBeGreaterThan(0);
    });

    it("全zoomで失敗するとフラット標高（0m）でタイルが表示される", async () => {
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.reject(new Error("all fail"))
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);
        // フラット標高でもタイルは生成される
        expect(tm.activeTileCount).toBeGreaterThan(0);
    });

    it("maxElevationZoomを超えるzoomでは標高フェッチを試みない", async () => {
        const fetchedZooms: number[] = [];
        (gsiTileMock.loadElevationTile as jest.Mock<(zoom: number, x: number, y: number) => Promise<Float32Array>>).mockImplementation(
            (zoom) => {
                fetchedZooms.push(zoom);
                return Promise.resolve(new Float32Array(256 * 256));
            }
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 3,
            maxElevationZoom: 12,
            minZoom: 10,
        });

        await tm.setCenter(35.68, 139.77);
        // zoom 13, 14 でのフェッチは発生しない
        expect(fetchedZooms.every((z) => z <= 12)).toBe(true);
    });

    it("minElevationZoomを下回るzoomでは標高フェッチを試みない", async () => {
        const fetchedZooms: number[] = [];
        (gsiTileMock.loadElevationTile as jest.Mock<(zoom: number, x: number, y: number) => Promise<Float32Array>>).mockImplementation(
            (zoom) => {
                fetchedZooms.push(zoom);
                // 全zoomで失敗させてフォールバックを最大まで試行させる
                return Promise.reject(new Error("not available"));
            }
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 3,
            maxElevationZoom: 14,
            minZoom: 2,
            minElevationZoom: 10,
        });

        await tm.setCenter(35.68, 139.77);
        // zoom 9以下でのフェッチは発生しない（minElevationZoom=10が下限）
        expect(fetchedZooms.every((z) => z >= 10)).toBe(true);
        // フォールバック幅は 14→10 の5段以内
        const uniqueZooms = new Set(fetchedZooms);
        expect(uniqueZooms.size).toBeLessThanOrEqual(5);
        tm.dispose();
    });

    it("minElevationZoom省略時はデフォルト値 max(minZoom, maxElevationZoom-4) が適用される", async () => {
        const fetchedZooms: number[] = [];
        (gsiTileMock.loadElevationTile as jest.Mock<(zoom: number, x: number, y: number) => Promise<Float32Array>>).mockImplementation(
            (zoom) => {
                fetchedZooms.push(zoom);
                return Promise.reject(new Error("not available"));
            }
        );

        const camera = createMockCamera();
        // maxElevationZoom=14, minZoom=2 → デフォルト minElevationZoom = max(2, 14-4) = 10
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 3,
            maxElevationZoom: 14,
            minZoom: 2,
        });

        await tm.setCenter(35.68, 139.77);
        // zoom 9以下でのフェッチは発生しない
        expect(fetchedZooms.every((z) => z >= 10)).toBe(true);
        tm.dispose();
    });
});

/* ================================================================
 * setMapType テスト
 * ================================================================ */
describe("setMapType", () => {
    beforeEach(() => {
        (gsiTileMock.textureUrl as jest.Mock).mockClear();
    });

    it("setMapType で地図タイプを切り替えると textureUrl が新しいタイプで呼ばれる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);

        // 初期状態では std で呼ばれている
        const initialCalls = (gsiTileMock.textureUrl as jest.Mock).mock.calls;
        expect(initialCalls.length).toBeGreaterThan(0);
        expect(initialCalls[0][0]).toBe("std");

        (gsiTileMock.textureUrl as jest.Mock).mockClear();

        // photo に切り替え
        tm.setMapType("photo");

        // retextureAll が呼ばれ、photo タイプで textureUrl が呼ばれる
        const photoCalls = (gsiTileMock.textureUrl as jest.Mock).mock.calls;
        expect(photoCalls.length).toBeGreaterThan(0);
        expect(photoCalls.every((c: unknown[]) => c[0] === "photo")).toBe(true);

        tm.dispose();
    });

    it("同じ地図タイプを設定しても textureUrl は呼ばれない", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);
        (gsiTileMock.textureUrl as jest.Mock).mockClear();

        // 同じタイプを再設定
        tm.setMapType("std");

        expect((gsiTileMock.textureUrl as jest.Mock).mock.calls.length).toBe(0);

        tm.dispose();
    });
});

/* ================================================================
 * computeTextureUvParams 単体テスト
 * ================================================================ */
describe("computeTextureUvParams", () => {
    it("zoom差がない場合はデフォルト値を返す", () => {
        const uv = computeTextureUvParams(14, 100, 200, 14);
        expect(uv).toEqual({ uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 });
    });

    it("textureZoomがtileZoomより大きい場合はデフォルト値を返す", () => {
        const uv = computeTextureUvParams(12, 50, 100, 14);
        expect(uv).toEqual({ uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 });
    });

    it("zoom差1で左上子タイル(0,0)のUV値が正しい", () => {
        // tile zoom=15, x=200(even), y=200(even) → subX=0, subY=0
        const uv = computeTextureUvParams(15, 200, 200, 14);
        expect(uv.uScale).toBeCloseTo(0.5);
        expect(uv.vScale).toBeCloseTo(0.5);
        expect(uv.uOffset).toBeCloseTo(0);
        expect(uv.vOffset).toBeCloseTo(0);
    });

    it("zoom差1で右下子タイル(1,1)のUV値が正しい", () => {
        // tile zoom=15, x=201(odd), y=201(odd) → subX=1, subY=1
        const uv = computeTextureUvParams(15, 201, 201, 14);
        expect(uv.uScale).toBeCloseTo(0.5);
        expect(uv.vScale).toBeCloseTo(0.5);
        expect(uv.uOffset).toBeCloseTo(0.5);
        expect(uv.vOffset).toBeCloseTo(0.5);
    });

    it("zoom差2で4分の1領域のUV値が正しい", () => {
        // tile zoom=16, x=401, y=402 → subX=1, subY=2
        // scale=4, uScale=vScale=0.25
        const uv = computeTextureUvParams(16, 401, 402, 14);
        expect(uv.uScale).toBeCloseTo(0.25);
        expect(uv.vScale).toBeCloseTo(0.25);
        expect(uv.uOffset).toBeCloseTo(0.25);  // 1/4
        expect(uv.vOffset).toBeCloseTo(0.5);   // 2/4
    });
});

/* ================================================================
 * 標高データ全NaN時のフォールバック
 * ================================================================ */
describe("標高データ全NaNフォールバック", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(new Float32Array(256 * 256))
        );
        (gsiTileMock.tileEdgeMeters as jest.Mock).mockImplementation(
            () => 1000
        );
    });

    it("全NaN標高データを返すzoomから低zoomにフォールバックする", async () => {
        // zoom 14: 全NaN（throwされる想定）, zoom 13以下: 有効データ
        const validElev = new Float32Array(256 * 256).fill(300);
        (gsiTileMock.loadElevationTile as jest.Mock<(zoom: number, x: number, y: number) => Promise<Float32Array>>).mockImplementation(
            (zoom) => {
                if (zoom >= 14) {
                    return Promise.reject(new Error("All NaN tile"));
                }
                return Promise.resolve(validElev);
            }
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
            maxElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        expect(tm.activeTileCount).toBeGreaterThan(0);

        // zoom 13以下で成功していることを確認
        const calls = (gsiTileMock.loadElevationTile as jest.Mock).mock.calls;
        const lowZoomCalls = calls.filter((c) => (c as number[])[0] < 14);
        expect(lowZoomCalls.length).toBeGreaterThan(0);

        tm.dispose();
    });
});

/* ================================================================
 * queryElevationAtWorld 単体テスト
 * ================================================================ */
describe("queryElevationAtWorld", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(new Float32Array(256 * 256))
        );
        (gsiTileMock.tileEdgeMeters as jest.Mock).mockImplementation(
            () => 1000
        );
    });

    /**
     * camera.radius が小さいとき computeBaseZoom が maxZoom(=14) を返し、
     * タイルが zoom 14 でロードされる。
     * minZoom=14 にすることで LOD による低zoom混在を防止。
     */
    const createNearCamera = () => {
        const cam = createMockCamera();
        (cam as any).radius = 500;
        (cam as any).position = { x: 0, y: 500, z: 0 };
        return cam;
    };

    it("setCenter前はnullを返す", () => {
        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            minZoom: 14,
        });

        expect(tm.queryElevationAtWorld(0, 0)).toBeNull();
        tm.dispose();
    });

    it("中心座標でキャッシュ済み標高値を返す", async () => {
        const elevData = new Float32Array(256 * 256);
        elevData[0] = 100; // pixel (0,0) = 100m
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(elevData)
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // ワールド原点 (0,0) は中心タイルのピクセル (0,0) に対応
        const result = tm.queryElevationAtWorld(0, 0);
        expect(result).toBe(100);
        tm.dispose();
    });

    it("heightScaleが標高値に反映される", async () => {
        const elevData = new Float32Array(256 * 256);
        elevData[0] = 100;
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(elevData)
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 2.0,
            maxTiles: 5,
            minZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // (100 + 0) * 2.0 = 200
        expect(tm.queryElevationAtWorld(0, 0)).toBe(200);
        tm.dispose();
    });

    it("altitudeOffsetが標高値に反映される", async () => {
        const elevData = new Float32Array(256 * 256);
        elevData[0] = 100;
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(elevData)
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
        });

        await tm.setCenter(35.68, 139.77, 50); // altitudeOffset = 50
        // (100 + 50) * 1.0 = 150
        expect(tm.queryElevationAtWorld(0, 0)).toBe(150);
        tm.dispose();
    });

    it("heightScaleとaltitudeOffsetが同時に反映される", async () => {
        const elevData = new Float32Array(256 * 256);
        elevData[0] = 100;
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(elevData)
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 2.0,
            maxTiles: 5,
            minZoom: 14,
        });

        await tm.setCenter(35.68, 139.77, 50);
        // (100 + 50) * 2.0 = 300
        expect(tm.queryElevationAtWorld(0, 0)).toBe(300);
        tm.dispose();
    });

    it("全zoomレベルでキャッシュ未ヒットの座標はnullを返す", async () => {
        (gsiTileMock.loadElevationTile as jest.Mock).mockImplementation(
            () => Promise.resolve(new Float32Array(256 * 256))
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 1,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 14, // フォールバック無し
        });

        await tm.setCenter(35.68, 139.77);
        // 中心から十分離れた座標（50タイル分）はキャッシュに存在しない
        const result = tm.queryElevationAtWorld(50000, 50000);
        expect(result).toBeNull();
        tm.dispose();
    });

    it("zoomフォールバック: 高zoom未ヒットでも低zoomキャッシュから値を返す", async () => {
        // zoom依存の tileEdgeMeters: z14=1000, z13=2000
        (gsiTileMock.tileEdgeMeters as jest.Mock<(lat: number, zoom: number) => number>).mockImplementation(
            (_lat, zoom) => 1000 * Math.pow(2, 14 - zoom)
        );

        const elevData13 = new Float32Array(256 * 256);
        // zoom13タイルのピクセル(64,64)に既知の値を設定
        // wx=0, wz=-1000 → zoom13で fracTile=(0.25,0.25) → px=64, py=64
        elevData13[64 * 256 + 64] = 777;

        (gsiTileMock.loadElevationTile as jest.Mock<(zoom: number, x: number, y: number) => Promise<Float32Array>>).mockImplementation(
            (zoom) => {
                if (zoom >= 14) return Promise.reject(new Error("not available"));
                return Promise.resolve(elevData13);
            }
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: {} as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 1,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 13,
        });

        await tm.setCenter(35.68, 139.77);
        // wx=0, wz=-1000 → zoom14キー"14/14547/6453"は未キャッシュ
        // → zoom13キー"13/7273/3226"にフォールバックしてヒット
        const result = tm.queryElevationAtWorld(0, -1000);
        expect(result).toBe(777);
        tm.dispose();
    });
});
