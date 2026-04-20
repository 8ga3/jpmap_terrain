/**
 * skybox のユニットテスト。
 * Babylon.js の Scene/Mesh/SkyMaterial をモックして、生成ロジックを検証する。
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

let mockMesh: {
    material: unknown;
    isPickable: boolean;
    infiniteDistance: boolean;
};

let mockSkyMaterialInstance: {
    backFaceCulling: boolean;
    turbidity: number;
    luminance: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
    inclination: number;
    azimuth: number;
};

function createFreshMesh() {
    return {
        material: null as unknown,
        isPickable: true,
        infiniteDistance: false,
    };
}

function createFreshSkyMaterial() {
    return {
        backFaceCulling: true,
        turbidity: 0,
        luminance: 0,
        rayleigh: 0,
        mieCoefficient: 0,
        mieDirectionalG: 0,
        inclination: 0,
        azimuth: 0,
    };
}

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/boxBuilder", () => ({
    CreateBox: jest.fn(() => mockMesh),
}));

jest.unstable_mockModule("@babylonjs/materials/sky/skyMaterial", () => ({
    SkyMaterial: jest.fn(() => mockSkyMaterialInstance),
}));

const { createSkybox } = await import("../src/terrain/skybox");
const { CreateBox } = await import("@babylonjs/core/Meshes/Builders/boxBuilder");

const mockScene = {} as never;

describe("createSkybox", () => {
    beforeEach(() => {
        mockMesh = createFreshMesh();
        mockSkyMaterialInstance = createFreshSkyMaterial();
        jest.clearAllMocks();
    });

    it("CreateBox を呼び出して skybox メッシュを返す", () => {
        const result = createSkybox(mockScene);
        expect(CreateBox).toHaveBeenCalledWith(
            "skybox",
            expect.objectContaining({ size: expect.any(Number) }),
            mockScene
        );
        expect(result).toBe(mockMesh);
    });

    it("skybox は isPickable = false に設定される", () => {
        createSkybox(mockScene);
        expect(mockMesh.isPickable).toBe(false);
    });

    it("skybox は infiniteDistance = true に設定される", () => {
        createSkybox(mockScene);
        expect(mockMesh.infiniteDistance).toBe(true);
    });

    it("SkyMaterial の backFaceCulling が false に設定される", () => {
        createSkybox(mockScene);
        expect(mockSkyMaterialInstance.backFaceCulling).toBe(false);
    });

    it("skybox に SkyMaterial が割り当てられる", () => {
        createSkybox(mockScene);
        expect(mockMesh.material).toBe(mockSkyMaterialInstance);
    });
});
