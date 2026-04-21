/**
 * meshPool のユニットテスト。
 * Babylon.js の Scene/Mesh をモックして、acquire/release のロジックを検証する。
 */

import { jest, describe, it, expect } from "@jest/globals";

const createMockMesh = () => ({
    material: null as unknown,
    setEnabled: jest.fn(),
    dispose: jest.fn(),
    scaling: { x: 1, y: 1, z: 1 },
    position: { x: 0, y: 0, z: 0 },
});

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/groundBuilder", () => ({
    CreateGround: jest.fn(() => createMockMesh()),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: jest.fn().mockImplementation(() => ({
        specularColor: null,
        diffuseTexture: null,
        diffuseColor: { r: 1, g: 1, b: 1 },
        dispose: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color3: {
        Black: jest.fn(() => ({ r: 0, g: 0, b: 0 })),
        White: jest.fn(() => ({ r: 1, g: 1, b: 1 })),
    },
}));

const { createMeshPool } = await import("../src/terrain/meshPool");

const mockScene = {} as never;

describe("createMeshPool", () => {
    it("acquire でメッシュを取得し activeCount が増加する", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        expect(pool.activeCount).toBe(0);
        const mesh = pool.acquire();
        expect(mesh).toBeDefined();
        expect(pool.activeCount).toBe(1);
    });

    it("release でメッシュがプールに戻り pooledCount が増加する", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        const mesh = pool.acquire();
        expect(pool.activeCount).toBe(1);
        expect(pool.pooledCount).toBe(0);

        pool.release(mesh);
        expect(pool.activeCount).toBe(0);
        expect(pool.pooledCount).toBe(1);
    });

    it("release 後の acquire でプールからメッシュを再利用する", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        const mesh1 = pool.acquire();
        pool.release(mesh1);

        const mesh2 = pool.acquire();
        expect(mesh2).toBe(mesh1); // 同一オブジェクト
    });

    it("active でないメッシュの release は無視される", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        const mesh = pool.acquire();
        pool.release(mesh);
        pool.release(mesh); // 二重 release
        expect(pool.pooledCount).toBe(1); // 1つのまま
    });

    it("dispose で全メッシュが破棄される", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        const mesh1 = pool.acquire();
        const mesh2 = pool.acquire();
        pool.release(mesh2);

        pool.dispose();
        expect(pool.activeCount).toBe(0);
        expect(pool.pooledCount).toBe(0);
        expect(mesh1.dispose).toHaveBeenCalled();
        expect(mesh2.dispose).toHaveBeenCalled();
    });

    it("release で diffuseColor がデフォルト（白）にリセットされる", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        const mesh = pool.acquire();
        // 海タイル使用をシミュレート: diffuseColor を変更
        (mesh.material as any).diffuseColor = { r: 0.2, g: 0.4, b: 0.6 };

        pool.release(mesh);
        // diffuseColor がリセットされていること
        expect((mesh.material as any).diffuseColor).toEqual({ r: 1, g: 1, b: 1 });
    });

    it("release で diffuseTexture が解放される", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });

        const mesh = pool.acquire();
        const mockDispose = jest.fn();
        (mesh.material as any).diffuseTexture = { dispose: mockDispose };

        pool.release(mesh);
        expect(mockDispose).toHaveBeenCalled();
        expect((mesh.material as any).diffuseTexture).toBeNull();
    });
});
