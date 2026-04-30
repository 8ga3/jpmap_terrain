/**
 * 個別ポリゴンノード (Issue #170 / #171)。
 *
 * - 頂点ごとの球（{@link CreateSphere}）
 * - 頂点列を結ぶチューブ（{@link CreateTube}、`updatable: true`）
 * - 各頂点から地表へ落ちる垂線（#171, 1 頂点 1 Tube、`updatable: true`）
 * - `labels[i]` が指定された頂点に対応するラベル平面（#171, ビルボード + DynamicTexture）
 * を 1 つの root TransformNode 配下に親子化して管理する。
 *
 * `closed=true` のときはチューブ末端に最初の頂点を append し、可視的に閉じる。
 * 面塗り・壁は本タスクでは実装しない（#172 / #173）。
 */

import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import {
    POLYGON_DEFAULTS,
    type AltitudeMode,
    type PolygonHandle,
    type PolygonOptions,
    type PolygonPointOptions,
    type PolygonPointPartial,
    type PolygonStyleOptions,
} from "../lib/types";

const RENDERING_GROUP_ID = 1;
/**
 * 垂線 / 壁は地表メッシュ（既定グループ 0）と同グループで
 * 描画し、地表の深度バッファで地中部分をオクルードさせる (#186)。
 * 頂点球 / ポリライン / ラベルは引き続き `RENDERING_GROUP_ID` にて
 * 地表より手前に描画される。
 */
const SUBTERRAIN_RENDERING_GROUP_ID = 0;
const LABEL_MAX_DT_SIZE = 1024;
// テキストにフィットさせるため MIN は小さくし、余白は innerPad のみで表現する。
const LABEL_MIN_DT_SIZE = 32;
// 球トップとラベル下端の間隔 (フォント高さに対する比率をスケール反映)。 (#171)
const LABEL_GAP_FONT_RATIO = 0.0;

interface ResolvedStyle {
    lineColor: string;
    lineWidth: number;
    lineOpacity: number;
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

const resolveStyle = (style: PolygonStyleOptions | undefined): ResolvedStyle => ({
    lineColor: style?.lineColor ?? POLYGON_DEFAULTS.style.lineColor,
    lineWidth: style?.lineWidth ?? POLYGON_DEFAULTS.style.lineWidth,
    lineOpacity: style?.lineOpacity ?? POLYGON_DEFAULTS.style.lineOpacity,
    pointDiameter:
        style?.pointDiameter ?? POLYGON_DEFAULTS.style.pointDiameter,
    pointColor: style?.pointColor ?? POLYGON_DEFAULTS.style.pointColor,
    pointOpacity: style?.pointOpacity ?? POLYGON_DEFAULTS.style.pointOpacity,
    dropLineColor:
        style?.dropLineColor ?? POLYGON_DEFAULTS.style.dropLineColor,
    dropLineWidth:
        style?.dropLineWidth ?? POLYGON_DEFAULTS.style.dropLineWidth,
    dropLineOpacity:
        style?.dropLineOpacity ?? POLYGON_DEFAULTS.style.dropLineOpacity,
    labelColor: style?.labelColor ?? POLYGON_DEFAULTS.style.labelColor,
    labelBackgroundColor:
        style?.labelBackgroundColor ??
        POLYGON_DEFAULTS.style.labelBackgroundColor,
    labelFontSize:
        style?.labelFontSize ?? POLYGON_DEFAULTS.style.labelFontSize,
    wallColor: style?.wallColor ?? POLYGON_DEFAULTS.style.wallColor,
    wallOpacity: style?.wallOpacity ?? POLYGON_DEFAULTS.style.wallOpacity,
});

/**
 * 1 ポリゴン分の Babylon ノード。`PolygonManager` から生成・更新・破棄される。
 */
export interface PolygonNode {
    readonly id: string;
    readonly altitudeMode: AltitudeMode;
    readonly closed: boolean;
    /** 頂点座標 (lat / lon / altitude) のスナップショット。manager から更新される */
    readonly points: readonly PolygonPointOptions[];
    /**
     * 全頂点を更新する。
     * @param worldPoints 各頂点のワールド座標（Y は標高反映済み）。
     * @param groundYs 各頂点の地表ワールド Y。`null` のときは 0 にフォールバックする。
     * @param pointScale screen-stable な距離スケール係数。
     */
    applyTransform(
        worldPoints: readonly Vector3[],
        groundYs: readonly (number | null)[],
        pointScale: number,
    ): void;
    setEnabledLogical(enabled: boolean): void;
    setVerticalsEnabledLogical(enabled: boolean): void;
    setLabelsEnabledLogical(enabled: boolean): void;
    setWallsEnabledLogical(enabled: boolean): void;
    setElevationResolved(resolved: boolean): void;
    /**
     * 頂点列の編集 API (#173)。
     * いずれも内部状態（points / labels / メッシュ配列）を更新したのち、
     * 即時の applyTransform を呼ばずに完了する（呼び出し側が tick で反映する）。
     * 点数が変化した場合 lineMesh / wallMesh は dispose され、次回 applyTransform
     * 時に instance なしで再生成される。
     */
    insertPoint(index: number, point: PolygonPointOptions): void;
    removePoint(index: number): void;
    updatePoint(index: number, partial: PolygonPointPartial): void;
    replacePoints(points: readonly PolygonPointOptions[]): void;
    getHandle(): PolygonHandle;
    dispose(): void;
}

const createPointSphere = (
    scene: Scene,
    id: string,
    index: number,
    style: ResolvedStyle,
    parent: TransformNode,
): { mesh: Mesh; material: StandardMaterial } => {
    const mesh = CreateSphere(
        `polygon-${id}-point-${index}`,
        { diameter: 1, segments: 16 },
        scene,
    );
    const material = new StandardMaterial(
        `polygon-${id}-point-mat-${index}`,
        scene,
    );
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.emissiveColor = Color3.FromHexString(style.pointColor);
    material.alpha = style.pointOpacity;
    mesh.material = material;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    // 頂点インタラクション API (#184) のため pickable にする。
    // 名前 `polygon-${id}-point-${index}` は DefaultScene 側の
    // `pickPolygonPoint` でパースされ、polygonId / index の解決に使われる。
    mesh.isPickable = true;
    mesh.parent = parent;
    return { mesh, material };
};

const createDropLine = (
    scene: Scene,
    id: string,
    index: number,
    style: ResolvedStyle,
    parent: TransformNode,
): { mesh: Mesh; material: StandardMaterial } => {
    // updatable Tube は path 長を変えられないため、placeholder の 2 点で構築する。
    const path = [new Vector3(0, 0, 0), new Vector3(0, 1, 0)];
    const mesh = CreateTube(
        `polygon-${id}-drop-${index}`,
        {
            path,
            radius: Math.max(style.dropLineWidth, 0.001),
            updatable: true,
            cap: Mesh.NO_CAP,
        },
        scene,
    );
    const material = new StandardMaterial(
        `polygon-${id}-drop-mat-${index}`,
        scene,
    );
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.emissiveColor = Color3.FromHexString(style.dropLineColor);
    material.alpha = style.dropLineOpacity;
    mesh.material = material;
    // 地表と同グループで描画し、地表の深度バッファで
    // 地表より下のセグメントをオクルードさせる (#186)。
    mesh.renderingGroupId = SUBTERRAIN_RENDERING_GROUP_ID;
    mesh.isPickable = false;
    mesh.parent = parent;
    return { mesh, material };
};

interface LabelEntry {
    mesh: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    /** 平面の幅（world m, スケール=1 時）。 */
    widthWorld: number;
    /** 平面の高さ（world m, スケール=1 時）。 */
    heightWorld: number;
}

const createLabelMesh = (
    scene: Scene,
    id: string,
    index: number,
    text: string,
    style: ResolvedStyle,
    parent: TransformNode,
    /**
     * mesh / material / texture 名のプレフィクス。`"label"`（点ラベル）または
     * `"edge-label"`（#185 辺ラベル）。命名以外の挙動は共通。
     */
    namePrefix: "label" | "edge-label" = "label",
): LabelEntry => {
    const dpr =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio ===
            "number"
            ? Math.max(
                  (globalThis as { devicePixelRatio: number }).devicePixelRatio,
                  1,
              )
            : 1;

    const lines = text.split("\n");
    const fontSize = Math.max(style.labelFontSize, 1);
    const padPx = Math.round(fontSize * 0.1);
    const strokePx = Math.max(2, Math.round(fontSize * 0.12));
    const lineHeightPx = fontSize * 1.2;

    // 文字幅を測るための probe テクスチャ。
    const probe = new DynamicTexture(
        `polygon-${id}-${namePrefix}-probe-${index}`,
        { width: 16, height: 16 },
        scene,
        false,
    );
    const probeCtx = probe.getContext();
    probeCtx.font = `${fontSize}px sans-serif`;
    let maxLineWidth = 0;
    for (const ln of lines) {
        const m = probeCtx.measureText(ln === "" ? " " : ln);
        if (m.width > maxLineWidth) maxLineWidth = m.width;
    }
    probe.dispose();

    // 縁取り (stroke) ぶんも余白に確保する。
    const innerPad = padPx + strokePx;
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

    const texture = new DynamicTexture(
        `polygon-${id}-${namePrefix}-${index}`,
        { width: dtWidth, height: dtHeight },
        scene,
        false,
    );
    texture.hasAlpha = true;
    // Plane の UV と canvas の Y 軸を一致させる（上下反転防止）。
    texture.vScale = -1;
    texture.vOffset = 1;

    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, dtWidth, dtHeight);
    if (style.labelBackgroundColor && style.labelBackgroundColor !== "transparent") {
        ctx.fillStyle = style.labelBackgroundColor;
        ctx.fillRect(0, 0, dtWidth, dtHeight);
    }
    ctx.font = `${fontSize * dpr}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    const startY = innerPad * dpr;
    const centerX = dtWidth / 2;
    // 1) 白縁取り → 2) テキスト本体（マーカーと同じ描画順）
    ctx.lineWidth = strokePx * 2 * dpr;
    ctx.strokeStyle = "#ffffff";
    for (let i = 0; i < lines.length; i++) {
        ctx.strokeText(lines[i], centerX, startY + i * lineHeightPx * dpr);
    }
    ctx.fillStyle = style.labelColor;
    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], centerX, startY + i * lineHeightPx * dpr);
    }
    texture.update(false);

    // pixel→world は 1px = 1m 換算（distScale 適用前のベースサイズ）。
    const widthWorld = dtWidth / dpr;
    const heightWorld = dtHeight / dpr;

    const mesh = CreatePlane(
        `polygon-${id}-${namePrefix}-${index}`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    mesh.parent = parent;

    const material = new StandardMaterial(
        `polygon-${id}-${namePrefix}-mat-${index}`,
        scene,
    );
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = Color3.White();
    material.diffuseTexture = texture;
    mesh.material = material;

    return { mesh, material, texture, widthWorld, heightWorld };
};

/**
 * 線パスを構築する。`closed=true` のときは先頭頂点を末尾に append する。
 * 参照を分けるために常に新しい配列・新しい Vector3 を返す。
 */
const buildLinePath = (
    worldPoints: readonly Vector3[],
    closed: boolean,
): Vector3[] => {
    const path: Vector3[] = worldPoints.map((p) => new Vector3(p.x, p.y, p.z));
    if (closed && path.length >= 2) {
        const first = path[0];
        path.push(new Vector3(first.x, first.y, first.z));
    }
    return path;
};

/**
 * 壁 Ribbon の pathArray を構築する。
 * 上側 row = 各頂点の世界座標、下側 row = 同じ XZ で Y=0 に落とした座標 (#186)。
 * `closed=true` のときは先頭頂点を末尾にも追加して閉じる。
 *
 * Ribbon は updatable + instance 更新時に長さを変えられないため、
 * 構築時の長さ（`closed ? N+1 : N`）で固定される。
 *
 * 旧仕様では地表 Y を下端としていたため `groundYs` を引数に取っていたが、
 * 現仕様では地表を貫通させて Y=0 まで伸ばす。引数名は呼び出し側と既存の
 * 型を維持するため残しているが、未使用であることを示すため `_groundYs`
 * とした。
 */
const buildWallPathArray = (
    worldPoints: readonly Vector3[],
    _groundYs: readonly (number | null)[],
    closed: boolean,
): [Vector3[], Vector3[]] => {
    const top: Vector3[] = worldPoints.map((p) => new Vector3(p.x, p.y, p.z));
    const ground: Vector3[] = worldPoints.map((p) => new Vector3(p.x, 0, p.z));
    if (closed && top.length >= 2) {
        const ft = top[0];
        const fg = ground[0];
        top.push(new Vector3(ft.x, ft.y, ft.z));
        ground.push(new Vector3(fg.x, fg.y, fg.z));
    }
    return [top, ground];
};

/**
 * `PolygonNode` を生成する。`points.length >= 1` 前提（`PolygonManager` 側で検証済み）。
 *
 * `points.length === 1` のときは辺（線）・壁・辺ラベルは存在せず、点・垂線・点ラベルのみ
 * 描画される。Babylon の `CreateTube` / `CreateRibbon` は path 長さを
 * instance 更新で変えられないため、N<2 のときも長さ 2 の placeholder を
 * 作って保持し、`setEnabled(false)` で隠す。
 */
export const createPolygonNode = (
    scene: Scene,
    id: string,
    options: PolygonOptions,
): PolygonNode => {
    const closed = options.closed ?? POLYGON_DEFAULTS.closed;
    const altitudeMode = options.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode;
    const style = resolveStyle(options.style);
    let logicalEnabled = options.enabled ?? POLYGON_DEFAULTS.enabled;
    let verticalsEnabled =
        options.verticalsEnabled ?? POLYGON_DEFAULTS.verticalsEnabled;
    let labelsEnabled =
        options.labelsEnabled ?? POLYGON_DEFAULTS.labelsEnabled;
    let wallsEnabled =
        options.wallsEnabled ?? POLYGON_DEFAULTS.wallsEnabled;
    let elevationResolved = altitudeMode === "absolute";

    // wallsEnabled が false の間は Ribbon 更新をスキップするため、適用した
    // worldPoints / groundYs の参照を保持して、再 enable 時に即時で
    // 位置を追い付かせる。呼び出し側 (PolygonManager.tickPolygon) は毎フレーム
    // 新規配列を生成するため、参照保持でも次フレームに上書きされず
    // 時間取り不整合は起きない。`null` は未適用を表す。
    let lastWorldPoints: readonly Vector3[] | null = null;
    let lastGroundYs: readonly (number | null)[] | null = null;

    // 頂点はディープコピーして外部からの破壊変更を無効化する。
    const points: PolygonPointOptions[] = options.points.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        altitude: p.altitude,
    }));

    // ラベルは常に points と同じ長さで保持する (#173)。`undefined` はラベルなし。
    // 一度でも labels が指定された（または `updatePoint(label)` で設定された）場合、
    // getHandle().labels で外部に露出する。
    let hasLabels = options.labels !== undefined;
    const labels: (string | undefined)[] = points.map((_, i) =>
        options.labels ? options.labels[i] : undefined,
    );

    // 辺ラベル (#185)。長さは `closed && N>=2 ? N : Math.max(0, N-1)`。つまり N<2 のときは 0 。
    // closed=true のときの末尾要素 (i = N-1) は points[N-1]→points[0] のラベル。
    const expectedEdgeCount = (): number =>
        closed && points.length >= 2
            ? points.length
            : Math.max(0, points.length - 1);
    let hasEdgeLabels = options.edgeLabels !== undefined;
    const edgeLabels: (string | undefined)[] = Array.from(
        { length: expectedEdgeCount() },
        (_, i) => (options.edgeLabels ? options.edgeLabels[i] : undefined),
    );

    const root = new TransformNode(`polygon-${id}`, scene);

    // 各頂点に対応する球を 1 つだけ作る。スケールは applyTransform で更新する。
    const sphereEntries = points.map((_pt, index) =>
        createPointSphere(scene, id, index, style, root),
    );

    // 各頂点に対応する垂線 Tube を 1 本ずつ作る。
    const dropEntries = points.map((_pt, index) =>
        createDropLine(scene, id, index, style, root),
    );

    // labels[i] が指定された頂点にのみラベルを作る。indexed by 頂点 index。
    const labelEntries: (LabelEntry | null)[] = points.map((_pt, index) => {
        const text = labels[index];
        if (text === undefined || text === null) return null;
        return createLabelMesh(scene, id, index, text, style, root);
    });

    // edgeLabels[i] が指定された辺にのみ辺ラベルを作る (#185)。indexed by 辺 index。
    const edgeLabelEntries: (LabelEntry | null)[] = edgeLabels.map(
        (text, index) => {
            if (text === undefined || text === null) return null;
            return createLabelMesh(
                scene,
                id,
                index,
                text,
                style,
                root,
                "edge-label",
            );
        },
    );

    // 初期 path（仮）。applyTransform で必ず上書きされる前提だが、
    // 構築時にも有効な Tube が必要なので原点付近の placeholder を渡す。
    // N<2 のときも Babylon が path>=2 を要求するため、長さ 2 の placeholder で作り、
    // applyVisibility で setEnabled(false) に隠す。
    const minLineLen = 2;
    const initialPathLen = Math.max(points.length, minLineLen);
    const initialPath: Vector3[] = Array.from(
        { length: initialPathLen },
        (_, i) => new Vector3(i, 0, 0),
    );
    const initialTubePath = buildLinePath(initialPath, closed);
    let lineMesh: Mesh = CreateTube(
        `polygon-${id}-line`,
        {
            path: initialTubePath,
            radius: Math.max(style.lineWidth, 0.001),
            updatable: true,
            cap: Mesh.NO_CAP,
        },
        scene,
    );
    const lineMaterial = new StandardMaterial(`polygon-${id}-line-mat`, scene);
    lineMaterial.disableLighting = true;
    lineMaterial.backFaceCulling = false;
    lineMaterial.emissiveColor = Color3.FromHexString(style.lineColor);
    lineMaterial.alpha = style.lineOpacity;
    lineMesh.material = lineMaterial;
    lineMesh.renderingGroupId = RENDERING_GROUP_ID;
    lineMesh.isPickable = false;
    lineMesh.parent = root;

    // 壁 Ribbon (#172): 上 row = 各頂点 world、下 row = 地表 Y。
    // 構築時は groundY を 0 とした placeholder を渡し、applyTransform で実値で更新する。
    // N<2 のときも path>=2 が必要なため placeholder 長さをそろえる。
    const initialGroundYs: (number | null)[] = Array.from(
        { length: initialPathLen },
        () => null,
    );
    const initialWallPathArray = buildWallPathArray(
        initialPath,
        initialGroundYs,
        closed,
    );
    let wallMesh: Mesh = CreateRibbon(
        `polygon-${id}-walls`,
        {
            pathArray: initialWallPathArray,
            updatable: true,
            // 半透明の壁を裏面からも見えるようにする。
            sideOrientation: Mesh.DOUBLESIDE,
            closeArray: false,
        },
        scene,
    );
    const wallMaterial = new StandardMaterial(`polygon-${id}-walls-mat`, scene);
    wallMaterial.disableLighting = true;
    wallMaterial.backFaceCulling = false;
    wallMaterial.emissiveColor = Color3.FromHexString(style.wallColor);
    wallMaterial.alpha = style.wallOpacity;
    // 半透明の z-fight 緩和（同一面が前後関係で乱れないようにする）。
    if (style.wallOpacity < 1) {
        wallMaterial.needDepthPrePass = true;
    }
    wallMesh.material = wallMaterial;
    // 地表と同グループで描画し、地表の深度バッファで
    // 地表より下のセグメントをオクルードさせる (#186)。
    wallMesh.renderingGroupId = SUBTERRAIN_RENDERING_GROUP_ID;
    wallMesh.isPickable = false;
    wallMesh.parent = root;

    const applyVisibility = (): void => {
        const visible = logicalEnabled && elevationResolved;
        // N<2 のときは線・壁が幾何的に存在しないため常に false。
        const hasEdges = points.length >= 2;
        root.setEnabled(visible);
        // 子要素の個別 ON/OFF（垂線・ラベル・壁）。root が無効なら自動で隠れるので、
        // root が有効なときに verticals/labels/walls の個別設定を反映する。
        for (const entry of dropEntries) {
            entry.mesh.setEnabled(visible && verticalsEnabled);
        }
        for (const entry of labelEntries) {
            if (!entry) continue;
            entry.mesh.setEnabled(visible && labelsEnabled);
        }
        // 辺ラベル (#185) も labelsEnabled を共用する。
        for (const entry of edgeLabelEntries) {
            if (!entry) continue;
            entry.mesh.setEnabled(visible && labelsEnabled);
        }
        lineMesh.setEnabled(visible && hasEdges);
        wallMesh.setEnabled(visible && wallsEnabled && hasEdges);
    };
    applyVisibility();

    /**
     * 点数変更時の lineMesh / wallMesh 再生成 (#173)。
     * Babylon の `CreateTube` / `CreateRibbon` は instance 更新時に頂点数を変えられないため、
     * insert/remove/replace で点数が変わった直後に既存メッシュを dispose し、
     * 新しい点数に合わせた placeholder で作り直す。Material は再 attach する。
     */
    const rebuildLineMeshForCurrentPointCount = (): void => {
        lineMesh.dispose();
        // N<2 のときも Babylon の Tube/Ribbon が path>=2 を必要とするため、
        // 幾何的には存在しない場合でも長さ 2 の placeholder を保持する。
        // 表示は applyVisibility 側で setEnabled(false) により抑制する。
        const len = Math.max(points.length, 2);
        const placeholder: Vector3[] = Array.from(
            { length: len },
            (_, i) => new Vector3(i, 0, 0),
        );
        const path = buildLinePath(placeholder, closed);
        lineMesh = CreateTube(
            `polygon-${id}-line`,
            {
                path,
                radius: Math.max(style.lineWidth, 0.001),
                updatable: true,
                cap: Mesh.NO_CAP,
            },
            scene,
        );
        lineMesh.material = lineMaterial;
        lineMesh.renderingGroupId = RENDERING_GROUP_ID;
        lineMesh.isPickable = false;
        lineMesh.parent = root;
    };
    const rebuildWallMeshForCurrentPointCount = (): void => {
        wallMesh.dispose();
        const len = Math.max(points.length, 2);
        const placeholder: Vector3[] = Array.from(
            { length: len },
            (_, i) => new Vector3(i, 0, 0),
        );
        const groundPlaceholder: (number | null)[] = Array.from(
            { length: len },
            () => null,
        );
        const pathArray = buildWallPathArray(
            placeholder,
            groundPlaceholder,
            closed,
        );
        wallMesh = CreateRibbon(
            `polygon-${id}-walls`,
            {
                pathArray,
                updatable: true,
                sideOrientation: Mesh.DOUBLESIDE,
                closeArray: false,
            },
            scene,
        );
        wallMesh.material = wallMaterial;
        wallMesh.renderingGroupId = SUBTERRAIN_RENDERING_GROUP_ID;
        wallMesh.isPickable = false;
        wallMesh.parent = root;
    };

    /** 点数変動時の共通後処理。stale キャッシュをクリアし可視状態を再評価する。 */
    const onPointCountChanged = (): void => {
        rebuildLineMeshForCurrentPointCount();
        rebuildWallMeshForCurrentPointCount();
        // 再 enable 時の stale 適用を防ぐためキャッシュ破棄。
        lastWorldPoints = null;
        lastGroundYs = null;
        // terrain モードで再評価するまで一旦 hide。次回 tick で resolve される。
        if (altitudeMode === "terrain") {
            elevationResolved = false;
        }
        applyVisibility();
    };

    /**
     * 配列上の index と mesh / material / texture 名の整合を保つために
     * sphere / drop / label の name を index に合わせて再採番する (#173)。
     * insert/remove での部分編集では同名 mesh の共存と index ズレを招くため、
     * splice 後に必ず呼び出して名前を再付与する。
     */
    const renumberEntries = (): void => {
        for (let i = 0; i < sphereEntries.length; i++) {
            const e = sphereEntries[i];
            e.mesh.name = `polygon-${id}-point-${i}`;
            e.material.name = `polygon-${id}-point-mat-${i}`;
        }
        for (let i = 0; i < dropEntries.length; i++) {
            const e = dropEntries[i];
            e.mesh.name = `polygon-${id}-drop-${i}`;
            e.material.name = `polygon-${id}-drop-mat-${i}`;
        }
        for (let i = 0; i < labelEntries.length; i++) {
            const e = labelEntries[i];
            if (!e) continue;
            e.mesh.name = `polygon-${id}-label-${i}`;
            e.material.name = `polygon-${id}-label-mat-${i}`;
            e.texture.name = `polygon-${id}-label-${i}`;
        }
        // 辺ラベル (#185) も同様に index に合わせて再採番する。
        for (let i = 0; i < edgeLabelEntries.length; i++) {
            const e = edgeLabelEntries[i];
            if (!e) continue;
            e.mesh.name = `polygon-${id}-edge-label-${i}`;
            e.material.name = `polygon-${id}-edge-label-mat-${i}`;
            e.texture.name = `polygon-${id}-edge-label-${i}`;
        }
    };

    /** 内部: lat/lon/altitude のバリデーション (#173)。 */
    const assertValidPoint = (p: PolygonPointOptions, prefix: string): void => {
        if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
            throw new RangeError(`${prefix}: lat out of range (got ${p.lat})`);
        }
        if (!Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) {
            throw new RangeError(`${prefix}: lon out of range (got ${p.lon})`);
        }
        if (p.altitude !== undefined && !Number.isFinite(p.altitude)) {
            throw new RangeError(
                `${prefix}: altitude must be a finite number (got ${p.altitude})`,
            );
        }
        if (altitudeMode === "absolute" && p.altitude === undefined) {
            throw new Error(
                `${prefix}: altitudeMode="absolute" requires altitude on every point`,
            );
        }
    };

    /** ラベル mesh を index に対応するエントリに設定 / 解放する (#173)。 */
    const setLabelAt = (index: number, value: string | undefined): void => {
        const existing = labelEntries[index];
        if (value === undefined) {
            if (existing) {
                existing.texture.dispose();
                existing.material.dispose();
                existing.mesh.dispose();
                labelEntries[index] = null;
            }
            labels[index] = undefined;
            return;
        }
        // value が定義済み: 既存があれば dispose して作り直す（テキスト変更に対応）。
        if (existing) {
            existing.texture.dispose();
            existing.material.dispose();
            existing.mesh.dispose();
        }
        labelEntries[index] = createLabelMesh(scene, id, index, value, style, root);
        labels[index] = value;
        hasLabels = true;
    };

    const applyTransform = (
        worldPoints: readonly Vector3[],
        groundYs: readonly (number | null)[],
        pointScale: number,
    ): void => {
        if (worldPoints.length !== sphereEntries.length) {
            // ディフェンシブ: 想定外。何もしない（次フレームで更新されうる）。
            return;
        }
        if (groundYs.length !== sphereEntries.length) {
            // groundYs の長さ不一致は呼び出し側バグ。黙って 0 フォールバックせず
            // 当フレームの更新をスキップして検知しやすくする。
            return;
        }
        const sphereDiameter = Math.max(style.pointDiameter, 0.001);
        const sphereRadiusWorld = sphereDiameter * pointScale * 0.5;
        // 球トップとラベル下端の間隔。`LABEL_GAP_FONT_RATIO === 0` ならギャップなし。
        const labelGap = style.labelFontSize * pointScale * LABEL_GAP_FONT_RATIO;
        // カメラから見た「画面上方向」を、各点で算出する。
        // ラベル中心を `球中心 + screenUp * offsetY` に置くことで、
        // ラベル平面の billboard 回転は事実上「球中心まわり」の回転として振る舞い、
        // どのカメラ角度でもラベルが球を覆い隠さない (#186 PR レビュー指摘)。
        const camera = scene.activeCamera;
        const camPos = camera ? camera.globalPosition : null;
        const camUp = camera ? camera.upVector : null;
        for (let i = 0; i < sphereEntries.length; i++) {
            const sphere = sphereEntries[i].mesh;
            const wp = worldPoints[i];
            sphere.position.set(wp.x, wp.y, wp.z);
            sphere.scaling.setAll(sphereDiameter * pointScale);

            // 垂線: top = wp.y, bottom = 0。地表を貫通して Y=0 まで伸ばす (#186)。
            // verticalsEnabled が false（非表示中）はメッシュ更新をスキップして
            // フレーム負荷を下げる。次回 enable 時にこのループで再更新される。
            if (verticalsEnabled) {
                const dropMesh = dropEntries[i].mesh;
                const dropPath = [
                    new Vector3(wp.x, wp.y, wp.z),
                    new Vector3(wp.x, 0, wp.z),
                ];
                // CreateTube に instance を渡すと in-place で更新される。
                CreateTube(
                    `polygon-${id}-drop-${i}`,
                    { path: dropPath, instance: dropMesh },
                    scene,
                );
            }

            // ラベル: 球中心からカメラ視点での「画面上方向」へオフセット配置 + distScale 連動。
            // 中心位置 = 球中心 + screenUp(その点でのカメラ上方向) * (球半径 + ギャップ + ラベル半高)。
            // billboardMode はラベル平面自身を画面に正対させる。両者の組み合わせで
            // ラベルが常に球の「上」（画面上）に来て、球を覆い隠さない。
            const label = labelEntries[i];
            if (label) {
                const labelHalfWorld = label.heightWorld * pointScale * 0.5;
                const offset = sphereRadiusWorld + labelGap + labelHalfWorld;
                let ux = 0;
                let uy = 1;
                let uz = 0;
                if (camPos && camUp) {
                    // toCam = (camPos - wp) を normalize。
                    const tx = camPos.x - wp.x;
                    const ty = camPos.y - wp.y;
                    const tz = camPos.z - wp.z;
                    const tlen = Math.hypot(tx, ty, tz);
                    if (tlen > 1e-6) {
                        const fx = tx / tlen;
                        const fy = ty / tlen;
                        const fz = tz / tlen;
                        // right = camUp × toCam
                        const rx = camUp.y * fz - camUp.z * fy;
                        const ry = camUp.z * fx - camUp.x * fz;
                        const rz = camUp.x * fy - camUp.y * fx;
                        // screenUp = toCam × right
                        const sxv = fy * rz - fz * ry;
                        const syv = fz * rx - fx * rz;
                        const szv = fx * ry - fy * rx;
                        const slen = Math.hypot(sxv, syv, szv);
                        if (slen > 1e-6) {
                            ux = sxv / slen;
                            uy = syv / slen;
                            uz = szv / slen;
                        }
                    }
                }
                label.mesh.position.set(
                    wp.x + ux * offset,
                    wp.y + uy * offset,
                    wp.z + uz * offset,
                );
                label.mesh.scaling.setAll(pointScale);
            }
        }
        // 辺ラベル (#185): edgeLabels[i] は worldPoints[i] と worldPoints[(i+1) % N]
        // の中点に配置する。closed=false の末尾辺は対象外（edgeLabelEntries の長さで吸収）。
        // 中点そのままだと線と重なるため、線より上（画面上方向）にオフセットして
        // 線を覆い隠さないようにする (#186)。点ラベルと同じく billboard と組み合わせて
        // 「線中点まわりの公転」として振る舞わせる。
        const lineRadiusWorld = Math.max(style.lineWidth, 0.001);
        const edgeLabelGap = style.labelFontSize * pointScale * LABEL_GAP_FONT_RATIO;
        const N = worldPoints.length;
        for (let i = 0; i < edgeLabelEntries.length; i++) {
            const entry = edgeLabelEntries[i];
            if (!entry) continue;
            const a = worldPoints[i];
            const b = worldPoints[(i + 1) % N];
            const mx = (a.x + b.x) * 0.5;
            const my = (a.y + b.y) * 0.5;
            const mz = (a.z + b.z) * 0.5;
            const labelHalfWorld = entry.heightWorld * pointScale * 0.5;
            const offset = lineRadiusWorld + edgeLabelGap + labelHalfWorld;
            let ux = 0;
            let uy = 1;
            let uz = 0;
            if (camPos && camUp) {
                const tx = camPos.x - mx;
                const ty = camPos.y - my;
                const tz = camPos.z - mz;
                const tlen = Math.hypot(tx, ty, tz);
                if (tlen > 1e-6) {
                    const fx = tx / tlen;
                    const fy = ty / tlen;
                    const fz = tz / tlen;
                    const rx = camUp.y * fz - camUp.z * fy;
                    const ry = camUp.z * fx - camUp.x * fz;
                    const rz = camUp.x * fy - camUp.y * fx;
                    const sxv = fy * rz - fz * ry;
                    const syv = fz * rx - fx * rz;
                    const szv = fx * ry - fy * rx;
                    const slen = Math.hypot(sxv, syv, szv);
                    if (slen > 1e-6) {
                        ux = sxv / slen;
                        uy = syv / slen;
                        uz = szv / slen;
                    }
                }
            }
            entry.mesh.position.set(
                mx + ux * offset,
                my + uy * offset,
                mz + uz * offset,
            );
            entry.mesh.scaling.setAll(pointScale);
        }
        const tubePath = buildLinePath(worldPoints, closed);
        // N<2 のときは線・壁が幾何的に存在しないので Tube/Ribbon は更新しない
        // （placeholder のまま setEnabled(false) で隠す）。
        if (worldPoints.length >= 2) {
            lineMesh = CreateTube(
                `polygon-${id}-line`,
                { path: tubePath, instance: lineMesh },
                scene,
            );
        }

        // 壁 Ribbon (#172) の更新。非表示中はスキップしてフレーム負荷を下げるが、
        // 上で lastWorldPoints / lastGroundYs の参照を保持しておき、setWallsEnabled(true)
        // 時に同一データで Ribbon を再適用して stale 表示を避ける。
        lastWorldPoints = worldPoints;
        lastGroundYs = groundYs;
        if (wallsEnabled && worldPoints.length >= 2) {
            const wallPathArray = buildWallPathArray(
                worldPoints,
                groundYs,
                closed,
            );
            wallMesh = CreateRibbon(
                `polygon-${id}-walls`,
                { pathArray: wallPathArray, instance: wallMesh },
                scene,
            );
        }
    };

    const getHandle = (): PolygonHandle => ({
        id,
        points: points.map((p) => ({ ...p })),
        closed,
        altitudeMode,
        labels: hasLabels ? Object.freeze([...labels]) : undefined,
        edgeLabels: hasEdgeLabels ? Object.freeze([...edgeLabels]) : undefined,
        style: { ...style },
        enabled: logicalEnabled,
        verticalsEnabled,
        labelsEnabled,
        wallsEnabled,
        elevationResolved,
    });

    const dispose = (): void => {
        for (const entry of sphereEntries) {
            entry.material.dispose();
            entry.mesh.dispose();
        }
        sphereEntries.length = 0;
        for (const entry of dropEntries) {
            entry.material.dispose();
            entry.mesh.dispose();
        }
        dropEntries.length = 0;
        for (const entry of labelEntries) {
            if (!entry) continue;
            entry.texture.dispose();
            entry.material.dispose();
            entry.mesh.dispose();
        }
        labelEntries.length = 0;
        // 辺ラベル (#185) も dispose する。
        for (const entry of edgeLabelEntries) {
            if (!entry) continue;
            entry.texture.dispose();
            entry.material.dispose();
            entry.mesh.dispose();
        }
        edgeLabelEntries.length = 0;
        lineMaterial.dispose();
        lineMesh.dispose();
        wallMaterial.dispose();
        wallMesh.dispose();
        root.dispose();
    };

    return {
        id,
        altitudeMode,
        closed,
        points,
        applyTransform,
        setEnabledLogical(enabled: boolean): void {
            logicalEnabled = enabled;
            applyVisibility();
        },
        setVerticalsEnabledLogical(enabled: boolean): void {
            verticalsEnabled = enabled;
            applyVisibility();
        },
        setLabelsEnabledLogical(enabled: boolean): void {
            labelsEnabled = enabled;
            applyVisibility();
        },
        setWallsEnabledLogical(enabled: boolean): void {
            const wasEnabled = wallsEnabled;
            wallsEnabled = enabled;
            // false → true に切り替わったタイミングで stale を避けるため、
            // 直近適用された worldPoints / groundYs で Ribbon を即時再計算する。
            if (
                enabled &&
                !wasEnabled &&
                lastWorldPoints !== null &&
                lastGroundYs !== null &&
                lastWorldPoints.length === sphereEntries.length
            ) {
                const wallPathArray = buildWallPathArray(
                    lastWorldPoints,
                    lastGroundYs,
                    closed,
                );
                wallMesh = CreateRibbon(
                    `polygon-${id}-walls`,
                    { pathArray: wallPathArray, instance: wallMesh },
                    scene,
                );
            }
            applyVisibility();
        },
        setElevationResolved(resolved: boolean): void {
            elevationResolved = resolved;
            applyVisibility();
        },
        insertPoint(index: number, point: PolygonPointOptions): void {
            const prefix = `polygon[${id}].insertPoint`;
            if (!Number.isInteger(index) || index < 0 || index > points.length) {
                throw new RangeError(
                    `${prefix}: index out of range (got ${index}, length=${points.length})`,
                );
            }
            assertValidPoint(point, prefix);
            points.splice(index, 0, {
                lat: point.lat,
                lon: point.lon,
                altitude: point.altitude,
            });
            // sphere / drop / label を index 位置に挿入する。
            const sphere = createPointSphere(
                scene,
                id,
                index,
                style,
                root,
            );
            sphereEntries.splice(index, 0, sphere);
            const drop = createDropLine(scene, id, index, style, root);
            dropEntries.splice(index, 0, drop);
            labels.splice(index, 0, undefined);
            labelEntries.splice(index, 0, null);
            // 辺ラベル (#185): 点ラベルと同じ規則で同 index にシフト。
            // expectedEdgeCount は points 増加で 1 増えるので 1 件挿入する。
            edgeLabels.splice(index, 0, undefined);
            edgeLabelEntries.splice(index, 0, null);
            renumberEntries();
            onPointCountChanged();
        },
        removePoint(index: number): void {
            const prefix = `polygon[${id}].removePoint`;
            if (!Number.isInteger(index) || index < 0 || index >= points.length) {
                throw new RangeError(
                    `${prefix}: index out of range (got ${index}, length=${points.length})`,
                );
            }
            if (points.length <= 1) {
                throw new Error(
                    `${prefix}: cannot remove (must keep at least 1 point)`,
                );
            }
            points.splice(index, 1);
            const sphere = sphereEntries.splice(index, 1)[0];
            sphere.material.dispose();
            sphere.mesh.dispose();
            const drop = dropEntries.splice(index, 1)[0];
            drop.material.dispose();
            drop.mesh.dispose();
            labels.splice(index, 1);
            const lbl = labelEntries.splice(index, 1)[0];
            if (lbl) {
                lbl.texture.dispose();
                lbl.material.dispose();
                lbl.mesh.dispose();
            }
            // 辺ラベル (#185): 点ラベルと同じ規則で同 index を 1 件削除する。
            // 開ポリゴンで末尾頂点を削除する場合、edgeLabels.length === points.length-1
            // なので index を `length-1` にクランプして末尾の辺ラベルを削除する。
            if (edgeLabels.length > 0) {
                const ei = Math.min(index, edgeLabels.length - 1);
                edgeLabels.splice(ei, 1);
                const elbl = edgeLabelEntries.splice(ei, 1)[0];
                if (elbl) {
                    elbl.texture.dispose();
                    elbl.material.dispose();
                    elbl.mesh.dispose();
                }
            }
            renumberEntries();
            onPointCountChanged();
        },
        updatePoint(index: number, partial: PolygonPointPartial): void {
            const prefix = `polygon[${id}].updatePoint`;
            if (!Number.isInteger(index) || index < 0 || index >= points.length) {
                throw new RangeError(
                    `${prefix}: index out of range (got ${index}, length=${points.length})`,
                );
            }
            const current = points[index];
            const next: PolygonPointOptions = {
                lat: partial.lat ?? current.lat,
                lon: partial.lon ?? current.lon,
                altitude:
                    partial.altitude !== undefined
                        ? partial.altitude
                        : current.altitude,
            };
            assertValidPoint(next, prefix);
            points[index] = next;
            if (partial.label !== undefined) {
                if (partial.label === null) {
                    setLabelAt(index, undefined);
                } else {
                    setLabelAt(index, partial.label);
                }
                // 新規 label mesh は default で enabled=true なので、現行の表示
                // フラグ (logicalEnabled / labelsEnabled / elevationResolved) と
                // 整合させるため applyVisibility() で再評価する。
                applyVisibility();
            }
            // 点数は不変なので line/wall は再生成しない。次回 applyTransform で位置反映。
            // terrain モードで lat/lon が変われば標高再解決が必要なため hide 復帰。
            if (
                altitudeMode === "terrain" &&
                (partial.lat !== undefined || partial.lon !== undefined)
            ) {
                elevationResolved = false;
                applyVisibility();
            }
        },
        replacePoints(newPoints: readonly PolygonPointOptions[]): void {
            const prefix = `polygon[${id}].replacePoints`;
            if (!newPoints || newPoints.length < 1) {
                throw new Error(
                    `${prefix}: points must contain at least 1 entry (got ${
                        newPoints?.length ?? 0
                    })`,
                );
            }
            for (let i = 0; i < newPoints.length; i++) {
                assertValidPoint(newPoints[i], `${prefix}[${i}]`);
            }
            // 既存 sphere / drop / label を全 dispose してから再構築する。
            for (const entry of sphereEntries) {
                entry.material.dispose();
                entry.mesh.dispose();
            }
            sphereEntries.length = 0;
            for (const entry of dropEntries) {
                entry.material.dispose();
                entry.mesh.dispose();
            }
            dropEntries.length = 0;
            for (const entry of labelEntries) {
                if (!entry) continue;
                entry.texture.dispose();
                entry.material.dispose();
                entry.mesh.dispose();
            }
            labelEntries.length = 0;
            labels.length = 0;
            hasLabels = false;
            // 辺ラベル (#185): replacePolygonPoints 後は全 undefined で再構成する。
            for (const entry of edgeLabelEntries) {
                if (!entry) continue;
                entry.texture.dispose();
                entry.material.dispose();
                entry.mesh.dispose();
            }
            edgeLabelEntries.length = 0;
            edgeLabels.length = 0;
            hasEdgeLabels = false;
            points.length = 0;
            for (let i = 0; i < newPoints.length; i++) {
                const p = newPoints[i];
                points.push({
                    lat: p.lat,
                    lon: p.lon,
                    altitude: p.altitude,
                });
                sphereEntries.push(
                    createPointSphere(scene, id, i, style, root),
                );
                dropEntries.push(createDropLine(scene, id, i, style, root));
                labels.push(undefined);
                labelEntries.push(null);
            }
            // 辺ラベルは expectedEdgeCount に合わせて全 undefined で再生成。
            const newEdgeCount = expectedEdgeCount();
            for (let i = 0; i < newEdgeCount; i++) {
                edgeLabels.push(undefined);
                edgeLabelEntries.push(null);
            }
            onPointCountChanged();
        },
        getHandle,
        dispose,
    };
};
