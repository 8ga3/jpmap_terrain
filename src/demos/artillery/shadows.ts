/**
 * 砲台・砲弾の影描画
 *
 * 真上からの平行光源 (DirectionalLight) と ShadowGenerator を用いて、
 * 砲台メッシュと砲弾メッシュの影を地形 (tile-ground-*) に落とす。
 *
 * 設定方針（旧 planar シーンの太陽影実装に倣う）:
 * - フィルタは Poisson sampling。`useBlurExponentialShadowMap` は WebGPU 経路で
 *   infiniteDistance メッシュ（太陽メッシュ等）と干渉して破綻し、PCF
 *   (`usePercentageCloserFiltering`) は WebGPU で comparison サンプラのバインドに
 *   失敗してシーン全体が白画面になる。Poisson sampling は双方で安定する。
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

import type { StageFrame } from "./stageFrame";

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

export const createArtilleryShadows = (
    scene: Scene,
    stage?: StageFrame,
): ArtilleryShadows => {
    // 影を視認可能にするためのライティング再構成。
    //
    // シーンには環境光（HemisphericLight）と影を持たない主たる平行光
    // （DirectionalLight）の 2 つがある。命名はシーンで異なる:
    //   - 旧 planar シーン: `sky-light` / `sun-light`
    //   - globe  (src/scenes/globe.ts)  : `globe-hemi` / `globe-sun`
    //
    // この主平行光が「影を持たないまま」地面全体をフル照明するため、こちらの
    // 平行光で落とした影の領域も環境光 + 主平行光で明るく塗りつぶされ、
    // 明るい地図テクスチャ上では飽和して影の減光が一切見えない。これが
    // 各種パラメータを調整しても影が出なかった根本原因。globe では命名差により
    // 主平行光（globe-sun）が減光されず、影が出力されていても完全に飛んでいた。
    //
    // 対策: 競合する主平行光を消し、環境光を低めの fill light に抑え、
    // こちらの artillery-top-light を唯一の主たる平行光（かつ影源）にする。
    // これにより影領域は環境光のみ（暗い）、非影領域は環境光＋平行光（明るい）
    // となり、明確な輝度差で影が地面に現れる。
    const hemi = (scene.getLightByName("sky-light") ??
        scene.getLightByName("globe-hemi")) as HemisphericLight | null;
    const competingSun =
        scene.getLightByName("sun-light") ??
        scene.getLightByName("globe-sun");
    // dispose 時にシーン側のライティングを汚染したまま残さないよう、
    // 変更前の intensity / 有効状態を保存しておき復元する。
    const prevHemiIntensity = hemi?.intensity ?? null;
    const prevSunIntensity = competingSun?.intensity ?? null;
    const prevSunEnabled = competingSun?.isEnabled() ?? null;
    if (hemi) hemi.intensity = 0.4;
    // 影を持たない主たる平行光は影をかき消すため無効化する。
    // planar はこれまでどおり intensity=0 のみで無効化する（既存挙動を維持）。
    // globe では globeSceneController の applyGlobeSunState が注視点移動（>1km）を
    // 契機に globe-sun.intensity を GLOBE_SUN_LIGHT_INTENSITY へ再適用するため、
    // intensity=0 だけでは artillery 起動時のカメラ寄せで即座に revert され影が飛ぶ。
    // applyGlobeSunState は setEnabled を触らないため、globe では setEnabled(false) で
    // 無効化して intensity 再適用に左右されず確実に競合光を断つ。
    if (competingSun) {
        competingSun.intensity = 0;
        if (stage?.root) {
            competingSun.setEnabled(false);
        }
    }

    // 光源方向。ユーザー要望は「真上」だが、完全な鉛直 (0,-1,0) や極端に近い値
    // (0.001,-1,0.001) では ShadowGenerator のビュー行列の up ベクトルが退化し、
    // シャドウマップが壊れて影が一切描画されない（Babylon の既知挙動）。
    // また真下すぎる影は物体の真下に隠れて視認できない。
    // そのため「ほぼ真上」を保ちつつ、影が安定して地面に投影される最小限の傾き
    // (約 8°) を与える。
    //
    // globe（stageRoot）では「真上」はステージの ENU Up（ECEF ベクトル）であり、
    // 光源の方向・位置を ENU フレームへ写像する。planar はワールド軸そのまま。
    const stageRoot = stage?.root ?? null;
    let lightDir: Vector3;
    let lightPos: Vector3;
    if (stageRoot && stage) {
        // ローカル方向 (0.12,-1,0.1) を ENU basis で ECEF へ写像（原点差分で方向化）。
        const originW = stage.localToWorld(Vector3.Zero(), new Vector3());
        const tipW = stage.localToWorld(new Vector3(0.12, -1, 0.1), new Vector3());
        lightDir = tipW.subtract(originW).normalize();
        lightPos = stage.localToWorld(new Vector3(0, LIGHT_HEIGHT, 0), new Vector3());
    } else {
        lightDir = new Vector3(0.12, -1, 0.1);
        lightPos = new Vector3(0, LIGHT_HEIGHT, 0);
    }
    const light = new DirectionalLight("artillery-top-light", lightDir, scene);
    // 戦場の遥か上空（中心の真上）に光源を置く。
    light.position = lightPos;
    // 環境光を下げた分、平行光を主光源として明るくする。これにより影部分
    // （平行光が遮られる領域）との輝度差が生まれ、影が視認できる。
    light.intensity = 1.0;

    // orthographic frustum を戦場サイズに固定する。
    // autoUpdateExtends=true（デフォルト）のままにすると、毎フレーム砲台メッシュのバウンディング
    // ボックスから XY 範囲が自動計算され、手動設定した ortho 値が上書きされる。
    // false にして手動設定を使う（太陽影と同じ方式）。
    light.autoUpdateExtends = false;
    light.autoCalcShadowZBounds = false;
    light.shadowMinZ = 1;
    light.shadowMaxZ = LIGHT_HEIGHT + 2000;
    light.orthoLeft = -FRUSTUM_RADIUS;
    light.orthoRight = FRUSTUM_RADIUS;
    light.orthoTop = FRUSTUM_RADIUS;
    light.orthoBottom = -FRUSTUM_RADIUS;

    const generator = new ShadowGenerator(SHADOW_MAP_SIZE, light);
    // フィルタ選定: PCF (`usePercentageCloserFiltering`) は WebGPU で comparison 付き
    // depth-stencil サンプラ（`shadowTexture2` / `shadowTexture2Sampler`）を要求するが、
    // 影マップのテクスチャがバインドされず `createBindGroup` がクラッシュし、シーン全体
    // （地形・砲台）が一切描画されず白画面になる（旧 planar シーンの
    // 太陽影と同じ対処）。Poisson sampling は通常テクスチャとしてバインドされ PostProcess も
    // 伴わないため、WebGL2 / WebGPU 双方で安定して動作する。
    generator.usePoissonSampling = true;
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
    let lastScannedMeshCount = 0;
    // 地形タイルの命名規約: planar=`tile-ground-*` / globe=`tile-*`・`base-tile-*`。
    const isTerrainReceiver = (name: string): boolean =>
        stageRoot
            ? name.startsWith("tile-") || name.startsWith("base-tile-")
            : name.startsWith("tile-ground-");
    const registerTerrainReceivers = (): void => {
        const meshes = scene.meshes;
        // メッシュが dispose されて配列が縮むとインデックスがずれるため、
        // 縮小を検知したらスキャン位置をリセットして全走査し直す。
        // receivers(WeakSet) により登録済みメッシュの再処理は抑止される。
        if (meshes.length < lastScannedMeshCount) {
            lastScannedMeshCount = 0;
        }
        if (meshes.length <= lastScannedMeshCount) return;
        for (let i = lastScannedMeshCount; i < meshes.length; i++) {
            const mesh = meshes[i];
            if (!isTerrainReceiver(mesh.name)) continue;
            if (receivers.has(mesh)) continue;
            mesh.receiveShadows = true;
            receivers.add(mesh);
        }
        lastScannedMeshCount = meshes.length;
    };

    const dispose = (): void => {
        generator.dispose();
        light.dispose();
        casters.clear();
        // createArtilleryShadows で変更した既存ライトの intensity を復元し、
        // シーン側のライティングを元に戻す。
        if (hemi && prevHemiIntensity !== null) {
            hemi.intensity = prevHemiIntensity;
        }
        if (competingSun && prevSunIntensity !== null) {
            competingSun.intensity = prevSunIntensity;
        }
        if (competingSun && prevSunEnabled !== null) {
            competingSun.setEnabled(prevSunEnabled);
        }
    };

    return { addCaster, registerTerrainReceivers, dispose };
};
