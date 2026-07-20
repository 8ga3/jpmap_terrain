/**
 * [一時的な診断コード / temporary diagnostic] Quest 3実機で
 * 「A/B/C（単一タイル・板ポリ）はAR中も正常表示できるが、本体の箱庭
 * （複雑な放射状メッシュ + 複数タイルのモザイクテクスチャ）は透けたまま」
 * という結果を受けて、残る2変数（メッシュの複雑さ / テクスチャの
 * サイズ・タイル数）のどちらが原因かを切り分けるための追加テスト。
 *
 * @remarks
 * - D（複雑なメッシュ卒業・単純テクスチャ）: 本体の箱庭メッシュの
 *   `material.diffuseTexture` を、単一タイルの「動作確認済み」テクスチャへ
 *   直接差し替える。地図はズレて表示されるが、それでも表示されるかどうかが
 *   重要（UV不整合は無視して良い、本テストの目的ではないため）。
 * - E（単純メッシュ・本番同様の複数タイルモザイクテクスチャ）: 実際の
 *   `buildDioramaGridPoints` / `computeDioramaTextureLayout` /
 *   `buildDioramaMosaicTexture`（本番と全く同じ関数）を使って複数タイルの
 *   モザイクテクスチャを生成し、単純な板ポリに貼る。
 *
 * Dが失敗（透ける）→ メッシュ（放射状グリッド・UV・法線等）に原因がある。
 * Eが失敗（透ける）→ モザイクテクスチャ自体（サイズ・NPOT・タイル数）に原因がある。
 *
 * **本ファイルは診断目的の一時的なコードであり、確認後にこのコミットごと
 * revertして破棄する予定**（ユーザー指示）。
 */
import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { buildDioramaGridPoints, type DioramaCenter } from "../../terrain/diorama/dioramaGrid";
import { computeDioramaTextureLayout, buildDioramaMosaicTexture } from "../../terrain/diorama/dioramaTexture";
import { toTileXY, textureUrl, type MapType } from "../../terrain/gsiTile";

/**
 * テストD: 本番と全く同じ関数（`computeDioramaTextureLayout` /
 * `buildDioramaMosaicTexture`）で複数タイルのモザイクテクスチャを生成し、
 * 単純な板ポリに貼る。
 */
export const createMosaicOnSimplePlaneTest = async (
    scene: Scene,
    center: DioramaCenter,
    footprintRadiusM: number,
    textureZoom: number,
    mapType: MapType,
): Promise<TransformNode> => {
    const points = buildDioramaGridPoints(center, footprintRadiusM, { ringCount: 12, radialSegments: 48 });
    const layout = computeDioramaTextureLayout(points, textureZoom);
    const texture = await buildDioramaMosaicTexture(scene, layout, mapType, "texture-de-test-E-mosaic");

    const root = new TransformNode("texture-de-test-E-root", scene);
    const plane = CreatePlane(
        "texture-de-test-E-plane",
        { width: 0.3, height: (0.3 * layout.mosaicHeightPx) / layout.mosaicWidthPx, sideOrientation: Mesh.FRONTSIDE },
        scene,
    );
    plane.parent = root;
    const material = new StandardMaterial("texture-de-test-E-material", scene);
    material.diffuseTexture = texture;
    material.specularColor = Color3.Black();
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    material.diffuseTexture.hasAlpha = false;
    plane.material = material;

    return root;
};

/**
 * テストE: 本体の箱庭メッシュ（`dioramaMesh`）の `diffuseTexture` を、
 * 単一タイルの「動作確認済み」テクスチャへ直接差し替える。UVはそのまま
 * （本番のモザイクレイアウト用）のため地図はズレて表示されるが、本テストの
 * 目的はズレの有無ではなく「複雑なメッシュ自体がAR中に表示されるか」の確認。
 */
export const swapDioramaTextureWithSimpleTile = (
    scene: Scene,
    dioramaMesh: Mesh,
    center: DioramaCenter,
    zoom: number,
    mapType: MapType,
): void => {
    const { x, y } = toTileXY(center.lat, center.lon, zoom);
    const url = textureUrl(mapType, zoom, x, y);
    const texture = new Texture(url, scene, false, false);
    const material = dioramaMesh.material as StandardMaterial | null;
    if (!material) return;
    material.diffuseTexture = texture;
    material.diffuseTexture.hasAlpha = false;
};
