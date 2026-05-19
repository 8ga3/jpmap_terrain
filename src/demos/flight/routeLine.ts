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
 * - Babylon.js CreateRibbon + ShaderMaterial で実装
 */

import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
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

// ─── フェード区間 ─────────────────────────────────────
/** 先端フェード区間の割合 (0-1)。先頭 20% でフェードイン */
const FADE_IN_RATIO = 0.2;
/** 末端フェード区間の割合 (0-1)。末尾 30% でフェードアウト */
const FADE_OUT_RATIO = 0.3;

// ─── シェーダー定義 ─────────────────────────────────────
const SHADER_NAME = "flightRoute";

const VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 worldViewProjection;

varying vec2 vUV;

void main() {
    vUV = uv;
    gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uFadeInRatio;
uniform float uFadeOutRatio;

varying vec2 vUV;

void main() {
    float t = vUV.x; // 0 = start (near plane), 1 = end (far)

    // ─── グラデーションカラー (animated) ───
    // 3色グラデーション: cyan → magenta → yellow、時間でスクロール
    float phase = fract(t * 2.0 - uTime * 0.4);
    vec3 c1 = vec3(0.0, 0.8, 1.0);  // cyan
    vec3 c2 = vec3(1.0, 0.2, 0.6);  // magenta
    vec3 c3 = vec3(1.0, 0.9, 0.1);  // yellow
    vec3 color;
    if (phase < 0.5) {
        color = mix(c1, c2, phase * 2.0);
    } else {
        color = mix(c2, c3, (phase - 0.5) * 2.0);
    }

    // ─── 両端フェード ───
    float alphaStart = smoothstep(0.0, uFadeInRatio, t);
    float alphaEnd = smoothstep(0.0, uFadeOutRatio, 1.0 - t);
    float alpha = alphaStart * alphaEnd * 0.6; // 全体の最大不透明度

    // 中央 (vUV.y=0.5) が最も濃く、端で少し薄くする
    float edgeFade = 1.0 - 0.3 * abs(vUV.y - 0.5) * 2.0;
    alpha *= edgeFade;

    gl_FragColor = vec4(color, alpha);
}
`;

// シェーダーを Effect Store に登録（一度だけ）
let shaderRegistered = false;
const ensureShaderRegistered = (): void => {
    if (shaderRegistered) return;
    Effect.ShadersStore[`${SHADER_NAME}VertexShader`] = VERTEX_SHADER;
    Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = FRAGMENT_SHADER;
    shaderRegistered = true;
};

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

/**
 * ルートラインを作成する。
 * 呼び出し側は毎フレーム `update()` を呼ぶこと。
 */
export const createRouteLine = (scene: Scene): RouteLine => {
    ensureShaderRegistered();

    // ShaderMaterial
    const material = new ShaderMaterial(
        "flightRouteMat",
        scene,
        { vertex: SHADER_NAME, fragment: SHADER_NAME },
        {
            attributes: ["position", "uv"],
            uniforms: ["worldViewProjection", "uTime", "uFadeInRatio", "uFadeOutRatio"],
            needAlphaBlending: true,
        },
    );
    material.backFaceCulling = false;
    material.alphaMode = 2; // ALPHA_COMBINE
    material.setFloat("uFadeInRatio", FADE_IN_RATIO);
    material.setFloat("uFadeOutRatio", FADE_OUT_RATIO);

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
    // Frustum culling を無効化（位置が毎フレーム変わるため bounding が遅延しがち）
    ribbon.alwaysSelectAsActiveMesh = true;

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

        // 円軌道の角速度方向: 時計回りなので、前方 = angleDeg + delta
        // arc length (m) → angle offset (deg): delta_deg = (arcLen / radius) * (180/π)
        const startArcLen = scaledStartOffset;
        const endArcLen = scaledStartOffset + scaledLength;

        // 飛行機の現在 lat/lon
        const planePos = circularOrbitPosition(centerLat, centerLon, radiusM, angleDeg);

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
            // world: X = east/west (lon), Z = north/south (lat)
            const offsetX = dLon * 111320 * cosLat;
            const offsetZ = dLat * 111320;

            // 未来点のワールド座標
            const wx = planeWorldPos.x + offsetX;
            const wz = planeWorldPos.z + offsetZ;
            const wy = altitudeM; // absolute altitude = Y

            // 未来点での接線方向（進行方向に垂直にリボン幅を出す）
            const futureHeading = circularOrbitHeading(futureAngle);
            const fhRad = (futureHeading * Math.PI) / 180;
            // 進行方向に垂直な左右ベクトル: heading を 90° 回転
            const perpX = Math.cos(fhRad); // 左方向 (heading+90 の sin と cos)
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
        }

        // Ribbon を更新
        ribbon = CreateRibbon(
            "flightRouteRibbon",
            { pathArray, updatable: true, instance: ribbon },
        );

        // シェーダー時間を更新
        material.setFloat("uTime", time * 0.001); // ms → seconds
    };

    const dispose = (): void => {
        ribbon.dispose();
        material.dispose();
    };

    return { update, dispose };
};
