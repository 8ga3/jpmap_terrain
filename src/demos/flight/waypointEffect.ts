/**
 * ウェイポイント通過エフェクト — パーティクル爆発 (Issue #274)。
 *
 * 飛行機がリングを通過したとき、短時間のバースト（ゴールド→白）を放射する。
 */

import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * 8×8 の白い円 PNG を base64 でインライン化。
 * パーティクルテクスチャとして使用する。
 */
const PARTICLE_TEXTURE_BASE64 =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAA" +
    "RElEQVQYV2P8////fwYGBgZGRkYGBgYGBkYQDWJgYMDCgHKA" +
    "LIZkMJgNEmBgYGBkAAlAaJACSAAkAGIzMEJNAQkAAHHJDQkd" +
    "hBG8AAAAAElFTkSuQmCC";

/**
 * ウェイポイント通過時のパーティクルバーストエフェクトを作成・開始する。
 *
 * エフェクトは `targetStopDuration` 後に自動停止し、
 * `disposeOnStop = true` で自動破棄される。
 *
 * @param scene Babylon.js シーン
 * @param position エフェクト発生のワールド座標
 * @returns 作成された ParticleSystem（自動停止・自動破棄）
 */
export const createPassEffect = (scene: Scene, position: Vector3): ParticleSystem => {
    const ps = new ParticleSystem("wpPassEffect", 200, scene);

    // テクスチャ
    ps.particleTexture = new Texture(PARTICLE_TEXTURE_BASE64, scene);

    // 発生位置
    ps.emitter = position;

    // 放射方向: 全方位球状
    ps.minEmitBox = new Vector3(-1, -1, -1);
    ps.maxEmitBox = new Vector3(1, 1, 1);

    // カラーグラデーション: ゴールド → 白
    ps.color1 = new Color4(1.0, 0.85, 0.2, 1.0);
    ps.color2 = new Color4(1.0, 0.95, 0.6, 1.0);
    ps.colorDead = new Color4(1.0, 1.0, 1.0, 0.0);

    // サイズ（大きめで派手に）
    ps.minSize = 3;
    ps.maxSize = 8;

    // ライフタイム
    ps.minLifeTime = 0.2;
    ps.maxLifeTime = 0.5;

    // 放射速度
    ps.minEmitPower = 30;
    ps.maxEmitPower = 80;

    // 放出レート (バースト風: 短時間に大量)
    ps.emitRate = 600;

    // 重力なし
    ps.gravity = new Vector3(0, 0, 0);

    // 自動停止 & 破棄
    ps.targetStopDuration = 0.3;
    ps.disposeOnStop = true;

    // 開始
    ps.start();

    return ps;
};
