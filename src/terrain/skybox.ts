import { Scene } from "@babylonjs/core/scene";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SunState } from "./sunState";

/** SkyMaterial.rayleigh の基準値（低高度・地表での青空散乱量）。 */
const BASE_RAYLEIGH = 2;

/**
 * 空が暗化し始める高度（メートル）。現実の大気では成層圏付近からレイリー散乱が
 * 急速に弱まり空が暗い青へ転じるため、約 12km を開始点とする（Issue #371）。
 */
export const SPACE_FADE_START_M = 12000;
/**
 * 空がほぼ黒（宇宙空間）になる高度（メートル）。カメラ高度上限（75km）に合わせる。
 * 現実のカーマンライン（100km）には届かないが、上限で「ほぼ黒」へ収束させる。
 */
export const SPACE_FADE_END_M = 75000;

/** `t` を `[edge0, edge1]` で正規化し Hermite smoothstep で滑らかにする。 */
const smoothstep = (edge0: number, edge1: number, t: number): number => {
    if (edge1 === edge0) return t < edge0 ? 0 : 1;
    const x = Math.max(0, Math.min(1, (t - edge0) / (edge1 - edge0)));
    return x * x * (3 - 2 * x);
};

/**
 * カメラ高度（メートル）から「宇宙度」を導く純関数。
 * 0=低高度の青空、1=高高度でほぼ黒。`SPACE_FADE_START_M`〜`SPACE_FADE_END_M` を
 * smoothstep で連続補間する（Issue #371）。
 */
export function computeSpaceFactor(altitudeMeters: number): number {
    if (!Number.isFinite(altitudeMeters)) return 0;
    return smoothstep(SPACE_FADE_START_M, SPACE_FADE_END_M, altitudeMeters);
}

/**
 * `createSkybox` の戻り値。Mesh 単体だけでなく、太陽位置を流し込むための
 * `applySunToSky` も合わせて返す。利用側は `applySunToSky(state, spaceFactor)` を毎更新ごとに呼び、
 * `inclination` / `azimuth` / `luminance` と高度連動の暗化をワンセットで反映する。
 */
export interface SkyboxHandle {
    /** Skybox メッシュ */
    mesh: Mesh;
    /** SkyMaterial インスタンス（テスト・デバッグ用に露出） */
    material: SkyMaterial;
    /**
     * 太陽位置パラメータと高度連動の暗化を SkyMaterial へ流し込む。
     * @param state 時刻連動の太陽パラメータ
     * @param spaceFactor 高度連動の宇宙度（0=青空, 1=ほぼ黒）。既定 0。
     */
    applySunToSky(state: SunState, spaceFactor?: number): void;
}

export function createSkybox(scene: Scene): SkyboxHandle {
    const skyboxSize = (scene.activeCamera?.maxZ ?? 100000) * 10;

    const skyMaterial = new SkyMaterial("sky-material", scene);
    skyMaterial.backFaceCulling = false;
    skyMaterial.turbidity = 10;
    skyMaterial.luminance = 1;
    skyMaterial.rayleigh = BASE_RAYLEIGH;
    skyMaterial.mieCoefficient = 0.005;
    skyMaterial.mieDirectionalG = 0.8;
    skyMaterial.inclination = 0.25;
    skyMaterial.azimuth = 0.25;

    const skybox = CreateBox("skybox", { size: skyboxSize }, scene);
    skybox.material = skyMaterial;
    skybox.isPickable = false;
    skybox.infiniteDistance = true;

    const applySunToSky = (state: SunState, spaceFactor = 0): void => {
        const f = Math.max(0, Math.min(1, spaceFactor));
        skyMaterial.inclination = state.skyInclination;
        skyMaterial.azimuth = state.skyAzimuth;
        // 高度が上がるほど輝度とレイリー散乱を 0 へ落とし、空を黒（宇宙）へ近づける。
        skyMaterial.luminance = state.skyLuminance * (1 - f);
        skyMaterial.rayleigh = BASE_RAYLEIGH * (1 - f);
    };

    return { mesh: skybox, material: skyMaterial, applySunToSky };
}
