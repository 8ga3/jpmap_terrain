import { Scene } from "@babylonjs/core/scene";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SunState } from "./sunState";

/**
 * `createSkybox` の戻り値。Mesh 単体だけでなく、太陽位置を流し込むための
 * `applySunToSky` も合わせて返す。利用側は `applySunToSky(state)` を毎更新ごとに呼び、
 * `inclination` / `azimuth` / `luminance` をワンセットで反映する。
 */
export interface SkyboxHandle {
    /** Skybox メッシュ */
    mesh: Mesh;
    /** SkyMaterial インスタンス（テスト・デバッグ用に露出） */
    material: SkyMaterial;
    /** 太陽位置パラメータを SkyMaterial へ流し込む */
    applySunToSky(state: SunState): void;
}

export function createSkybox(scene: Scene): SkyboxHandle {
    const skyboxSize = (scene.activeCamera?.maxZ ?? 100000) * 10;

    const skyMaterial = new SkyMaterial("sky-material", scene);
    skyMaterial.backFaceCulling = false;
    skyMaterial.turbidity = 10;
    skyMaterial.luminance = 1;
    skyMaterial.rayleigh = 2;
    skyMaterial.mieCoefficient = 0.005;
    skyMaterial.mieDirectionalG = 0.8;
    skyMaterial.inclination = 0.25;
    skyMaterial.azimuth = 0.25;

    const skybox = CreateBox("skybox", { size: skyboxSize }, scene);
    skybox.material = skyMaterial;
    skybox.isPickable = false;
    skybox.infiniteDistance = true;

    const applySunToSky = (state: SunState): void => {
        skyMaterial.inclination = state.skyInclination;
        skyMaterial.azimuth = state.skyAzimuth;
        skyMaterial.luminance = state.skyLuminance;
    };

    return { mesh: skybox, material: skyMaterial, applySunToSky };
}
