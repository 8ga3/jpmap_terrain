/**
 * 実機AR診断用: 基本プリミティブ（Cube + Cylinder x2）が Meta Quest 3 / Android スマホの
 * 両デバイスで正しく表示・オクルージョンされるかを確認するための一時的な切り分けコード。
 *
 * @remarks
 * これまでの調査で、独自構築の地形メッシュ（`VertexData` 手組み）と側面壁メッシュの組み合わせでは
 * `renderingGroupId`分離・深度バイアス（`zOffset`）・単一`Mesh`統合（`Mesh.MergeMeshes`）の
 * いずれを試しても、実機上での「側面壁が地形面を覆い隠す」不具合を機種間で一貫して解消できなかった。
 * 3つの大きく異なるアプローチが同一の症状を再現し続けたことから、問題が地形メッシュ固有の
 * 構築方法（独自VertexData・DynamicTexture由来のTexture等）に起因する可能性を切り分けるため、
 * Babylon標準の `MeshBuilder` プリミティブ（独自VertexDataを一切使わない）だけで、地形（薄い円盤）・
 * 側面壁（開いた円柱）と同様の位置関係を再現し、基本的な多メッシュAR描画・深度オクルージョンが
 * 機能するかどうかを単独で確認する。
 *
 * [一時的] 診断が終わったら削除する。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/** 器（側面壁の代わり）・円盤（地形面の代わり）の直径[m]。 */
const RIM_DIAMETER_M = 0.8;
/** 器（側面壁の代わり）の高さ[m]。 */
const BOWL_HEIGHT_M = 0.3;

/**
 * 診断用プリミティブ（器 = Cylinder、円盤 = Cylinder、参照用 = Cube）を `parent` の子として生成する。
 * 地形（円盤）は器の上端付近にわずかに重なるよう配置し、実際の地形/側面壁の位置関係
 * （器の上端に地形面が乗る構成）を再現する。
 */
export const createPrimitiveArTestObjects = (scene: Scene, parent: TransformNode): void => {
    // 器（側面壁の代わり）: 上下同径の開いた円柱、茶色。
    const bowl = MeshBuilder.CreateCylinder(
        "primitive-test-bowl",
        { diameter: RIM_DIAMETER_M, height: BOWL_HEIGHT_M, tessellation: 32 },
        scene,
    );
    bowl.position.y = BOWL_HEIGHT_M / 2;
    const bowlMaterial = new StandardMaterial("primitive-test-bowl-material", scene);
    bowlMaterial.diffuseColor = new Color3(0.55, 0.35, 0.2);
    bowlMaterial.specularColor = Color3.Black();
    bowlMaterial.backFaceCulling = false;
    bowl.material = bowlMaterial;
    bowl.parent = parent;

    // 円盤（地形面の代わり）: 薄い円柱、緑色。器の上端にわずかに重なる高さへ配置する
    // （実際の地形面/側面壁の境界と同様、わずかな重なりを意図的に作る）。
    const disc = MeshBuilder.CreateCylinder(
        "primitive-test-disc",
        { diameter: RIM_DIAMETER_M, height: 0.03, tessellation: 32 },
        scene,
    );
    disc.position.y = BOWL_HEIGHT_M - 0.005;
    const discMaterial = new StandardMaterial("primitive-test-disc-material", scene);
    discMaterial.diffuseColor = new Color3(0.2, 0.6, 0.25);
    discMaterial.specularColor = Color3.Black();
    discMaterial.backFaceCulling = false;
    disc.material = discMaterial;
    disc.parent = parent;

    // 参照用キューブ: 器/円盤の重なりとは無関係に、基本的な多メッシュAR描画そのものが
    // 機能しているかを確認するための単独オブジェクト（赤）。器/円盤の横に配置する。
    const cube = MeshBuilder.CreateBox("primitive-test-cube", { size: 0.25 }, scene);
    cube.position.set(RIM_DIAMETER_M / 2 + 0.3, 0.125, 0);
    const cubeMaterial = new StandardMaterial("primitive-test-cube-material", scene);
    cubeMaterial.diffuseColor = new Color3(0.8, 0.15, 0.15);
    cubeMaterial.specularColor = Color3.Black();
    cube.material = cubeMaterial;
    cube.parent = parent;
};
