/**
 * 爆発エフェクト (Issue #259)
 *
 * ParticleSystem を使った爆発演出。
 */
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * 指定位置に爆発パーティクルを発生させる。
 * 一定時間で自動停止・dispose する。
 */
export const createExplosion = (
    scene: Scene,
    position: Vector3,
): ParticleSystem => {
    const ps = new ParticleSystem("explosion", 200, scene);

    // テクスチャなし（丸い既定パーティクル）
    ps.particleTexture = new Texture(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c4xDQAgDAXRDi5O8O8EC0hgDAYqQDLLvOSWf7oGzN8pAAUgAIBfKAAFIACAXygABSAAgF8oAAUgAIBfKAAFIACAXygABSAAgF8oAAUgAIBfKAAFIAAA/kfEA1LfAZcl6wplAAAAAElFTkSuQmCC",
        scene,
    );

    ps.emitter = position.clone();
    ps.minEmitBox = new Vector3(-2, -2, -2);
    ps.maxEmitBox = new Vector3(2, 2, 2);

    ps.color1 = new Color4(1.0, 0.5, 0.0, 1.0);
    ps.color2 = new Color4(1.0, 0.2, 0.0, 1.0);
    ps.colorDead = new Color4(0.3, 0.3, 0.3, 0.0);

    ps.minSize = 3;
    ps.maxSize = 8;

    ps.minLifeTime = 0.3;
    ps.maxLifeTime = 0.8;

    ps.emitRate = 500;

    ps.direction1 = new Vector3(-20, 20, -20);
    ps.direction2 = new Vector3(20, 40, 20);

    ps.gravity = new Vector3(0, -30, 0);

    ps.minEmitPower = 10;
    ps.maxEmitPower = 30;

    ps.updateSpeed = 0.02;

    ps.start();

    // 自動停止
    setTimeout(() => {
        ps.stop();
        setTimeout(() => {
            ps.dispose();
        }, 1000);
    }, 300);

    return ps;
};
