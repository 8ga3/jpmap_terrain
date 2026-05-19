/**
 * フライトルートライン (Issue #265)。
 *
 * 飛行機の前方に「これから飛行するルート」を半透明のリボン（帯）として描画する。
 *
 * 仕様:
 * - 飛行機先頭から ROUTE_START_OFFSET_M 先から描画開始
 * - ROUTE_LENGTH_M 分だけ表示
 * - 両端が徐々に透明にフェード
 * - グラデーションカラーアニメーション
 * - Babylon.js CreateRibbon + StandardMaterial + 頂点カラーで実装
 */

import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";

import { circularOrbitPosition, circularOrbitHeading } from "../avatar/orbit";

// ─── 調整可能な定数 ─────────────────────────────────────
/** 飛行機中心から先頭までの距離 (m) */
const NOSE_OFFSET_M = 5;
/** 先頭からルートライン開始までのギャップ (m) */
const START_GAP_M = 2;
/** ルートライン開始地点 = 中心から前方への距離 (m) */
const ROUTE_START_OFFSET_M = NOSE_OFFSET_M + START_GAP_M;
/** ルートラインの表示距離 (m) */
const ROUTE_LENGTH_M = 200;
/** リボンの幅 (m)。進行方向に対して左右に半幅ずつ広がる */
const RIBBON_HALF_WIDTH_M = 3;
/** 経路上のサンプル点数（固定）。多いほど滑らか・負荷大 */
const SAMPLE_COUNT = 40;
/** リボンを飛行機のわずか下に配置し Follow カメラからの視認性を上げる (m) */
const RIBBON_Y_OFFSET_M = -2;

// ─── フェード区間 ─────────────────────────────────────
/** 先端フェード区間の割合 (0-1)。先頭 20% でフェードイン */
const FADE_IN_RATIO = 0.2;
/** 末端フェード区間の割合 (0-1)。末尾 30% でフェードアウト */
const FADE_OUT_RATIO = 0.3;

// ─── 型 ─────────────────────────────────────────────────
export interface RouteLineContext {
    scene: Scene;
    /** 現在の軌道角度 (deg) */
    angleDeg: number;
    /** 軌道の中心緯度 */
    centerLat: number;
    /** 軌道の中心経度 */
    centerLon: number;
    /** 軌道半径 (m) */
    radiusM: number;
    /** 飛行高度 (m, absolute) */
    altitudeM: number;
    /** model の TransformNode 名。実際の world position 取得用 */
    modelNodeName: string;
    /**
     * モデルのワールドスケール倍率。
     * ROUTE_START_OFFSET_M / ROUTE_LENGTH_M / RIBBON_HALF_WIDTH_M は
     * モデル空間 (m) で定義されているため、この値を掛けてワールド空間に変換する。
     */
    modelScale: number;
}

export interface RouteLine {
    /** 毎フレーム呼び出してリボンを更新する */
    update(ctx: RouteLineContext, time: number): void;
    /** リソース解放 */
    dispose(): void;
}

/** smoothstep helper */
const smoothstep = (edge0: number, edge1: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

/**
 * グラデーションカラーを t (0-1) と time から計算する。
 */
const computeGradientColor = (t: number, timeSec: number): Color4 => {
    // 3色グラデーション: cyan → magenta → yellow、時間でスクロール
    const phase = ((t * 2.0 - timeSec * 0.4) % 1.0 + 1.0) % 1.0;
    const c1 = { r: 0.0, g: 0.8, b: 1.0 };
    const c2 = { r: 1.0, g: 0.2, b: 0.6 };
    const c3 = { r: 1.0, g: 0.9, b: 0.1 };

    let r: number, g: number, b: number;
    if (phase < 0.5) {
        const f = phase * 2.0;
        r = c1.r + (c2.r - c1.r) * f;
        g = c1.g + (c2.g - c1.g) * f;
        b = c1.b + (c2.b - c1.b) * f;
    } else {
        const f = (phase - 0.5) * 2.0;
        r = c2.r + (c3.r - c2.r) * f;
        g = c2.g + (c3.g - c2.g) * f;
        b = c2.b + (c3.b - c2.b) * f;
    }

    // 両端フェード
    const alphaStart = smoothstep(0, FADE_IN_RATIO, t);
    const alphaEnd = smoothstep(0, FADE_OUT_RATIO, 1.0 - t);
    const alpha = alphaStart * alphaEnd * 0.6;

    return new Color4(r, g, b, alpha);
};

/**
 * ルートラインを作成する。
 * 呼び出し側は毎フレーム `update()` を呼ぶこと。
 */
export const createRouteLine = (scene: Scene): RouteLine => {
    // StandardMaterial + 頂点カラー (hasVertexAlpha) で
    // グラデーション + アルファフェードを実現する。
    // ShaderMaterial は BJS 9 + WebGPU で互換性問題がある場合があるため回避。
    const material = new StandardMaterial("flightRouteMat", scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.White();
    material.backFaceCulling = false;
    material.alpha = 1;
    material.disableDepthWrite = true;

    // 初期 Ribbon 用のダミーパス（2列、SAMPLE_COUNT 点ずつ）
    const initPath = (): Vector3[][] => {
        const left: Vector3[] = [];
        const right: Vector3[] = [];
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            left.push(new Vector3(0, 0, 0));
            right.push(new Vector3(0, 0, 0));
        }
        return [left, right];
    };

    const pathArray = initPath();

    let ribbon: Mesh = CreateRibbon(
        "flightRouteRibbon",
        { pathArray, updatable: true, sideOrientation: Mesh.DOUBLESIDE },
        scene,
    );
    ribbon.material = material;
    ribbon.renderingGroupId = 1;
    ribbon.isPickable = false;
    ribbon.alwaysSelectAsActiveMesh = true;
    ribbon.hasVertexAlpha = true;

    const update = (ctx: RouteLineContext, time: number): void => {
        const { angleDeg, centerLat, centerLon, radiusM, altitudeM, modelNodeName, modelScale } = ctx;

        // 飛行機の root TransformNode からワールド位置を取得
        const root = ctx.scene.getTransformNodeByName(modelNodeName);
        if (!root) return;
        const childMesh = root.getChildMeshes(false)[0];
        if (!childMesh) return;
        childMesh.computeWorldMatrix(true);
        const planeWorldPos = childMesh.absolutePosition;

        // モデル空間の定数をワールド空間にスケール変換
        const scaledStartOffset = ROUTE_START_OFFSET_M * modelScale;
        const scaledLength = ROUTE_LENGTH_M * modelScale;
        const scaledHalfWidth = RIBBON_HALF_WIDTH_M * modelScale;

        const startArcLen = scaledStartOffset;
        const endArcLen = scaledStartOffset + scaledLength;

        // 飛行機の現在 lat/lon
        const planePos = circularOrbitPosition(centerLat, centerLon, radiusM, angleDeg);

        const timeSec = time * 0.001;

        // 頂点カラー配列: ribbon の頂点順序に合わせる
        // CreateRibbon は pathArray[0][i], pathArray[1][i] を交互に配置
        const colors: number[] = [];

        for (let i = 0; i < SAMPLE_COUNT; i++) {
            const t = i / (SAMPLE_COUNT - 1); // 0..1
            const arcLen = startArcLen + t * (endArcLen - startArcLen);

            // 弧長を角度に変換 (時計回り)
            const deltaAngleDeg = (arcLen / radiusM) * (180 / Math.PI);
            const futureAngle = angleDeg + deltaAngleDeg;

            // 未来の位置を lat/lon で計算
            const futurePos = circularOrbitPosition(centerLat, centerLon, radiusM, futureAngle);

            // lat/lon 差分をメートル換算で world offset に変換
            const dLat = futurePos.lat - planePos.lat;
            const dLon = futurePos.lon - planePos.lon;
            const cosLat = Math.cos((planePos.lat * Math.PI) / 180);
            const offsetX = dLon * 111320 * cosLat;
            const offsetZ = dLat * 111320;

            // 未来点のワールド座標
            const wx = planeWorldPos.x + offsetX;
            const wz = planeWorldPos.z + offsetZ;
            const wy = altitudeM + RIBBON_Y_OFFSET_M;

            // 未来点での接線方向（進行方向に垂直にリボン幅を出す）
            const futureHeading = circularOrbitHeading(futureAngle);
            const fhRad = (futureHeading * Math.PI) / 180;
            const perpX = Math.cos(fhRad);
            const perpZ = -Math.sin(fhRad);

            // 左右のパスを設定
            pathArray[0][i].set(
                wx - perpX * scaledHalfWidth,
                wy,
                wz - perpZ * scaledHalfWidth,
            );
            pathArray[1][i].set(
                wx + perpX * scaledHalfWidth,
                wy,
                wz + perpZ * scaledHalfWidth,
            );

            // 頂点カラー: CreateRibbon は path[0][i], path[1][i] 順でインターリーブ
            const col = computeGradientColor(t, timeSec);
            colors.push(col.r, col.g, col.b, col.a); // left
            colors.push(col.r, col.g, col.b, col.a); // right
        }

        // Ribbon を更新
        ribbon = CreateRibbon(
            "flightRouteRibbon",
            { pathArray, updatable: true, instance: ribbon },
        );

        // 頂点カラーを設定（毎フレーム更新でアニメーション）
        ribbon.setVerticesData(VertexBuffer.ColorKind, colors, true);
    };

    const dispose = (): void => {
        ribbon.dispose();
        material.dispose();
    };

    return { update, dispose };
};
