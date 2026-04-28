/**
 * 個別ポリゴンノード (Issue #170)。
 *
 * - 頂点ごとの球（{@link CreateSphere}）
 * - 頂点列を結ぶチューブ（{@link CreateTube}、`updatable: true`）
 * を 1 つの root TransformNode 配下に親子化して管理する。
 *
 * `closed=true` のときはチューブ末端に最初の頂点を append し、可視的に閉じる。
 * 面塗り・壁・点ラベル・垂線は本タスクでは実装しない（#171 / #172 / #173）。
 */

import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
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
    /** 全頂点を更新する。`worldPoints[i].y` には標高が反映済みのワールド Y を渡す */
    applyTransform(worldPoints: readonly Vector3[], pointScale: number): void;
    setEnabledLogical(enabled: boolean): void;
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
    };
    applyVisibility();

    const applyTransform = (
        worldPoints: readonly Vector3[],
        pointScale: number,
    ): void => {
        if (worldPoints.length !== sphereEntries.length) {
            // ディフェンシブ: 想定外。何もしない（次フレームで更新されうる）。
            return;
        }
        const sphereDiameter = Math.max(style.pointDiameter, 0.001);
        for (let i = 0; i < sphereEntries.length; i++) {
            const sphere = sphereEntries[i].mesh;
            const wp = worldPoints[i];
            sphere.position.set(wp.x, wp.y, wp.z);
            sphere.scaling.setAll(sphereDiameter * pointScale);
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
        elevationResolved,
    });

    const dispose = (): void => {
        for (const entry of sphereEntries) {
            entry.material.dispose();
            entry.mesh.dispose();
        }
        sphereEntries.length = 0;
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
        setElevationResolved(resolved: boolean): void {
            elevationResolved = resolved;
            applyVisibility();
        },
        getHandle,
        dispose,
    };
};
