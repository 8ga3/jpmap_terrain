/**
 * 箱庭ジオラマ地形（円形放射状メッシュ + 縮小スケール）。
 *
 * `dioramaGrid`（放射状グリッド・純粋関数）・`dioramaElevation`（DEMバイリニア
 * サンプリング）・`dioramaTexture`（ラスタタイルのモザイク合成）を統合し、
 * Babylon.js の `Mesh` として構築する。
 *
 * 縮小スケール・回転・高さ変更（後続タスクで実装するコントローラー操作）は、
 * すべて公開する `root`（`TransformNode`）に対して適用する想定で、メッシュ自体は
 * 常に実世界メートル単位（中心からの東西・南北オフセット + 標高）で構築する。
 * 中心・フットプリント半径・地図種別の変更は、既存メッシュを破棄して
 * 作り直す（箱庭は視錐台駆動の連続更新ではなく、離散的な操作単位で
 * 再構築する設計のため）。
 */
import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";

import type { MapType } from "../gsiTile";
import {
    buildDioramaGridPoints,
    buildDioramaGridIndices,
    type DioramaCenter,
    type DioramaGridOptions,
} from "./dioramaGrid";
import { fetchDioramaElevations } from "./dioramaElevation";
import { computeDioramaTextureLayout, buildDioramaMosaicTexture } from "./dioramaTexture";
import { buildDioramaSkirtGeometry } from "./dioramaSkirt";

/** 箱庭地形の構築オプション。 */
export interface DioramaTerrainOptions {
    /** 実世界の中心（測地座標）。 */
    center: DioramaCenter;
    /** 実世界フットプリント半径[m]（拡大縮小操作で可変になる想定）。 */
    footprintRadiusM: number;
    /** 卓上表示半径[m]（`root` の縮小スケール算出に使用）。 */
    tableRadiusM: number;
    /** 同心円リング数（既定 12）。 */
    ringCount?: number;
    /** 1リングあたりの分割数（既定 48）。 */
    radialSegments?: number;
    /** 標高取得ズーム（既定 14）。 */
    demZoom?: number;
    /** テクスチャ取得ズーム（既定 16）。 */
    textureZoom?: number;
    /** 地図種別（既定 "std"、#542切替対象）。 */
    mapType?: MapType;
    /** 標高の垂直誇張倍率（`root` の一様スケール適用前、既定 1）。 */
    heightScaleFactor?: number;
    /**
     * 側面壁（土台）の深さ ÷ footprintRadiusM（既定 0.15）。
     * `root` の一様スケール適用後は tableRadiusM に対する比率として一定になるため、
     * フットプリント半径を変えても見た目の壁厚は変わらない。
     */
    baseDepthRatio?: number;
}

export interface DioramaTerrain {
    /** 現在の地形メッシュ（`setCenter` 等での再構築時に差し替わる）。 */
    readonly mesh: Mesh;
    /** スケール・回転・高さ変更の適用点（後続タスクが利用）。 */
    readonly root: TransformNode;
    setCenter(lat: number, lon: number): Promise<void>;
    setFootprintRadius(radiusM: number): Promise<void>;
    setMapType(mapType: MapType): Promise<void>;
    dispose(): void;
}

const DEFAULTS = {
    ringCount: 12,
    radialSegments: 48,
    demZoom: 14,
    textureZoom: 16,
    mapType: "std" as MapType,
    heightScaleFactor: 1,
    baseDepthRatio: 0.15,
};

/** 側面壁・底面（土台）の色（土色）。 */
const SOIL_COLOR = new Color3(0.36, 0.26, 0.16);

interface ResolvedOptions {
    center: DioramaCenter;
    footprintRadiusM: number;
    tableRadiusM: number;
    ringCount: number;
    radialSegments: number;
    demZoom: number;
    textureZoom: number;
    mapType: MapType;
    heightScaleFactor: number;
    baseDepthRatio: number;
}

const resolveOptions = (options: DioramaTerrainOptions): ResolvedOptions => {
    // tableRadiusM は root.scaling の分母（applyScale）になるため、構築完了を待たず
    // ここで早期に検証し、不正値（0/負数）による無効なスケール算出を防ぐ。
    if (!(options.tableRadiusM > 0)) {
        throw new RangeError(`tableRadiusM must be > 0 (got ${options.tableRadiusM})`);
    }
    // footprintRadiusM は buildDioramaGridPoints（dioramaGrid.ts）内でも検証されるが、
    // ここでも早期に検証し、非同期のタイル取得等を開始する前に失敗させる。
    if (!(options.footprintRadiusM > 0)) {
        throw new RangeError(`footprintRadiusM must be > 0 (got ${options.footprintRadiusM})`);
    }
    return {
        center: options.center,
        footprintRadiusM: options.footprintRadiusM,
        tableRadiusM: options.tableRadiusM,
        ringCount: options.ringCount ?? DEFAULTS.ringCount,
        radialSegments: options.radialSegments ?? DEFAULTS.radialSegments,
        demZoom: options.demZoom ?? DEFAULTS.demZoom,
        textureZoom: options.textureZoom ?? DEFAULTS.textureZoom,
        mapType: options.mapType ?? DEFAULTS.mapType,
        heightScaleFactor: options.heightScaleFactor ?? DEFAULTS.heightScaleFactor,
        baseDepthRatio: options.baseDepthRatio ?? DEFAULTS.baseDepthRatio,
    };
};

interface BuiltMesh {
    mesh: Mesh;
    material: StandardMaterial;
    texture: Texture;
    skirtMesh: Mesh;
    skirtMaterial: StandardMaterial;
}

/**
 * 実世界メートル単位の地形メッシュ（+ 地図テクスチャ材質）を1回分構築する。
 * `dioramaGrid`/`dioramaElevation`/`dioramaTexture` を順に呼び出す統合ポイント。
 */
const buildMesh = async (
    scene: Scene,
    resolved: ResolvedOptions,
): Promise<BuiltMesh> => {
    const gridOptions: DioramaGridOptions = {
        ringCount: resolved.ringCount,
        radialSegments: resolved.radialSegments,
    };
    const points = buildDioramaGridPoints(resolved.center, resolved.footprintRadiusM, gridOptions);
    const indices = buildDioramaGridIndices(gridOptions);

    const [elevations, textureLayout] = await Promise.all([
        fetchDioramaElevations(points, resolved.demZoom),
        Promise.resolve(computeDioramaTextureLayout(points, resolved.textureZoom)),
    ]);
    const texture = await buildDioramaMosaicTexture(scene, textureLayout, resolved.mapType);

    // 中心点の標高を基準面とし、箱庭が root.position.y=0 付近に収まるようにする。
    const baseElevation = elevations[0];

    const positions = new Float32Array(points.length * 3);
    const uvs = new Float32Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = (elevations[i] - baseElevation) * resolved.heightScaleFactor;
        positions[i * 3 + 2] = p.z;
        uvs[i * 2] = textureLayout.uvs[i].u;
        uvs[i * 2 + 1] = textureLayout.uvs[i].v;
    }
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;

    const mesh = new Mesh("diorama-terrain", scene);
    vertexData.applyToMesh(mesh, true);

    const material = new StandardMaterial("diorama-terrain-material", scene);
    material.diffuseTexture = texture;
    material.specularColor = Color3.Black();
    mesh.material = material;

    // 側面壁・底面（土台）。実物のジオラマ模型のように、外周リングから一定深さ下へ
    // 壁を張って底面で閉じることで、地形メッシュ単体では失われがちな水平（基準面）の
    // 手がかりを与える。壁の深さは footprintRadiusM に比例させ、root の一様スケール
    // 適用後は tableRadiusM に対する比率として一定になるようにする
    // （フットプリント半径を変えても見た目の壁厚が変わらない）。
    let minY = Infinity;
    for (let i = 1; i < positions.length; i += 3) {
        if (positions[i] < minY) minY = positions[i];
    }
    const baseY = minY - resolved.footprintRadiusM * resolved.baseDepthRatio;
    const outerRingStart = 1 + (resolved.ringCount - 1) * resolved.radialSegments;
    const outerRing = Array.from({ length: resolved.radialSegments }, (_, i) => {
        const idx = outerRingStart + i;
        return { x: positions[idx * 3], y: positions[idx * 3 + 1], z: positions[idx * 3 + 2] };
    });
    const skirtGeometry = buildDioramaSkirtGeometry(outerRing, baseY);
    const skirtVertexData = new VertexData();
    skirtVertexData.positions = skirtGeometry.positions;
    skirtVertexData.indices = skirtGeometry.indices;
    skirtVertexData.normals = skirtGeometry.normals;

    const skirtMesh = new Mesh("diorama-skirt", scene);
    skirtVertexData.applyToMesh(skirtMesh, true);

    const skirtMaterial = new StandardMaterial("diorama-skirt-material", scene);
    skirtMaterial.diffuseColor = SOIL_COLOR;
    skirtMaterial.specularColor = Color3.Black();
    // 巻き順に依存せず常に描画されるようにする（箱庭の周りを歩く/回転させる用途のため、
    // 側面壁は裏側からも見える可能性がある小規模メッシュ。カリングによる負荷は無視できる）。
    skirtMaterial.backFaceCulling = false;
    skirtMesh.material = skirtMaterial;

    return { mesh, material, texture, skirtMesh, skirtMaterial };
};

/**
 * 箱庭地形を構築する。
 * @param scene   配置先シーン。
 * @param options 構築オプション（{@link DioramaTerrainOptions}）。
 */
export const createDioramaTerrain = async (
    scene: Scene,
    options: DioramaTerrainOptions,
): Promise<DioramaTerrain> => {
    let resolved = resolveOptions(options);

    const root = new TransformNode("diorama-root", scene);
    const applyScale = (): void => {
        if (!(resolved.tableRadiusM > 0)) {
            throw new RangeError(`tableRadiusM must be > 0 (got ${resolved.tableRadiusM})`);
        }
        if (!(resolved.footprintRadiusM > 0)) {
            throw new RangeError(`footprintRadiusM must be > 0 (got ${resolved.footprintRadiusM})`);
        }
        const scale = resolved.tableRadiusM / resolved.footprintRadiusM;
        root.scaling.setAll(scale);
    };

    let built = await buildMesh(scene, resolved);
    built.mesh.parent = root;
    built.skirtMesh.parent = root;
    applyScale();

    const disposeBuilt = (b: BuiltMesh): void => {
        b.mesh.dispose();
        b.material.dispose();
        b.texture.dispose();
        b.skirtMesh.dispose();
        b.skirtMaterial.dispose();
    };

    const rebuild = async (next: ResolvedOptions): Promise<void> => {
        const rebuilt = await buildMesh(scene, next);
        rebuilt.mesh.parent = root;
        rebuilt.skirtMesh.parent = root;
        const previous = built;
        built = rebuilt;
        resolved = next;
        applyScale();
        disposeBuilt(previous);
    };

    return {
        get mesh(): Mesh {
            return built.mesh;
        },
        root,
        setCenter: (lat: number, lon: number): Promise<void> =>
            rebuild({ ...resolved, center: { lat, lon } }),
        setFootprintRadius: (radiusM: number): Promise<void> =>
            rebuild({ ...resolved, footprintRadiusM: radiusM }),
        setMapType: (mapType: MapType): Promise<void> => rebuild({ ...resolved, mapType }),
        dispose: (): void => {
            disposeBuilt(built);
            root.dispose();
        },
    };
};
