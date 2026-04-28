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
    type PolygonStyleOptions,
} from "../lib/types";

const RENDERING_GROUP_ID = 1;
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
    setElevationResolved(resolved: boolean): void;
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
    mesh.isPickable = false;
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
    mesh.renderingGroupId = RENDERING_GROUP_ID;
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
        `polygon-${id}-label-probe-${index}`,
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
        `polygon-${id}-label-${index}`,
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
        `polygon-${id}-label-${index}`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    mesh.parent = parent;

    const material = new StandardMaterial(
        `polygon-${id}-label-mat-${index}`,
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
 * `PolygonNode` を生成する。`points.length >= 2` 前提（`PolygonManager` 側で検証済み）。
 */
export const createPolygonNode = (
    scene: Scene,
    id: string,
    options: PolygonOptions,
): PolygonNode => {
    const closed = options.closed ?? POLYGON_DEFAULTS.closed;
    const altitudeMode = options.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode;
    const labels = options.labels
        ? Object.freeze([...options.labels])
        : undefined;
    const style = resolveStyle(options.style);
    let logicalEnabled = options.enabled ?? POLYGON_DEFAULTS.enabled;
    let verticalsEnabled =
        options.verticalsEnabled ?? POLYGON_DEFAULTS.verticalsEnabled;
    let labelsEnabled =
        options.labelsEnabled ?? POLYGON_DEFAULTS.labelsEnabled;
    let elevationResolved = altitudeMode === "absolute";

    // 頂点はディープコピーして外部からの破壊変更を無効化する。
    const points: PolygonPointOptions[] = options.points.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        altitude: p.altitude,
    }));

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
        const text = labels ? labels[index] : undefined;
        if (text === undefined || text === null) return null;
        return createLabelMesh(scene, id, index, text, style, root);
    });

    // 初期 path（仮）。applyTransform で必ず上書きされる前提だが、
    // 構築時にも有効な Tube が必要なので原点付近の placeholder を渡す。
    const initialPath: Vector3[] = points.map((_, i) => new Vector3(i, 0, 0));
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

    const applyVisibility = (): void => {
        const visible = logicalEnabled && elevationResolved;
        root.setEnabled(visible);
        // 子要素の個別 ON/OFF（垂線・ラベル）。root が無効なら自動で隠れるので、
        // root が有効なときに verticals/labels の個別設定を反映する。
        for (const entry of dropEntries) {
            entry.mesh.setEnabled(visible && verticalsEnabled);
        }
        for (const entry of labelEntries) {
            if (!entry) continue;
            entry.mesh.setEnabled(visible && labelsEnabled);
        }
    };
    applyVisibility();

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
        for (let i = 0; i < sphereEntries.length; i++) {
            const sphere = sphereEntries[i].mesh;
            const wp = worldPoints[i];
            sphere.position.set(wp.x, wp.y, wp.z);
            sphere.scaling.setAll(sphereDiameter * pointScale);

            // 垂線: top = wp.y, bottom = groundYs[i] ?? 0。
            const dropMesh = dropEntries[i].mesh;
            const groundY = groundYs[i] ?? 0;
            const dropPath = [
                new Vector3(wp.x, wp.y, wp.z),
                new Vector3(wp.x, groundY, wp.z),
            ];
            // CreateTube に instance を渡すと in-place で更新される。
            CreateTube(
                `polygon-${id}-drop-${i}`,
                { path: dropPath, instance: dropMesh },
                scene,
            );

            // ラベル: 球の上にオフセット配置 + distScale 連動。
            // 中心位置 = 球中心 + 球半径 + ギャップ + ラベル平面の半分。
            const label = labelEntries[i];
            if (label) {
                const labelHalfWorld = label.heightWorld * pointScale * 0.5;
                const offsetY = sphereRadiusWorld + labelGap + labelHalfWorld;
                label.mesh.position.set(wp.x, wp.y + offsetY, wp.z);
                label.mesh.scaling.setAll(pointScale);
            }
        }
        const tubePath = buildLinePath(worldPoints, closed);
        lineMesh = CreateTube(
            `polygon-${id}-line`,
            { path: tubePath, instance: lineMesh },
            scene,
        );
    };

    const getHandle = (): PolygonHandle => ({
        id,
        points: points.map((p) => ({ ...p })),
        closed,
        altitudeMode,
        labels,
        style: { ...style },
        enabled: logicalEnabled,
        verticalsEnabled,
        labelsEnabled,
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
        lineMaterial.dispose();
        lineMesh.dispose();
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
        setElevationResolved(resolved: boolean): void {
            elevationResolved = resolved;
            applyVisibility();
        },
        getHandle,
        dispose,
    };
};
