/**
 * ウェイポイント通過エフェクト — 小粒パーティクルの軽快な弾け (Issue #274)。
 *
 * 全方位に小さな輝点を短時間放射し、すぐに消える「シャラッ」とした演出。
 */

import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/** 8×8 の白い円 PNG (パーティクルテクスチャ) */
const PARTICLE_TEXTURE_BASE64 =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAA" +
    "RElEQVQYV2P8////fwYGBgZGRkYGBgYGBkYQDWJgYMDCgHKA" +
    "LIZkMJgNEmBgYGBkAAlAaJACSAAkAGIzMEJNAQkAAHHJDQkd" +
    "hBG8AAAAAElFTkSuQmCC";

/**
 * ウェイポイント通過時の小粒パーティクル弾けエフェクト。
 * 自動停止・自動破棄。
 */
export const createPassEffect = (scene: Scene, position: Vector3): ParticleSystem => {
    const ps = new ParticleSystem("wpPassEffect", 120, scene);

    ps.particleTexture = new Texture(PARTICLE_TEXTURE_BASE64, scene);
    ps.emitter = position;

    // 全方位に小さく放射
    ps.minEmitBox = new Vector3(-0.5, -0.5, -0.5);
    ps.maxEmitBox = new Vector3(0.5, 0.5, 0.5);

    // カラー: 白〜薄いシアン (魔法陣のカラーに合わせる)
    ps.color1 = new Color4(1.0, 1.0, 1.0, 1.0);
    ps.color2 = new Color4(0.6, 0.9, 1.0, 1.0);
    ps.colorDead = new Color4(0.4, 0.7, 1.0, 0.0);

    // 小さなパーティクル
    ps.minSize = 0.8;
    ps.maxSize = 2.0;

    // 短いライフタイム
    ps.minLifeTime = 0.2;
    ps.maxLifeTime = 0.5;

    // 中速で弾ける
    ps.minEmitPower = 20;
    ps.maxEmitPower = 50;

    ps.emitRate = 600;
    ps.gravity = new Vector3(0, 0, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    // 短い発火時間で「シャラッ」と消える
    ps.targetStopDuration = 0.1;
    ps.disposeOnStop = true;

    ps.start();
    return ps;
};
