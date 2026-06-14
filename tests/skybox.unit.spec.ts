/**
 * skybox のユニットテスト。
 * Babylon.js の Scene/Mesh/SkyMaterial をモックして、生成ロジックを検証する。
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

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
const { computeSpaceFactor, SPACE_FADE_START_M, SPACE_FADE_END_M } = await import(
    "../src/terrain/skybox"
);
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
            // sunDir はここでは検証しない（Skybox 側では不要）が、`SunState` 型の意図を保つため
            // 実際の `Vector3` / `Color3` を渡す（型キャストでチェックを無効化しない）。
            sunDir: new Vector3(0, 1, 0),
            dayFactor: 1,
            skyInclination: 0.1,
            skyAzimuth: 0.7,
            skyLuminance: 0.42,
            skyVisible: true,
            clearColor: new Color3(0.75, 0.86, 0.95),
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

    it("applySunToSky は spaceFactor で luminance / rayleigh を暗化する", () => {
        const handle = createSkybox(mockScene);
        const state = {
            sunDir: new Vector3(0, 1, 0),
            dayFactor: 1,
            skyInclination: 0.1,
            skyAzimuth: 0.7,
            skyLuminance: 0.5,
            skyVisible: true,
            clearColor: new Color3(0.75, 0.86, 0.95),
            visibleAboveHorizon: true,
        };
        // spaceFactor=1 で空はほぼ黒（luminance/rayleigh が 0）。
        handle.applySunToSky(state, 1);
        expect(mockSkyMaterialInstance.luminance).toBeCloseTo(0, 5);
        expect(mockSkyMaterialInstance.rayleigh).toBeCloseTo(0, 5);
        // spaceFactor=0 では従来どおり（luminance=skyLuminance, rayleigh=2）。
        handle.applySunToSky(state, 0);
        expect(mockSkyMaterialInstance.luminance).toBeCloseTo(0.5, 5);
        expect(mockSkyMaterialInstance.rayleigh).toBeCloseTo(2, 5);
        // 中間（0.5）は線形に減衰。
        handle.applySunToSky(state, 0.5);
        expect(mockSkyMaterialInstance.luminance).toBeCloseTo(0.25, 5);
        expect(mockSkyMaterialInstance.rayleigh).toBeCloseTo(1, 5);
    });
});

describe("computeSpaceFactor", () => {
    it("開始高度以下では 0（青空）", () => {
        expect(computeSpaceFactor(0)).toBe(0);
        expect(computeSpaceFactor(SPACE_FADE_START_M)).toBe(0);
        expect(computeSpaceFactor(-100)).toBe(0);
    });

    it("終了高度以上では 1（ほぼ黒）", () => {
        expect(computeSpaceFactor(SPACE_FADE_END_M)).toBe(1);
        expect(computeSpaceFactor(SPACE_FADE_END_M + 10000)).toBe(1);
    });

    it("中間高度では 0..1 で単調増加する", () => {
        const mid = (SPACE_FADE_START_M + SPACE_FADE_END_M) / 2;
        const v = computeSpaceFactor(mid);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
        const lower = computeSpaceFactor(mid - 5000);
        const upper = computeSpaceFactor(mid + 5000);
        expect(lower).toBeLessThan(v);
        expect(upper).toBeGreaterThan(v);
    });

    it("非有限値は 0 を返す", () => {
        expect(computeSpaceFactor(Number.NaN)).toBe(0);
        expect(computeSpaceFactor(Number.POSITIVE_INFINITY)).toBe(0);
    });
});
