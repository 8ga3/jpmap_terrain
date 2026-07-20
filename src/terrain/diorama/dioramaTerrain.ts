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
import { Material } from "@babylonjs/core/Materials/material";
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

/** 有限の正数であることを検証する（0以下・NaN・Infinityを拒否）。 */
const assertPositiveFinite = (value: number, name: string): void => {
    if (!(Number.isFinite(value) && value > 0)) {
        throw new RangeError(`${name} must be a positive finite number (got ${value})`);
    }
};

/** 0以上の有限数であることを検証する（負数・NaN・Infinityを拒否）。 */
const assertNonNegativeFinite = (value: number, name: string): void => {
    if (!(Number.isFinite(value) && value >= 0)) {
        throw new RangeError(`${name} must be a non-negative finite number (got ${value})`);
    }
};

/** 0以上の整数であることを検証する（ズームレベル用。非整数・負数・NaN・Infinityを拒否）。 */
const assertNonNegativeInteger = (value: number, name: string): void => {
    if (!(Number.isInteger(value) && value >= 0)) {
        throw new RangeError(`${name} must be a non-negative integer (got ${value})`);
    }
};

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
    const demZoom = options.demZoom ?? DEFAULTS.demZoom;
    const textureZoom = options.textureZoom ?? DEFAULTS.textureZoom;
    const heightScaleFactor = options.heightScaleFactor ?? DEFAULTS.heightScaleFactor;
    const baseDepthRatio = options.baseDepthRatio ?? DEFAULTS.baseDepthRatio;
    // 非整数/負数の zoom は toTileXY・totalPixelsForZoom（gsiTile.ts/geo/mapping.ts）を
    // 不正なタイル要求・レイアウト計算に導くため、早期に検証する。
    assertNonNegativeInteger(demZoom, "demZoom");
    assertNonNegativeInteger(textureZoom, "textureZoom");
    assertPositiveFinite(heightScaleFactor, "heightScaleFactor");
    assertNonNegativeFinite(baseDepthRatio, "baseDepthRatio");
    return {
        center: options.center,
        footprintRadiusM: options.footprintRadiusM,
        tableRadiusM: options.tableRadiusM,
        ringCount: options.ringCount ?? DEFAULTS.ringCount,
        radialSegments: options.radialSegments ?? DEFAULTS.radialSegments,
        demZoom,
        textureZoom,
        mapType: options.mapType ?? DEFAULTS.mapType,
        heightScaleFactor,
        baseDepthRatio,
    };
};

interface BuiltMesh {
    mesh: Mesh;
    material: StandardMaterial;
    texture: Texture;
    skirtMaterial: StandardMaterial;
}

/**
 * 実世界メートル単位の地形メッシュ（+ 地図テクスチャ材質）を1回分構築する。
 * `dioramaGrid`/`dioramaElevation`/`dioramaTexture` を順に呼び出す統合ポイント。
 *
 * @remarks
 * 地形面（テクスチャ付き）と側面壁（無地）は、別々の `Mesh` として構築した後
 * `Mesh.MergeMeshes`（`multiMultiMaterials: true`）で1つの `Mesh` +
 * `MultiMaterial` に統合する。実機（Meta Quest 3 / Androidスマホ）検証で、
 * 2つの独立した `Mesh` のままだと、どちらが深度的に「手前」として扱われるかが
 * 機種・エンジンによって不安定/逆転する不具合を確認した
 * （`renderingGroupId`分離、`zOffset`によるバイアス、いずれも機種間で一貫した
 * 解決に至らなかった）。1つの `Mesh`（＝1回の描画コール群、通常のWebGL深度
 * テストのみに依存）へ統合することで、メッシュ間の描画順・レンダリング
 * グループ切り替えタイミングに一切依存しない、より頑健な構成にする。
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

    // computeDioramaTextureLayout は同期処理のため先に算出し、DEM取得と
    // テクスチャタイル取得（いずれもネットワーク待ちを伴う）を Promise.all で並列に
    // 開始する。直列にすると両者の待ち時間が合算されて初期構築/再構築が不要に遅くなる。
    const textureLayout = computeDioramaTextureLayout(points, resolved.textureZoom);
    const [elevations, texture] = await Promise.all([
        fetchDioramaElevations(points, resolved.demZoom),
        buildDioramaMosaicTexture(scene, textureLayout, resolved.mapType),
    ]);

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
    // WebXR (`immersive-ar`) のパススルー合成では、レンダリング結果のアルファ値が
    // そのまま「実世界カメラ映像とどれだけ混ぜるか」に使われる（通常のデスクトップ
    // 表示ではアルファ値は表示に一切影響しないため気づきにくい）ため、まず
    // アルファブレンドが一切有効化されないことを保証しておく。
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    material.diffuseTexture.hasAlpha = false;
    material.backFaceCulling = false;
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
    // `Mesh.MergeMeshes` は統合対象の全メッシュが同じ頂点属性集合を持つことを
    // 要求する（`VertexData._mergeCoroutine` が属性不一致でエラーを投げる）。
    // 側面壁は無地マテリアルのためUVは実際には使わないが、地形面との統合のために
    // ダミーのUV（0埋め）を用意しておく。
    skirtVertexData.uvs = new Float32Array(skirtGeometry.positions.length / 3 * 2);

    const skirtMesh = new Mesh("diorama-skirt", scene);
    skirtVertexData.applyToMesh(skirtMesh, true);

    const skirtMaterial = new StandardMaterial("diorama-skirt-material", scene);
    skirtMaterial.diffuseColor = SOIL_COLOR;
    skirtMaterial.specularColor = Color3.Black();
    // 地形面と同様の理由（AR中のパススルー合成でアルファ値が意味を持つ）で、
    // 念のため側面壁も不透明へ明示固定する。
    skirtMaterial.transparencyMode = Material.MATERIAL_OPAQUE;
    // 巻き順に依存せず常に描画されるようにする（箱庭の周りを歩く/回転させる用途のため、
    // 側面壁は裏側からも見える可能性がある小規模メッシュ。カリングによる負荷は無視できる）。
    skirtMaterial.backFaceCulling = false;
    skirtMesh.material = skirtMaterial;

    // 実機（Meta Quest 3 / Androidスマホ）検証で、地形面と側面壁を別々の`Mesh`の
    // ままにしておくと、どちらが深度的に「手前」として扱われるかが機種・エンジンに
    // よって不安定/逆転することを確認した（`renderingGroupId`分離、`zOffset`
    // バイアス、いずれも機種間で一貫した解決に至らなかった）。
    // `Mesh.MergeMeshes`（`multiMultiMaterials: true`）で1つの`Mesh` +
    // `MultiMaterial`へ統合し、メッシュ間の描画順・レンダリンググループ切り替え
    // タイミングに一切依存しない、通常のWebGL深度テストのみに基づく構成にする。
    const merged = Mesh.MergeMeshes([mesh, skirtMesh], true, true, undefined, false, true);
    if (!merged) {
        throw new Error("[jpmap-terrain diorama] failed to merge terrain and skirt meshes");
    }
    merged.name = "diorama-terrain";
    // 地形メッシュは側面壁より遥かに広い水平方向の外延（footprintRadiusM半径の
    // 円盤）を持つ一方で標高差は比較的小さく、バウンディングボリュームが非常に
    // 薄く偏平になりやすい。root の一様スケールも極端に小さい
    // （tableRadiusM/footprintRadiusM、既定で概ね1/2000）ため、フラスタム判定で
    // 誤ってカリングされるリスクを避ける目的で明示的に無効化しておく。
    merged.alwaysSelectAsActiveMesh = true;

    return { mesh: merged, material, texture, skirtMaterial };
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

    // root は buildMesh 成功後に生成する。buildMesh より先に生成すると、初期構築で
    // buildMesh が例外（例: center がWebメルカトル有効域外など）を投げた場合に
    // root が dispose されずシーンへ残留してリークするため。
    let built = await buildMesh(scene, resolved);

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

    built.mesh.parent = root;
    applyScale();

    const disposeBuilt = (b: BuiltMesh): void => {
        // `b.mesh` は地形面・側面壁を統合した1つの `Mesh`。
        // `Mesh.dispose()` は既定でアタッチされた `Material`（統合時に
        // Babylonが生成した `MultiMaterial`）を破棄しないため、
        // 明示的に破棄する必要がある。
        b.mesh.material?.dispose();
        b.mesh.dispose();
        b.material.dispose();
        b.texture.dispose();
        b.skirtMaterial.dispose();
    };

    /**
     * 保留中の rebuild チェーン。`enqueueRebuild` はこれに繋げて直列化する。
     * `setCenter`/`setFootprintRadius`/`setMapType` が並行に呼ばれても、rebuild が
     * 呼び出し順に1つずつ実行されるようにし、以下の競合を防ぐ:
     * - 後から開始したが先に完了した rebuild が `built`/`resolved` を上書きし、
     *   別の（本来もっと新しい）rebuild の結果を消してしまう
     * - 同時に走る rebuild 同士で `previous`/`built` の入れ替えが競合し、
     *   まだ使用中のメッシュを誤って dispose する、または二重 dispose する
     * 失敗（reject）した rebuild があってもチェーンを止めない（`.then` の
     * 第2引数にも同じ `run` を渡し、次のキュー項目へ進める）。
     */
    let pendingRebuild: Promise<void> = Promise.resolve();

    /**
     * `patch` はキューの実行順が回ってきた時点の最新 `resolved` を受け取る
     * （呼び出し時点ではなく実行時点の状態を基準にするため、直前の rebuild の
     * 結果を正しく引き継げる）。
     */
    /**
     * dispose 済みかどうか。`enqueueRebuild` の `run` はこれを実行前後で確認し、
     * dispose 後に新規 Mesh/Texture を生成してリークしたり、破棄済みの `root` へ
     * parent 設定して例外になるのを防ぐ。
     */
    let disposed = false;

    const enqueueRebuild = (patch: (current: ResolvedOptions) => ResolvedOptions): Promise<void> => {
        const run = async (): Promise<void> => {
            // dispose 後にキューの順番が回ってきた場合は何もしない
            // （新規フェッチ・メッシュ生成自体を行わない）。
            if (disposed) return;
            const next = patch(resolved);
            const rebuilt = await buildMesh(scene, next);
            if (disposed) {
                // buildMesh 実行中（非同期のタイル取得等の最中）に dispose された場合。
                // 破棄済みの root へ parent 設定すると例外になり得るため、生成物は
                // そのまま使わず即座に破棄する。
                disposeBuilt(rebuilt);
                return;
            }
            rebuilt.mesh.parent = root;
            const previous = built;
            built = rebuilt;
            resolved = next;
            applyScale();
            disposeBuilt(previous);
        };
        const chained = pendingRebuild.then(run, run);
        pendingRebuild = chained;
        return chained;
    };

    return {
        get mesh(): Mesh {
            return built.mesh;
        },
        root,
        setCenter: (lat: number, lon: number): Promise<void> =>
            enqueueRebuild((current) => ({ ...current, center: { lat, lon } })),
        setFootprintRadius: (radiusM: number): Promise<void> => {
            try {
                assertPositiveFinite(radiusM, "radiusM");
            } catch (err) {
                // 呼び出し側の一貫したエラーハンドリング（Promise.catch/await+try-catch）のため、
                // 同期例外ではなく reject として返す（他のメソッドと同じ非同期契約に揃える）。
                return Promise.reject(err instanceof Error ? err : new Error(String(err)));
            }
            return enqueueRebuild((current) => ({ ...current, footprintRadiusM: radiusM }));
        },
        setMapType: (mapType: MapType): Promise<void> =>
            enqueueRebuild((current) => ({ ...current, mapType })),
        dispose: (): void => {
            disposed = true;
            disposeBuilt(built);
            root.dispose();
        },
    };
};
