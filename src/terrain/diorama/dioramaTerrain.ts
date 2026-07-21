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
    /**
     * 標高取得ズーム。省略時は `footprintRadiusM` に応じて自動算出する
     * （{@link computeAutoZoomLevel} 参照）。明示指定すると自動算出を無効化し、
     * ズームアウトしても固定のズームレベルを使い続ける（テスト・デバッグ用途）。
     */
    demZoom?: number;
    /**
     * テクスチャ取得ズーム。省略時は `footprintRadiusM` に応じて自動算出する
     * （{@link computeAutoZoomLevel} 参照）。明示指定すると自動算出を無効化する。
     */
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
    /**
     * 中心・フットプリント半径の一方または両方を、1回のrebuild（buildMesh呼び出し）に
     * まとめて適用する。
     *
     * @remarks `setCenter`+`setFootprintRadius` を個別に呼ぶと、それぞれが独立して
     * `enqueueRebuild` されるため、内部の直列実行キュー（`pendingRebuild`）上で
     * 2回の完全なrebuild（DEM/テクスチャの再フェッチを含む）が順番に実行され、
     * ネットワーク往復分のレイテンシが積み重なる。AR中のコントローラー操作
     * （地図移動・拡大縮小が同時に入力される）等、低遅延性が重要な場面ではこちらを使う。
     */
    setView(patch: { center?: DioramaCenter; footprintRadiusM?: number }): Promise<void>;
    dispose(): void;
}

const DEFAULTS = {
    ringCount: 12,
    radialSegments: 48,
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
    /** 未指定（自動算出）の場合は `undefined`。{@link computeAutoZoomLevel} 参照。 */
    demZoom: number | undefined;
    /** 未指定（自動算出）の場合は `undefined`。{@link computeAutoZoomLevel} 参照。 */
    textureZoom: number | undefined;
    mapType: MapType;
    heightScaleFactor: number;
    baseDepthRatio: number;
}

/**
 * ズーム自動算出の基準となる `footprintRadiusM`[m] と、その時に用いる
 * DEM/テクスチャの取得ズームレベル（従来の固定既定値と同じ組み合わせ）。
 */
const AUTO_ZOOM_REFERENCE_FOOTPRINT_RADIUS_M = 800;
const AUTO_ZOOM_REFERENCE_DEM_ZOOM = 14;
const AUTO_ZOOM_REFERENCE_TEXTURE_ZOOM = 16;

/**
 * 自動算出ズームレベルの下限。GSIタイルの実用上のズーム下限（国土スケールの
 * 広域表示でも意味のある解像度を保つ下限）として、既存の全球ビュー
 * （`geo/gsiTile.ts` の `WORLD_TEXTURE_MAX_ZOOM=8` 等）を参考に十分低く設定する。
 */
const AUTO_ZOOM_MIN = 2;
/** DEM自動算出ズームの上限。`gsiTile.ts` の全国配信DEM（dem_png）の配信上限と同じ。 */
const AUTO_DEM_ZOOM_MAX = 14;
/** テクスチャ自動算出ズームの上限。`gsiTile.ts` の `TILE_MAX_ZOOM` と同じ。 */
const AUTO_TEXTURE_ZOOM_MAX = 18;

/**
 * `footprintRadiusM` から DEM/テクスチャの取得ズームレベルを自動算出する。
 *
 * @remarks
 * タイルピラミッドは「ズームレベルが1段階粗くなるごとに1タイルが被覆する実距離が
 * 2倍になる」という規則的な関係を持つため、`footprintRadiusM` が基準値の2倍に
 * なるごとにズームを1段階粗くすれば、取得タイル数・頂点あたりのデータ密度が
 * footprintRadiusM によらずほぼ一定に保たれる。3Dビューア（globeデモ）が
 * カメラ距離に応じてタイルズームを動的に選ぶのと同じ考え方を、箱庭の
 * フットプリント半径基準に単純化して適用したもの。
 *
 * これにより、ズームアウトして広範囲（日本全体等）を表示する際も取得タイル数が
 * 際限なく増えず動作が重くならない。固定ズームのままズームアウト上限だけを
 * 広げると、取得タイル数が急増して重くなる・`computeDioramaTextureLayout` の
 * `MAX_MOSAIC_TILES_PER_AXIS` 上限に抵触するため、本関数の自動算出と併せて
 * ズームアウト上限を広げる必要がある。
 */
export const computeAutoZoomLevel = (
    footprintRadiusM: number,
    referenceZoom: number,
    minZoom: number = AUTO_ZOOM_MIN,
    maxZoom: number = AUTO_TEXTURE_ZOOM_MAX,
): number => {
    const ratio = footprintRadiusM > 0 ? footprintRadiusM / AUTO_ZOOM_REFERENCE_FOOTPRINT_RADIUS_M : 1;
    const zoom = referenceZoom - Math.log2(ratio);
    if (!Number.isFinite(zoom)) return minZoom;
    return Math.min(maxZoom, Math.max(minZoom, Math.round(zoom)));
};

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
    // ここで早期に検証し、不正値（0以下・NaN・Infinity）による無効なスケール算出を防ぐ。
    assertPositiveFinite(options.tableRadiusM, "tableRadiusM");
    // footprintRadiusM は buildDioramaGridPoints（dioramaGrid.ts）内でも検証されるが、
    // ここでも早期に検証し、非同期のタイル取得等を開始する前に失敗させる
    // （0以下・NaN・Infinityを拒否。Infinityはタイルレイアウト計算・自動ズーム
    // 算出（computeAutoZoomLevel）を不正な値に導く）。
    assertPositiveFinite(options.footprintRadiusM, "footprintRadiusM");
    // demZoom/textureZoomは省略可（省略時はfootprintRadiusMから自動算出、
    // buildMesh側で行う）。明示指定された場合のみ検証する（非整数/負数は
    // toTileXY・totalPixelsForZoom（gsiTile.ts/geo/mapping.ts）を不正な
    // タイル要求・レイアウト計算に導くため）。
    if (options.demZoom !== undefined) assertNonNegativeInteger(options.demZoom, "demZoom");
    if (options.textureZoom !== undefined) assertNonNegativeInteger(options.textureZoom, "textureZoom");
    const heightScaleFactor = options.heightScaleFactor ?? DEFAULTS.heightScaleFactor;
    const baseDepthRatio = options.baseDepthRatio ?? DEFAULTS.baseDepthRatio;
    assertPositiveFinite(heightScaleFactor, "heightScaleFactor");
    assertNonNegativeFinite(baseDepthRatio, "baseDepthRatio");
    return {
        center: options.center,
        footprintRadiusM: options.footprintRadiusM,
        tableRadiusM: options.tableRadiusM,
        ringCount: options.ringCount ?? DEFAULTS.ringCount,
        radialSegments: options.radialSegments ?? DEFAULTS.radialSegments,
        demZoom: options.demZoom,
        textureZoom: options.textureZoom,
        mapType: options.mapType ?? DEFAULTS.mapType,
        heightScaleFactor,
        baseDepthRatio,
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

    // demZoom/textureZoomが明示指定されていない場合、footprintRadiusMから自動算出する
    // （{@link computeAutoZoomLevel} 参照）。ズームアウトして広範囲を表示する際も
    // 取得タイル数がほぼ一定に保たれ、動作が重くならないようにするため。
    const demZoom =
        resolved.demZoom ??
        computeAutoZoomLevel(resolved.footprintRadiusM, AUTO_ZOOM_REFERENCE_DEM_ZOOM, AUTO_ZOOM_MIN, AUTO_DEM_ZOOM_MAX);
    const textureZoom =
        resolved.textureZoom ??
        computeAutoZoomLevel(
            resolved.footprintRadiusM,
            AUTO_ZOOM_REFERENCE_TEXTURE_ZOOM,
            AUTO_ZOOM_MIN,
            AUTO_TEXTURE_ZOOM_MAX,
        );

    // computeDioramaTextureLayout は同期処理のため先に算出し、DEM取得と
    // テクスチャタイル取得（いずれもネットワーク待ちを伴う）を Promise.all で並列に
    // 開始する。直列にすると両者の待ち時間が合算されて初期構築/再構築が不要に遅くなる。
    const textureLayout = computeDioramaTextureLayout(points, textureZoom);
    const [elevations, texture] = await Promise.all([
        fetchDioramaElevations(points, demZoom),
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
    // シェーダーコンパイル完了・root への parent/scale 適用が済むまでは描画対象から
    // 外しておく（後述のコンパイル待ちの間、未スケールの巨大メッシュが一瞬でも
    // レンダーループに混入するのを防ぐ）。
    mesh.setEnabled(false);

    const material = new StandardMaterial("diorama-terrain-material", scene);
    material.diffuseTexture = texture;
    material.specularColor = Color3.Black();
    // WebXR (`immersive-ar`) のパススルー合成では、描画結果のアルファ値がそのまま
    // 実世界カメラ映像との合成比率に使われる（デスクトップ表示では気づきにくい）ため、
    // アルファブレンドが有効化されないことを明示的に保証する。
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    material.diffuseTexture.hasAlpha = false;
    // 地形面は単層の片面ジオメトリのため、視線角度によらず表示されるよう
    // 裏面カリングを無効化する（側面壁と同じ扱い）。
    material.backFaceCulling = false;
    mesh.material = material;
    // 地形メッシュは footprintRadiusM 半径の円盤に対し標高差が小さく、バウンディング
    // ボリュームが薄く偏平になりやすい。加えて root の一様スケールが極端に小さい
    // （既定で概ね1/2000）ため、誤ってフラスタムカリングされるリスクがある。
    // `alwaysSelectAsActiveMesh` でカリング判定自体を無効化し、常に描画対象に含める。
    mesh.alwaysSelectAsActiveMesh = true;

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
    // mesh と同様、コンパイル待ちの間は描画対象から外しておく。
    skirtMesh.setEnabled(false);

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

    // 地形面・側面壁のマテリアル（シェーダー）を、シーンへ追加する前にコンパイルしておく。
    // rebuild時（`enqueueRebuild`）は新メッシュ生成直後に旧メッシュを破棄するが、
    // マテリアルの初回シェーダーコンパイルはシーンへ追加後・初回描画時に走る
    // （Babylonの遅延コンパイル）ため、事前コンパイルしておかないと、旧メッシュ破棄
    // 後・新メッシュのコンパイル完了までの数フレーム何も描画されず、地図移動のたびに
    // チラつきが発生する（実機/デスクトップ双方で確認）。なお `new Mesh(...)` は
    // 生成直後からシーンの描画対象になるため、このコンパイル待ちの間は
    // `setEnabled(false)`（生成直後）で無効化しておき、root への parent/scale 適用が
    // 済んでいない未スケールの巨大メッシュがレンダーループへ混入しないようにする。
    await Promise.all([material.forceCompilationAsync(mesh), skirtMaterial.forceCompilationAsync(skirtMesh)]);
    // コンパイル完了後、呼び出し側が parent/scale を適用する前に描画対象へ戻す。
    // ここから return までは同期処理のため、無効化されたまま描画される隙間フレームは
    // 生じない。
    mesh.setEnabled(true);
    skirtMesh.setEnabled(true);

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
    built.skirtMesh.parent = root;
    applyScale();

    const disposeBuilt = (b: BuiltMesh): void => {
        b.mesh.dispose();
        b.material.dispose();
        b.texture.dispose();
        b.skirtMesh.dispose();
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
            rebuilt.skirtMesh.parent = root;
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
        setView: (patch: { center?: DioramaCenter; footprintRadiusM?: number }): Promise<void> => {
            if (patch.footprintRadiusM !== undefined) {
                try {
                    assertPositiveFinite(patch.footprintRadiusM, "footprintRadiusM");
                } catch (err) {
                    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
                }
            }
            return enqueueRebuild((current) => ({
                ...current,
                ...(patch.center !== undefined ? { center: patch.center } : {}),
                ...(patch.footprintRadiusM !== undefined ? { footprintRadiusM: patch.footprintRadiusM } : {}),
            }));
        },
        dispose: (): void => {
            disposed = true;
            disposeBuilt(built);
            root.dispose();
        },
    };
};
