/**
 * [一時的な診断コード / temporary diagnostic] 単純な板ポリ（平面）に地図タイル
 * テクスチャを1枚貼るだけの最小構成で、WebXR (`immersive-ar`) のパススルー
 * 合成中にテクスチャ付きメッシュが正しく表示されるかを切り分けるためのヘルパー。
 *
 * @remarks
 * - `dioramaTerrain`（放射状グリッド + DynamicTextureモザイク）を経由しない、
 *   独立した最小構成（Babylon標準の`Texture`をURLから直接読み込み、単一平面へ
 *   貼るだけ）にすることで、DynamicTexture固有の要因を切り分ける。
 * - 裏表が分かるよう、表面（front）に地図テクスチャ、裏面（back）に無地の赤
 *   （`Color3(1,0,0)`）を貼った2枚の板ポリを背中合わせに配置する。
 * - **本ファイルは診断目的の一時的なコードであり、確認後にこのコミットごと
 *   revertして破棄する予定**（ユーザー指示）。恒久的な実装に組み込む想定はない。
 */
import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { toTileXY, textureUrl, type MapType } from "../../terrain/gsiTile";

/** 裏面（back）の目印色（鮮やかな赤、地図テクスチャと明確に区別できる色）。 */
const BACK_MARKER_COLOR = new Color3(1, 0, 0);

/** 表裏2枚の板ポリの奥行きオフセット[m]（z-fighting防止）。 */
const BACK_PLANE_OFFSET_M = 0.01;

/**
 * 地図タイルテクスチャを1枚貼った板ポリ（表）＋無地赤の板ポリ（裏）を生成する。
 *
 * @param scene 配置先シーン。
 * @param center タイル取得に使う緯度経度（このタイルの中心付近が板ポリに写る）。
 * @param zoom タイルズームレベル。
 * @param mapType 地図種別（"std" | "photo"）。
 * @param sizeM 板ポリの一辺の長さ[m]。
 * @returns 表裏2枚の板ポリを子に持つ `TransformNode`。
 */
export const createDebugTexturePlane = (
    scene: Scene,
    center: { lat: number; lon: number },
    zoom: number,
    mapType: MapType,
    sizeM: number,
): TransformNode => {
    const root = new TransformNode("debug-texture-plane-root", scene);

    const { x, y } = toTileXY(center.lat, center.lon, zoom);
    const url = textureUrl(mapType, zoom, x, y);

    const front = CreatePlane("debug-plane-front", { size: sizeM, sideOrientation: Mesh.FRONTSIDE }, scene);
    front.parent = root;
    const frontMaterial = new StandardMaterial("debug-plane-front-material", scene);
    frontMaterial.diffuseTexture = new Texture(url, scene);
    frontMaterial.specularColor = Color3.Black();
    // 本Issueで実施した「AR中の透け」対策と同じ設定を、この最小構成でも検証する。
    frontMaterial.transparencyMode = Material.MATERIAL_OPAQUE;
    frontMaterial.diffuseTexture.hasAlpha = false;
    front.material = frontMaterial;

    const back = CreatePlane("debug-plane-back", { size: sizeM, sideOrientation: Mesh.FRONTSIDE }, scene);
    back.parent = root;
    // front と逆向きにし、かつわずかに奥へずらしてz-fightingを避ける。
    back.rotation.y = Math.PI;
    back.position.z = -BACK_PLANE_OFFSET_M;
    const backMaterial = new StandardMaterial("debug-plane-back-material", scene);
    backMaterial.diffuseColor = BACK_MARKER_COLOR;
    backMaterial.specularColor = Color3.Black();
    backMaterial.transparencyMode = Material.MATERIAL_OPAQUE;
    back.material = backMaterial;

    return root;
};
