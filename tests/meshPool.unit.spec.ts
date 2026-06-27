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
        dispose: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color3: {
        Black: jest.fn(() => ({ r: 0, g: 0, b: 0 })),
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

    it("setShadowHooks 設定後の acquire/release でフックが呼ばれる", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });
        const onAcquire = jest.fn();
        const onRelease = jest.fn();
        pool.setShadowHooks({ onAcquire, onRelease });

        const mesh = pool.acquire();
        expect(onAcquire).toHaveBeenCalledTimes(1);
        expect(onAcquire).toHaveBeenCalledWith(mesh);
        expect(onRelease).not.toHaveBeenCalled();

        pool.release(mesh);
        expect(onRelease).toHaveBeenCalledTimes(1);
        expect(onRelease).toHaveBeenCalledWith(mesh);
    });

    it("setShadowHooks(null) 後はフックが呼ばれない", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });
        const onAcquire = jest.fn();
        const onRelease = jest.fn();
        pool.setShadowHooks({ onAcquire, onRelease });
        pool.setShadowHooks(null);

        const mesh = pool.acquire();
        pool.release(mesh);
        expect(onAcquire).not.toHaveBeenCalled();
        expect(onRelease).not.toHaveBeenCalled();
    });

    it("forEachActive はアクティブなメッシュのみ列挙する", () => {
        const pool = createMeshPool({
            scene: mockScene,
            subdivisions: 128,
            tileSize: 100,
        });
        const m1 = pool.acquire();
        const m2 = pool.acquire();
        const m3 = pool.acquire();
        pool.release(m2);

        const visited: unknown[] = [];
        pool.forEachActive((mesh) => visited.push(mesh));
        expect(visited).toHaveLength(2);
        expect(visited).toContain(m1);
        expect(visited).toContain(m3);
        expect(visited).not.toContain(m2);
    });
});
