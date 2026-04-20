import { Scene } from "@babylonjs/core/scene";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

const SKYBOX_SIZE = 1000000;

export function createSkybox(scene: Scene): Mesh {
    const skyMaterial = new SkyMaterial("sky-material", scene);
    skyMaterial.backFaceCulling = false;
    skyMaterial.turbidity = 10;
    skyMaterial.luminance = 1;
    skyMaterial.rayleigh = 2;
    skyMaterial.mieCoefficient = 0.005;
    skyMaterial.mieDirectionalG = 0.8;
    skyMaterial.inclination = 0.25;
    skyMaterial.azimuth = 0.25;

    const skybox = CreateBox("skybox", { size: SKYBOX_SIZE }, scene);
    skybox.material = skyMaterial;
    skybox.isPickable = false;
    skybox.infiniteDistance = true;

    return skybox;
}
