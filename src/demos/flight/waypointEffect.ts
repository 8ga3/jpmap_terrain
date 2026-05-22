/**
 * ウェイポイント通過エフェクト — 多層パーティクル爆発 (Issue #274)。
 *
 * 4 種類の ParticleSystem を同時に発火させて派手な爆発を演出する。
 * - core    : 中心爆発（ゴールド/白）
 * - shock   : 衝撃波リング（円盤状に広がる青白い輝き）
 * - sparks  : スパーク（細く高速で飛び散る輝点）
 * - sparkle : キラキラ漂う星屑（虹色）
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
 * パーティクルテクスチャを生成する。
 * ParticleSystem の dispose で Texture も破棄されるため共有しない。
 */
const createParticleTexture = (scene: Scene): Texture =>
    new Texture(PARTICLE_TEXTURE_BASE64, scene);

interface ParticleConfig {
    name: string;
    capacity: number;
    color1: Color4;
    color2: Color4;
    colorDead: Color4;
    minSize: number;
    maxSize: number;
    minLifeTime: number;
    maxLifeTime: number;
    minEmitPower: number;
    maxEmitPower: number;
    emitRate: number;
    duration: number;
    emitBoxMin: Vector3;
    emitBoxMax: Vector3;
    gravity?: Vector3;
}

const createPS = (scene: Scene, position: Vector3, cfg: ParticleConfig): ParticleSystem => {
    const ps = new ParticleSystem(cfg.name, cfg.capacity, scene);
    ps.particleTexture = createParticleTexture(scene);
    ps.emitter = position;
    ps.minEmitBox = cfg.emitBoxMin;
    ps.maxEmitBox = cfg.emitBoxMax;
    ps.color1 = cfg.color1;
    ps.color2 = cfg.color2;
    ps.colorDead = cfg.colorDead;
    ps.minSize = cfg.minSize;
    ps.maxSize = cfg.maxSize;
    ps.minLifeTime = cfg.minLifeTime;
    ps.maxLifeTime = cfg.maxLifeTime;
    ps.minEmitPower = cfg.minEmitPower;
    ps.maxEmitPower = cfg.maxEmitPower;
    ps.emitRate = cfg.emitRate;
    ps.gravity = cfg.gravity ?? new Vector3(0, 0, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.targetStopDuration = cfg.duration;
    ps.disposeOnStop = true;
    ps.start();
    return ps;
};

/**
 * ウェイポイント通過時の派手な爆発エフェクトを発火する。
 * 複数の ParticleSystem を同時起動し、全て自動停止・破棄される。
 */
export const createPassEffect = (scene: Scene, position: Vector3): ParticleSystem => {
    // ① 中心爆発 — ゴールド/白の大きな閃光
    const core = createPS(scene, position, {
        name: "wpPass_core",
        capacity: 400,
        emitBoxMin: new Vector3(-1, -1, -1),
        emitBoxMax: new Vector3(1, 1, 1),
        color1: new Color4(1.0, 0.9, 0.3, 1.0),
        color2: new Color4(1.0, 1.0, 0.8, 1.0),
        colorDead: new Color4(1.0, 0.6, 0.2, 0.0),
        minSize: 4,
        maxSize: 12,
        minLifeTime: 0.3,
        maxLifeTime: 0.7,
        minEmitPower: 40,
        maxEmitPower: 110,
        emitRate: 1200,
        duration: 0.25,
    });

    // ② 衝撃波 — 横方向（XZ平面）に広がる青白いリング
    createPS(scene, position, {
        name: "wpPass_shock",
        capacity: 300,
        emitBoxMin: new Vector3(-1, -0.05, -1),
        emitBoxMax: new Vector3(1, 0.05, 1),
        color1: new Color4(0.3, 0.8, 1.0, 1.0),
        color2: new Color4(0.8, 0.9, 1.0, 1.0),
        colorDead: new Color4(0.2, 0.4, 1.0, 0.0),
        minSize: 6,
        maxSize: 16,
        minLifeTime: 0.4,
        maxLifeTime: 0.8,
        minEmitPower: 80,
        maxEmitPower: 150,
        emitRate: 800,
        duration: 0.2,
    });

    // ③ スパーク — 高速で遠くまで飛ぶ細い輝点
    createPS(scene, position, {
        name: "wpPass_sparks",
        capacity: 500,
        emitBoxMin: new Vector3(-0.5, -0.5, -0.5),
        emitBoxMax: new Vector3(0.5, 0.5, 0.5),
        color1: new Color4(1.0, 1.0, 1.0, 1.0),
        color2: new Color4(1.0, 0.9, 0.6, 1.0),
        colorDead: new Color4(1.0, 0.5, 0.2, 0.0),
        minSize: 1,
        maxSize: 3,
        minLifeTime: 0.5,
        maxLifeTime: 1.2,
        minEmitPower: 100,
        maxEmitPower: 200,
        emitRate: 1500,
        duration: 0.3,
        gravity: new Vector3(0, -20, 0),
    });

    // ④ キラキラ — ゆっくり漂う星屑（虹色・長寿命）
    createPS(scene, position, {
        name: "wpPass_sparkle",
        capacity: 200,
        emitBoxMin: new Vector3(-1, -1, -1),
        emitBoxMax: new Vector3(1, 1, 1),
        color1: new Color4(1.0, 0.4, 0.9, 1.0),
        color2: new Color4(0.4, 0.9, 1.0, 1.0),
        colorDead: new Color4(0.8, 0.4, 1.0, 0.0),
        minSize: 2,
        maxSize: 5,
        minLifeTime: 1.0,
        maxLifeTime: 2.0,
        minEmitPower: 15,
        maxEmitPower: 50,
        emitRate: 400,
        duration: 0.4,
        gravity: new Vector3(0, -5, 0),
    });

    return core;
};
