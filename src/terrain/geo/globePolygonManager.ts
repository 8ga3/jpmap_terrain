/**
 * グローブ用ポリゴンマネージャ (Issue #275 Phase 4 Slice 2b-1)。
 *
 * 公開 PolygonManager 互換アダプタから渡される解決済みオプションを、ECEF 上の
 * 点・線・垂線・ラベル・壁として描画する。編集はアダプタ側の add-then-remove 再生成で扱う。
 */
import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import {
    computeOverlayDistanceScale,
    drapedPolygonPathLength,
    writeDrapedPolygonPathsToRef,
    type LatLonPoint,
} from "./overlayPlacement";
import {
    POLYGON_DEFAULTS,
    type AltitudeMode,
    type PolygonStyleOptions,
} from "../../lib/types";

const RENDERING_GROUP_ID = 1;
const SUBTERRAIN_RENDERING_GROUP_ID = 0;
const LABEL_MAX_DT_SIZE = 1024;
const LABEL_MIN_DT_SIZE = 32;

// placeNode の毎フレーム配置ループで使い回すスクラッチ Vector3（割り当て削減のため）。
const scratchUp = new Vector3();
const scratchMid = new Vector3();
const scratchBottomMid = new Vector3();
const scratchEdgeUp = new Vector3();

interface GlobePolygonPoint extends LatLonPoint {
    altitude?: number;
}

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
    pointDiameter: style?.pointDiameter ?? POLYGON_DEFAULTS.style.pointDiameter,
    pointColor: style?.pointColor ?? POLYGON_DEFAULTS.style.pointColor,
    pointOpacity: style?.pointOpacity ?? POLYGON_DEFAULTS.style.pointOpacity,
    dropLineColor: style?.dropLineColor ?? POLYGON_DEFAULTS.style.dropLineColor,
    dropLineWidth: style?.dropLineWidth ?? POLYGON_DEFAULTS.style.dropLineWidth,
    dropLineOpacity: style?.dropLineOpacity ?? POLYGON_DEFAULTS.style.dropLineOpacity,
    labelColor: style?.labelColor ?? POLYGON_DEFAULTS.style.labelColor,
    labelBackgroundColor:
        style?.labelBackgroundColor ?? POLYGON_DEFAULTS.style.labelBackgroundColor,
    labelFontSize: style?.labelFontSize ?? POLYGON_DEFAULTS.style.labelFontSize,
    wallColor: style?.wallColor ?? POLYGON_DEFAULTS.style.wallColor,
    wallOpacity: style?.wallOpacity ?? POLYGON_DEFAULTS.style.wallOpacity,
});

export interface GlobePolygonOptions {
    /** 頂点列（最低 1 点）。 */
    points: readonly GlobePolygonPoint[];
    /** 末尾と先頭を結んで輪を閉じる。default false。 */
    closed?: boolean;
    /** 高度モード。default terrain。 */
    altitudeMode?: AltitudeMode;
    /**
     * 旧 Phase 3 API 互換。指定時は全頂点をこの楕円体高度に置く（absolute 相当）。
     */
    topAltitudeMeters?: number;
    labels?: ReadonlyArray<string | undefined>;
    edgeLabels?: ReadonlyArray<string | undefined>;
    style?: PolygonStyleOptions;
    /** 旧 API 互換。style.lineColor より優先度は低い。 */
    outlineColor?: string;
    /** 旧 API 互換。style.wallColor より優先度は低い。 */
    wallColor?: string;
    /** 旧 API 互換。style.wallOpacity より優先度は低い。 */
    wallOpacity?: number;
    verticalsEnabled?: boolean;
    labelsEnabled?: boolean;
    wallsEnabled?: boolean;
    /** 内部用途: circle 委譲時は頂点マーカーを非表示にして既存の円表示を保つ。 */
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
    elevs: number[];
}

export interface GlobePolygonManager {
    add(opts: GlobePolygonOptions): string;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    /** 毎フレーム: 地形標高へ再ドレープし、距離スケールを更新する。 */
    update(cameraEcef?: Vector3): void;
    dispose(): void;
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
    if (alpha < 1) mat.needDepthPrePass = true;
    return mat;
};

const labelDpr = (): number =>
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio === "number"
        ? Math.max((globalThis as { devicePixelRatio: number }).devicePixelRatio, 1)
        : 1;

const createLabelMesh = (
    scene: Scene,
    id: string,
    index: number,
    text: string,
    style: ResolvedStyle,
    prefix: "label" | "edge-label",
): LabelEntry => {
    const dpr = labelDpr();
    const lines = text.split("\n");
    const fontSize = Math.max(style.labelFontSize, 1);
    const padPx = Math.round(fontSize * 0.1);
    const strokePx = Math.max(2, Math.round(fontSize * 0.12));
    const lineHeightPx = fontSize * 1.2;
    const probe = new DynamicTexture(
        `globe-polygon-${id}-${prefix}-probe-${index}`,
        { width: 16, height: 16 },
        scene,
        false,
    );
    const probeCtx = probe.getContext();
    probeCtx.font = `${fontSize}px sans-serif`;
    let maxLineWidth = 0;
    for (const line of lines) {
        maxLineWidth = Math.max(maxLineWidth, probeCtx.measureText(line || " ").width);
    }
    probe.dispose();

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
        `globe-polygon-${id}-${prefix}-${index}`,
        { width: dtWidth, height: dtHeight },
        scene,
        false,
    );
    texture.hasAlpha = true;
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

    const widthWorld = dtWidth / dpr;
    const heightWorld = dtHeight / dpr;
    const mesh = CreatePlane(
        `globe-polygon-${id}-${prefix}-${index}`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    const material = new StandardMaterial(
        `globe-polygon-${id}-${prefix}-mat-${index}`,
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

    const buildPaths = (node: GlobePolygonNode): boolean => {
        let resolved = true;
        if (node.topAltitudeMeters != null) {
            for (let i = 0; i < node.elevs.length; i++) node.elevs[i] = node.topAltitudeMeters;
        } else if (node.altitudeMode === "absolute") {
            for (let i = 0; i < node.points.length; i++) {
                node.elevs[i] = node.points[i].altitude ?? 0;
            }
        } else {
            for (let i = 0; i < node.points.length; i++) {
                const p = node.points[i];
                const terrain = terrainElevAt(p.lat, p.lon);
                if (terrain === null) {
                    resolved = false;
                    node.elevs[i] = 0;
                } else {
                    node.elevs[i] = terrain + (p.altitude ?? 0);
                }
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
            if (entry) entry.mesh.setEnabled(visible && node.verticalsEnabled);
        }
        for (const entry of node.pointLabels) {
            if (entry) entry.mesh.setEnabled(visible && node.labelsEnabled);
        }
        for (const entry of node.edgeLabels) {
            if (entry) entry.mesh.setEnabled(visible && node.labelsEnabled && hasEdges);
        }
        node.lineMesh.setEnabled(visible && hasEdges);
        node.wallMesh.setEnabled(visible && hasEdges && node.wallsEnabled);
    };

    const placeNode = (node: GlobePolygonNode, cameraEcef?: Vector3): void => {
        if (!buildPaths(node)) {
            applyVisibility(node);
            return;
        }
        const firstTop = node.top[0] ?? Vector3.Zero();
        const distScale = cameraEcef
            ? computeOverlayDistanceScale(cameraEcef, firstTop)
            : 1;
        const pointDiameter = Math.max(node.style.pointDiameter, 0.001);
        const pointRadius = pointDiameter * distScale * 0.5;
        const labelGap = node.style.labelFontSize * distScale * 0.05;
        for (let i = 0; i < node.points.length; i++) {
            const top = node.top[i];
            const bottom = node.bottom[i];
            top.subtractToRef(bottom, scratchUp);
            if (scratchUp.lengthSquared() < 1e-12) top.normalizeToRef(scratchUp);
            else scratchUp.normalize();

            const point = node.pointMeshes[i];
            if (point) {
                point.mesh.position.copyFrom(top);
                point.mesh.scaling.setAll(pointDiameter * distScale);
            }

            const drop = node.dropMeshes[i];
            if (node.verticalsEnabled && drop) {
                drop.mesh = CreateTube(
                    `${node.id}-drop-${i}`,
                    {
                        path: [top, bottom],
                        radius: Math.max(node.style.dropLineWidth, 0.001),
                        instance: drop.mesh,
                    },
                    scene,
                );
            }

            const label = node.pointLabels[i];
            if (label) {
                label.mesh.scaling.setAll(distScale);
                label.mesh.position
                    .copyFrom(top)
                    .addInPlace(
                        scratchUp.scaleInPlace(
                            pointRadius + label.heightWorld * distScale * 0.5 + labelGap,
                        ),
                    );
            }
        }

        const hasEdges = node.points.length >= 2;
        if (hasEdges) {
            node.lineMesh = CreateTube(
                `${node.id}-outline`,
                {
                    path: node.top,
                    radius: Math.max(node.style.lineWidth, 0.001),
                    instance: node.lineMesh,
                },
                scene,
            );
            if (node.wallsEnabled) {
                node.wallMesh = CreateRibbon(
                    `${node.id}-wall`,
                    { pathArray: [node.top, node.bottom], instance: node.wallMesh },
                    scene,
                );
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
                label.mesh.position
                    .copyFrom(scratchMid)
                    .addInPlace(
                        scratchEdgeUp.scaleInPlace(
                            Math.max(node.style.lineWidth, 0.001) +
                                label.heightWorld * distScale * 0.5 +
                                labelGap,
                        ),
                    );
            }
        }
        applyVisibility(node);
    };

    const add = (opts: GlobePolygonOptions): string => {
        if (disposed) throw new Error("GlobePolygonManager.add: called after dispose");
        if (!opts.points || opts.points.length < 1) {
            throw new Error("GlobePolygonManager.add: points requires at least 1 vertex");
        }
        const id = `globe-polygon-${seq++}`;
        const closed = opts.closed ?? POLYGON_DEFAULTS.closed;
        const altitudeMode =
            opts.topAltitudeMeters != null
                ? "absolute"
                : (opts.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode);
        const style = resolveStyle({
            ...opts.style,
            lineColor: opts.style?.lineColor ?? opts.outlineColor,
            wallColor: opts.style?.wallColor ?? opts.wallColor,
            wallOpacity: opts.style?.wallOpacity ?? opts.wallOpacity,
        });
        const pathLen = Math.max(2, drapedPolygonPathLength(opts.points.length, closed));
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
            mesh.renderingGroupId = RENDERING_GROUP_ID;
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
            mesh.renderingGroupId = SUBTERRAIN_RENDERING_GROUP_ID;
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
            return text == null ? null : createLabelMesh(scene, id, i, text, style, "label");
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
        lineMesh.renderingGroupId = RENDERING_GROUP_ID;
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
                pathArray: [placeholderPath(opts.points.length, closed), placeholderPath(opts.points.length, closed)],
                updatable: true,
                sideOrientation: Mesh.DOUBLESIDE,
            },
            scene,
        );
        wallMesh.renderingGroupId = SUBTERRAIN_RENDERING_GROUP_ID;
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
            points: opts.points.map((p) => ({ lat: p.lat, lon: p.lon, altitude: p.altitude })),
            closed,
            altitudeMode,
            topAltitudeMeters: opts.topAltitudeMeters,
            enabled: opts.enabled ?? POLYGON_DEFAULTS.enabled,
            verticalsEnabled,
            labelsEnabled: opts.labelsEnabled ?? POLYGON_DEFAULTS.labelsEnabled,
            wallsEnabled: opts.wallsEnabled ?? POLYGON_DEFAULTS.wallsEnabled,
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
            elevs: opts.points.map(() => 0),
        };
        nodes.set(id, node);
        placeNode(node);
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
        if (disposed) throw new Error("GlobePolygonManager.setEnabled: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobePolygonManager.setEnabled: id "${id}" not found`);
        node.enabled = enabled;
        applyVisibility(node);
    };

    const update = (cameraEcef?: Vector3): void => {
        if (disposed) throw new Error("GlobePolygonManager.update: called after dispose");
        for (const node of nodes.values()) {
            if (!node.enabled) continue;
            placeNode(node, cameraEcef);
        }
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return { add, remove, setEnabled, update, dispose };
};
