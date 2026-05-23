/**
 * `src/demos/flight/afterburner.ts` の unit test (Issue #276)。
 *
 * TrailMesh + GlowLayer によるアフターバーナーの状態遷移をテストする。
 * Babylon.js 依存はモック化。
 */
import { describe, it, expect, jest, beforeAll } from "@jest/globals";
import type { Scene } from "@babylonjs/core/scene";

// --- Babylon.js モック ---

const mockTrailMeshInstance = () => ({
    material: null,
    isPickable: false,
    alwaysSelectAsActiveMesh: false,
    renderingGroupId: 0,
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
    dispose: jest.fn(),
    setEnabled: jest.fn(),
});

const mockTransformNodeInstance = () => ({
    parent: null,
    position: { x: 0, y: 0, z: 0, set: jest.fn() },
    computeWorldMatrix: jest.fn(),
    dispose: jest.fn(),
});

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color3: jest.fn(() => ({ r: 0, g: 0, b: 0 })),
}));

jest.unstable_mockModule("@babylonjs/core/Engines/constants", () => ({
    Constants: { ALPHA_ADD: 6 },
}));

jest.unstable_mockModule("@babylonjs/core/Layers/glowLayer", () => ({
    GlowLayer: jest.fn(() => ({
        intensity: 0,
        addIncludedOnlyMesh: jest.fn(),
        dispose: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: jest.fn(() => ({
        disableLighting: false,
        emissiveColor: null,
        diffuseColor: null,
        specularColor: null,
        alpha: 1,
        alphaMode: 0,
        backFaceCulling: true,
        dispose: jest.fn(),
    })),
}));

const TrailMeshMock = jest.fn(mockTrailMeshInstance);
jest.unstable_mockModule("@babylonjs/core/Meshes/trailMesh", () => ({
    TrailMesh: TrailMeshMock,
}));

const TransformNodeMock = jest.fn(mockTransformNodeInstance);
jest.unstable_mockModule("@babylonjs/core/Meshes/transformNode", () => ({
    TransformNode: TransformNodeMock,
}));

// --- テスト ---

const MODEL_NODE_NAME = "model-test";

const createMockScene = (): Scene =>
    ({
        getTransformNodeByName: jest.fn(() => ({
            computeWorldMatrix: jest.fn(),
        })),
    }) as unknown as Scene;

describe("createAfterburner", () => {
    let createAfterburner: typeof import("../src/demos/flight/afterburner").createAfterburner;

    beforeAll(async () => {
        const mod = await import("../src/demos/flight/afterburner");
        createAfterburner = mod.createAfterburner;
    });

    it("start が TrailMesh と TransformNode を生成する", () => {
        const scene = createMockScene();
        const ab = createAfterburner(scene);

        TrailMeshMock.mockClear();
        TransformNodeMock.mockClear();

        ab.start({ scene, modelNodeName: MODEL_NODE_NAME });

        // 左右2つの generator TransformNode が作成される
        expect(TransformNodeMock).toHaveBeenCalledTimes(2);
        // 左右2つの TrailMesh が作成される
        expect(TrailMeshMock).toHaveBeenCalledTimes(2);
    });

    it("setVisible(false) で TrailMesh が stop/setEnabled(false) される", () => {
        TrailMeshMock.mockClear();

        const scene = createMockScene();
        const ab = createAfterburner(scene);
        ab.start({ scene, modelNodeName: MODEL_NODE_NAME });

        const trailInstances = TrailMeshMock.mock.results.map((r) => r.value);

        ab.setVisible(false);

        for (const trail of trailInstances) {
            expect(trail.stop).toHaveBeenCalled();
            expect(trail.setEnabled).toHaveBeenCalledWith(false);
        }
    });

    it("setVisible(true) で TrailMesh が start/setEnabled(true) される", () => {
        TrailMeshMock.mockClear();

        const scene = createMockScene();
        const ab = createAfterburner(scene);
        ab.start({ scene, modelNodeName: MODEL_NODE_NAME });

        ab.setVisible(false);
        // clear mocks to check next call
        const trailInstances = TrailMeshMock.mock.results.map((r) => r.value);
        for (const t of trailInstances) {
            (t.start as jest.Mock).mockClear();
            (t.setEnabled as jest.Mock).mockClear();
        }

        ab.setVisible(true);

        for (const trail of trailInstances) {
            expect(trail.start).toHaveBeenCalled();
            expect(trail.setEnabled).toHaveBeenCalledWith(true);
        }
    });

    it("stop/dispose を二重呼び出ししてもエラーにならない", () => {
        const scene = createMockScene();
        const ab = createAfterburner(scene);
        ab.start({ scene, modelNodeName: MODEL_NODE_NAME });

        expect(() => {
            ab.stop();
            ab.stop();
        }).not.toThrow();

        expect(() => {
            ab.dispose();
            ab.dispose();
        }).not.toThrow();
    });

    it("start 前に stop/reset/setVisible を呼んでもエラーにならない", () => {
        const scene = createMockScene();
        const ab = createAfterburner(scene);

        expect(() => {
            ab.stop();
            ab.reset();
            ab.setVisible(false);
            ab.setVisible(true);
        }).not.toThrow();
    });
});
