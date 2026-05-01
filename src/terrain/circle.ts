/**
 * 個別円ノード (Issue #201 / #203)。
 *
 * - 中心点の球（{@link CreateSphere}）
 * - 円周を結ぶチューブ（{@link CreateTube}、`updatable: true`、閉ループ）
 * - 円周下端から Y=0 まで伸ばす壁 Ribbon（{@link CreateRibbon}、`updatable: true`）
 * - 中心ラベル（DynamicTexture + ビルボード Plane、複数行対応）
 *
 * を 1 つの root TransformNode 配下に親子化して管理する。
 *
 * 円周点列は world 平面で polar 展開して生成する（C + radius·(cosθ, 0, sinθ)）。
 * これにより緯度方向の Mercator 圧縮による楕円化を回避する。
 *
 * 描画グループ:
 * - 中心球 / 円周 Tube / 中心ラベル: `RENDERING_GROUP_ID = 1`（地表より手前）
 * - 壁 Ribbon: `SUBTERRAIN_RENDERING_GROUP_ID = 0`（地表深度でオクルード、#186 参照）
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
    CIRCLE_DEFAULTS,
    type AltitudeMode,
    type CircleCenterOptions,
    type CircleHandle,
    type CircleOptions,
    type CircleStyleOptions,
} from "../lib/types";

const RENDERING_GROUP_ID = 1;
const SUBTERRAIN_RENDERING_GROUP_ID = 0;
const LABEL_MAX_DT_SIZE = 1024;
const LABEL_MIN_DT_SIZE = 32;
const LABEL_GAP_FONT_RATIO = 0.0;

interface ResolvedStyle {
    pointColor: string;
    pointDiameter: number;
    pointOpacity: number;
    lineColor: string;
    lineWidth: number;
    lineOpacity: number;
    wallColor: string;
    wallOpacity: number;
    labelColor: string;
    labelBackgroundColor: string;
    labelFontSize: number;
}

const resolveStyle = (style: CircleStyleOptions | undefined): ResolvedStyle => ({
    pointColor: style?.pointColor ?? CIRCLE_DEFAULTS.style.pointColor,
    pointDiameter:
        style?.pointDiameter ?? CIRCLE_DEFAULTS.style.pointDiameter,
    pointOpacity: style?.pointOpacity ?? CIRCLE_DEFAULTS.style.pointOpacity,
    lineColor: style?.lineColor ?? CIRCLE_DEFAULTS.style.lineColor,
    lineWidth: style?.lineWidth ?? CIRCLE_DEFAULTS.style.lineWidth,
    lineOpacity: style?.lineOpacity ?? CIRCLE_DEFAULTS.style.lineOpacity,
    wallColor: style?.wallColor ?? CIRCLE_DEFAULTS.style.wallColor,
    wallOpacity: style?.wallOpacity ?? CIRCLE_DEFAULTS.style.wallOpacity,
    labelColor: style?.labelColor ?? CIRCLE_DEFAULTS.style.labelColor,
    labelBackgroundColor:
        style?.labelBackgroundColor ??
        CIRCLE_DEFAULTS.style.labelBackgroundColor,
    labelFontSize:
        style?.labelFontSize ?? CIRCLE_DEFAULTS.style.labelFontSize,
});

interface LabelEntry {
    mesh: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    widthWorld: number;
    heightWorld: number;
}

const createLabelMesh = (
    scene: Scene,
    id: string,
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

    const probe = new DynamicTexture(
        `circle-${id}-label-probe`,
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
        `circle-${id}-label`,
        { width: dtWidth, height: dtHeight },
        scene,
        false,
    );
    texture.hasAlpha = true;
    texture.vScale = -1;
    texture.vOffset = 1;

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
    const startY = innerPad * dpr;
    const centerX = dtWidth / 2;
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

    const widthWorld = dtWidth / dpr;
    const heightWorld = dtHeight / dpr;

    const mesh = CreatePlane(
        `circle-${id}-label`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    mesh.parent = parent;

    const material = new StandardMaterial(`circle-${id}-label-mat`, scene);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = Color3.White();
    material.diffuseTexture = texture;
    mesh.material = material;

    return { mesh, material, texture, widthWorld, heightWorld };
};

/**
 * 中心 world 座標 + 半径 + segments から円周点列を生成する。
 *
 * 戻り値は未クローズの円周点列（長さ = segments）。必要な閉ループ化
 * （末尾への先頭点の追加）は呼び出し側で行う。
 * 円周点の (X, Z) は world 平面の polar 展開で求められる。
 * terrain モード時の各点 Y は呼び出し側で標高解決して設定する。
 */
const buildRingXZ = (
    cx: number,
    cz: number,
    radius: number,
    segments: number,
): { x: number; z: number }[] => {
    const ring: { x: number; z: number }[] = [];
    const step = (Math.PI * 2) / segments;
    for (let i = 0; i < segments; i++) {
        const θ = i * step;
        ring.push({
            x: cx + radius * Math.cos(θ),
            z: cz + radius * Math.sin(θ),
        });
    }
    return ring;
};

/**
 * 1 円分の Babylon ノード。`CircleManager` から生成・更新・破棄される。
 */
export interface CircleNode {
    readonly id: string;
    readonly altitudeMode: AltitudeMode;
    /** 中心点（lat / lon / altitude）のスナップショット。manager から更新される */
    center: CircleCenterOptions;
    /** 半径 (m, world)。manager から更新される */
    radius: number;
    /** 円周分割数。manager から更新される */
    segments: number;
    /**
     * フレーム単位の幾何更新。
     * @param centerWorld 中心の world 座標（Y は標高反映済み）
     * @param ringWorld 円周点の world 座標列（長さ === segments）
     * @param pointScale screen-stable な距離スケール係数
     */
    applyTransform(
        centerWorld: Vector3,
        ringWorld: readonly Vector3[],
        pointScale: number,
    ): void;
    setEnabledLogical(enabled: boolean): void;
    setPointEnabledLogical(enabled: boolean): void;
    setLineEnabledLogical(enabled: boolean): void;
    setWallEnabledLogical(enabled: boolean): void;
    setLabelEnabledLogical(enabled: boolean): void;
    setElevationResolved(resolved: boolean): void;
    getHandle(): CircleHandle;
    dispose(): void;
}

/**
 * 中心ラベルの自動生成テキスト（lat / lon / altitude / radius を 4 行で表示）。
 */
const formatAutoLabel = (
    center: CircleCenterOptions,
    radius: number,
): string => {
    const altText =
        center.altitude !== undefined ? center.altitude.toFixed(1) : "0.0";
    return [
        `lat: ${center.lat.toFixed(6)}`,
        `lon: ${center.lon.toFixed(6)}`,
        `alt: ${altText} m`,
        `radius: ${radius.toFixed(1)} m`,
    ].join("\n");
};

/**
 * 内部状態として保持する label 値の解決ルール。
 * - `options.label === undefined`: 自動生成（auto = true）
 * - `options.label === null`: 非表示（hidden）
 * - `options.label === "..."`: カスタム（auto = false）
 */
const resolveLabelText = (
    options: CircleOptions,
): { auto: boolean; text: string | null } => {
    if (options.label === null) return { auto: false, text: null };
    if (options.label === undefined) {
        return {
            auto: true,
            text: formatAutoLabel(options.center, options.radius),
        };
    }
    return { auto: false, text: options.label };
};

/**
 * `CircleNode` を生成する。`segments / radius / center` は `CircleManager` 側で
 * 検証済みである前提。
 */
export const createCircleNode = (
    scene: Scene,
    id: string,
    options: CircleOptions,
): CircleNode => {
    const altitudeMode = options.altitudeMode ?? CIRCLE_DEFAULTS.altitudeMode;
    const segments = options.segments ?? CIRCLE_DEFAULTS.segments;
    const style = resolveStyle(options.style);
    let logicalEnabled = options.enabled ?? CIRCLE_DEFAULTS.enabled;
    let pointEnabled = options.pointEnabled ?? CIRCLE_DEFAULTS.pointEnabled;
    let lineEnabled = options.lineEnabled ?? CIRCLE_DEFAULTS.lineEnabled;
    let wallEnabled = options.wallEnabled ?? CIRCLE_DEFAULTS.wallEnabled;
    let labelEnabled = options.labelEnabled ?? CIRCLE_DEFAULTS.labelEnabled;
    let elevationResolved = altitudeMode === "absolute";

    const center: CircleCenterOptions = {
        lat: options.center.lat,
        lon: options.center.lon,
        altitude: options.center.altitude,
    };
    let radius = options.radius;

    const root = new TransformNode(`circle-${id}`, scene);

    // 中心球
    const sphereMesh = CreateSphere(
        `circle-${id}-center`,
        { diameter: 1, segments: 16 },
        scene,
    );
    const sphereMaterial = new StandardMaterial(
        `circle-${id}-center-mat`,
        scene,
    );
    sphereMaterial.disableLighting = true;
    sphereMaterial.backFaceCulling = false;
    sphereMaterial.emissiveColor = Color3.FromHexString(style.pointColor);
    sphereMaterial.alpha = style.pointOpacity;
    sphereMesh.material = sphereMaterial;
    sphereMesh.renderingGroupId = RENDERING_GROUP_ID;
    sphereMesh.isPickable = true;
    sphereMesh.parent = root;

    // 円周 Tube（閉ループ：path 長 = segments + 1、末尾は先頭と同点）
    const initialRing = buildRingXZ(0, 0, Math.max(radius, 0.001), segments);
    const initialTubePath: Vector3[] = initialRing.map(
        (p) => new Vector3(p.x, 0, p.z),
    );
    initialTubePath.push(
        new Vector3(initialTubePath[0].x, 0, initialTubePath[0].z),
    );
    let lineMesh: Mesh = CreateTube(
        `circle-${id}-line`,
        {
            path: initialTubePath,
            radius: Math.max(style.lineWidth, 0.001),
            updatable: true,
            cap: Mesh.NO_CAP,
        },
        scene,
    );
    const lineMaterial = new StandardMaterial(`circle-${id}-line-mat`, scene);
    lineMaterial.disableLighting = true;
    lineMaterial.backFaceCulling = false;
    lineMaterial.emissiveColor = Color3.FromHexString(style.lineColor);
    lineMaterial.alpha = style.lineOpacity;
    lineMesh.material = lineMaterial;
    lineMesh.renderingGroupId = RENDERING_GROUP_ID;
    lineMesh.isPickable = false;
    lineMesh.parent = root;

    // 壁 Ribbon
    const initialWallTop: Vector3[] = initialTubePath.map(
        (p) => new Vector3(p.x, 0, p.z),
    );
    const initialWallBottom: Vector3[] = initialTubePath.map(
        (p) => new Vector3(p.x, 0, p.z),
    );
    let wallMesh: Mesh = CreateRibbon(
        `circle-${id}-wall`,
        {
            pathArray: [initialWallTop, initialWallBottom],
            updatable: true,
            sideOrientation: Mesh.DOUBLESIDE,
            closeArray: false,
        },
        scene,
    );
    const wallMaterial = new StandardMaterial(`circle-${id}-wall-mat`, scene);
    wallMaterial.disableLighting = true;
    wallMaterial.backFaceCulling = false;
    wallMaterial.emissiveColor = Color3.FromHexString(style.wallColor);
    wallMaterial.alpha = style.wallOpacity;
    if (style.wallOpacity < 1) {
        wallMaterial.needDepthPrePass = true;
    }
    wallMesh.material = wallMaterial;
    wallMesh.renderingGroupId = SUBTERRAIN_RENDERING_GROUP_ID;
    wallMesh.isPickable = false;
    wallMesh.parent = root;

    // ラベル
    let labelState = resolveLabelText(options);
    let labelEntry: LabelEntry | null = labelState.text
        ? createLabelMesh(scene, id, labelState.text, style, root)
        : null;

    const applyVisibility = (): void => {
        const visible = logicalEnabled && elevationResolved;
        root.setEnabled(visible);
        sphereMesh.setEnabled(visible && pointEnabled);
        lineMesh.setEnabled(visible && lineEnabled);
        wallMesh.setEnabled(visible && wallEnabled);
        if (labelEntry) {
            labelEntry.mesh.setEnabled(visible && labelEnabled);
        }
    };
    applyVisibility();

    const applyTransform = (
        centerWorld: Vector3,
        ringWorld: readonly Vector3[],
        pointScale: number,
    ): void => {
        if (ringWorld.length !== segments) {
            // 想定外。何もせず次フレームへ。
            return;
        }
        const sphereDiameter = Math.max(style.pointDiameter, 0.001);
        const sphereRadiusWorld = sphereDiameter * pointScale * 0.5;

        sphereMesh.position.set(centerWorld.x, centerWorld.y, centerWorld.z);
        sphereMesh.scaling.setAll(sphereDiameter * pointScale);

        // 円周 Tube を閉ループとして更新（path 長 = segments + 1）。
        const tubePath: Vector3[] = ringWorld.map(
            (p) => new Vector3(p.x, p.y, p.z),
        );
        tubePath.push(
            new Vector3(tubePath[0].x, tubePath[0].y, tubePath[0].z),
        );
        lineMesh = CreateTube(
            `circle-${id}-line`,
            { path: tubePath, instance: lineMesh },
            scene,
        );

        // 壁 Ribbon: 上 row = 円周頂点位置、下 row = 同 XZ で Y=0。
        const top: Vector3[] = ringWorld.map(
            (p) => new Vector3(p.x, p.y, p.z),
        );
        const bottom: Vector3[] = ringWorld.map(
            (p) => new Vector3(p.x, 0, p.z),
        );
        top.push(new Vector3(top[0].x, top[0].y, top[0].z));
        bottom.push(new Vector3(bottom[0].x, bottom[0].y, bottom[0].z));
        wallMesh = CreateRibbon(
            `circle-${id}-wall`,
            { pathArray: [top, bottom], instance: wallMesh },
            scene,
        );

        // 中心ラベルの位置: 中心 + screenUp * (球半径 + ラベル半高)。
        if (labelEntry) {
            const labelGap =
                style.labelFontSize * pointScale * LABEL_GAP_FONT_RATIO;
            const labelHalfWorld =
                labelEntry.heightWorld * pointScale * 0.5;
            const offset = sphereRadiusWorld + labelGap + labelHalfWorld;
            const camera = scene.activeCamera;
            const camPos = camera ? camera.globalPosition : null;
            const camUp = camera ? camera.upVector : null;
            let ux = 0;
            let uy = 1;
            let uz = 0;
            if (camPos && camUp) {
                const tx = camPos.x - centerWorld.x;
                const ty = camPos.y - centerWorld.y;
                const tz = camPos.z - centerWorld.z;
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
            labelEntry.mesh.position.set(
                centerWorld.x + ux * offset,
                centerWorld.y + uy * offset,
                centerWorld.z + uz * offset,
            );
            labelEntry.mesh.scaling.setAll(pointScale);
        }
    };

    const refreshAutoLabel = (): void => {
        if (!labelState.auto) return;
        const newText = formatAutoLabel(center, radius);
        if (newText === labelState.text) return;
        labelState = { auto: true, text: newText };
        if (labelEntry) {
            labelEntry.texture.dispose();
            labelEntry.material.dispose();
            labelEntry.mesh.dispose();
        }
        labelEntry = createLabelMesh(scene, id, newText, style, root);
        applyVisibility();
    };

    const getHandle = (): CircleHandle => ({
        id,
        center: { ...center },
        radius,
        segments,
        altitudeMode,
        label: labelState.text,
        style: { ...style },
        enabled: logicalEnabled,
        pointEnabled,
        lineEnabled,
        wallEnabled,
        labelEnabled,
        elevationResolved,
    });

    const dispose = (): void => {
        sphereMaterial.dispose();
        sphereMesh.dispose();
        lineMaterial.dispose();
        lineMesh.dispose();
        wallMaterial.dispose();
        wallMesh.dispose();
        if (labelEntry) {
            labelEntry.texture.dispose();
            labelEntry.material.dispose();
            labelEntry.mesh.dispose();
            labelEntry = null;
        }
        root.dispose();
    };

    return {
        id,
        altitudeMode,
        get center() {
            return center;
        },
        get radius() {
            return radius;
        },
        set radius(v: number) {
            radius = v;
            refreshAutoLabel();
        },
        get segments() {
            return segments;
        },
        applyTransform,
        setEnabledLogical(enabled: boolean): void {
            logicalEnabled = enabled;
            applyVisibility();
        },
        setPointEnabledLogical(enabled: boolean): void {
            pointEnabled = enabled;
            applyVisibility();
        },
        setLineEnabledLogical(enabled: boolean): void {
            lineEnabled = enabled;
            applyVisibility();
        },
        setWallEnabledLogical(enabled: boolean): void {
            wallEnabled = enabled;
            applyVisibility();
        },
        setLabelEnabledLogical(enabled: boolean): void {
            labelEnabled = enabled;
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

/**
 * world 平面の polar 展開で円周点列を生成するユーティリティ（テスト用）。
 *
 * 中心 (cx, cz) を中心に、半径 `radius` (m, world)、`segments` 等分の点列を返す。
 * Y は呼び出し側で設定する想定のため、本関数は `(x, z)` のみを返す。
 */
export const __computeCircleRingForTest = buildRingXZ;
