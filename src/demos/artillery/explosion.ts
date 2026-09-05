/**
 * 爆発エフェクト
 *
 * ParticleSystem を複数レイヤー（閃光・火球・煙・火花・衝撃波リング）で
 * 重ねて、命中時に派手な爆発演出を行う。
 */

import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { Scene } from "@babylonjs/core/scene";

/** 既定の丸いパーティクルテクスチャ（白い円・PNG base64）。 */
const PARTICLE_TEXTURE_DATA =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c4xDQAgDAXRDi5O8O8EC0hgDAYqQDLLvOSWf7oGzN8pAAUgAIBfKAAFIACAXygABSAAgF8oAAUgAIBfKAAFIACAXygABSAAgF8oAAUgAIBfKAAFIAAA/kfEA1LfAZcl6wplAAAAAElFTkSuQmCC";

let sharedTexture: Texture | null = null;
const getTexture = (scene: Scene): Texture => {
    if (!sharedTexture || sharedTexture.getScene() !== scene) {
        sharedTexture?.dispose();
        sharedTexture = new Texture(PARTICLE_TEXTURE_DATA, scene);
    }
    return sharedTexture;
};

/** バースト系（一定数を一気に放出して消えるパーティクル）を生成する。 */
const createBurst = (
    scene: Scene,
    name: string,
    position: Vector3,
    opts: {
        capacity: number;
        manualCount: number;
        emitBox: number;
        color1: Color4;
        color2: Color4;
        colorDead: Color4;
        minSize: number;
        maxSize: number;
        minLife: number;
        maxLife: number;
        minPower: number;
        maxPower: number;
        gravityY: number;
        dir1: Vector3;
        dir2: Vector3;
        blendAdd?: boolean;
    },
): ParticleSystem => {
    const ps = new ParticleSystem(name, opts.capacity, scene);
    ps.particleTexture = getTexture(scene);
    ps.emitter = position.clone();
    ps.minEmitBox = new Vector3(-opts.emitBox, -opts.emitBox, -opts.emitBox);
    ps.maxEmitBox = new Vector3(opts.emitBox, opts.emitBox, opts.emitBox);
    ps.color1 = opts.color1;
    ps.color2 = opts.color2;
    ps.colorDead = opts.colorDead;
    ps.minSize = opts.minSize;
    ps.maxSize = opts.maxSize;
    ps.minLifeTime = opts.minLife;
    ps.maxLifeTime = opts.maxLife;
    ps.direction1 = opts.dir1;
    ps.direction2 = opts.dir2;
    ps.gravity = new Vector3(0, opts.gravityY, 0);
    ps.minEmitPower = opts.minPower;
    ps.maxEmitPower = opts.maxPower;
    ps.updateSpeed = 0.02;
    if (opts.blendAdd) {
        ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    }
    // バースト演出: emitRate=0 にして manualEmitCount で一気に放出する
    ps.emitRate = 0;
    ps.manualEmitCount = opts.manualCount;
    return ps;
};

/** 指定時間後に stop → dispose して後片付けする。 */
const autoDispose = (
    ps: ParticleSystem,
    stopMs: number,
    disposeMs: number,
): void => {
    setTimeout(() => {
        ps.stop();
        setTimeout(() => ps.dispose(), disposeMs);
    }, stopMs);
};

/**
 * 指定位置に派手な爆発を発生させる。
 * 閃光・火球・煙・火花・衝撃波リングを重ねて表示し、自動で後片付けする。
 */
export const createExplosion = (
    scene: Scene,
    position: Vector3,
): ParticleSystem => {
    // 1) 中心の閃光（白〜黄、加算合成で一瞬強く光る）
    const flash = createBurst(scene, "explosion-flash", position, {
        capacity: 120,
        manualCount: 120,
        emitBox: 1,
        color1: new Color4(1.0, 1.0, 0.9, 1.0),
        color2: new Color4(1.0, 0.9, 0.5, 1.0),
        colorDead: new Color4(1.0, 0.6, 0.2, 0.0),
        minSize: 8,
        maxSize: 20,
        minLife: 0.12,
        maxLife: 0.28,
        minPower: 30,
        maxPower: 70,
        gravityY: 0,
        dir1: new Vector3(-1, -1, -1),
        dir2: new Vector3(1, 1, 1),
        blendAdd: true,
    });

    // 2) 火球（オレンジ〜赤、上方向に膨らむ）
    const fireball = createBurst(scene, "explosion-fireball", position, {
        capacity: 400,
        manualCount: 360,
        emitBox: 2,
        color1: new Color4(1.0, 0.7, 0.1, 1.0),
        color2: new Color4(1.0, 0.25, 0.0, 1.0),
        colorDead: new Color4(0.4, 0.05, 0.0, 0.0),
        minSize: 4,
        maxSize: 12,
        minLife: 0.4,
        maxLife: 1.1,
        minPower: 18,
        maxPower: 55,
        gravityY: -10,
        dir1: new Vector3(-30, 10, -30),
        dir2: new Vector3(30, 55, 30),
        blendAdd: true,
    });

    // 3) 火花（黄白の細かい粒、四方へ高速飛散）
    const sparks = createBurst(scene, "explosion-sparks", position, {
        capacity: 300,
        manualCount: 240,
        emitBox: 0.5,
        color1: new Color4(1.0, 1.0, 0.6, 1.0),
        color2: new Color4(1.0, 0.8, 0.2, 1.0),
        colorDead: new Color4(1.0, 0.5, 0.0, 0.0),
        minSize: 0.6,
        maxSize: 2.0,
        minLife: 0.3,
        maxLife: 0.9,
        minPower: 60,
        maxPower: 140,
        gravityY: -40,
        dir1: new Vector3(-1, -1, -1),
        dir2: new Vector3(1, 1, 1),
        blendAdd: true,
    });

    // 4) 衝撃波リング（地面付近で水平方向に広がる）
    const shockwave = createBurst(scene, "explosion-shockwave", position, {
        capacity: 160,
        manualCount: 140,
        emitBox: 0.2,
        color1: new Color4(1.0, 0.9, 0.7, 0.8),
        color2: new Color4(1.0, 0.6, 0.3, 0.6),
        colorDead: new Color4(0.6, 0.4, 0.2, 0.0),
        minSize: 3,
        maxSize: 7,
        minLife: 0.3,
        maxLife: 0.6,
        minPower: 80,
        maxPower: 130,
        gravityY: 0,
        dir1: new Vector3(-1, 0.02, -1),
        dir2: new Vector3(1, 0.12, 1),
        blendAdd: true,
    });

    // 5) 煙（灰色、ゆっくり上昇しながら消える）
    const smoke = createBurst(scene, "explosion-smoke", position, {
        capacity: 220,
        manualCount: 180,
        emitBox: 2,
        color1: new Color4(0.35, 0.33, 0.3, 0.8),
        color2: new Color4(0.18, 0.17, 0.16, 0.7),
        colorDead: new Color4(0.1, 0.1, 0.1, 0.0),
        minSize: 8,
        maxSize: 22,
        minLife: 0.9,
        maxLife: 2.0,
        minPower: 6,
        maxPower: 20,
        gravityY: 6,
        dir1: new Vector3(-12, 8, -12),
        dir2: new Vector3(12, 30, 12),
    });

    for (const ps of [flash, fireball, sparks, shockwave, smoke]) {
        ps.start();
    }

    autoDispose(flash, 60, 600);
    autoDispose(sparks, 80, 1200);
    autoDispose(shockwave, 80, 900);
    autoDispose(fireball, 120, 1500);
    autoDispose(smoke, 200, 2500);

    // 互換のため代表として fireball を返す
    return fireball;
};
