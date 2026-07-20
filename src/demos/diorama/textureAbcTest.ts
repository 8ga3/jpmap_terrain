/**
 * [一時的な診断コード / temporary diagnostic] Quest 3実機で「地形メッシュの
 * isReady/material.isReady/diffuseTexture.isReady が全てtrueなのに、AR中は
 * 地図テクスチャが透けて見える（壁は問題ない）」という不具合の原因を切り分ける
 * ためのA/Bテスト。
 *
 * @remarks
 * 3種類のテクスチャ生成方式で、同じ1枚のタイル画像を貼った板ポリを並べて表示する:
 * - A（左）: リモートURLを直接 `Texture` で読み込む（既に実機でAR中も正常表示
 *   できることを確認済みの「対照群」）。
 * - B（中央）: canvasへ描画 → `canvas.toBlob()` → `URL.createObjectURL()` →
 *   `Texture` で読み込む（現在の本番実装 `buildDioramaMosaicTexture` と同じ方式）。
 * - C（右）: canvasへ描画 → `ctx.getImageData()` → `RawTexture.CreateRGBATexture()`
 *   （`<img>`要素・URL読み込みを一切経由しない、最も直接的なアップロード方式）。
 *
 * A/B/Cのうちどれが実機のAR中に透けるかによって、原因を
 * 「blob: URLがAR中のテクスチャ合成と相性が悪い」のか
 * 「canvas由来のピクセルデータ全般がAR中のテクスチャ合成と相性が悪い」のか
 * 切り分けられる。
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
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { TILE_SIZE, toTileXY, textureUrl, type MapType } from "../../terrain/gsiTile";

const FETCH_TIMEOUT_MS = 15000;

const loadTileBitmap = async (url: string): Promise<ImageBitmap> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Tile fetch failed (${res.status}): ${url}`);
    const blob = await res.blob();
    return createImageBitmap(blob);
};

const drawTileToCanvas = async (url: string): Promise<HTMLCanvasElement> => {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("failed to acquire 2D context");
    const bitmap = await loadTileBitmap(url);
    ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
    bitmap.close();
    return canvas;
};

const createPlaneWithTexture = (
    scene: Scene,
    parent: TransformNode,
    name: string,
    xOffsetM: number,
    texture: Texture,
): Mesh => {
    const plane = CreatePlane(name, { size: 0.3, sideOrientation: Mesh.FRONTSIDE }, scene);
    plane.parent = parent;
    plane.position.x = xOffsetM;
    const material = new StandardMaterial(`${name}-material`, scene);
    material.diffuseTexture = texture;
    material.specularColor = Color3.Black();
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    material.diffuseTexture.hasAlpha = false;
    plane.material = material;
    return plane;
};

/**
 * A（リモートURL直読み）/ B（canvas→blob→Texture）/ C（canvas→RawTexture）の
 * 3枚の板ポリを生成して返す。
 */
export const createTextureAbcTest = async (
    scene: Scene,
    center: { lat: number; lon: number },
    zoom: number,
    mapType: MapType,
): Promise<TransformNode> => {
    const root = new TransformNode("texture-abc-test-root", scene);
    const { x, y } = toTileXY(center.lat, center.lon, zoom);
    const url = textureUrl(mapType, zoom, x, y);

    // A: リモートURL直読み（対照群）。
    const textureA = new Texture(url, scene, false, false);
    createPlaneWithTexture(scene, root, "abc-test-A", -0.4, textureA);

    // B/C共通: 同じタイルをcanvasへ一旦描画してから、異なる方式でTexture化する。
    const canvas = await drawTileToCanvas(url);

    // B: canvas → blob → URL.createObjectURL → Texture（現在の本番実装と同じ方式）。
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
    if (blob) {
        const objectUrl = URL.createObjectURL(blob);
        const textureB = new Texture(objectUrl, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE, () => {
            URL.revokeObjectURL(objectUrl);
        });
        createPlaneWithTexture(scene, root, "abc-test-B", 0, textureB);
    }

    // C: canvas → getImageData → RawTexture（<img>/URL読み込みを一切経由しない）。
    const ctx = canvas.getContext("2d");
    if (ctx) {
        const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
        const textureC = RawTexture.CreateRGBATexture(
            imageData.data,
            TILE_SIZE,
            TILE_SIZE,
            scene,
            false,
            false,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        createPlaneWithTexture(scene, root, "abc-test-C", 0.4, textureC);
    }

    return root;
};
