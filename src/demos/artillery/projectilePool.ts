/**
 * 砲弾メッシュプール (Issue #259)
 *
 * 砲弾を Havok 物理エンジンで飛ばす。重力・地形コリジョン・バウンドはすべて
 * Havok が計算する（手動パラボラではない）。地形コリジョンは terrainCollider.ts の
 * 静的メッシュボディが担当し、砲弾はそれに衝突法線込みで自然にバウンドする。
 *
 * メッシュはプールで再利用し、物理ボディ (PhysicsAggregate) は発射ごとに
 * 生成・破棄する（ターン制で発射頻度が低いためコストは問題にならず、
 * 物理状態のリセット漏れによるバグを避けられる）。
 */
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

export interface Projectile {
    mesh: Mesh;
    active: boolean;
    spawnTime: number;
    /** 物理ボディ（発射ごとに生成・破棄） */
    aggregate: PhysicsAggregate | null;
    /** 発射位置（飛距離計測・デバッグ用） */
    launchPos: Vector3;
}

export const PROJECTILE_RADIUS = 25;

/** 砲弾の質量 */
const PROJECTILE_MASS = 1;
/** 砲弾の反発係数（地面の値と合成されてバウンドの強さが決まる） */
const PROJECTILE_RESTITUTION = 0.6;
/** 砲弾の摩擦係数 */
const PROJECTILE_FRICTION = 0.4;

/** 砲弾が自動非表示になるまでの秒数 */
export const PROJECTILE_LIFETIME_SEC = 8;

export interface ProjectilePool {
    /** 砲弾を発射する。position に出現し velocity の初速で飛ぶ。 */
    acquire: (position: Vector3, velocity: Vector3) => Projectile;
    release: (projectile: Projectile) => void;
    /** 毎フレーム呼ぶ: 寿命管理（物理積分は Havok が自動で行う） */
    tick: (now: number) => void;
    getActive: () => Projectile[];
    dispose: () => void;
}

export const createProjectilePool = (
    scene: Scene,
    /** 砲弾メッシュ生成時のコールバック（影のキャスター登録などに使う） */
    onMeshCreated?: (mesh: Mesh) => void,
): ProjectilePool => {
    const pool: Projectile[] = [];
    const material = new StandardMaterial("projectile-mat", scene);
    material.diffuseColor = new Color3(0.2, 0.2, 0.2);
    material.specularColor = new Color3(0.5, 0.5, 0.5);

    let counter = 0;

    const createNew = (): Projectile => {
        const mesh = MeshBuilder.CreateSphere(
            `projectile-${counter++}`,
            { diameter: PROJECTILE_RADIUS * 2 },
            scene,
        );
        mesh.material = material;
        mesh.setEnabled(false);
        onMeshCreated?.(mesh);

        const projectile: Projectile = {
            mesh,
            active: false,
            spawnTime: 0,
            aggregate: null,
            launchPos: Vector3.Zero(),
        };
        pool.push(projectile);
        return projectile;
    };

    const destroyBody = (p: Projectile): void => {
        if (p.aggregate) {
            p.aggregate.dispose();
            p.aggregate = null;
        }
    };

    const acquire = (position: Vector3, velocity: Vector3): Projectile => {
        let projectile = pool.find((p) => !p.active);
        if (!projectile) {
            projectile = createNew();
        }

        destroyBody(projectile);

        projectile.active = true;
        projectile.spawnTime = performance.now() / 1000;
        projectile.mesh.setEnabled(true);
        projectile.mesh.position.copyFrom(position);
        projectile.mesh.rotationQuaternion = Quaternion.Identity();
        projectile.launchPos.copyFrom(position);

        // 物理ボディを生成し初速を与える。重力・コリジョン・バウンドは Havok が担当。
        const aggregate = new PhysicsAggregate(
            projectile.mesh,
            PhysicsShapeType.SPHERE,
            {
                mass: PROJECTILE_MASS,
                restitution: PROJECTILE_RESTITUTION,
                friction: PROJECTILE_FRICTION,
            },
            scene,
        );
        aggregate.body.setLinearVelocity(velocity);
        // 空気抵抗による減速を無効化（射程が縮まないように）
        aggregate.body.setLinearDamping(0);
        aggregate.body.setAngularDamping(0);
        projectile.aggregate = aggregate;

        if (
            process.env.NODE_ENV !== "production" &&
            typeof window !== "undefined" &&
            (window as unknown as { __ARTILLERY_DEBUG?: boolean }).__ARTILLERY_DEBUG === true
        ) {
            const applied = aggregate.body.getLinearVelocity();
            console.debug(
                `[artillery] SET vel=(${velocity.x.toFixed(1)}, ${velocity.y.toFixed(1)}, ${velocity.z.toFixed(1)}) |v|=${velocity.length().toFixed(1)} ` +
                    `→ applied=(${applied.x.toFixed(1)}, ${applied.y.toFixed(1)}, ${applied.z.toFixed(1)}) |v|=${applied.length().toFixed(1)}`,
            );
        }

        return projectile;
    };

    const release = (projectile: Projectile): void => {
        if (
            process.env.NODE_ENV !== "production" &&
            typeof window !== "undefined" &&
            (window as unknown as { __ARTILLERY_DEBUG?: boolean }).__ARTILLERY_DEBUG === true
        ) {
            const dx = projectile.mesh.position.x - projectile.launchPos.x;
            const dz = projectile.mesh.position.z - projectile.launchPos.z;
            const range = Math.sqrt(dx * dx + dz * dz);
            console.debug(
                `[artillery] LAND range=${range.toFixed(0)} ` +
                    `from=(${projectile.launchPos.x.toFixed(0)}, ${projectile.launchPos.z.toFixed(0)}) ` +
                    `to=(${projectile.mesh.position.x.toFixed(0)}, ${projectile.mesh.position.z.toFixed(0)})`,
            );
        }
        destroyBody(projectile);
        projectile.active = false;
        projectile.mesh.setEnabled(false);
    };

    const tick = (now: number): void => {
        const nowSec = now / 1000;
        for (const p of pool) {
            if (!p.active) continue;
            if (nowSec - p.spawnTime > PROJECTILE_LIFETIME_SEC) {
                release(p);
            }
        }
    };

    const getActive = (): Projectile[] => pool.filter((p) => p.active);

    const dispose = (): void => {
        for (const p of pool) {
            destroyBody(p);
            p.mesh.dispose();
        }
        pool.length = 0;
        material.dispose();
    };

    return { acquire, release, tick, getActive, dispose };
};
