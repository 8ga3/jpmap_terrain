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

    it("CreateBox を呼び出して skybox ハンドルを返す", () => {
        const result = createSkybox(mockScene);
        expect(CreateBox).toHaveBeenCalledWith(
            "skybox",
            expect.objectContaining({ size: expect.any(Number) }),
            mockScene
        );
        // ハンドル経由で mesh / material / applySunToSky を露出する。
        expect(result.mesh).toBe(mockMesh);
        expect(result.material).toBe(mockSkyMaterialInstance);
        expect(typeof result.applySunToSky).toBe("function");
    });

    it("applySunToSky は SunState を SkyMaterial へ反映する", () => {
        const handle = createSkybox(mockScene);
        handle.applySunToSky({
            // sunDir はここでは検証しない（Skybox 側では不要）。
            sunDir: { x: 0, y: 1, z: 0 } as unknown as never,
            dayFactor: 1,
            skyInclination: 0.1,
            skyAzimuth: 0.7,
            skyLuminance: 0.42,
            skyVisible: true,
            clearColor: { r: 0.75, g: 0.86, b: 0.95 } as unknown as never,
            visibleAboveHorizon: true,
        });
        expect(mockSkyMaterialInstance.inclination).toBeCloseTo(0.1, 5);
        expect(mockSkyMaterialInstance.azimuth).toBeCloseTo(0.7, 5);
        expect(mockSkyMaterialInstance.luminance).toBeCloseTo(0.42, 5);
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
