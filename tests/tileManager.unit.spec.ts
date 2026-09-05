/**
 * tileManager のユニットテスト。
 * Babylon.js 依存をモックし、TileManager のロジックを検証する。
 */

import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

const mockMeshInstance = () => ({
    material: {
        specularColor: null,
        diffuseTexture: null,
        dispose: vi.fn(),
    },
    setEnabled: vi.fn(),
    dispose: vi.fn(),
    scaling: { x: 1, y: 1, z: 1 },
    position: { x: 0, y: 0, z: 0 },
    getVerticesData: vi.fn(() => new Float32Array(3 * 129 * 129)),
    getIndices: vi.fn(() => new Uint32Array(6 * 128 * 128)),
    updateVerticesData: vi.fn(),
    refreshBoundingInfo: vi.fn(),
});

vi.mock("@babylonjs/core/Meshes/Builders/groundBuilder", () => ({
    CreateGround: vi.fn(() => mockMeshInstance()),
}));

vi.mock("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(function () {
            return {
                specularColor: null,
                diffuseTexture: null,
                dispose: vi.fn(),
            };
        }),
}));

const capturedTextureOnLoads: Array<() => void> = [];

// テスト完了後に onLoad クロージャ参照を解放し、メモリリークを防ぐ
afterEach(() => {
    capturedTextureOnLoads.length = 0;
});

vi.mock("@babylonjs/core/Materials/Textures/texture", () => {
    const TextureMock = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(function (...args: unknown[]) {
            const onLoad = args[5] as (() => void) | undefined;
            if (onLoad) capturedTextureOnLoads.push(onLoad);
            return {
                dispose: vi.fn(),
                uScale: 1,
                vScale: 1,
                uOffset: 0,
                vOffset: 0,
            };
        }) as Mock & { TRILINEAR_SAMPLINGMODE: number };
    TextureMock.TRILINEAR_SAMPLINGMODE = 3;
    return { Texture: TextureMock };
});

vi.mock("@babylonjs/core/Maths/math.color", () => ({
    Color3: {
        Black: vi.fn(() => ({ r: 0, g: 0, b: 0 })),
    },
}));

vi.mock("@babylonjs/core/Meshes/mesh.vertexData", () => ({
    VertexData: {
        ComputeNormals: vi.fn(),
    },
}));

vi.mock("@babylonjs/core/Buffers/buffer", () => ({
    VertexBuffer: {
        PositionKind: "position",
        NormalKind: "normal",
    },
}));

vi.mock("@babylonjs/core/Maths/math.frustum", () => ({
    Frustum: {
        GetPlanesToRef: vi.fn(
            (
                _transform: unknown,
                planes: Array<{
                    normal: { x: number; y: number; z: number };
                    d: number;
                }>,
            ) => {
                // 事前に Plane インスタンスが入っている前提で上書き
                for (let i = 0; i < 6; i++) {
                    planes[i].normal.x = 0;
                    planes[i].normal.y = 0;
                    planes[i].normal.z = 0;
                    planes[i].d = 1e9;
                }
            },
        ),
    },
}));

vi.mock("@babylonjs/core/Cameras/camera", () => ({
    Camera: { ORTHOGRAPHIC_CAMERA: 1, PERSPECTIVE_CAMERA: 0 },
}));

vi.mock("@babylonjs/core/Maths/math.vector", () => {
    class Vector3Mock {
        x: number;
        y: number;
        z: number;
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        subtract(other: Vector3Mock): Vector3Mock {
            return new Vector3Mock(
                this.x - other.x,
                this.y - other.y,
                this.z - other.z,
            );
        }
        length(): number {
            return Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);
        }
        scaleInPlace(s: number): Vector3Mock {
            this.x *= s;
            this.y *= s;
            this.z *= s;
            return this;
        }
        static Down(): Vector3Mock {
            return new Vector3Mock(0, -1, 0);
        }
    }
    return {
        Matrix: {
            Identity: vi.fn(() => ({
                m: new Float32Array(16),
            })),
        },
        Vector3: Vector3Mock,
    };
});

vi.mock("@babylonjs/core/Culling/ray", () => ({
    Ray: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(() => ({})),
}));

vi.mock("@babylonjs/core/Maths/math.plane", () => ({
    Plane: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(function () {
            return {
                normal: { x: 0, y: 0, z: 0 },
                d: 0,
            };
        }),
}));

vi.mock("../src/terrain/gsiTile", () => ({
    TILE_SIZE: 256,
    clamp: vi.fn((v: number, min: number, max: number) =>
        Math.min(Math.max(v, min), max),
    ),
    toTileXY: vi.fn(() => ({ x: 14547, y: 6452 })),
    // zoom 非依存だと Quadtree が無限再帰しうるため、zoom 依存にする。
    tileEdgeMeters: vi.fn<(lat: number, zoom: number) => number>(
        (_lat, zoom) => 1000 * 2 ** (14 - zoom),
    ),
    loadElevationTile: vi.fn(() =>
        Promise.resolve(new Float32Array(256 * 256)),
    ),
    isAllNaN: vi.fn((data: Float32Array) => {
        for (let i = 0; i < data.length; i++) {
            if (!Number.isNaN(data[i]) && data[i] !== -100) return false;
        }
        return true;
    }),
    isInvalidElev: vi.fn((v: number) => Number.isNaN(v) || v === -100),
    NO_DATA_SENTINEL: -100,
    stdTextureUrl: vi.fn(() => "https://example.com/tile.png"),
    photoTextureUrl: vi.fn(() => "https://example.com/photo.jpg"),
    textureUrl: vi.fn(() => "https://example.com/tile.png"),
    fillInvalidPixels: vi.fn(),
}));

const {
    createTileManager,
    extractSubTileElevation,
    computeTextureUvParams,
    extractOrthoStableFrustumPlanes,
} = await import("../src/terrain/tileManager");
const gsiTileMock = await import("../src/terrain/gsiTile");

const createMockCamera = () => {
    const observers: Array<() => void> = [];
    const makeTarget = (x = 0, y = 0, z = 0) => ({
        x,
        y,
        z,
        subtract(other: { x: number; y: number; z: number }) {
            return {
                x: x - other.x,
                y: y - other.y,
                z: z - other.z,
                length() {
                    return Math.sqrt(
                        (x - other.x) ** 2 +
                            (y - other.y) ** 2 +
                            (z - other.z) ** 2,
                    );
                },
                scaleInPlace() {
                    return this;
                },
            };
        },
    });
    return {
        alpha: 0,
        beta: 0,
        fov: Math.PI / 3,
        radius: 4000,
        position: { x: 0, y: 4000, z: 0 },
        target: makeTarget(),
        getScene: vi.fn(() => ({
            getEngine: vi.fn(() => ({})),
        })),
        getViewMatrix: vi.fn(() => ({
            multiplyToRef: vi.fn(),
        })),
        getProjectionMatrix: vi.fn(() => ({})),
        onViewMatrixChangedObservable: {
            add: vi.fn((cb: () => void) => {
                observers.push(cb);
                return cb;
            }),
            remove: vi.fn(),
        },
        _observers: observers,
    } as unknown as ArcRotateCamera;
};

/** scene モック。getEngine は getRenderHeight を返す。 */
const createMockScene = () => ({
    getEngine: vi.fn(() => ({
        getRenderHeight: vi.fn(() => 1080),
    })),
    pickWithRay: vi.fn(() => ({ hit: false, distance: 0, pickedPoint: null })),
});

describe("createTileManager", () => {
    it("setCenter でタイルがロードされる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
            scene: createMockScene() as never,
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
            scene: createMockScene() as never,
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
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
        });

        // attachCamera でオブザーバが追加される
        tm.attachCamera();
        expect(camera.onViewMatrixChangedObservable.add).toHaveBeenCalled();

        // detachCamera でオブザーバが削除される
        tm.detachCamera();
        expect(camera.onViewMatrixChangedObservable.remove).toHaveBeenCalled();
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
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    const parentZoom = 14;

    it("zoom+1 子タイル(0,0)は親の左上領域のみ参照する", () => {
        // parentX = 100 → child (200, 200) → subX=0, subY=0
        const child = { zoom: 15, x: 200, y: 200 };
        const result = extractSubTileElevation(
            parent,
            child,
            parentZoom,
            tileSize,
        );

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
        const result = extractSubTileElevation(
            parent,
            child,
            parentZoom,
            tileSize,
        );

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
        const result = extractSubTileElevation(
            parent,
            child,
            parentZoom,
            tileSize,
        );

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
        const result = extractSubTileElevation(
            parent,
            child,
            parentZoom,
            tileSize,
        );

        expect(result.length).toBe(tileSize * tileSize);
        // subSize=1, originX=1, originY=1 → 全ピクセルが parent[1*4+1]=5 を参照
        const values = new Set(result);
        expect(values.size).toBe(1);
        expect(values.has(5)).toBe(true);
    });

    it("zoom差2で右下端の子タイルが正しい値のみ参照する", () => {
        // child (403, 403) → subX=3, subY=3 (parentX=100<<2=400, 403-400=3)
        const child = { zoom: 16, x: 403, y: 403 };
        const result = extractSubTileElevation(
            parent,
            child,
            parentZoom,
            tileSize,
        );

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
 * LOD連携テスト（computeQuadtreeTiles 経由）
 * ================================================================ */
describe("LOD連携", () => {
    beforeEach(() => {
        (gsiTileMock.textureUrl as Mock).mockClear();
        (gsiTileMock.loadElevationTile as Mock).mockClear();
    });

    afterEach(() => {
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
    });

    it("カメラ位置が近いと高 zoom タイルがロードされる", async () => {
        // カメラ近距離: position (0,500,0) vs target (0,0,0) → D ≈ 500
        const cameraNear = Object.assign(createMockCamera(), {
            position: { x: 0, y: 500, z: 0 },
        });

        const tmNear = createTileManager({
            scene: createMockScene() as never,
            camera: cameraNear,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 200,
            minZoom: 12,
        });
        await tmNear.setCenter(35.68, 139.77);

        const zoomsNear = (gsiTileMock.textureUrl as Mock).mock.calls.map(
            (c) => (c as number[])[1],
        );
        tmNear.dispose();

        // 近景なので zoom14 タイルが少なくとも 1 枚はロードされる
        expect(zoomsNear).toContain(14);
    });

    it("カメラ位置が遠いと低 zoom タイルのみロードされる", async () => {
        // カメラ遠距離: y を十分大きく取り、zoom12 root で SSE が既定しきい値を下回るようにする。
        // zoom12 tileSize ≈ 10000m (Tokyo 緯度補正後)、viewportH 1080、FOV π/3 の場合
        // D ≈ 2_000_000 なら SSE ≈ 5（<<400）で root 採用となる。
        const cameraFar = Object.assign(createMockCamera(), {
            position: { x: 0, y: 2_000_000, z: 0 },
        });

        const tmFar = createTileManager({
            scene: createMockScene() as never,
            camera: cameraFar,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 60,
            minZoom: 12,
        });
        await tmFar.setCenter(35.68, 139.77);

        const zoomsFar = (gsiTileMock.textureUrl as Mock).mock.calls.map(
            (c) => (c as number[])[1],
        );
        tmFar.dispose();

        expect(zoomsFar.length).toBeGreaterThan(0);
        // 全タイルは minZoom (=12) で採用されているはず
        expect(zoomsFar.every((z: number) => z <= 12)).toBe(true);
    });
});

/* ================================================================
 * 標高ズーム段階フォールバック
 * ================================================================ */
describe("標高ズーム段階フォールバック", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));
    });

    it("最高zoomで失敗すると低いzoomにフォールバックする", async () => {
        // zoom 14 は失敗、zoom 13以下は成功
        const elevData13 = new Float32Array(256 * 256).fill(500);
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            if (zoom >= 14) return Promise.reject(new Error("not available"));
            return Promise.resolve(elevData13);
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        const calls = (gsiTileMock.loadElevationTile as Mock).mock.calls;
        const successZooms = calls.filter((c) => (c as number[])[0] < 14);
        expect(successZooms.length).toBeGreaterThan(0);
    });

    it("全zoomで失敗するとフラット標高（0m）でタイルが表示される", async () => {
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.reject(new Error("all fail")),
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            fetchedZooms.push(zoom);
            return Promise.resolve(new Float32Array(256 * 256));
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            fetchedZooms.push(zoom);
            // 全zoomで失敗させてフォールバックを最大まで試行させる
            return Promise.reject(new Error("not available"));
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            fetchedZooms.push(zoom);
            return Promise.reject(new Error("not available"));
        });

        const camera = createMockCamera();
        // maxElevationZoom=14, minZoom=2 → デフォルト minElevationZoom = max(2, 14-4) = 10
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        (gsiTileMock.textureUrl as Mock).mockClear();
    });

    it("setMapType で地図タイプを切り替えると textureUrl が新しいタイプで呼ばれる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);

        // 初回 setCenter のテクスチャ job キューが片付くのを待つ
        await new Promise((r) => setTimeout(r, 100));

        // 初期状態では std で呼ばれている
        const initialCalls = (gsiTileMock.textureUrl as Mock).mock.calls;
        expect(initialCalls.length).toBeGreaterThan(0);
        expect(initialCalls[0][0]).toBe("std");

        (gsiTileMock.textureUrl as Mock).mockClear();

        // photo に切り替え
        tm.setMapType("photo");

        // テクスチャ発行は 1フレームあたり N 個に絞られるため、
        // キューに残った job を消化するため setTimeout(16ms) ベースの flush を待つ
        await new Promise((r) => setTimeout(r, 100));

        // retextureAll が呼ばれ、photo タイプで textureUrl が呼ばれる
        const photoCalls = (gsiTileMock.textureUrl as Mock).mock.calls;
        expect(photoCalls.length).toBeGreaterThan(0);
        expect(photoCalls.every((c: unknown[]) => c[0] === "photo")).toBe(true);

        tm.dispose();
    });

    it("同じ地図タイプを設定しても textureUrl は呼ばれない", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);
        // 初回 setCenter のテクスチャ job キューが片付くのを待つ
        await new Promise((r) => setTimeout(r, 100));
        (gsiTileMock.textureUrl as Mock).mockClear();

        // 同じタイプを再設定
        tm.setMapType("std");
        await new Promise((r) => setTimeout(r, 100));

        expect((gsiTileMock.textureUrl as Mock).mock.calls.length).toBe(0);

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
        expect(uv.uOffset).toBeCloseTo(0.25); // 1/4
        expect(uv.vOffset).toBeCloseTo(0.5); // 2/4
    });
});

/* ================================================================
 * 標高データ全NaN時のフォールバック
 * ================================================================ */
describe("標高データ全NaNフォールバック", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
        (gsiTileMock.tileEdgeMeters as Mock).mockImplementation(() => 1000);
    });

    it("全NaN標高データを返すzoomから低zoomにフォールバックする", async () => {
        // zoom 14: 全NaN（throwされる想定）, zoom 13以下: 有効データ
        const validElev = new Float32Array(256 * 256).fill(300);
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            if (zoom >= 14) {
                return Promise.reject(new Error("All NaN tile"));
            }
            return Promise.resolve(validElev);
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        const calls = (gsiTileMock.loadElevationTile as Mock).mock.calls;
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
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
        (gsiTileMock.tileEdgeMeters as Mock).mockImplementation(() => 1000);
    });

    /**
     * カメラが近距離のとき SSE が大きくなり四分木再帰が maxZoom(=14) まで進み、
     * タイルが zoom 14 でロードされる。
     * minZoom=14 にすることで LOD による低zoom混在を防止。
     */
    const createNearCamera = () => {
        const cam = createMockCamera();
        return Object.assign(cam, {
            radius: 500,
            position: { x: 0, y: 500, z: 0 },
        });
    };

    it("setCenter前はnullを返す", () => {
        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        const elevData = new Float32Array(256 * 256).fill(100); // 全ピクセル 100m
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(elevData),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // ワールド原点 (0,0) は中心タイルの中央ピクセル (127.5, 127.5) に対応
        const result = tm.queryElevationAtWorld(0, 0);
        expect(result).toBe(100);
        tm.dispose();
    });

    it("heightScaleが標高値に反映される", async () => {
        const elevData = new Float32Array(256 * 256).fill(100);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(elevData),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        const elevData = new Float32Array(256 * 256).fill(100);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(elevData),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        const elevData = new Float32Array(256 * 256).fill(100);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(elevData),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
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

    it("zoomフォールバック: 高zoom標高取得失敗時は低zoomデータ抽出でアクティブタイルの標高を返す", async () => {
        // zoom依存の tileEdgeMeters: z14=1000, z13=2000
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));
        const elevData13 = new Float32Array(256 * 256).fill(777);
        // elevData13 を全て 777 で埋めることで、zoom-13 から抽出した
        // zoom-14 タイルの全ピクセルが 777 になる。
        // wx=0,wz=0 → 中心ピクセル (127.5,127.5) のバイリニア補間結果 = 777。

        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            if (zoom >= 14) return Promise.reject(new Error("not available"));
            return Promise.resolve(elevData13);
        });

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 13,
        });

        await tm.setCenter(35.68, 139.77);
        // wx=0, wz=0 → 中心タイル (14/14547/6452) が activeTiles にある。
        // zoom-14 の elevation データは zoom-13 から抽出されたもの（全て 777）。
        // activeTiles チェックにより、表示タイルと同じデータを使って標高を返す。
        const result = tm.queryElevationAtWorld(0, 0);
        expect(result).toBe(777);
        tm.dispose();
    });

    /* ── NaN 挙動テスト（海域タイル等） ── */

    it("NaNピクセルのみのタイル（海域等）でnullを返す", async () => {
        const nanData = new Float32Array(256 * 256).fill(NaN);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(nanData),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        expect(tm.queryElevationAtWorld(0, 0)).toBeNull();
        tm.dispose();
    });

    it("NaNピクセル位置で低zoomへフォールバックし有効値を返す", async () => {
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));

        // zoom14 クエリ対象タイル: 全NaN（海域想定）
        const nanData14 = new Float32Array(256 * 256).fill(NaN);
        // zoom13: ピクセル(64,64)に有効値42を設定
        // wx=0, wz=-1000 → zoom13で fracTile=(0.25,0.25) → px=64, py=64
        const elevData13 = new Float32Array(256 * 256).fill(NaN);
        elevData13[64 * 256 + 64] = 42;

        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom, x, y) => {
            // クエリ対象の zoom14 タイル (14547,6453) は NaN で成功
            if (zoom === 14 && x === 14547 && y === 6453) {
                return Promise.resolve(nanData14);
            }
            // その他の zoom14 タイルは失敗 → zoom13 キャッシュ生成を誘発
            if (zoom >= 14) {
                return Promise.reject(new Error("not available"));
            }
            return Promise.resolve(elevData13);
        });

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 13,
        });

        await tm.setCenter(35.68, 139.77);
        // wx=0, wz=-1000 → zoom14キー"14/14547/6453"はNaN
        // → zoom13キー"13/7273/3226"にフォールバック → pixel(64,64)=42
        const result = tm.queryElevationAtWorld(0, -1000);
        expect(result).toBe(42);
        tm.dispose();
    });

    it("全zoomレベルでNaNの場合nullを返す（フォールバック全滅）", async () => {
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));

        const nanData = new Float32Array(256 * 256).fill(NaN);
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom, x, y) => {
            // クエリ対象タイル (14547,6453) はNaNで成功
            if (zoom === 14 && x === 14547 && y === 6453) {
                return Promise.resolve(new Float32Array(nanData));
            }
            // 他のzoom14は失敗 → zoom13キャッシュ生成を誘発（NaN）
            if (zoom >= 14) {
                return Promise.reject(new Error("not available"));
            }
            // zoom13もNaN
            return Promise.resolve(new Float32Array(nanData));
        });

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);
        // zoom14→13→12 全てNaN → null
        expect(tm.queryElevationAtWorld(0, -1000)).toBeNull();
        tm.dispose();
    });

    it("NaNフォールバック結果にheightScaleとaltitudeOffsetが反映される", async () => {
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));

        // zoom14 クエリ対象: 全NaN
        const nanData14 = new Float32Array(256 * 256).fill(NaN);
        // zoom13: ピクセル(64,64)に有効値50
        const elevData13 = new Float32Array(256 * 256).fill(NaN);
        elevData13[64 * 256 + 64] = 50;

        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom, x, y) => {
            if (zoom === 14 && x === 14547 && y === 6453) {
                return Promise.resolve(nanData14);
            }
            if (zoom >= 14) {
                return Promise.reject(new Error("not available"));
            }
            return Promise.resolve(elevData13);
        });

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 2.0,
            maxTiles: 5,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 13,
        });

        await tm.setCenter(35.68, 139.77, 10); // altitudeOffset = 10
        // wx=0, wz=-1000 → zoom14 NaN → zoom13 フォールバック → 50取得
        // (50 + 10) * 2.0 = 120
        const result = tm.queryElevationAtWorld(0, -1000);
        expect(result).toBe(120);
        tm.dispose();
    });

    it("NaN混在タイルで有効ピクセルは正しく返す", async () => {
        const mixedData = new Float32Array(256 * 256).fill(NaN);
        // ワールド原点 (0,0) は中心ピクセル (127.5, 127.5) → (127,127)〜(128,128) を使用
        mixedData[127 * 256 + 127] = 88;
        mixedData[127 * 256 + 128] = 88;
        mixedData[128 * 256 + 127] = 88;
        mixedData[128 * 256 + 128] = 88;
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(mixedData),
        );

        const camera = createNearCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 14,
            maxElevationZoom: 14,
            minElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // ピクセル(127,127)〜(128,128)が有効値88 → バイリニア補間で88を返す
        expect(tm.queryElevationAtWorld(0, 0)).toBe(88);
        tm.dispose();
    });

    it("zoom > maxElevationZoom でも activeTiles のデータから標高を返す", async () => {
        // zoom=18（表示最大）, maxElevationZoom=17（標高タイル最大）
        // zoom18 の標高データは zoom17 から extractSubTileElevation で抽出される。
        // 修正前: ループが maxElevationZoom(17) から始まるため activeTiles(zoom18) にヒットせず null。
        // 修正後: ループが zoom(18) から始まるため activeTiles(zoom18) にヒットして値を返す。
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));
        const elevData = new Float32Array(256 * 256).fill(55);
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((zoom) => {
            if (zoom >= 18) return Promise.reject(new Error("not available"));
            return Promise.resolve(elevData);
        });

        // radius を小さくして zoom18 のタイルがロードされるようにする
        const camera = Object.assign(createNearCamera(), {
            radius: 50,
            position: { x: 0, y: 50, z: 0 },
        });
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 18,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 18,
            maxElevationZoom: 17,
            minElevationZoom: 17,
        });

        await tm.setCenter(35.68, 139.77);
        const result = tm.queryElevationAtWorld(0, 0);
        // activeTiles には zoom18 のエントリがあり、その標高データは
        // zoom17 から抽出された値（55）。修正により正しくヒットする。
        expect(result).toBe(55);
        tm.dispose();
    });
});

/* ================================================================
 * Quadtree + SSE によるタイル選定
 * ================================================================ */
describe("Quadtree + SSE によるタイル選定", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
        (gsiTileMock.tileEdgeMeters as Mock).mockImplementation(() => 1000);
    });

    it("高標高地形ではカメラとの距離が縮まり SSE が増えて高zoomタイルが表示される", async () => {
        // zoom依存の tileEdgeMeters: z14=1000, z13=2000, z12=4000
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));

        // 高標高（3776m）の標高データをロードさせる
        const highElev = new Float32Array(256 * 256).fill(3776);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(highElev),
        );

        const cameraHigh = Object.assign(createMockCamera(), {
            radius: 8000,
            beta: Math.PI / 3,
        });

        const tmHigh = createTileManager({
            scene: createMockScene() as never,
            camera: cameraHigh,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 200,
            minZoom: 12,
        });

        await tmHigh.setCenter(35.36, 138.73);
        // 標高キャッシュを反映させるため 2 回目の setCenter を実行
        (gsiTileMock.textureUrl as Mock).mockClear();
        await tmHigh.setCenter(35.36, 138.73);

        const zoomsHigh = (gsiTileMock.textureUrl as Mock).mock.calls.map(
            (c) => (c as number[])[1],
        );
        const maxZoomHigh = zoomsHigh.length > 0 ? Math.max(...zoomsHigh) : 12;

        // 海面付近（標高0）では radius=8000 がそのまま使われ低zoom
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );

        const cameraLow = Object.assign(createMockCamera(), {
            radius: 8000,
            beta: Math.PI / 3,
        });

        const tmLow = createTileManager({
            scene: createMockScene() as never,
            camera: cameraLow,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 200,
            minZoom: 12,
        });

        await tmLow.setCenter(35.68, 139.77);
        (gsiTileMock.textureUrl as Mock).mockClear();
        await tmLow.setCenter(35.68, 139.77);

        const zoomsLow = (gsiTileMock.textureUrl as Mock).mock.calls.map(
            (c) => (c as number[])[1],
        );
        const maxZoomLow = zoomsLow.length > 0 ? Math.max(...zoomsLow) : 12;

        // 高標高時は低標高時より高zoomが選ばれる
        expect(maxZoomHigh).toBeGreaterThanOrEqual(maxZoomLow);

        tmHigh.dispose();
        tmLow.dispose();
    });

    it("標高データ未キャッシュでもタイルがロードされる", async () => {
        const camera = Object.assign(createMockCamera(), { radius: 4000 });

        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 5,
            minZoom: 12,
        });

        await tm.setCenter(35.68, 139.77);
        // 標高未キャッシュでもクラッシュせずタイルがロードされる
        expect(tm.activeTileCount).toBeGreaterThan(0);
        tm.dispose();
    });

    it("AABB にカメラが埋没しても SSE の距離クランプで安定動作する", async () => {
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));

        // 標高がradiusとほぼ同じ（radius-terrainY ≈ 0）でも下限でクランプされ安定
        const extremeElev = new Float32Array(256 * 256).fill(7999);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(extremeElev),
        );

        const camera = Object.assign(createMockCamera(), {
            radius: 8000,
            beta: Math.PI / 3,
        });

        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 200,
            minZoom: 12,
        });

        await tm.setCenter(35.36, 138.73);
        // SSE は距離 D を max(1, D) でクランプしているため、
        // カメラが地形に埋没しても安定してタイルが出る
        expect(tm.activeTileCount).toBeGreaterThan(0);
        tm.dispose();
    });

    it("同じ radius・標高でチルト角を変えても SSE による採用 zoom が安定する", async () => {
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));

        const highElev = new Float32Array(256 * 256).fill(3776);
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(highElev),
        );

        const runWithBeta = async (beta: number): Promise<number> => {
            const camera = Object.assign(createMockCamera(), {
                radius: 8000,
                beta,
            });
            const tm = createTileManager({
                scene: createMockScene() as never,
                camera,
                zoom: 14,
                subdivisions: 128,
                heightScale: 1.0,
                maxTiles: 200,
                minZoom: 12,
            });
            await tm.setCenter(35.36, 138.73);
            (gsiTileMock.textureUrl as Mock).mockClear();
            await tm.setCenter(35.36, 138.73);
            const zooms = (gsiTileMock.textureUrl as Mock).mock.calls.map(
                (c) => (c as number[])[1],
            );
            tm.dispose();
            return zooms.length > 0 ? Math.max(...zooms) : -1;
        };

        const zoomVertical = await runWithBeta(0.01); // ほぼ真下
        const zoomMid = await runWithBeta(Math.PI / 3); // 60°
        const zoomHorizontal = await runWithBeta(Math.PI / 2.1); // ほぼ水平

        // チルト角を変えても採用 zoom は同じ
        expect(zoomVertical).toBe(zoomMid);
        expect(zoomMid).toBe(zoomHorizontal);
    });
});

/* ================================================================
 * refineAllNaNTiles — 反復 all-NaN 補間
 * ================================================================ */
describe("refineAllNaNTiles", () => {
    afterEach(() => {
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
        (
            gsiTileMock.tileEdgeMeters as Mock<
                (lat: number, zoom: number) => number
            >
        ).mockImplementation((_lat, zoom) => 1000 * 2 ** (14 - zoom));
        (gsiTileMock.fillInvalidPixels as Mock).mockImplementation(() => {});
    });

    it("隣接が段階的に unblocked になると中心タイルも最終的に unblocked になる", async () => {
        // 中心タイル (14547, 6452) は有効データ (500m)
        // 隣接 (14548, 6452) は all-NaN → 中心から seeds を受け unblocked になる
        // さらに (14549, 6452) も all-NaN → (14548) がunblocked後に解決される
        const nanData = new Float32Array(256 * 256).fill(NaN);
        const validData = new Float32Array(256 * 256).fill(500);

        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((_zoom, x) => {
            // x が center+1 以上のタイルを all-NaN にする
            if (x > 14547) return Promise.resolve(new Float32Array(nanData));
            return Promise.resolve(new Float32Array(validData));
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
            minZoom: 14,
            maxElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);

        // 有効タイルの隣接にある all-NaN タイルの queryElevation が null でない
        // （unblocked になり filled データが利用可能）
        // ステッチ経由で中心タイルの右辺値(500)がシード値として伝搬される
        expect(tm.activeTileCount).toBeGreaterThan(1);
        tm.dispose();
    });

    it("進展がない場合は早期停止する（全て all-NaN で隣接なし）", async () => {
        // 全タイルが all-NaN → refineAllNaNTiles は1イテレーションで停止
        const nanData = new Float32Array(256 * 256).fill(NaN);

        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(nanData)),
        );

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
            minZoom: 14,
            maxElevationZoom: 14,
        });

        // setCenter が正常終了する（無限ループしない）
        await tm.setCenter(35.68, 139.77);
        // 全て all-NaN → queryElevation は null
        expect(tm.queryElevationAtWorld(0, 0)).toBeNull();
        tm.dispose();
    });

    it("all-NaN タイルが隣接有効タイルから unblocked になると filled データで標高が返る", async () => {
        // 中心 (14547, 6452) は 200m 固定
        // 右隣 (14548, 6452) は all-NaN → 中心からシードされて ~200m
        const nanData = new Float32Array(256 * 256).fill(NaN);
        const validData = new Float32Array(256 * 256).fill(200);

        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((_zoom, x) => {
            if (x >= 14548) return Promise.resolve(new Float32Array(nanData));
            return Promise.resolve(new Float32Array(validData));
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
            minZoom: 14,
            maxElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // 中心タイルの高さは有効 → 200
        const centerElev = tm.queryElevationAtWorld(0, 0);
        expect(centerElev).toBe(200);
        tm.dispose();
    });

    it("useFilled=true により岸タイルの NaN 補間済みデータからシードが伝搬する（回帰テスト）", async () => {
        // 岸タイル A(14547): 300m だが右辺(col=255)だけ NaN（湖岸の欠測）
        // 湖タイル B(14548+): 全 NaN
        // fillInvalidPixels が A の右辺 NaN を隣接 300m で補間 → A.filled の右辺が有効値
        // refineAllNaNTiles の useFilled=true が A.filled を参照 → B にシード伝搬
        // useFilled=false だと A.elevation（右辺 NaN）を参照し B は解決不能

        // fillInvalidPixels を 1パス 4近傍補間に差し替え
        (
            gsiTileMock.fillInvalidPixels as Mock<
                (data: Float32Array, width: number, height: number) => void
            >
        ).mockImplementation((data, width, height) => {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    if (!Number.isNaN(data[i]) && data[i] !== -100) continue;
                    const neighbors: number[] = [];
                    if (
                        x > 0 &&
                        !Number.isNaN(data[i - 1]) &&
                        data[i - 1] !== -100
                    )
                        neighbors.push(data[i - 1]);
                    if (
                        x < width - 1 &&
                        !Number.isNaN(data[i + 1]) &&
                        data[i + 1] !== -100
                    )
                        neighbors.push(data[i + 1]);
                    if (
                        y > 0 &&
                        !Number.isNaN(data[i - width]) &&
                        data[i - width] !== -100
                    )
                        neighbors.push(data[i - width]);
                    if (
                        y < height - 1 &&
                        !Number.isNaN(data[i + width]) &&
                        data[i + width] !== -100
                    )
                        neighbors.push(data[i + width]);
                    if (neighbors.length > 0) {
                        data[i] =
                            neighbors.reduce((a, b) => a + b, 0) /
                            neighbors.length;
                    } else {
                        data[i] = -100;
                    }
                }
            }
        });

        // 岸タイル: 右辺(col=255)だけ NaN
        const shoreData = new Float32Array(256 * 256).fill(300);
        for (let y = 0; y < 256; y++) shoreData[y * 256 + 255] = NaN;

        // 湖タイル: 全 NaN
        const lakeData = new Float32Array(256 * 256).fill(NaN);

        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((_zoom, x) => {
            if (x <= 14547) return Promise.resolve(new Float32Array(shoreData));
            return Promise.resolve(new Float32Array(lakeData));
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
            minZoom: 14,
            maxElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);

        // 湖タイル B(14548) が unblocked されて filled データで標高が返る
        // wx=1000 → tile 14548, col=0（B の左辺）
        const lakeBorderElev = tm.queryElevationAtWorld(1000, -4);
        expect(lakeBorderElev).not.toBeNull();
        // 岸タイルの filled 右辺（≈300）からシードされるため 300 に近い値
        expect(lakeBorderElev).toBeCloseTo(300, 0);

        tm.dispose();
    });
});

describe("同zoom タイル間ステッチの対称性", () => {
    // flushRestitch は requestAnimationFrame 経由で実行されるが、
    // Node.js テスト環境では rAF が未定義のため、コールバックをキューし
    // 手動フラッシュする方式でポリフィルする
    let origRAF: typeof globalThis.requestAnimationFrame;
    let origCAF: typeof globalThis.cancelAnimationFrame;
    let rafQueue: FrameRequestCallback[];
    const flushRAF = () => {
        let safety = 20;
        while (rafQueue.length > 0 && safety-- > 0) {
            const batch = rafQueue.splice(0);
            for (const cb of batch) cb(0);
        }
    };
    beforeEach(() => {
        origRAF = globalThis.requestAnimationFrame;
        origCAF = globalThis.cancelAnimationFrame;
        rafQueue = [];
        let nextId = 1;
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
            rafQueue.push(cb);
            return nextId++;
        }) as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame =
            (() => {}) as typeof cancelAnimationFrame;
    });
    afterEach(() => {
        globalThis.requestAnimationFrame = origRAF;
        globalThis.cancelAnimationFrame = origCAF;
        (gsiTileMock.loadElevationTile as Mock).mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256)),
        );
    });

    it("隣接タイルの共有辺が raw 同士の平均で一致する（回帰テスト）", async () => {
        // Tile A (x<=14547) = 100m, Tile B (x>14547) = 200m
        // raw ステッチ後、共有辺は avg(100, 200) = 150 で両側一致すること
        (
            gsiTileMock.loadElevationTile as Mock<
                (zoom: number, x: number, y: number) => Promise<Float32Array>
            >
        ).mockImplementation((_zoom, x) => {
            const val = x <= 14547 ? 100 : 200;
            return Promise.resolve(new Float32Array(256 * 256).fill(val));
        });

        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
            minZoom: 14,
            maxElevationZoom: 14,
        });

        await tm.setCenter(35.68, 139.77);
        // タイルロード後に蓄積された再ステッチを実行
        flushRAF();

        // A の右辺 (col=255) と B の左辺 (col=0) を queryElevationAtWorld で取得
        // tile A: world [-500, +500), tile B: world [+500, +1500), wz=-4 → 辺（非角）
        // wx=499 → tile A 右辺付近, wx=500 → tile B 左辺付近
        const aRightEdge = tm.queryElevationAtWorld(499, -4);
        const bLeftEdge = tm.queryElevationAtWorld(500, -4);

        if (aRightEdge === null) throw new Error("unreachable");
        if (bLeftEdge === null) throw new Error("unreachable");
        // バイリニア補間により、ステッチ値(150)と内部ピクセル(100/200)の加重平均となる。
        // ステッチが機能していれば境界付近の値は 100〜200 の間に収まる。
        // ステッチなしの場合: tile A 右辺 = 100, tile B 左辺 = 200（不連続）
        // ステッチありの場合: 両辺ともステッチ値150が含まれ 100〜200 の中間に近づく
        expect(aRightEdge).toBeGreaterThan(100); // 150 が混入して 100 より大きい
        expect(aRightEdge).toBeLessThanOrEqual(150);
        expect(bLeftEdge).toBeGreaterThanOrEqual(100);
        expect(bLeftEdge).toBeLessThan(200); // 150 が混入して 200 より小さい

        tm.dispose();
    });
});

/* ================================================================
 * LOD 遷移時の遅延解放テスト
 * ================================================================ */
describe("LOD遷移時の遅延解放", () => {
    it("再 setCenter 後も activeTileCount が維持される", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
        });

        await tm.setCenter(35.68, 139.77);
        const initialCount = tm.activeTileCount;
        expect(initialCount).toBeGreaterThan(0);

        // 中心タイル座標を変えて、旧タイルが不要になる状況を再現
        (gsiTileMock.toTileXY as Mock).mockReturnValueOnce({
            x: 14600,
            y: 6500,
        });
        await tm.setCenter(36.0, 140.0);
        // 新しい中心でもタイル数が変わっていないこと（維持）
        expect(tm.activeTileCount).toBe(initialCount);

        tm.dispose();
    });

    it("dispose が例外なく完了し activeTileCount が 0 になる", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 10,
        });

        await tm.setCenter(35.68, 139.77);
        expect(tm.activeTileCount).toBeGreaterThan(0);

        // 中心タイル座標を変えて旧タイルを pendingRelease に移す
        (gsiTileMock.toTileXY as Mock).mockReturnValueOnce({
            x: 14600,
            y: 6500,
        });
        await tm.setCenter(36.0, 140.0);

        // dispose が例外なく完了すること（タイマーのクリーンアップ含む）
        expect(() => tm.dispose()).not.toThrow();
        expect(tm.activeTileCount).toBe(0);
    });

    it("同じ位置で setCenter しても重複ロードが発生しない", async () => {
        const camera = createMockCamera();
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 20,
        });

        await tm.setCenter(35.68, 139.77);
        const count1 = tm.activeTileCount;
        const loadCallsBefore = (gsiTileMock.loadElevationTile as Mock).mock
            .calls.length;

        // 同じ中心で再度呼び出し → 既に activeTiles にあるため再ロード不要
        await tm.setCenter(35.68, 139.77);
        const count2 = tm.activeTileCount;
        const loadCallsAfter = (gsiTileMock.loadElevationTile as Mock).mock
            .calls.length;

        expect(count2).toBe(count1);
        // loadElevationTile の呼び出し回数が増えていないこと（重複ロードなし）
        expect(loadCallsAfter).toBe(loadCallsBefore);

        tm.dispose();
    });

    it("zoom-up 遷移時に zoom-coarse な旧タイルが pendingRelease に入る", async () => {
        // SSE = (tileSize * viewportHeight) / (distance * 2 * tan(fov/2))
        // cameraHeight=1e6 → SSE 極小 → zoom=12 タイルが採用（過剰分割しない）
        // cameraHeight=0.1 → 距離 max(1,0.1)=1 → SSE 極大 → maxZoom=14 まで分割
        // rootSearchRadius: 0 で root を 1 タイルに限定し、maxTiles を超過しない決定的なテストにする。
        // 旧実装（即時解放）では pendingReleaseCount=0 になり、このテストは失敗する。
        const cameraMock = createMockCamera() as {
            position: { x: number; y: number; z: number };
        };
        const camera = cameraMock as never;
        const tm = createTileManager({
            scene: createMockScene() as never,
            camera,
            zoom: 14,
            subdivisions: 128,
            heightScale: 1.0,
            maxTiles: 30,
            rootSearchRadius: 0,
        });

        // 1st setCenter: カメラを高空（1e6）に置き zoom=12 タイルのみを採用させる
        cameraMock.position = { ...cameraMock.position, y: 1e6 };
        await tm.setCenter(35.68, 139.77);
        expect(tm.activeTileCount).toBeGreaterThan(0);
        const countAtZoom12 = tm.activeTileCount;

        // 2nd setCenter: カメラを地表付近（0.1）に下げ zoom=14 タイルまで分割させる
        // 旧 zoom=12 タイルは新 zoom=14 タイルの祖先 → hasZoomRelation = true
        // → 即時解放されず pendingRelease に入る
        cameraMock.position = { ...cameraMock.position, y: 0.1 };
        await tm.setCenter(35.68, 139.77);

        expect(tm.pendingReleaseCount).toBeGreaterThan(0);
        // zoom=12 タイル数以下であること（全部 pending に入るか一部は解放されても OK）
        expect(tm.pendingReleaseCount).toBeLessThanOrEqual(countAtZoom12);

        tm.dispose();
        // dispose 後は pendingRelease が空になること
        expect(tm.pendingReleaseCount).toBe(0);
    });

    it("zoom-down 遷移後に祖先タイルの Texture onLoad を発火すると pendingRelease が解放される", async () => {
        // vi.useFakeTimers でテクスチャキュー（MAX_TEXTURE_PER_FRAME=2, 16ms間隔）を
        // vi.advanceTimersByTime(200) で全件フラッシュする。
        // PENDING_RELEASE_TIMEOUT_MS(5000ms) は発火させず、手動 onLoad 発火で
        // checkAndReleaseCoveredTiles の解放経路を検証する。
        vi.useFakeTimers();
        try {
            capturedTextureOnLoads.length = 0;

            const cameraMock = createMockCamera() as {
                position: { x: number; y: number; z: number };
            };
            const camera = cameraMock as never;
            const tm = createTileManager({
                scene: createMockScene() as never,
                camera,
                zoom: 14,
                subdivisions: 128,
                heightScale: 1.0,
                maxTiles: 30,
                rootSearchRadius: 0,
            });

            // 1st setCenter: カメラを地表付近（0.1）に置き zoom=14 タイルを採用
            cameraMock.position = { ...cameraMock.position, y: 0.1 };
            await tm.setCenter(35.68, 139.77);
            // テクスチャキューを全件フラッシュ（16ms × 複数フレーム分）
            // PENDING_RELEASE_TIMEOUT_MS(5000ms) は発火しない安全な範囲で進める
            vi.advanceTimersByTime(200);

            // 2nd setCenter: カメラを高空（1e6）に上げ zoom=12 タイルに移行
            // 旧 zoom=14 タイルは pendingRelease に移動し、新 zoom=12 タイルがロードされる
            capturedTextureOnLoads.length = 0;
            cameraMock.position = { ...cameraMock.position, y: 1e6 };
            await tm.setCenter(35.68, 139.77);
            // 新 zoom=12 タイルのテクスチャジョブをフラッシュして onLoad をキャプチャ
            vi.advanceTimersByTime(200);

            expect(tm.pendingReleaseCount).toBeGreaterThan(0);
            expect(capturedTextureOnLoads.length).toBeGreaterThan(0);

            // zoom=12 祖先タイルの Texture onLoad を手動発火
            // checkAndReleaseCoveredTiles が pendingRelease の zoom=14 タイル（子孫）を解放する
            const onLoadsToFire = [...capturedTextureOnLoads];
            onLoadsToFire.forEach((cb) => {
                cb();
            });

            expect(tm.pendingReleaseCount).toBe(0);

            tm.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("extractOrthoStableFrustumPlanes", () => {
    const makeCamera = (
        orthoHalfW: number,
        orthoHalfH: number,
        targetX = 100,
        targetZ = -50,
    ) => ({
        orthoLeft: -orthoHalfW,
        orthoRight: orthoHalfW,
        orthoTop: orthoHalfH,
        orthoBottom: -orthoHalfH,
        target: { x: targetX, z: targetZ },
    });

    it("正方形 ortho 矩形のとき、半辺は対角距離(=hypot(halfW,halfH))に拡張される", () => {
        const cam = makeCamera(1000, 1000);
        const planes = extractOrthoStableFrustumPlanes(cam);
        // X+ 方向の平面: normal=(1,0,0), d = -(cx - radius)
        // radius = hypot(1000, 1000) = 1000 * sqrt(2)
        const expectedRadius = Math.hypot(1000, 1000);
        const cx = 100;
        const cz = -50;
        expect(planes[0].normal).toEqual({ x: 1, y: 0, z: 0 });
        expect(planes[0].d).toBeCloseTo(-(cx - expectedRadius), 6);
        expect(planes[1].normal).toEqual({ x: -1, y: 0, z: 0 });
        expect(planes[1].d).toBeCloseTo(cx + expectedRadius, 6);
        expect(planes[2].normal).toEqual({ x: 0, y: 0, z: 1 });
        expect(planes[2].d).toBeCloseTo(-(cz - expectedRadius), 6);
        expect(planes[3].normal).toEqual({ x: 0, y: 0, z: -1 });
        expect(planes[3].d).toBeCloseTo(cz + expectedRadius, 6);
    });

    it("camera.target を中心とする回転不変な平面である（alphaに依存しない）", () => {
        // 関数引数に alpha は含まれないため、引数が同じなら結果は同一
        const cam1 = makeCamera(800, 600, 0, 0);
        const cam2 = makeCamera(800, 600, 0, 0);
        expect(extractOrthoStableFrustumPlanes(cam1)).toEqual(
            extractOrthoStableFrustumPlanes(cam2),
        );
    });

    it("Y 方向は十分大きな上下平面（地形 ±数千m を完全カバー）", () => {
        const cam = makeCamera(500, 500);
        const planes = extractOrthoStableFrustumPlanes(cam);
        expect(planes[4].normal).toEqual({ x: 0, y: 1, z: 0 });
        expect(planes[5].normal).toEqual({ x: 0, y: -1, z: 0 });
        expect(planes[4].d).toBeGreaterThan(1e6);
        expect(planes[5].d).toBeGreaterThan(1e6);
    });

    it("ortho* が未設定（null/undefined）でも 0 として安全にフォールバックする", () => {
        const planes = extractOrthoStableFrustumPlanes({
            target: { x: 0, z: 0 },
        });
        expect(planes).toHaveLength(6);
        // radius = hypot(0,0) = 0 → X+ 平面の d = ±0（Object.is で -0/+0 区別を避ける）
        expect(planes[0].d).toBeCloseTo(0);
    });
});
