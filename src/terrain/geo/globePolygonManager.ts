/**
 * グローブ用ポリゴンマネージャ。
 *
 * 公開 PolygonManager 互換アダプタから渡される解決済みオプションを、ECEF 上の
 * 点・線・垂線・ラベル・壁として描画する。構造変化を伴う編集（点数・closed・各種フラグ・
 * style 変更）はアダプタ側の add-then-remove 再生成で扱う。一方、点座標／ラベルのみの更新は
 * `setContent` による in-place 更新（メッシュ破棄なしの instance 更新／ラベル再描画）で扱い、
 * ドラッグ編集中のチラつきを防ぐ。点数不一致など in-place 不可の場合は false を返し、
 * アダプタが再生成へフォールバックする。
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import {
    type AltitudeMode,
    POLYGON_DEFAULTS,
    type PolygonStyleOptions,
    resolvePolygonStyle,
} from "../../lib/types";
import {
    computeOverlayDistanceScale,
    computeOverlayPointDiameter,
    computeScreenUpToRef,
    drapedPolygonPathLength,
    type LatLonPoint,
    writeDrapedPolygonPathsToRef,
} from "./overlayPlacement";

/**
 * 頂点球・垂線・壁・線（アウトライン）・ラベルは全て地表メッシュ（既定グループ 0）と同グループ
 * で描画し、地表の深度バッファで正しくオクルードさせる。以前は線・ラベルを別グループにして
 * 「常に地表より手前」にしていたが、山などに正しく隠れてほしいという要望により
 * 撤回し、地形と同じ深度で扱う方式に統一した。
 */
const TERRAIN_RENDERING_GROUP_ID = 0;
const LABEL_MAX_DT_SIZE = 1024;
const LABEL_MIN_DT_SIZE = 32;

// 点／辺ラベルを地心 up 方向へ押し出すギャップ（フォント高さに対する比率、距離スケール反映）。
// 球トップや辺の上にラベルが重ならないよう、わずかにオフセットする（planar の同名定数と対応）。
const LABEL_GAP_FONT_RATIO = 0.05;

// placeNode の毎フレーム配置ループで使い回すスクラッチ Vector3（割り当て削減のため）。
const scratchUp = new Vector3();
const scratchMid = new Vector3();
const scratchBottomMid = new Vector3();
const scratchEdgeUp = new Vector3();
const scratchCentroid = new Vector3();
// ラベルを画面上方向へ逃がすための screen up と、方向ベクトルを破壊せずスケールするための一時。
const scratchScreenUp = new Vector3();
const scratchLabelOffset = new Vector3();
// floating origin 精度対策: tube/ribbon はパス座標を頂点バッファへ焼き込むため、真の ECEF
// （~6.4e6）を直接渡すと float32 で精度が落ち、最大ズーム付近で線/円が揺れ・退化して消える。
// 原点（node.top[0]）を引いたローカル座標で形状を作り、原点は mesh.position へ載せて floating
// origin にリベースさせる（点スフィア/ラベルが mesh.position で精度を保つのと同じ仕組み）。
const scratchOrigin = new Vector3();

interface GlobePolygonPoint extends LatLonPoint {
    altitude?: number;
}

interface ResolvedStyle {
    lineColor: string;
    lineWidth: number;
    lineOpacity: number;
    lineWidthMode: "world" | "screen";
    pointDiameter: number;
    pointColor: string;
    pointOpacity: number;
    dropLineColor: string;
    dropLineWidth: number;
    dropLineOpacity: number;
    labelColor: string;
    labelBackgroundColor: string;
    labelFontSize: number;
    wallColor: string;
    wallOpacity: number;
}

const resolveStyle = (style: PolygonStyleOptions | undefined): ResolvedStyle =>
    resolvePolygonStyle(style);

export interface GlobePolygonOptions {
    /** 頂点列（最低 1 点）。 */
    points: readonly GlobePolygonPoint[];
    /** 末尾と先頭を結んで輪を閉じる。default false。 */
    closed?: boolean;
    /** 高度モード。default terrain。 */
    altitudeMode?: AltitudeMode;
    /**
     * 指定時は全頂点をこの楕円体高度に置く（absolute 相当）。
     */
    topAltitudeMeters?: number;
    labels?: ReadonlyArray<string | undefined>;
    edgeLabels?: ReadonlyArray<string | undefined>;
    style?: PolygonStyleOptions;
    verticalsEnabled?: boolean;
    labelsEnabled?: boolean;
    wallsEnabled?: boolean;
    /** アウトライン（輪郭線）の表示。default true。circle 委譲で線と壁を独立トグルするために使う。 */
    lineEnabled?: boolean;
    /** 頂点球体マーカーの表示。default true。circle 委譲では円周ノードで false にして既存の円表示を保つ。 */
    pointsEnabled?: boolean;
    enabled?: boolean;
}

export interface GlobePolygonManagerDeps {
    scene: Scene;
    /** 緯度経度の地形標高[m]（無ければ null）。`globeTileManager.terrainElevAt` を渡す。 */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
}

interface LabelEntry {
    mesh: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    widthWorld: number;
    heightWorld: number;
    /** 現在描画中のテキスト（in-place 再描画の要否判定用）。 */
    text: string;
    /** texture の実ピクセル寸法（in-place 再描画が収まるかの判定用）。 */
    dtWidth: number;
    dtHeight: number;
}

interface MeshEntry {
    mesh: Mesh;
    material: StandardMaterial;
}

interface GlobePolygonNode {
    id: string;
    points: readonly GlobePolygonPoint[];
    closed: boolean;
    altitudeMode: AltitudeMode;
    topAltitudeMeters?: number;
    enabled: boolean;
    verticalsEnabled: boolean;
    labelsEnabled: boolean;
    wallsEnabled: boolean;
    lineEnabled: boolean;
    pointsEnabled: boolean;
    elevationResolved: boolean;
    style: ResolvedStyle;
    pointMeshes: (MeshEntry | null)[];
    dropMeshes: (MeshEntry | null)[];
    pointLabels: (LabelEntry | null)[];
    edgeLabels: (LabelEntry | null)[];
    lineMesh: Mesh;
    lineMat: StandardMaterial;
    wallMesh: Mesh;
    wallMat: StandardMaterial;
    top: Vector3[];
    bottom: Vector3[];
    /** floating origin リベース用、原点（top[0]）相対のローカル座標パス（tube/ribbon 頂点用）。 */
    relTop: Vector3[];
    relBottom: Vector3[];
    elevs: number[];
    /** 直近 placeNode で算出した点スフィアのワールド半径 [m]（幾何ピック用）。 */
    pointWorldRadius: number;
}

export interface GlobePolygonManager {
    add(opts: GlobePolygonOptions): string;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    /**
     * 2D（トップダウン正射）縮退の有効/無効を切り替える。`true` で全ポリゴンの壁
     * （カーテン）と垂線を無効化し、接地アウトライン・頂点・ラベルのみを残す。`false` で復元する。
     */
    setFlatten(flat: boolean): void;
    /** 毎フレーム: 地形標高へ再ドレープし、距離スケールを更新する。 */
    update(cameraEcef?: Vector3, flatScale?: number): void;
    /**
     * 点数・closed 構造を変えずに、頂点座標・点ラベル・辺ラベルのみを in-place 更新する。
     * 既存の mesh / material / texture を再利用するため、ドラッグ編集中の毎フレーム
     * remove→add 再構築（ラベルのチラつき要因）を回避できる。ラベルはテキスト不変なら再描画も省略、
     * 変化時も既存テクスチャ寸法に収まれば再描画（mesh/material/texture 再利用）で更新する。
     * 点数が一致しない・未存在 id の場合は false を返し、呼び出し側で remove/add へフォールバックする。
     */
    setContent(id: string, content: GlobePolygonContentUpdate): boolean;
    /**
     * 現在表示中・ピック可能な頂点（点メッシュ）の真の ECEF 位置と当該フレームの
     * ワールド半径を `out` に書き込み、件数を返す（floating origin 非依存の幾何ピック用）。
     * 非表示ノード・点無効ノード・標高未解決ノードは含めない。closed の重複末尾点は除外する。
     * pointermove ごとに呼ばれるため、`out` の要素オブジェクトを再利用して割り当て/GC を抑える。
     * 呼び出し側は返り値の件数ぶん（`out[0..count)`）のみ参照すること。
     */
    getPickablePoints(out: GlobePolygonPickablePoint[]): number;
    dispose(): void;
}

/** {@link GlobePolygonManager.getPickablePoints} の戻り要素。 */
export interface GlobePolygonPickablePoint {
    /** ポリゴン id。 */
    polygonId: string;
    /** 頂点 index（0-based）。 */
    index: number;
    /** 頂点の真の ECEF 位置 [m]。 */
    x: number;
    y: number;
    z: number;
    /** 当該フレームの点スフィアのワールド半径 [m]（画面ほぼ定サイズ）。 */
    radius: number;
}

/** {@link GlobePolygonManager.setContent} の入力。点数・closed 構造は変えない前提。 */
export interface GlobePolygonContentUpdate {
    points: readonly { lat: number; lon: number; altitude?: number }[];
    labels?: ReadonlyArray<string | null | undefined>;
    edgeLabels?: ReadonlyArray<string | null | undefined>;
}

const toColor3 = (color: string, fallbackHex: string): Color3 => {
    try {
        return Color3.FromHexString(color);
    } catch {
        return Color3.FromHexString(fallbackHex);
    }
};

const createMaterial = (
    scene: Scene,
    name: string,
    color: string,
    fallbackHex: string,
    alpha: number,
): StandardMaterial => {
    const mat = new StandardMaterial(name, scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.emissiveColor = toColor3(color, fallbackHex);
    mat.alpha = alpha;
    // 両面描画（backFaceCulling=false）の半透明メッシュは、自己の前後面が同一パスで
    // 描画されると重なり順が不定になり見た目が破綻する（自己透過アーティファクト）。
    // これを避けるため以前は needDepthPrePass を使っていたが、depth pre-pass は
    // 不透明メッシュより前の専用パスで深度バッファへ実深度を書き込むため、後段の
    // 半透明マーカー/ラベル（アイコン・テキスト）がこの壁の深度に対して不透明物のように
    // 深度テストで弾かれ、透けて見えるべき壁の奥のマーカーが隠れてしまう。
    // separateCullingPass は背面→前面の 2 パス描画で同じ自己透過問題を
    // 解決しつつ、深度バッファへは半透明パス通常の書き込み（オフ）のままなので、
    // 他の半透明メッシュの深度テストを汚染しない。
    if (alpha < 1) mat.separateCullingPass = true;
    return mat;
};

const labelDpr = (): number =>
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio ===
        "number"
        ? Math.max(
              (globalThis as { devicePixelRatio: number }).devicePixelRatio,
              1,
          )
        : 1;

// 文字幅計測用 probe テクスチャをシーン単位でキャッシュし、ラベル再描画（ドラッグ中の動的ラベルは
// テキスト変化のたびに呼ばれる）での DynamicTexture 確保/破棄コストを抑える。シーン dispose 時に
// テクスチャも破棄されるため WeakMap で保持し、明示破棄は不要。
const probeTextureByScene = new WeakMap<Scene, DynamicTexture>();
const getProbeContext = (
    scene: Scene,
): ReturnType<DynamicTexture["getContext"]> => {
    let probe = probeTextureByScene.get(scene);
    if (!probe) {
        probe = new DynamicTexture(
            "polygon-label-probe",
            { width: 16, height: 16 },
            scene,
            false,
        );
        probeTextureByScene.set(scene, probe);
    }
    return probe.getContext();
};

/** ラベル描画の共通レイアウト指標（フォントサイズ由来のパディング・行高）。 */
interface LabelTextLayoutMetrics {
    fontSize: number;
    padPx: number;
    strokePx: number;
    lineHeightPx: number;
    innerPad: number;
}

/**
 * `style.labelFontSize` からラベル計測・描画の双方で使う指標を導出する。
 * `computeLabelDims`（計測）と `paintLabel`（描画）で同一の値が必要なため共通化する。
 */
const computeLabelTextLayoutMetrics = (
    style: ResolvedStyle,
): LabelTextLayoutMetrics => {
    const fontSize = Math.max(style.labelFontSize, 1);
    const padPx = Math.round(fontSize * 0.1);
    const strokePx = Math.max(2, Math.round(fontSize * 0.12));
    const lineHeightPx = fontSize * 1.2;
    return {
        fontSize,
        padPx,
        strokePx,
        lineHeightPx,
        innerPad: padPx + strokePx,
    };
};

const computeLabelDims = (
    scene: Scene,
    text: string,
    style: ResolvedStyle,
    dpr: number,
): { dtWidth: number; dtHeight: number } => {
    const lines = text.split("\n");
    const { fontSize, lineHeightPx, innerPad } =
        computeLabelTextLayoutMetrics(style);
    const probeCtx = getProbeContext(scene);
    probeCtx.font = `${fontSize}px sans-serif`;
    let maxLineWidth = 0;
    for (const line of lines) {
        maxLineWidth = Math.max(
            maxLineWidth,
            probeCtx.measureText(line || " ").width,
        );
    }

    const innerW = maxLineWidth + innerPad * 2;
    const innerH = lineHeightPx * Math.max(lines.length, 1) + innerPad * 2;
    const dtWidth = Math.max(
        LABEL_MIN_DT_SIZE,
        Math.min(LABEL_MAX_DT_SIZE, Math.ceil(innerW * dpr)),
    );
    const dtHeight = Math.max(
        LABEL_MIN_DT_SIZE,
        Math.min(LABEL_MAX_DT_SIZE, Math.ceil(innerH * dpr)),
    );
    return { dtWidth, dtHeight };
};

/**
 * 既存テクスチャへラベル文字列を（再）描画する。texture の寸法（dtWidth/dtHeight）は
 * 呼び出し側が決め、本関数はその範囲に中央寄せで描画する。mesh / material / texture を
 * すべて再利用するため、GPU エフェクトの再コンパイルが起きず 1 フレームの空白（チラつき）を生まない。
 */
const paintLabel = (
    texture: DynamicTexture,
    text: string,
    style: ResolvedStyle,
    dtWidth: number,
    dtHeight: number,
    dpr: number,
): void => {
    const lines = text.split("\n");
    const { fontSize, strokePx, lineHeightPx, innerPad } =
        computeLabelTextLayoutMetrics(style);
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, dtWidth, dtHeight);
    if (
        style.labelBackgroundColor &&
        style.labelBackgroundColor !== "transparent"
    ) {
        ctx.fillStyle = style.labelBackgroundColor;
        ctx.fillRect(0, 0, dtWidth, dtHeight);
    }
    ctx.font = `${fontSize * dpr}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = strokePx * 2 * dpr;
    ctx.strokeStyle = "#ffffff";
    const startY = innerPad * dpr;
    const centerX = dtWidth / 2;
    for (let i = 0; i < lines.length; i++) {
        ctx.strokeText(lines[i], centerX, startY + i * lineHeightPx * dpr);
    }
    ctx.fillStyle = style.labelColor;
    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], centerX, startY + i * lineHeightPx * dpr);
    }
    texture.update(false);
};

const createLabelMesh = (
    scene: Scene,
    id: string,
    index: number,
    text: string,
    style: ResolvedStyle,
    prefix: "label" | "edge-label",
): LabelEntry => {
    const dpr = labelDpr();
    const { dtWidth, dtHeight } = computeLabelDims(scene, text, style, dpr);
    const texture = new DynamicTexture(
        `${id}-${prefix}-${index}`,
        { width: dtWidth, height: dtHeight },
        scene,
        false,
    );
    texture.hasAlpha = true;
    texture.vScale = -1;
    texture.vOffset = 1;
    paintLabel(texture, text, style, dtWidth, dtHeight, dpr);

    const widthWorld = dtWidth / dpr;
    const heightWorld = dtHeight / dpr;
    const mesh = CreatePlane(
        `${id}-${prefix}-${index}`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = TERRAIN_RENDERING_GROUP_ID;
    mesh.isPickable = false;
    const material = new StandardMaterial(
        `${id}-${prefix}-mat-${index}`,
        scene,
    );
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = Color3.White();
    material.diffuseTexture = texture;
    mesh.material = material;
    return {
        mesh,
        material,
        texture,
        widthWorld,
        heightWorld,
        text,
        dtWidth,
        dtHeight,
    };
};

/**
 * 既存ラベルのテキストを in-place で更新する。新テキストが現テクスチャ寸法に収まる場合のみ
 * 再描画して true を返す（mesh/material/texture を再利用＝チラつき無し）。収まらない場合は
 * false を返し、呼び出し側で作り直す。
 *
 * 注: テキストが短くなっても texture / 平面（widthWorld/heightWorld）は縮小しない（最大寸法を維持）。
 * 縮小には texture・平面の作り直しが必要で、それは本関数が回避したい 1 フレームの空白（チラつき）を
 * 再発させるため、意図的に許容する。固定幅の点ラベル（lat/lon）では寸法は実質一定で影響はない。
 * 辺ラベル（距離/高低差）で桁数が減ると外周マージンが僅かに大きく見えるのみ（位置ずれではない）。
 */
const redrawLabel = (
    scene: Scene,
    entry: LabelEntry,
    text: string,
    style: ResolvedStyle,
): boolean => {
    if (entry.text === text) return true;
    const dpr = labelDpr();
    const { dtWidth, dtHeight } = computeLabelDims(scene, text, style, dpr);
    if (dtWidth > entry.dtWidth || dtHeight > entry.dtHeight) return false;
    paintLabel(entry.texture, text, style, entry.dtWidth, entry.dtHeight, dpr);
    entry.text = text;
    return true;
};

const edgeCount = (pointCount: number, closed: boolean): number =>
    closed && pointCount >= 2 ? pointCount : Math.max(0, pointCount - 1);

const placeholderPath = (count: number, closed: boolean): Vector3[] => {
    const len = Math.max(count, 2);
    const path = Array.from({ length: len }, (_, i) => new Vector3(i, 0, 0));
    if (closed && count >= 2) path.push(path[0].clone());
    return path;
};

export const createGlobePolygonManager = (
    deps: GlobePolygonManagerDeps,
): GlobePolygonManager => {
    const { scene, terrainElevAt } = deps;
    const nodes = new Map<string, GlobePolygonNode>();
    let seq = 0;
    let disposed = false;
    // 2D（トップダウン正射）縮退フラグ。true の間は壁（カーテン）と垂線を無効化し、
    // 接地アウトライン・頂点・ラベルのみを残す。3D 復帰（false）で元の表示へ戻る。
    let flat = false;
    // 直近フレームの距離スケール基準（add 時に新規ポリゴンを即座に正しいスケールで配置するため）。
    // add は placeNode を distScale 既定値（=1）で実行するため、これを使わないと再構築直後の
    // 1 フレームだけ点/ライン/ラベルが誤サイズ（特に 2D は flatScale 比で大きく乖離）で描画され、
    // ドラッグ中の毎フレーム再構築でチラつく。update のたびに最新値をキャッシュする。
    let lastCameraEcef: Vector3 | undefined;
    let lastFlatScale: number | undefined;

    const buildPaths = (node: GlobePolygonNode): boolean => {
        let resolved = true;
        if (flat) {
            // 2D（トップダウン正射）では物体高度を無効化し、必ず地形標高へ接地する（マーカー parity）。
            // 高度を残すとカメラ距離が radius-高度となり、ズームインで near クリップ面を割って
            // オブジェクトが消える／ドラッグ時にチラつく。altitude / topAltitudeMeters は 2D では使わない。
            // terrain 未解決の点は前回値（初期 0=海面）を保持し、非表示にはしない（マーカーと同じ）。
            for (let i = 0; i < node.points.length; i++) {
                const p = node.points[i];
                const terrain = terrainElevAt(p.lat, p.lon);
                if (terrain !== null) node.elevs[i] = terrain;
            }
        } else if (node.topAltitudeMeters != null) {
            for (let i = 0; i < node.elevs.length; i++)
                node.elevs[i] = node.topAltitudeMeters;
        } else if (node.altitudeMode === "absolute") {
            for (let i = 0; i < node.points.length; i++) {
                node.elevs[i] = node.points[i].altitude ?? 0;
            }
        } else {
            for (let i = 0; i < node.points.length; i++) {
                const p = node.points[i];
                const terrain = terrainElevAt(p.lat, p.lon);
                if (terrain === null) {
                    // 1 点でも未解決ならポリゴン全体を非表示にするため、残りの terrainElevAt
                    // クエリは不要。早期終了して毎フレームの標高クエリ回数を抑える
                    // （頂点数が多い circle 委譲などで効く）。planar 実装と parity。
                    resolved = false;
                    node.elevs[i] = 0;
                    break;
                }
                node.elevs[i] = terrain + (p.altitude ?? 0);
            }
        }
        if (resolved) {
            writeDrapedPolygonPathsToRef(
                node.points,
                node.elevs,
                node.closed,
                node.top,
                node.bottom,
            );
        }
        node.elevationResolved = resolved;
        return resolved;
    };

    const applyVisibility = (node: GlobePolygonNode): void => {
        const visible = node.enabled && node.elevationResolved;
        const hasEdges = node.points.length >= 2;
        for (const entry of node.pointMeshes) {
            if (entry) entry.mesh.setEnabled(visible && node.pointsEnabled);
        }
        for (const entry of node.dropMeshes) {
            if (entry)
                entry.mesh.setEnabled(
                    visible && node.verticalsEnabled && !flat,
                );
        }
        for (const entry of node.pointLabels) {
            if (entry) entry.mesh.setEnabled(visible && node.labelsEnabled);
        }
        for (const entry of node.edgeLabels) {
            if (entry)
                entry.mesh.setEnabled(
                    visible && node.labelsEnabled && hasEdges,
                );
        }
        node.lineMesh.setEnabled(visible && hasEdges && node.lineEnabled);
        node.wallMesh.setEnabled(
            visible && hasEdges && node.wallsEnabled && !flat,
        );
    };

    const placeNode = (
        node: GlobePolygonNode,
        cameraEcef?: Vector3,
        flatScale?: number,
    ): void => {
        if (!buildPaths(node)) {
            applyVisibility(node);
            return;
        }
        // planar (polygonManager) と同様、頂点列の重心を distScale の基準にする。
        // 先頭頂点基準だと大きなポリゴンやカメラが先頭頂点から離れたケースで
        // スケールが不自然に変化するため。closed の重複点（top[points.length]）は除外する。
        let distScale = 1;
        if (flat && flatScale != null) {
            // 2D 正射（flat）では、距離由来スケールを使わず radius 比例の固定スケールを直接採用する。
            // 距離由来だと頂点高度（top の海抜）ぶんカメラ距離が変わり、ズーム時に見かけ大きさが
            // ばらつく（高度が「生きている」状態）。radius 比例なら ortho フラスタムと相殺し、
            // 高度・パンに依らず全ズームで画面上サイズが一定（マーカー同等）になる。
            distScale = flatScale;
        } else if (cameraEcef) {
            const n = node.points.length;
            scratchCentroid.setAll(0);
            for (let i = 0; i < n; i++) scratchCentroid.addInPlace(node.top[i]);
            if (n > 0) scratchCentroid.scaleInPlace(1 / n);
            // 2D 正射（flat）では下限スケールを外し、全ズームで画面上サイズを一定に保つ
            // （ortho フラスタムが radius 比例のため、距離比例スケールと相殺してマーカー同等になる）。
            // 3D 透視は近接時の過小化を防ぐ既定の下限を維持する。
            distScale = computeOverlayDistanceScale(
                cameraEcef,
                scratchCentroid,
                undefined,
                flat ? 0 : undefined,
            );
        }
        // 点（頂点マーカー）のワールド直径。マーカーと同様、distScale（= 距離比例）を掛けて
        // ズームに依らず画面上の見かけ大きさを一定に保つ（line/label も同様にスケールするため
        // 相対比が保たれ、ズームインで点がラインに埋もれない）。ただし上限クランプあり
        // （地形と同じ深度で描画されるため、無制限に拡大すると遠距離で地形を貫通してしまう）。
        const pointWorldDiameter = computeOverlayPointDiameter(
            node.style.pointDiameter,
            distScale,
        );
        const pointRadius = pointWorldDiameter * 0.5;
        node.pointWorldRadius = pointRadius;
        const labelGap =
            node.style.labelFontSize * distScale * LABEL_GAP_FONT_RATIO;
        // floating origin 精度対策: tube/ribbon（line/wall/drop）の頂点は原点相対のローカル座標で
        // 作り、原点を mesh.position に載せてリベースさせる。原点は top[0]（真の ECEF）。
        // 差分は JS float64 で計算してから float32 頂点バッファへ落とすため、最大ズームでも精度を保つ。
        scratchOrigin.copyFrom(node.top[0]);
        for (let i = 0; i < node.top.length; i++) {
            node.top[i].subtractToRef(scratchOrigin, node.relTop[i]);
            node.bottom[i].subtractToRef(scratchOrigin, node.relBottom[i]);
        }
        // カメラ（render 空間）。ラベルを画面上方向へ逃がして点／線に重ねないために使う。
        const camPos = scene.activeCamera?.globalPosition;
        const camUp = scene.activeCamera?.upVector;
        for (let i = 0; i < node.points.length; i++) {
            const top = node.top[i];
            const bottom = node.bottom[i];
            top.subtractToRef(bottom, scratchUp);
            if (scratchUp.lengthSquared() < 1e-12)
                top.normalizeToRef(scratchUp);
            else scratchUp.normalize();

            const point = node.pointMeshes[i];
            if (point) {
                point.mesh.position.copyFrom(top);
                point.mesh.scaling.setAll(pointWorldDiameter);
            }

            const drop = node.dropMeshes[i];
            // flat（2D）では垂線は applyVisibility で常に非表示のため、非表示メッシュの
            // 毎フレーム再生成（instance 更新）を省く（無駄な更新コスト削減）。
            if (node.verticalsEnabled && drop && !flat) {
                drop.mesh = CreateTube(
                    `${node.id}-drop-${i}`,
                    {
                        path: [node.relTop[i], node.relBottom[i]],
                        // 垂線も distScale を掛けて画面上の太さを一定に保つ。
                        radius:
                            Math.max(node.style.dropLineWidth, 0.001) *
                            distScale,
                        instance: drop.mesh,
                    },
                    scene,
                );
                drop.mesh.position.copyFrom(scratchOrigin);
            }

            const label = node.pointLabels[i];
            if (label) {
                label.mesh.scaling.setAll(distScale);
                // ラベルは点を覆い隠さないよう「画面上方向」へオフセットする（平面版と同手法）。
                // 2D トップダウン（視線=地心 up）では地心 up オフセットだと点に重なるため screen up を使う。
                // screen up が特異な場合のみ地心 up（scratchUp）へフォールバックする。
                const dir =
                    camPos &&
                    camUp &&
                    computeScreenUpToRef(camPos, camUp, top, scratchScreenUp)
                        ? scratchScreenUp
                        : scratchUp;
                const offset =
                    pointRadius +
                    label.heightWorld * distScale * 0.5 +
                    labelGap;
                label.mesh.position
                    .copyFrom(top)
                    .addInPlace(
                        scratchLabelOffset.copyFrom(dir).scaleInPlace(offset),
                    );
            }
        }

        const hasEdges = node.points.length >= 2;
        if (hasEdges) {
            const lineRadiusWorld = Math.max(node.style.lineWidth, 0.001);
            // "screen" モードでは頂点ごとの実カメラ距離から distScale を計算する
            // （既定の "world" は距離比例の distScale だが、算出元が全頂点の重心のため、
            // 長い折れ線の一部にズームインすると重心距離が遠いままで太く見えてしまう。
            // radiusFunction で頂点ごとに計算すれば、垂線と同じ考え方でズーム位置に
            // 依らず太さを一定に保てる）。
            // 2D 正射（flat）では、上の distScale と同じ理由（radius 比例の flatScale が
            // 既に全頂点で画面上サイズを一定にする。距離比例の per-vertex 計算は高度差で
            // カメラ距離がばらつき、逆に太さが不揃いになる）で radiusFunction を無効化し、
            // 一律 distScale（= flatScale）を使う。
            const radiusFunction =
                !flat && node.style.lineWidthMode === "screen" && cameraEcef
                    ? (i: number): number =>
                          lineRadiusWorld *
                          computeOverlayDistanceScale(cameraEcef, node.top[i])
                    : undefined;
            node.lineMesh = CreateTube(
                `${node.id}-outline`,
                {
                    path: node.relTop,
                    // ラインも distScale を掛けて画面上の太さを一定に保つ（マーカーの pole と同様）。
                    radius: lineRadiusWorld * distScale,
                    radiusFunction,
                    instance: node.lineMesh,
                },
                scene,
            );
            node.lineMesh.position.copyFrom(scratchOrigin);
            // flat（2D）では壁は applyVisibility で常に非表示のため再生成を省く。
            if (node.wallsEnabled && !flat) {
                node.wallMesh = CreateRibbon(
                    `${node.id}-wall`,
                    {
                        pathArray: [node.relTop, node.relBottom],
                        instance: node.wallMesh,
                    },
                    scene,
                );
                node.wallMesh.position.copyFrom(scratchOrigin);
            }
            const count = edgeCount(node.points.length, node.closed);
            for (let i = 0; i < count; i++) {
                const label = node.edgeLabels[i];
                if (!label) continue;
                const a = node.top[i];
                const b = node.top[(i + 1) % node.points.length];
                a.addToRef(b, scratchMid);
                scratchMid.scaleInPlace(0.5);
                node.bottom[i].addToRef(
                    node.bottom[(i + 1) % node.points.length],
                    scratchBottomMid,
                );
                scratchBottomMid.scaleInPlace(0.5);
                scratchMid.subtractToRef(scratchBottomMid, scratchEdgeUp);
                if (scratchEdgeUp.lengthSquared() < 1e-12)
                    scratchMid.normalizeToRef(scratchEdgeUp);
                else scratchEdgeUp.normalize();
                label.mesh.scaling.setAll(distScale);
                // 辺ラベルも線に重ねないよう画面上方向へ逃がす（特異時は地心 up へフォールバック）。
                const edgeDir =
                    camPos &&
                    camUp &&
                    computeScreenUpToRef(
                        camPos,
                        camUp,
                        scratchMid,
                        scratchScreenUp,
                    )
                        ? scratchScreenUp
                        : scratchEdgeUp;
                const edgeOffset =
                    Math.max(node.style.lineWidth, 0.001) * distScale +
                    label.heightWorld * distScale * 0.5 +
                    labelGap;
                label.mesh.position
                    .copyFrom(scratchMid)
                    .addInPlace(
                        scratchLabelOffset
                            .copyFrom(edgeDir)
                            .scaleInPlace(edgeOffset),
                    );
            }
        }
        applyVisibility(node);
    };

    const add = (opts: GlobePolygonOptions): string => {
        if (disposed)
            throw new Error("GlobePolygonManager.add: called after dispose");
        if (!opts.points || opts.points.length < 1) {
            throw new Error(
                "GlobePolygonManager.add: points requires at least 1 vertex",
            );
        }
        const id = `globe-polygon-${seq++}`;
        const closed = opts.closed ?? POLYGON_DEFAULTS.closed;
        const altitudeMode =
            opts.topAltitudeMeters != null
                ? "absolute"
                : (opts.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode);
        const style = resolveStyle(opts.style);
        const pathLen = Math.max(
            2,
            drapedPolygonPathLength(opts.points.length, closed),
        );
        const pointsEnabled = opts.pointsEnabled ?? true;
        const verticalsEnabled =
            opts.verticalsEnabled ?? POLYGON_DEFAULTS.verticalsEnabled;
        const pointMeshes: (MeshEntry | null)[] = opts.points.map((_p, i) => {
            if (!pointsEnabled) return null;
            const mesh = CreateSphere(
                `${id}-point-${i}`,
                { diameter: 1, segments: 16 },
                scene,
            );
            mesh.renderingGroupId = TERRAIN_RENDERING_GROUP_ID;
            mesh.isPickable = true;
            const material = createMaterial(
                scene,
                `${id}-point-mat-${i}`,
                style.pointColor,
                POLYGON_DEFAULTS.style.pointColor,
                style.pointOpacity,
            );
            mesh.material = material;
            return { mesh, material };
        });
        const dropMeshes: (MeshEntry | null)[] = opts.points.map((_p, i) => {
            if (!verticalsEnabled) return null;
            const mesh = CreateTube(
                `${id}-drop-${i}`,
                {
                    path: [new Vector3(0, 0, 0), new Vector3(0, 1, 0)],
                    radius: Math.max(style.dropLineWidth, 0.001),
                    updatable: true,
                    cap: Mesh.NO_CAP,
                },
                scene,
            );
            mesh.renderingGroupId = TERRAIN_RENDERING_GROUP_ID;
            mesh.isPickable = false;
            const material = createMaterial(
                scene,
                `${id}-drop-mat-${i}`,
                style.dropLineColor,
                POLYGON_DEFAULTS.style.dropLineColor,
                style.dropLineOpacity,
            );
            mesh.material = material;
            return { mesh, material };
        });
        const pointLabels = opts.points.map((_p, i) => {
            const text = opts.labels?.[i];
            return text == null
                ? null
                : createLabelMesh(scene, id, i, text, style, "label");
        });
        const eCount = edgeCount(opts.points.length, closed);
        const edgeLabels = Array.from({ length: eCount }, (_v, i) => {
            const text = opts.edgeLabels?.[i];
            return text == null
                ? null
                : createLabelMesh(scene, id, i, text, style, "edge-label");
        });

        const lineMesh = CreateTube(
            `${id}-outline`,
            {
                path: placeholderPath(opts.points.length, closed),
                radius: Math.max(style.lineWidth, 0.001),
                updatable: true,
                cap: Mesh.NO_CAP,
            },
            scene,
        );
        lineMesh.renderingGroupId = TERRAIN_RENDERING_GROUP_ID;
        lineMesh.isPickable = false;
        const lineMat = createMaterial(
            scene,
            `${id}-outline-mat`,
            style.lineColor,
            POLYGON_DEFAULTS.style.lineColor,
            style.lineOpacity,
        );
        lineMesh.material = lineMat;

        const wallMesh = CreateRibbon(
            `${id}-wall`,
            {
                pathArray: [
                    placeholderPath(opts.points.length, closed),
                    placeholderPath(opts.points.length, closed),
                ],
                updatable: true,
                sideOrientation: Mesh.DOUBLESIDE,
            },
            scene,
        );
        wallMesh.renderingGroupId = TERRAIN_RENDERING_GROUP_ID;
        wallMesh.isPickable = false;
        const wallMat = createMaterial(
            scene,
            `${id}-wall-mat`,
            style.wallColor,
            POLYGON_DEFAULTS.style.wallColor,
            style.wallOpacity,
        );
        wallMesh.material = wallMat;

        const node: GlobePolygonNode = {
            id,
            points: opts.points.map((p) => ({
                lat: p.lat,
                lon: p.lon,
                altitude: p.altitude,
            })),
            closed,
            altitudeMode,
            topAltitudeMeters: opts.topAltitudeMeters,
            enabled: opts.enabled ?? POLYGON_DEFAULTS.enabled,
            verticalsEnabled,
            labelsEnabled: opts.labelsEnabled ?? POLYGON_DEFAULTS.labelsEnabled,
            wallsEnabled: opts.wallsEnabled ?? POLYGON_DEFAULTS.wallsEnabled,
            lineEnabled: opts.lineEnabled ?? true,
            pointsEnabled,
            elevationResolved: altitudeMode === "absolute",
            style,
            pointMeshes,
            dropMeshes,
            pointLabels,
            edgeLabels,
            lineMesh,
            lineMat,
            wallMesh,
            wallMat,
            top: Array.from({ length: pathLen }, () => new Vector3()),
            bottom: Array.from({ length: pathLen }, () => new Vector3()),
            relTop: Array.from({ length: pathLen }, () => new Vector3()),
            relBottom: Array.from({ length: pathLen }, () => new Vector3()),
            elevs: opts.points.map(() => 0),
            pointWorldRadius: Math.max(style.pointDiameter, 0.001) * 0.5,
        };
        nodes.set(id, node);
        placeNode(node, lastCameraEcef, lastFlatScale);
        return id;
    };

    const remove = (id: string): void => {
        const node = nodes.get(id);
        if (!node) {
            console.warn(`[globe-polygon] remove: id "${id}" not found`);
            return;
        }
        for (const entry of node.pointMeshes) {
            if (!entry) continue;
            entry.material.dispose();
            entry.mesh.dispose();
        }
        for (const entry of node.dropMeshes) {
            if (!entry) continue;
            entry.material.dispose();
            entry.mesh.dispose();
        }
        for (const entry of node.pointLabels) {
            if (!entry) continue;
            entry.texture.dispose();
            entry.material.dispose();
            entry.mesh.dispose();
        }
        for (const entry of node.edgeLabels) {
            if (!entry) continue;
            entry.texture.dispose();
            entry.material.dispose();
            entry.mesh.dispose();
        }
        node.lineMat.dispose();
        node.lineMesh.dispose();
        node.wallMat.dispose();
        node.wallMesh.dispose();
        nodes.delete(id);
    };

    const setEnabled = (id: string, enabled: boolean): void => {
        if (disposed)
            throw new Error(
                "GlobePolygonManager.setEnabled: called after dispose",
            );
        const node = nodes.get(id);
        if (!node)
            throw new Error(
                `GlobePolygonManager.setEnabled: id "${id}" not found`,
            );
        node.enabled = enabled;
        applyVisibility(node);
    };

    const setFlatten = (next: boolean): void => {
        if (disposed)
            throw new Error(
                "GlobePolygonManager.setFlatten: called after dispose",
            );
        if (next === flat) return;
        flat = next;
        if (flat) {
            // 3D→2D 切替の瞬間に elevs を terrain 基準へ正規化する。これをしないと、3D で
            // absolute / topAltitudeMeters を使っていたポリゴンの elevs（=絶対高度）が残り、
            // 切替直後に terrainElevAt が未解決（null）だと buildPaths の flat 分岐が前回値を
            // 保持するため 2D でも高度が生きてしまう（ズームインで near クリップを割る原因）。
            // terrain 解決済みなら接地高度、未解決なら 0（海面）へ揃える（offset/絶対高度を除去）。
            for (const node of nodes.values()) {
                for (let i = 0; i < node.points.length; i++) {
                    const p = node.points[i];
                    node.elevs[i] = terrainElevAt(p.lat, p.lon) ?? 0;
                }
            }
        }
        // 壁/垂線の有効可否は applyVisibility が flat を参照して決めるため、全ノードへ再適用する。
        for (const node of nodes.values()) applyVisibility(node);
    };

    const update = (cameraEcef?: Vector3, flatScale?: number): void => {
        if (disposed)
            throw new Error("GlobePolygonManager.update: called after dispose");
        lastCameraEcef = cameraEcef;
        lastFlatScale = flatScale;
        for (const node of nodes.values()) {
            if (!node.enabled) continue;
            placeNode(node, cameraEcef, flatScale);
        }
    };

    // ラベルを希望テキストへ合わせる。不変なら再利用、変化時も既存テクスチャに収まれば in-place 再描画
    // （mesh/material/texture 再利用＝チラつき無し）、収まらない場合のみ作り直す。null/undefined で削除。
    const reconcileLabel = (
        entry: LabelEntry | null,
        desiredText: string | null | undefined,
        style: ResolvedStyle,
        id: string,
        index: number,
        prefix: "label" | "edge-label",
    ): LabelEntry | null => {
        const desired = desiredText ?? null;
        if (desired == null) {
            if (entry) {
                entry.texture.dispose();
                entry.material.dispose();
                entry.mesh.dispose();
            }
            return null;
        }
        if (entry) {
            if (redrawLabel(scene, entry, desired, style)) return entry;
            // 新テキストが既存テクスチャに収まらない（幅拡大）場合のみ作り直す。
            entry.texture.dispose();
            entry.material.dispose();
            entry.mesh.dispose();
        }
        return createLabelMesh(scene, id, index, desired, style, prefix);
    };

    const setContent = (
        id: string,
        content: GlobePolygonContentUpdate,
    ): boolean => {
        if (disposed)
            throw new Error(
                "GlobePolygonManager.setContent: called after dispose",
            );
        const node = nodes.get(id);
        if (!node) return false;
        // 点数（＝辺数の前提）が変わる場合は in-place 不可。呼び出し側で remove/add する。
        if (content.points.length !== node.points.length) return false;
        node.points = content.points.map((p) => ({
            lat: p.lat,
            lon: p.lon,
            altitude: p.altitude,
        }));
        // node.id は内部 id（createLabelMesh の命名に使う）。
        // labels / edgeLabels は「キーの有無」で判定する。`{ labels: undefined }` のように
        // 明示クリアしたいケースを反映するため `if (content.labels)`（truthy）ではなくキー存在で判定し、
        // `content.labels?.[i]` の undefined を reconcileLabel がクリアとして扱う。
        if ("labels" in content) {
            for (let i = 0; i < node.pointLabels.length; i++) {
                node.pointLabels[i] = reconcileLabel(
                    node.pointLabels[i],
                    content.labels?.[i],
                    node.style,
                    node.id,
                    i,
                    "label",
                );
            }
        }
        if ("edgeLabels" in content) {
            for (let i = 0; i < node.edgeLabels.length; i++) {
                node.edgeLabels[i] = reconcileLabel(
                    node.edgeLabels[i],
                    content.edgeLabels?.[i],
                    node.style,
                    node.id,
                    i,
                    "edge-label",
                );
            }
        }
        // buildPaths が node.points から top/bottom・標高を再計算し、placeNode が
        // tube/ribbon を instance 更新・点/ラベルを再配置する（メッシュ破棄なし）。
        placeNode(node, lastCameraEcef, lastFlatScale);
        return true;
    };

    const getPickablePoints = (out: GlobePolygonPickablePoint[]): number => {
        let n = 0;
        if (disposed) {
            out.length = 0;
            return 0;
        }
        for (const node of nodes.values()) {
            if (
                !node.enabled ||
                !node.elevationResolved ||
                !node.pointsEnabled
            ) {
                continue;
            }
            // closed の重複末尾点（top[points.length]）は対象外。点メッシュ数ぶんのみ。
            for (let i = 0; i < node.points.length; i++) {
                const entry = node.pointMeshes[i];
                if (!entry) continue;
                const top = node.top[i];
                // 既存スロットを再利用し、無ければ 1 度だけ生成する（割り当て抑制）。
                let slot = out[n];
                if (!slot) {
                    slot = {
                        polygonId: "",
                        index: 0,
                        x: 0,
                        y: 0,
                        z: 0,
                        radius: 0,
                    };
                    out[n] = slot;
                }
                slot.polygonId = node.id;
                slot.index = i;
                slot.x = top.x;
                slot.y = top.y;
                slot.z = top.z;
                slot.radius = node.pointWorldRadius;
                n++;
            }
        }
        return n;
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return {
        add,
        remove,
        setEnabled,
        setFlatten,
        update,
        setContent,
        getPickablePoints,
        dispose,
    };
};
