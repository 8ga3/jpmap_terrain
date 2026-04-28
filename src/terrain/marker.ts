/**
 * 個別マーカーノード (Issue #167)。
 *
 * 地表からの線 (Tube)・アイコン Plane・テキスト Plane の組み合わせで
 * 1 マーカーを表現する。`MarkerManager` から生成・更新・破棄される。
 */

import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

import {
    MARKER_DEFAULTS,
    type MarkerHandle,
    type MarkerIconOptions,
    type MarkerLineOptions,
    type MarkerOptions,
    type MarkerTextOptions,
    type MarkerUpdate,
} from "../lib/types";

const ICON_TEXT_GAP_M = 4;
const RENDERING_GROUP_ID = 1;
const MAX_DT_SIZE = 1024;
/**
 * `fontSize` (ピクセル表記) を 1ピクセル = N ワールド m として描画プレーンのサイズを決定するための分母。
 *
 * デフォルト表示高度 2000m 付近でもテキストが判読可能なサイズになるよう 1 としている。
 * より小さく見せたい場合は `MarkerOptions.text.fontSize` で調整する。
 */
const TEXT_WORLD_PX_PER_M = 1;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);

/**
 * `icon.url` を検証する。`javascript:` / `vbscript:` 等の危険スキームを拒否する。
 *
 * - 空文字: 例外
 * - `scheme:` を含まない（相対パス・絶対パス）: そのまま許可
 * - `scheme:` を含む: `http(s)` / `data:image/*` のみ許可
 */
export const validateIconUrl = (url: string): void => {
    const trimmed = url.trim();
    if (!trimmed) throw new Error("addMarker: icon.url is empty");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(
            `addMarker: icon.url is invalid: ${trimmed.slice(0, 64)}`,
        );
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(
            `addMarker: icon.url has disallowed scheme: ${parsed.protocol}`,
        );
    }
    if (parsed.protocol === "data:" && !/^data:image\//i.test(trimmed)) {
        throw new Error("addMarker: data URL must be image/*");
    }
};

const ceilPow2 = (n: number): number => {
    if (n <= 1) return 1;
    return 2 ** Math.ceil(Math.log2(n));
};

interface ResolvedMarker {
    enabled: boolean;
    line: Required<MarkerLineOptions>;
    icon: Required<MarkerIconOptions> | null;
    text: Required<MarkerTextOptions> | null;
}

const resolveLine = (line: MarkerLineOptions | undefined): Required<MarkerLineOptions> => ({
    color: line?.color ?? MARKER_DEFAULTS.line.color,
    width: line?.width ?? MARKER_DEFAULTS.line.width,
    height: line?.height ?? MARKER_DEFAULTS.line.height,
});

const resolveIcon = (
    icon: MarkerIconOptions | undefined,
): Required<MarkerIconOptions> | null => {
    if (!icon) return null;
    return {
        url: icon.url,
        width: icon.width ?? MARKER_DEFAULTS.icon.width,
        height: icon.height ?? MARKER_DEFAULTS.icon.height,
    };
};

const resolveText = (
    text: MarkerTextOptions | undefined,
): Required<MarkerTextOptions> | null => {
    if (!text) return null;
    let value = text.value;
    if (value.length > MARKER_DEFAULTS.textMaxLength) {
        console.warn(
            `[jpmap-terrain] marker text exceeds ${MARKER_DEFAULTS.textMaxLength} chars; truncating`,
        );
        value = value.slice(0, MARKER_DEFAULTS.textMaxLength);
    }
    return {
        value,
        fontSize: text.fontSize ?? MARKER_DEFAULTS.text.fontSize,
        color: text.color ?? MARKER_DEFAULTS.text.color,
        backgroundColor:
            text.backgroundColor ?? MARKER_DEFAULTS.text.backgroundColor,
        lineHeight: text.lineHeight ?? MARKER_DEFAULTS.text.lineHeight,
    };
};

const resolve = (options: MarkerOptions): ResolvedMarker => ({
    enabled: options.enabled ?? MARKER_DEFAULTS.enabled,
    line: resolveLine(options.line),
    icon: resolveIcon(options.icon),
    text: resolveText(options.text),
});

interface LineMeshes {
    outer: Mesh;
    inner: Mesh;
    outerMaterial: StandardMaterial;
    innerMaterial: StandardMaterial;
}

/**
 * 垂直線を 「外側（縁取り色） + 内側（コア色）」の二重チューブで表現する。
 * `line.color` をコア色、縁取りは白固定とし、両者はデフォルトスケール (1) で描画され、
 * 距離一定スケールは mesh.scaling で外部から調整する。
 */
const createLineMesh = (
    scene: Scene,
    id: string,
    line: Required<MarkerLineOptions>,
): LineMeshes => {
    const outerRadius = Math.max(line.width / 2, 0.05);
    // 内側は外側の 50% を目安にし、極端に細いときも最低限見えるようクランプする。
    const innerRadius = Math.max(outerRadius * 0.5, 0.02);
    const path = [Vector3.Zero(), new Vector3(0, line.height, 0)];
    const outer = CreateTube(
        `marker-line-outer-${id}`,
        { path, radius: outerRadius, tessellation: 8, updatable: false },
        scene,
    );
    const inner = CreateTube(
        `marker-line-inner-${id}`,
        { path, radius: innerRadius, tessellation: 8, updatable: false },
        scene,
    );
    const outerMaterial = new StandardMaterial(
        `marker-line-outer-mat-${id}`,
        scene,
    );
    outerMaterial.emissiveColor = Color3.White();
    outerMaterial.disableLighting = true;
    outer.material = outerMaterial;
    outer.renderingGroupId = RENDERING_GROUP_ID;
    outer.isPickable = false;
    const innerMaterial = new StandardMaterial(
        `marker-line-inner-mat-${id}`,
        scene,
    );
    innerMaterial.emissiveColor = Color3.FromHexString(line.color);
    innerMaterial.disableLighting = true;
    inner.material = innerMaterial;
    inner.renderingGroupId = RENDERING_GROUP_ID;
    inner.isPickable = false;
    // 内側を手前に描画して艦色体を俺閐させるための Z-fight 選出オフセット。
    inner.material.zOffset = -1;
    return { outer, inner, outerMaterial, innerMaterial };
};

interface IconMeshes {
    mesh: Mesh;
    material: StandardMaterial;
    texture: Texture;
    widthWorld: number;
    heightWorld: number;
}

const createIconMesh = (
    scene: Scene,
    id: string,
    icon: Required<MarkerIconOptions>,
): IconMeshes => {
    const mesh = CreatePlane(
        `marker-icon-${id}`,
        { width: icon.width, height: icon.height },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    const material = new StandardMaterial(`marker-icon-mat-${id}`, scene);
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.useAlphaFromDiffuseTexture = true;
    const texture = new Texture(icon.url, scene);
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    mesh.material = material;
    return {
        mesh,
        material,
        texture,
        widthWorld: icon.width,
        heightWorld: icon.height,
    };
};

interface TextMeshes {
    mesh: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    widthWorld: number;
    heightWorld: number;
}

const createTextMesh = (
    scene: Scene,
    id: string,
    text: Required<MarkerTextOptions>,
): TextMeshes => {
    const lines = text.value.split("\n");
    const lineCount = Math.max(lines.length, 1);
    const dpr =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio ===
            "number"
            ? Math.max((globalThis as { devicePixelRatio: number }).devicePixelRatio, 1)
            : 1;
    const padPx = Math.round(text.fontSize * 0.4);
    // 縁取り幅 (px)。フォントサイズの ~12% を目安にし、最低 2px を確保する。
    const strokePx = Math.max(2, Math.round(text.fontSize * 0.12));
    // 暫定 DT を作って measureText で各行の最大幅を計測する
    const probe = new DynamicTexture(
        `marker-text-probe-${id}`,
        { width: 16, height: 16 },
        scene,
        false,
    );
    const probeCtx = probe.getContext();
    const fontStr = `${text.fontSize}px sans-serif`;
    probeCtx.font = fontStr;
    let maxLineWidth = 0;
    for (const ln of lines) {
        const m = probeCtx.measureText(ln === "" ? " " : ln);
        if (m.width > maxLineWidth) maxLineWidth = m.width;
    }
    probe.dispose();
    const lineHeightPx = text.fontSize * text.lineHeight;
    const totalTextHeightPx = lineHeightPx * lineCount;
    // 縁取り分も収まるよう余白に加算する。
    const innerPad = padPx + strokePx;
    const dtWidth = Math.min(
        MAX_DT_SIZE,
        ceilPow2(Math.max(1, Math.ceil((maxLineWidth + innerPad * 2) * dpr))),
    );
    const dtHeight = Math.min(
        MAX_DT_SIZE,
        ceilPow2(
            Math.max(1, Math.ceil((totalTextHeightPx + innerPad * 2) * dpr)),
        ),
    );
    const texture = new DynamicTexture(
        `marker-text-${id}`,
        { width: dtWidth, height: dtHeight },
        scene,
        false,
    );
    texture.hasAlpha = true;
    // Plane の UV と DynamicTexture canvas の Y 軸を一致させる（上下反転防止）。
    texture.vScale = -1;
    texture.vOffset = 1;
    const ctx = texture.getContext();
    // 背景は描かず透明のままにする（ウィンドウ非表示要件）。
    ctx.clearRect(0, 0, dtWidth, dtHeight);
    const ctx2d = ctx as unknown as CanvasRenderingContext2D;
    ctx2d.font = `${text.fontSize * dpr}px sans-serif`;
    ctx2d.textBaseline = "top";
    ctx2d.textAlign = "center";
    ctx2d.lineJoin = "round";
    ctx2d.miterLimit = 2;
    const centerX = dtWidth / 2;
    const startY = innerPad * dpr;
    // 1) 白の縁取りを strokeText で描き、2) その上に黒の本体を fillText する。
    ctx2d.lineWidth = strokePx * 2 * dpr; // strokeText は中心線基準なので 2 倍
    ctx2d.strokeStyle = "#ffffff";
    for (let i = 0; i < lines.length; i++) {
        ctx2d.strokeText(lines[i], centerX, startY + i * lineHeightPx * dpr);
    }
    ctx2d.fillStyle = text.color;
    for (let i = 0; i < lines.length; i++) {
        ctx2d.fillText(lines[i], centerX, startY + i * lineHeightPx * dpr);
    }
    texture.update(false);

    const widthWorld = (maxLineWidth + innerPad * 2) / TEXT_WORLD_PX_PER_M;
    const heightWorld =
        (totalTextHeightPx + innerPad * 2) / TEXT_WORLD_PX_PER_M;
    const mesh = CreatePlane(
        `marker-text-${id}`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    const material = new StandardMaterial(`marker-text-mat-${id}`, scene);
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.useAlphaFromDiffuseTexture = true;
    material.diffuseTexture = texture;
    mesh.material = material;
    return { mesh, material, texture, widthWorld, heightWorld };
};

export interface MarkerNode {
    readonly id: string;
    readonly lat: number;
    readonly lon: number;
    /**
     * 位置とスクリーン一定スケールを適用する。
     * @param distScale カメラ距離に比例したスケール倍率。未指定時は 1。
     */
    applyTransform(wx: number, elev: number, wz: number, distScale?: number): void;
    setEnabledLogical(enabled: boolean): void;
    setElevationResolved(resolved: boolean): void;
    update(partial: MarkerUpdate, newLat: number, newLon: number): void;
    getHandle(): MarkerHandle;
    dispose(): void;
}

export interface CreateMarkerNodeDeps {
    /** 親 manager に lat/lon が変更されたことを通知する（manager 側の Map 整合用ではなく将来拡張） */
    readonly _placeholder?: never;
}

export const createMarkerNode = (
    scene: Scene,
    id: string,
    options: MarkerOptions,
): MarkerNode => {
    if (!options.icon && !options.text) {
        throw new Error(
            `addMarker: at least one of icon/text is required (id="${id}")`,
        );
    }
    if (options.icon) validateIconUrl(options.icon.url);

    let resolved = resolve(options);
    let lat = options.lat;
    let lon = options.lon;
    let logicalEnabled = resolved.enabled;
    let elevationResolved = false;

    let lineMeshes: LineMeshes = createLineMesh(scene, id, resolved.line);
    let iconMeshes: IconMeshes | null = resolved.icon
        ? createIconMesh(scene, id, resolved.icon)
        : null;
    let textMeshes: TextMeshes | null = resolved.text
        ? createTextMesh(scene, id, resolved.text)
        : null;

    const applyVisibility = (): void => {
        const visible = logicalEnabled && elevationResolved;
        lineMeshes.outer.setEnabled(visible);
        lineMeshes.inner.setEnabled(visible);
        iconMeshes?.mesh.setEnabled(visible);
        textMeshes?.mesh.setEnabled(visible);
    };
    applyVisibility();

    const applyTransform = (
        wx: number,
        elev: number,
        wz: number,
        distScale = 1,
    ): void => {
        // 線: 足元を地表に固定し、Y 軸方向に distScale 倍して伸ばす。
        // 太さ（X/Z）も distScale で反映させるとカメラ距離に関わらず見た目の太さが一定になる。
        lineMeshes.outer.position.set(wx, elev, wz);
        lineMeshes.inner.position.set(wx, elev, wz);
        lineMeshes.outer.scaling.set(distScale, distScale, distScale);
        lineMeshes.inner.scaling.set(distScale, distScale, distScale);
        const baseY = elev + resolved.line.height * distScale;
        const iconH = (iconMeshes?.heightWorld ?? 0) * distScale;
        const textH = (textMeshes?.heightWorld ?? 0) * distScale;
        const gap = ICON_TEXT_GAP_M * distScale;
        if (iconMeshes) {
            iconMeshes.mesh.scaling.set(distScale, distScale, distScale);
        }
        if (textMeshes) {
            textMeshes.mesh.scaling.set(distScale, distScale, distScale);
        }
        if (iconMeshes && textMeshes) {
            iconMeshes.mesh.position.set(wx, baseY + iconH / 2, wz);
            textMeshes.mesh.position.set(
                wx,
                baseY + iconH + gap + textH / 2,
                wz,
            );
        } else if (iconMeshes) {
            iconMeshes.mesh.position.set(wx, baseY + iconH / 2, wz);
        } else if (textMeshes) {
            textMeshes.mesh.position.set(wx, baseY + textH / 2, wz);
        }
    };

    const disposeIcon = (): void => {
        if (!iconMeshes) return;
        iconMeshes.texture.dispose();
        iconMeshes.material.dispose();
        iconMeshes.mesh.dispose();
        iconMeshes = null;
    };
    const disposeText = (): void => {
        if (!textMeshes) return;
        textMeshes.texture.dispose();
        textMeshes.material.dispose();
        textMeshes.mesh.dispose();
        textMeshes = null;
    };
    const disposeLine = (): void => {
        lineMeshes.outerMaterial.dispose();
        lineMeshes.innerMaterial.dispose();
        lineMeshes.outer.dispose();
        lineMeshes.inner.dispose();
    };

    return {
        id,
        get lat() {
            return lat;
        },
        get lon() {
            return lon;
        },
        applyTransform,
        setEnabledLogical(enabled: boolean): void {
            logicalEnabled = enabled;
            applyVisibility();
        },
        setElevationResolved(r: boolean): void {
            elevationResolved = r;
            applyVisibility();
        },
        update(partial: MarkerUpdate, newLat: number, newLon: number): void {
            lat = newLat;
            lon = newLon;
            if (partial.icon !== undefined) validateIconUrl(partial.icon.url);
            // line 差分 → 再生成
            if (partial.line !== undefined) {
                resolved = {
                    ...resolved,
                    line: resolveLine(partial.line),
                };
                disposeLine();
                lineMeshes = createLineMesh(scene, id, resolved.line);
            }
            if (partial.icon !== undefined) {
                resolved = { ...resolved, icon: resolveIcon(partial.icon) };
                disposeIcon();
                if (resolved.icon) {
                    iconMeshes = createIconMesh(scene, id, resolved.icon);
                }
            }
            if (partial.text !== undefined) {
                resolved = { ...resolved, text: resolveText(partial.text) };
                disposeText();
                if (resolved.text) {
                    textMeshes = createTextMesh(scene, id, resolved.text);
                }
            }
            if (partial.enabled !== undefined) {
                logicalEnabled = partial.enabled;
                resolved = { ...resolved, enabled: partial.enabled };
            }
            applyVisibility();
        },
        getHandle(): MarkerHandle {
            return {
                id,
                lat,
                lon,
                enabled: logicalEnabled,
                icon: resolved.icon,
                text: resolved.text,
                line: resolved.line,
                elevationResolved,
            };
        },
        dispose(): void {
            disposeIcon();
            disposeText();
            disposeLine();
        },
    };
};
