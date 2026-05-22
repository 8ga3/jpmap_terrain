/**
 * `src/demos/flight/waypoints.ts` の unit test (Issue #274)。
 *
 * ウェイポイント管理ロジック（arcDistance 等）をテストする。
 * Babylon.js の Scene/Mesh 依存部分はモック化。
 *
 * ESM + jest.unstable_mockModule で完全にモジュールを分離して
 * 他テストとのキャッシュ衝突を回避する。
 */
import { describe, it, expect, jest, beforeAll } from "@jest/globals";

// ESM環境のモック: jest.unstable_mockModule を使い、動的 import でテスト対象を取得

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/discBuilder", () => ({
    CreateDisc: jest.fn(() => ({
        material: null,
        isPickable: false,
        alwaysSelectAsActiveMesh: false,
        rotation: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 0, z: 0, set: jest.fn(), clone: jest.fn(() => ({ x: 0, y: 0, z: 0 })) },
        visibility: 1,
        dispose: jest.fn(),
        setEnabled: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: class {},
}));

jest.unstable_mockModule("@babylonjs/core/Materials/shaderMaterial", () => ({
    ShaderMaterial: jest.fn(() => ({
        setFloat: jest.fn(), dispose: jest.fn(), backFaceCulling: false, alpha: 1,
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/effect", () => ({
    Effect: { ShadersStore: {} },
}));

jest.unstable_mockModule("@babylonjs/core/Particles/particleSystem", () => ({
    ParticleSystem: jest.fn(() => ({
        particleTexture: null, emitter: null,
        minEmitBox: null, maxEmitBox: null,
        color1: null, color2: null, colorDead: null,
        minSize: 0, maxSize: 0, minLifeTime: 0, maxLifeTime: 0,
        minEmitPower: 0, maxEmitPower: 0, emitRate: 0,
        gravity: null, targetStopDuration: 0, disposeOnStop: false,
        start: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color4: jest.fn(),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.vector", () => ({
    Vector3: jest.fn((x = 0, y = 0, z = 0) => ({ x, y, z })),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/Textures/texture", () => ({
    Texture: jest.fn(),
}));

jest.unstable_mockModule("../src/demos/flight/waypointShader", () => ({
    createWaypointMaterial: jest.fn(() => ({
        setFloat: jest.fn(), dispose: jest.fn(), backFaceCulling: false, alpha: 1,
    })),
    updateWaypointMaterialTime: jest.fn(),
}));

jest.unstable_mockModule("../src/demos/flight/waypointEffect", () => ({
    createPassEffect: jest.fn(),
}));

const createMockScene = () => ({
    getTransformNodeByName: jest.fn((): unknown => ({
        getChildMeshes: jest.fn(() => [
            {
                computeWorldMatrix: jest.fn(),
                absolutePosition: { x: 0, y: 100, z: 0 },
            },
        ]),
    })),
});

describe("createWaypointManager", () => {
    let createWaypointManager: any;
    let CreateDiscMock: jest.Mock;

    beforeAll(async () => {
        const waypoints = await import("../src/demos/flight/waypoints");
        createWaypointManager = waypoints.createWaypointManager;

        const discModule = await import("@babylonjs/core/Meshes/Builders/discBuilder");
        CreateDiscMock = discModule.CreateDisc as unknown as jest.Mock;
    });

    it("creates a WaypointManager with update/reset/dispose", () => {
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        expect(mgr).toBeDefined();
        expect(typeof mgr.update).toBe("function");
        expect(typeof mgr.reset).toBe("function");
        expect(typeof mgr.dispose).toBe("function");
    });

    it("reset creates waypoints based on radius", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
            modelNodeName: "model-plane",
        });

        // 2000m 半径 → 周長 ≈ 12566m → 12566/600 ≈ 20 → cap at MAX_WAYPOINT_COUNT=10
        const expectedCount = Math.min(
            Math.floor((2 * Math.PI * 2000) / 600),
            10,
        );
        expect(CreateDiscMock).toHaveBeenCalledTimes(expectedCount);
    });

    it("reset caps waypoints at MAX_WAYPOINTS", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 50000,
            altitudeM: 2000,
            angleDeg: 0,
            modelNodeName: "model-plane",
        });
        expect(CreateDiscMock).toHaveBeenCalledTimes(10);
    });

    it("dispose cleans up without error", () => {
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
            modelNodeName: "model-plane",
        });
        expect(() => mgr.dispose()).not.toThrow();
    });

    it("update does not throw when no model node found", () => {
        const scene = createMockScene();
        scene.getTransformNodeByName = jest.fn(() => null);
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
            modelNodeName: "model-plane",
        });
        expect(() =>
            mgr.update(
                {
                    centerLat: 35.68,
                    centerLon: 139.77,
                    radiusM: 2000,
                    altitudeM: 2000,
                    angleDeg: 10,
                    modelNodeName: "model-plane",
                },
                1000,
            ),
        ).not.toThrow();
    });
});
