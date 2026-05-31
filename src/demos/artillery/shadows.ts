/**
 * 砲台・砲弾の影描画 (Issue #259)
 *
 * 真上からの平行光源 (DirectionalLight) と ShadowGenerator を用いて、
 * 砲台メッシュと砲弾メッシュの影を地形 (tile-ground-*) に落とす。
 *
 * 設定方針（src/scenes/default.ts の太陽影実装 Issue #39 に倣う）:
 * - フィルタは PCF (Percentage Closer Filtering)。`useBlurExponentialShadowMap`
 *   は WebGPU 経路で infiniteDistance メッシュ（太陽メッシュ等）と干渉して破綻する
 *   ことが確認されているため使用しない。
 * - DirectionalLight は orthographic frustum を明示指定する。`autoUpdateExtends` /
 *   `autoCalcShadowZBounds` は使わず、戦場サイズに合わせた固定 frustum にすることで
 *   毎フレームコストと WebGPU 不安定要因を避ける。
 *
 * 受け手（地形タイル）はストリーミングで生成・破棄されるため、描画ループから
 * registerTerrainReceivers を呼んで随時 receiveShadows を設定する。
 * 砲弾メッシュはプールで遅延生成されるため、生成時に addCaster で登録する。
 */
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";

export interface ArtilleryShadows {
    /** 影を落とすメッシュ（砲台・砲弾）を登録する。 */
    addCaster: (mesh: AbstractMesh) => void;
    /**
     * 現在表示中の地形タイルを影の受け手として設定する。
     * タイルはストリーミングで増減するため、描画ループから毎フレーム呼ぶ。
     */
    registerTerrainReceivers: () => void;
    dispose: () => void;
}

/**
 * 影マップ解像度。戦場（±3000m）を 2048px でカバーし、約 3m/texel。
 * 砲台（直径約 80m）でも十分に精細な影が得られる。
 */
const SHADOW_MAP_SIZE = 2048;

/**
 * orthographic frustum の半径 (m)。砲台は中心から ±750m、砲弾の射程は
 * 最大約 2500m のため、余裕を持って 3000m とする。
 */
const FRUSTUM_RADIUS = 3000;

/** 光源の高度 (m)。砲弾の打ち上げ高度（最大約 2000m）より十分に高く取る。 */
const LIGHT_HEIGHT = 8000;

export const createArtilleryShadows = (scene: Scene): ArtilleryShadows => {
    // 影を視認可能にするためのライティング再構成。
    //
    // 既定シーンには次の 2 つのライトがある（src/scenes/default.ts）:
    //   - sky-light: HemisphericLight（全方向から均一に照らす環境光）
    //   - sun-light: DirectionalLight（真下向き・影を持たない）。太陽系統が
    //     昼間は intensity=1.0 に設定する。
    //
    // この sun-light が「影を持たないまま」地面全体をフル照明するため、こちらの
    // 平行光で落とした影の領域も sun-light + sky-light で明るく塗りつぶされ、
    // 明るい地図テクスチャ上では飽和して影の減光が一切見えない。これが
    // 各種パラメータを調整しても影が出なかった根本原因。
    //
    // 対策: 競合する sun-light を消し、環境光を低めの fill light に抑え、
    // こちらの artillery-top-light を唯一の主たる平行光（かつ影源）にする。
    // これにより影領域は環境光のみ（暗い）、非影領域は環境光＋平行光（明るい）
    // となり、明確な輝度差で影が地面に現れる。
    const hemi = scene.getLightByName("sky-light") as HemisphericLight | null;
    if (hemi) hemi.intensity = 0.4;
    // 影を持たない真下向きの平行光は影をかき消すため無効化する。
    const competingSun = scene.getLightByName("sun-light");
    if (competingSun) competingSun.intensity = 0;

    // 光源方向。ユーザー要望は「真上」だが、完全な鉛直 (0,-1,0) や極端に近い値
    // (0.001,-1,0.001) では ShadowGenerator のビュー行列の up ベクトルが退化し、
    // シャドウマップが壊れて影が一切描画されない（Babylon の既知挙動）。
    // また真下すぎる影は物体の真下に隠れて視認できない。
    // そのため「ほぼ真上」を保ちつつ、影が安定して地面に投影される最小限の傾き
    // (約 8°) を与える。
    const light = new DirectionalLight(
        "artillery-top-light",
        new Vector3(0.12, -1, 0.1),
        scene,
    );
    // 戦場の遥か上空（中心の真上）に光源を置く。
    light.position = new Vector3(0, LIGHT_HEIGHT, 0);
    // 環境光を下げた分、平行光を主光源として明るくする。これにより影部分
    // （平行光が遮られる領域）との輝度差が生まれ、影が視認できる。
    light.intensity = 1.0;

    // orthographic frustum を戦場サイズに固定する。
    // autoUpdateExtends=true（デフォルト）のままにすると、毎フレーム砲台メッシュのバウンディング
    // ボックスから XY 範囲が自動計算され、手動設定した ortho 値が上書きされる。
    // false にして手動設定を使う（Issue #39 の太陽影と同じ方式）。
    light.autoUpdateExtends = false;
    light.autoCalcShadowZBounds = false;
    light.shadowMinZ = 1;
    light.shadowMaxZ = LIGHT_HEIGHT + 2000;
    light.orthoLeft = -FRUSTUM_RADIUS;
    light.orthoRight = FRUSTUM_RADIUS;
    light.orthoTop = FRUSTUM_RADIUS;
    light.orthoBottom = -FRUSTUM_RADIUS;

    const generator = new ShadowGenerator(SHADOW_MAP_SIZE, light);
    // PCF を採用（WebGL2/WebGPU 双方で安定）。
    generator.usePercentageCloserFiltering = true;
    generator.bias = 0.0003;
    generator.normalBias = 0.02;
    // darkness=0.2: 影の最低輝度。0=真っ暗、1=影なし。はっきり見えるよう濃いめ。
    generator.setDarkness(0.2);

    const casters = new Set<AbstractMesh>();

    const addCaster = (mesh: AbstractMesh): void => {
        if (casters.has(mesh)) return;
        casters.add(mesh);
        generator.addShadowCaster(mesh);
    };

    const receivers = new WeakSet<AbstractMesh>();
    const registerTerrainReceivers = (): void => {
        for (const mesh of scene.meshes) {
            if (!mesh.name.startsWith("tile-ground-")) continue;
            if (receivers.has(mesh)) continue;
            mesh.receiveShadows = true;
            receivers.add(mesh);
        }
    };

    const dispose = (): void => {
        generator.dispose();
        light.dispose();
        casters.clear();
    };

    return { addCaster, registerTerrainReceivers, dispose };
};
