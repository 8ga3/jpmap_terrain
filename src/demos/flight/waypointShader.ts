/**
 * ウェイポイント魔法陣シェーダー。
 *
 * ディスクメッシュに適用する ShaderMaterial。
 * - 同心円リング（内・外で逆回転）
 * - 六芒星・幾何学模様
 * - ルーン風セグメント
 * - パルス発光 + シアン/紫のグラデーション
 */

import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Effect } from "@babylonjs/core/Materials/effect";
import type { Scene } from "@babylonjs/core/scene";

// ─── シェーダーソース ────────────────────────────────────

const VERTEX_SHADER = `
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

const FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUV;
uniform float uTime;

#define PI 3.14159265
#define TAU 6.28318530

// --- ユーティリティ ---

// 回転
vec2 rotate2D(vec2 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec2(p.x*c - p.y*s, p.x*s + p.y*c);
}

// アンチエイリアスされたリング
float ring(float r, float center, float width) {
    return smoothstep(center - width, center, r) - smoothstep(center, center + width, r);
}

// N角形の距離関数
// atan(p.x, p.y) は意図的: +Y軸を0°基準にして頂点を12時方向に配置する
float polygon(vec2 p, int n, float size) {
    float a = atan(p.x, p.y) + PI;
    float r = TAU / float(n);
    float d = cos(floor(0.5 + a/r) * r - a) * length(p);
    return smoothstep(size + 0.005, size, d);
}

// セグメント（ルーン風の破線マーク）
float segments(float angle, int count, float width) {
    float seg = fract(angle / TAU * float(count));
    return step(width, seg) * step(seg, 1.0 - width);
}

void main() {
    vec2 uv = vUV * 2.0 - 1.0;
    float r = length(uv);
    float angle = atan(uv.y, uv.x);

    // 円盤外を完全透明に
    if (r > 0.98) discard;

    float alpha = 0.0;
    vec3 color = vec3(0.0);

    // --- 基本カラー: シアン〜紫のグラデーション ---
    float hueShift = uTime * 0.4;
    vec3 col1 = vec3(0.1, 0.8, 1.0); // シアン
    vec3 col2 = vec3(0.6, 0.2, 1.0); // 紫
    vec3 baseColor = mix(col1, col2, 0.5 + 0.5 * sin(angle * 2.0 + hueShift));

    // --- 外側リング (逆回転) ---
    float outerRing = ring(r, 0.92, 0.015);
    float outerRing2 = ring(r, 0.85, 0.008);
    // ルーン風セグメント（外周に沿った破線）
    float outerAngle = angle + uTime * 1.2;
    float runeOuter = segments(outerAngle, 24, 0.15) * ring(r, 0.88, 0.02);
    alpha += outerRing + outerRing2 + runeOuter * 0.7;
    color += baseColor * (outerRing + outerRing2 + runeOuter * 0.7);

    // --- 中間リング (正回転) ---
    float midRing = ring(r, 0.68, 0.01);
    float midRing2 = ring(r, 0.62, 0.006);
    float midAngle = angle - uTime * 0.8;
    float runeMid = segments(midAngle, 16, 0.2) * ring(r, 0.65, 0.025);
    alpha += midRing + midRing2 + runeMid * 0.6;
    color += baseColor * (midRing + midRing2 + runeMid * 0.6);

    // --- 内側リング ---
    float innerRing = ring(r, 0.42, 0.008);
    float innerAngle = angle + uTime * 1.5;
    float runeInner = segments(innerAngle, 12, 0.25) * ring(r, 0.44, 0.02);
    alpha += innerRing + runeInner * 0.5;
    color += baseColor * (innerRing + runeInner * 0.5);

    // --- 六芒星 (外側, 逆回転) ---
    vec2 hexUV = rotate2D(uv, -uTime * 0.5);
    float hex1 = polygon(hexUV, 3, 0.72) - polygon(hexUV, 3, 0.70);
    vec2 hexUV2 = rotate2D(uv, -uTime * 0.5 + PI / 3.0);
    float hex2 = polygon(hexUV2, 3, 0.72) - polygon(hexUV2, 3, 0.70);
    float hexagram = clamp(hex1 + hex2, 0.0, 1.0);
    alpha += hexagram * 0.8;
    color += vec3(0.3, 0.9, 1.0) * hexagram * 0.8;

    // --- 内側六角形 (正回転) ---
    vec2 innerHexUV = rotate2D(uv, uTime * 0.7);
    float innerHex = polygon(innerHexUV, 6, 0.35) - polygon(innerHexUV, 6, 0.33);
    alpha += innerHex * 0.6;
    color += vec3(0.8, 0.4, 1.0) * innerHex * 0.6;

    // --- 中心の円 (パルス) ---
    float centerGlow = smoothstep(0.15, 0.0, r);
    float pulse = 0.5 + 0.5 * sin(uTime * 3.0);
    alpha += centerGlow * pulse * 0.4;
    color += vec3(1.0, 1.0, 1.0) * centerGlow * pulse * 0.4;

    // --- 放射線 (十字, 回転) ---
    vec2 crossUV = rotate2D(uv, uTime * 0.3);
    float crossLine = (step(abs(crossUV.x), 0.003) + step(abs(crossUV.y), 0.003))
                      * step(0.2, r) * step(r, 0.6);
    alpha += crossLine * 0.4;
    color += baseColor * crossLine * 0.4;

    // --- 全体パルス + エミッシブ ---
    float emit = 2.0 + 1.0 * sin(uTime * 2.0);
    color *= emit;
    alpha = clamp(alpha, 0.0, 1.0);

    // 外縁フェード
    alpha *= smoothstep(0.98, 0.93, r);

    gl_FragColor = vec4(color, alpha * 0.9);
}
`;

let shaderRegistered = false;

/** シェーダーソースを Effect.ShadersStore に登録する（初回のみ） */
const ensureShaderRegistered = (): void => {
    if (shaderRegistered) return;
    Effect.ShadersStore["waypointRingVertexShader"] = VERTEX_SHADER;
    Effect.ShadersStore["waypointRingFragmentShader"] = FRAGMENT_SHADER;
    shaderRegistered = true;
};

/**
 * ウェイポイントリング用の ShaderMaterial を作成する。
 * @param scene Babylon.js シーン
 * @param id マテリアルに付与するユニーク名
 */
export const createWaypointMaterial = (scene: Scene, id: string): ShaderMaterial => {
    ensureShaderRegistered();

    const mat = new ShaderMaterial(
        `waypointMat_${id}`,
        scene,
        { vertex: "waypointRing", fragment: "waypointRing" },
        {
            attributes: ["position", "uv"],
            uniforms: ["worldViewProjection", "uTime"],
        },
    );
    mat.backFaceCulling = false;
    mat.alpha = 0.9;
    mat.setFloat("uTime", 0);
    return mat;
};

/**
 * 毎フレーム呼び出してシェーダーの時間 uniform を更新する。
 * @param material createWaypointMaterial で作成したマテリアル
 * @param time 経過時間 (秒)
 */
export const updateWaypointMaterialTime = (material: ShaderMaterial, time: number): void => {
    material.setFloat("uTime", time);
};
