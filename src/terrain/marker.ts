/**
 * マーカー描画の共通ユーティリティ (Issue #167 / #414)。
 *
 * アイコン Plane・テキスト Plane を 1 枚の板ポリにまとめて描画する `createIconTextMesh` と、
 * icon/text オプション解決・URL 検証を提供する。globe 単一バックエンド（#414）では
 * `globeMarkerManager` がこれらを再利用してマーカーを表示する（座標系非依存）。
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
    type MarkerIconOptions,
    type MarkerTextOptions,
} from "../lib/types";

// グローブ版オーバーレイ（#275 Phase 3）が同じ描画レイヤーに揃えるため export する。
export const RENDERING_GROUP_ID = 1;
const MAX_DT_SIZE = 1024;

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

// グローブ版オーバーレイ（#275 Phase 3, geo/globeMarkerManager）が同じアイコン/ラベル描画を
// 再利用するため export する（座標系非依存のビルボード描画。平面版の挙動は不変）。
export const resolveIcon = (
    icon: MarkerIconOptions | undefined,
): Required<MarkerIconOptions> | null => {
    if (!icon) return null;
    return {
        url: icon.url,
        width: icon.width ?? MARKER_DEFAULTS.icon.width,
        height: icon.height ?? MARKER_DEFAULTS.icon.height,
    };
};

export const resolveText = (
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

export interface IconTextMeshes {
    mesh: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    widthWorld: number;
    heightWorld: number;
    /** プレーン下部に占めるアイコン領域の高さ (world m)。アイコン無しの場合 0。 */
    iconHeightWorld: number;
    /** プレーン上部に占めるテキスト領域の高さ (world m)。テキスト無しの場合 0。 */
    textHeightWorld: number;
    /**
     * dispose 済みフラグ。アイコン画像の非同期ロードが dispose
     * 後に完了した際、解放済みの texture / mesh にアクセスして例外を
     * 引き起こさないよう onload コールバックで参照してガードする。
     */
    disposed: boolean;
}

/**
 * アイコン画像とテキストを 1 枚の板ポリ（DynamicTexture）にまとめて描画する。
 * - 上半分: テキスト（複数行・縁取り付き、中央揃え）
 * - 下半分: アイコン画像（非同期 Image ロード、ロード完了後に canvas へ drawImage して update）
 * - 板の幅は max(textWidth, iconWidth) に揃え、両領域とも水平中央に配置する。
 * - 板の左右はアスペクト維持のためテクスチャと同サイズ（dpr 換算）。
 */
export const createIconTextMesh = (
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
    // テキスト下端の内側パディング: アイコンが存在する場合は半分にしてアイコンを近づける。
    let textBottomPadPx = 0;
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
        // アイコンが下に並ぶ場合は底側パディングを半分に詰めて寄せる。
        textBottomPadPx = icon ? innerPad * 0.5 : innerPad;
        textWidthPx = Math.ceil((maxLineWidth + innerPad * 2) * dpr);
        textHeightPx = Math.ceil((totalTextHeightPx + innerPad + textBottomPadPx) * dpr);
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
        // 1) backgroundColor が "transparent" 以外なら、テキスト領域の背景を塗る。
        if (text.backgroundColor && text.backgroundColor !== "transparent") {
            ctx2d.fillStyle = text.backgroundColor;
            ctx2d.fillRect(0, 0, dtWidth, textHeightPx);
        }
        ctx2d.font = `${text.fontSize * dpr}px sans-serif`;
        ctx2d.textBaseline = "top";
        ctx2d.textAlign = "center";
        ctx2d.lineJoin = "round";
        ctx2d.miterLimit = 2;
        const innerPad = padPx + strokePx;
        const startY = innerPad * dpr;
        const centerX = dtWidth / 2;
        // 2) 白の縁取り → 3) テキスト本体
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

    const handle: IconTextMeshes = {
        mesh,
        material,
        texture,
        widthWorld,
        heightWorld,
        iconHeightWorld,
        textHeightWorld,
        disposed: false,
    };

    // アイコン画像を非同期にロードして下半分へ描き込む（Canvas で描いた PNG data URL や
    // CORS 許可済み http(s) を想定）。
    // dispose 後に onload が走った場合は解放済み texture / mesh への誤アクセスを避けるため、
    // handle.disposed を確認してからガードする。
    if (icon) {
        const img = new Image();
        // クロスオリジン対応: 失敗してもタグ自体は読み込まれるため crossOrigin を試行する。
        img.crossOrigin = "anonymous";
        img.onload = () => {
            if (handle.disposed) return;
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

    return handle;
};
