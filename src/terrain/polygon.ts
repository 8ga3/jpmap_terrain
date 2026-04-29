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
 * 壁 Ribbon の pathArray を構築する。
 * 上側 row = 各頂点の世界座標、下側 row = 同じ XZ で Y を地表値に置き換えたもの。
 * `closed=true` のときは先頭頂点を末尾にも追加して閉じる。
 *
 * Ribbon は updatable + instance 更新時に長さを変えられないため、
 * 構築時の長さ（`closed ? N+1 : N`）で固定される。
 */
const buildWallPathArray = (
    worldPoints: readonly Vector3[],
    groundYs: readonly (number | null)[],
    closed: boolean,
): [Vector3[], Vector3[]] => {
    const top: Vector3[] = worldPoints.map((p) => new Vector3(p.x, p.y, p.z));
    const ground: Vector3[] = worldPoints.map((p, i) => {
        const gy = groundYs[i];
        return new Vector3(p.x, gy ?? 0, p.z);
    });
    if (closed && top.length >= 2) {
        const ft = top[0];
        const fg = ground[0];
        top.push(new Vector3(ft.x, ft.y, ft.z));
        ground.push(new Vector3(fg.x, fg.y, fg.z));
    }
    return [top, ground];
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

    // 壁 Ribbon (#172): 上 row = 各頂点 world、下 row = 地表 Y。
    // 構築時は groundY を 0 とした placeholder を渡し、applyTransform で実値で更新する。
    const initialGroundYs: (number | null)[] = points.map(() => null);
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
    wallMesh.renderingGroupId = RENDERING_GROUP_ID;
    wallMesh.isPickable = false;
    wallMesh.parent = root;

    const applyVisibility = (): void => {
        const visible = logicalEnabled && elevationResolved;
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
        wallMesh.setEnabled(visible && wallsEnabled);
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
        const placeholder: Vector3[] = points.map(
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
        const placeholder: Vector3[] = points.map(
            (_, i) => new Vector3(i, 0, 0),
        );
        const groundPlaceholder: (number | null)[] = points.map(() => null);
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
        wallMesh.renderingGroupId = RENDERING_GROUP_ID;
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
        for (let i = 0; i < sphereEntries.length; i++) {
            const sphere = sphereEntries[i].mesh;
            const wp = worldPoints[i];
            sphere.position.set(wp.x, wp.y, wp.z);
            sphere.scaling.setAll(sphereDiameter * pointScale);

            // 垂線: top = wp.y, bottom = groundYs[i] ?? 0。
            // verticalsEnabled が false（非表示中）はメッシュ更新をスキップして
            // フレーム負荷を下げる。次回 enable 時にこのループで再更新される。
            if (verticalsEnabled) {
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
            }

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

        // 壁 Ribbon (#172) の更新。非表示中はスキップしてフレーム負荷を下げるが、
        // 上で lastWorldPoints / lastGroundYs の参照を保持しておき、setWallsEnabled(true)
        // 時に同一データで Ribbon を再適用して stale 表示を避ける。
        lastWorldPoints = worldPoints;
        lastGroundYs = groundYs;
        if (wallsEnabled) {
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
            onPointCountChanged();
        },
        removePoint(index: number): void {
            const prefix = `polygon[${id}].removePoint`;
            if (!Number.isInteger(index) || index < 0 || index >= points.length) {
                throw new RangeError(
                    `${prefix}: index out of range (got ${index}, length=${points.length})`,
                );
            }
            if (points.length <= 2) {
                throw new Error(
                    `${prefix}: cannot remove (must keep at least 2 points)`,
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
            if (!newPoints || newPoints.length < 2) {
                throw new Error(
                    `${prefix}: points must contain at least 2 entries (got ${
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
            onPointCountChanged();
        },
        getHandle,
        dispose,
    };
};
