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
});

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/groundBuilder", () => ({
    CreateGround: jest.fn(() => mockMeshInstance()),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: jest.fn().mockImplementation(() => ({
        specularColor: null,
        diffuseTexture: null,
        dispose: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/Textures/texture", () => ({
    Texture: jest.fn().mockImplementation(() => ({
        dispose: jest.fn(),
    })),
}));

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
    Plane: jest.fn().mockImplementation(() => ({
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
    stdTextureUrl: jest.fn(() => "https://example.com/tile.png"),
}));

const { createTileManager } = await import("../src/terrain/tileManager");

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
