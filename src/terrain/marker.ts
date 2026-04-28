/**
 * 個別マーカーノード (Issue #167)。
 *
 * 地表からの線 (Tube)・アイコン Plane・テキスト Plane の組み合わせで
 * 1 マーカーを表現する。`MarkerManager` から生成・更新・破棄される。
 */

import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
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

const RENDERING_GROUP_ID = 1;
const MAX_DT_SIZE = 1024;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);/**
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
 * 垂直線をビルボード平面 2 枚 (外側=白縁, 内側=黒コア) で表現する。
 *
 * - `BILLBOARDMODE_Y` により Y 軸回転のみで常にカメラへ正面を向ける。
 * - 高さは applyTransform 時に `dynamicLineHeight` を Y スケールへ流し込む。
 * - 幅は `line.width` をベースとし、X スケールでカメラ距離一定 (distScale) を反映する。
 * - 縁取り幅は内側幅の 50% を片側に確保し、上端も同量だけ延ばして額縁状にする。
 */
const createLineMesh = (
    scene: Scene,
    id: string,
    line: Required<MarkerLineOptions>,
): LineMeshes => {
    const inner = CreatePlane(
        `marker-line-inner-${id}`,
        { width: 1, height: 1 },
        scene,
    );
    inner.billboardMode = AbstractMesh.BILLBOARDMODE_Y;
    inner.renderingGroupId = RENDERING_GROUP_ID;
    inner.isPickable = false;
    const innerMaterial = new StandardMaterial(
        `marker-line-inner-mat-${id}`,
        scene,
    );
    innerMaterial.emissiveColor = Color3.FromHexString(line.color);
    innerMaterial.disableLighting = true;
    innerMaterial.backFaceCulling = false;
    // 内側を縁取りより手前へ寄せて Z-fight を回避する。
    innerMaterial.zOffset = -1;
    inner.material = innerMaterial;

    const outer = CreatePlane(
        `marker-line-outer-${id}`,
        { width: 1, height: 1 },
        scene,
    );
    outer.billboardMode = AbstractMesh.BILLBOARDMODE_Y;
    outer.renderingGroupId = RENDERING_GROUP_ID;
    outer.isPickable = false;
    const outerMaterial = new StandardMaterial(
        `marker-line-outer-mat-${id}`,
        scene,
    );
    outerMaterial.emissiveColor = Color3.White();
    outerMaterial.disableLighting = true;
    outerMaterial.backFaceCulling = false;
    outer.material = outerMaterial;

    return { outer, inner, outerMaterial, innerMaterial };
};

interface IconTextMeshes {
    mesh: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    widthWorld: number;
    heightWorld: number;
    /** プレーン下部に占めるアイコン領域の高さ (world m)。アイコン無しの場合 0。 */
    iconHeightWorld: number;
    /** プレーン上部に占めるテキスト領域の高さ (world m)。テキスト無しの場合 0。 */
    textHeightWorld: number;
}

/**
 * アイコン画像とテキストを 1 枚の板ポリ（DynamicTexture）にまとめて描画する。
 * - 上半分: テキスト（複数行・縁取り付き、中央揃え）
 * - 下半分: アイコン画像（非同期 Image ロード、ロード完了後に canvas へ drawImage して update）
 * - 板の幅は max(textWidth, iconWidth) に揃え、両領域とも水平中央に配置する。
 * - 板の左右はアスペクト維持のためテクスチャと同サイズ（dpr 換算）。
 */
const createIconTextMesh = (
    scene: Scene,
    id: string,
    icon: Required<MarkerIconOptions> | null,
    text: Required<MarkerTextOptions> | null,
): IconTextMeshes | null => {
    if (!icon && !text) return null;

    const dpr =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio ===
            "number"
            ? Math.max((globalThis as { devicePixelRatio: number }).devicePixelRatio, 1)
            : 1;

    // テキスト領域サイズ (px)
    let lines: string[] = [];
    let lineHeightPx = 0;
    let padPx = 0;
    let strokePx = 0;
    let textWidthPx = 0;
    let textHeightPx = 0;
    if (text) {
        lines = text.value.split("\n");
        const lineCount = Math.max(lines.length, 1);
        padPx = Math.round(text.fontSize * 0.4);
        strokePx = Math.max(2, Math.round(text.fontSize * 0.12));
        const probe = new DynamicTexture(
            `marker-iconText-probe-${id}`,
            { width: 16, height: 16 },
            scene,
            false,
        );
        const probeCtx = probe.getContext();
        probeCtx.font = `${text.fontSize}px sans-serif`;
        let maxLineWidth = 0;
        for (const ln of lines) {
            const m = probeCtx.measureText(ln === "" ? " " : ln);
            if (m.width > maxLineWidth) maxLineWidth = m.width;
        }
        probe.dispose();
        lineHeightPx = text.fontSize * text.lineHeight;
        const totalTextHeightPx = lineHeightPx * lineCount;
        const innerPad = padPx + strokePx;
        textWidthPx = Math.ceil((maxLineWidth + innerPad * 2) * dpr);
        textHeightPx = Math.ceil((totalTextHeightPx + innerPad * 2) * dpr);
    }

    // アイコン領域サイズ (px)。icon.width/height は world m なので dpr 換算で px にする。
    let iconWidthPx = 0;
    let iconHeightPx = 0;
    if (icon) {
        iconWidthPx = Math.max(1, Math.ceil(icon.width * dpr));
        iconHeightPx = Math.max(1, Math.ceil(icon.height * dpr));
    }

    const dtWidth = Math.min(
        MAX_DT_SIZE,
        Math.max(1, Math.max(textWidthPx, iconWidthPx)),
    );
    const dtHeight = Math.min(
        MAX_DT_SIZE,
        Math.max(1, textHeightPx + iconHeightPx),
    );

    const texture = new DynamicTexture(
        `marker-iconText-${id}`,
        { width: dtWidth, height: dtHeight },
        scene,
        false,
    );
    texture.hasAlpha = true;
    // Plane の UV と canvas の Y 軸を一致させる（上下反転防止）。
    texture.vScale = -1;
    texture.vOffset = 1;

    const ctx = texture.getContext();
    const ctx2d = ctx as unknown as CanvasRenderingContext2D;
    ctx2d.clearRect(0, 0, dtWidth, dtHeight);

    // 上半分にテキストを描く
    if (text) {
        ctx2d.font = `${text.fontSize * dpr}px sans-serif`;
        ctx2d.textBaseline = "top";
        ctx2d.textAlign = "center";
        ctx2d.lineJoin = "round";
        ctx2d.miterLimit = 2;
        const innerPad = padPx + strokePx;
        const startY = innerPad * dpr;
        const centerX = dtWidth / 2;
        // 1) 白の縁取り → 2) 黒の本体
        ctx2d.lineWidth = strokePx * 2 * dpr;
        ctx2d.strokeStyle = "#ffffff";
        for (let i = 0; i < lines.length; i++) {
            ctx2d.strokeText(lines[i], centerX, startY + i * lineHeightPx * dpr);
        }
        ctx2d.fillStyle = text.color;
        for (let i = 0; i < lines.length; i++) {
            ctx2d.fillText(lines[i], centerX, startY + i * lineHeightPx * dpr);
        }
    }
    texture.update(false);

    const widthWorld = dtWidth / dpr;
    const heightWorld = dtHeight / dpr;
    const iconHeightWorld = iconHeightPx / dpr;
    const textHeightWorld = textHeightPx / dpr;

    const mesh = CreatePlane(
        `marker-iconText-${id}`,
        { width: widthWorld, height: heightWorld },
        scene,
    );
    mesh.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    mesh.renderingGroupId = RENDERING_GROUP_ID;
    mesh.isPickable = false;
    const material = new StandardMaterial(`marker-iconText-mat-${id}`, scene);
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.useAlphaFromDiffuseTexture = true;
    material.diffuseTexture = texture;
    mesh.material = material;

    // アイコン画像を非同期にロードして下半分へ描き込む（Canvas で描いた PNG data URL や
    // CORS 許可済み http(s) を想定）。
    if (icon) {
        const img = new Image();
        // クロスオリジン対応: 失敗してもタグ自体は読み込まれるため crossOrigin を試行する。
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const dx = (dtWidth - iconWidthPx) / 2;
            const dy = textHeightPx;
            ctx2d.drawImage(img, dx, dy, iconWidthPx, iconHeightPx);
            texture.update(false);
        };
        img.onerror = () => {
            console.warn(
                `[jpmap-terrain] marker icon image load failed: id=${id}`,
                icon.url,
            );
        };
        img.src = icon.url;
    }

    return {
        mesh,
        material,
        texture,
        widthWorld,
        heightWorld,
        iconHeightWorld,
        textHeightWorld,
    };
};

export interface MarkerNode {
    readonly id: string;
    readonly lat: number;
    readonly lon: number;
    /**
     * 位置・スケール・線高さを 1 フレーム分まとめて反映する。
     * @param distScale カメラ距離に応じたスクリーン一定スケール（幅・アイコン・テキストへ適用）。
     * @param dynamicLineHeight 線の高さ (m)。`undefined` の場合は `line.height` をそのまま使用する。
     */
    applyTransform(
        wx: number,
        elev: number,
        wz: number,
        distScale?: number,
        dynamicLineHeight?: number,
    ): void;
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
    let iconTextMeshes: IconTextMeshes | null = createIconTextMesh(
        scene,
        id,
        resolved.icon,
        resolved.text,
    );

    const applyVisibility = (): void => {
        const visible = logicalEnabled && elevationResolved;
        lineMeshes.outer.setEnabled(visible);
        lineMeshes.inner.setEnabled(visible);
        iconTextMeshes?.mesh.setEnabled(visible);
    };
    applyVisibility();

    const applyTransform = (
        wx: number,
        elev: number,
        wz: number,
        distScale = 1,
        dynamicLineHeight?: number,
    ): void => {
        // 線の高さ: 動的指定があればそれを使い、無ければ resolved.line.height (×distScale で screen-constant) にフォールバック。
        const lineHeight =
            dynamicLineHeight !== undefined && dynamicLineHeight > 0
                ? dynamicLineHeight
                : resolved.line.height * distScale;
        // 線の幅は distScale でスクリーン定幅に保つ。
        const innerW = Math.max(resolved.line.width, 0.5) * distScale;
        // 縁取り幅 (片側) = 内側幅の 50%。上端も同量だけ延ばして額縁状にする。
        const border = innerW * 0.5;
        const outerW = innerW + border * 2;
        const outerH = lineHeight + border;

        // 内側 (黒コア): 平面 1×1 を innerW × lineHeight にスケールし、底辺を地表に合わせる。
        lineMeshes.inner.scaling.set(innerW, lineHeight, 1);
        lineMeshes.inner.position.set(wx, elev + lineHeight / 2, wz);
        // 外側 (白縁): innerW + 2*border 幅、上端を border 分だけ高くした位置に置く。
        lineMeshes.outer.scaling.set(outerW, outerH, 1);
        lineMeshes.outer.position.set(wx, elev + outerH / 2, wz);

        // アイコン+テキストの合成プレーン:
        // - 線の先端 (lineTopY) をアイコン中心に合わせる。
        // - プレーン内訳 (上→下): textHeight, iconHeight。
        //   plane center.y = lineTopY + textHeight*distScale / 2
        //   （icon 無しなら plane center = lineTopY = text bottom、
        //     text 無しなら plane center = lineTopY = icon center）
        if (iconTextMeshes) {
            iconTextMeshes.mesh.scaling.set(distScale, distScale, distScale);
            const lineTopY = elev + lineHeight;
            const textH = iconTextMeshes.textHeightWorld * distScale;
            iconTextMeshes.mesh.position.set(wx, lineTopY + textH / 2, wz);
        }
    };

    const disposeIconText = (): void => {
        if (!iconTextMeshes) return;
        iconTextMeshes.texture.dispose();
        iconTextMeshes.material.dispose();
        iconTextMeshes.mesh.dispose();
        iconTextMeshes = null;
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
            // icon / text どちらかが変化したら 1 枚のプレーンを作り直す。
            const iconChanged = partial.icon !== undefined;
            const textChanged = partial.text !== undefined;
            if (iconChanged || textChanged) {
                if (iconChanged) {
                    resolved = { ...resolved, icon: resolveIcon(partial.icon) };
                }
                if (textChanged) {
                    resolved = { ...resolved, text: resolveText(partial.text) };
                }
                disposeIconText();
                iconTextMeshes = createIconTextMesh(
                    scene,
                    id,
                    resolved.icon,
                    resolved.text,
                );
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
            disposeIconText();
            disposeLine();
        },
    };
};
