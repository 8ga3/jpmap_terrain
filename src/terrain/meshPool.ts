/** 地形メッシュのオブジェクトプール */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

/**
 * 太陽影描画のための caster / receiver 設定フック。
 *
 * `MeshPool.acquire` 直後と `release` 直前に呼ばれる。`ShadowGenerator` の
 * `addShadowCaster` / `removeShadowCaster` と `mesh.receiveShadows` の切替を集約する。
 */
export interface ShadowHooks {
    /** メッシュがアクティブ化された直後に呼ばれる（caster 登録 + receiveShadows=true） */
    onAcquire(mesh: Mesh): void;
    /** メッシュがプールへ戻される直前に呼ばれる（caster 解除 + receiveShadows=false） */
    onRelease(mesh: Mesh): void;
}

export interface MeshPool {
    acquire(): Mesh;
    release(mesh: Mesh): void;
    dispose(): void;
    readonly activeCount: number;
    readonly pooledCount: number;
    /**
     * 影 caster / receiver 設定フックを差し替える。
     * `null` を渡すとフック解除。設定済みフックは差し替え時には自動解除されないため、
     * 既存メッシュへの一括反映は呼び出し側で {@link MeshPool.forEachActive} を併用する。
     */
    setShadowHooks(hooks: ShadowHooks | null): void;
    /** 現在アクティブな（acquire 中の）全メッシュを列挙する。OFF→ON 切替時の一括適用用途 */
    forEachActive(cb: (mesh: Mesh) => void): void;
}

export interface MeshPoolOptions {
    scene: Scene;
    subdivisions: number;
    tileSize: number;
}

let meshSeq = 0;

export const createMeshPool = (opts: MeshPoolOptions): MeshPool => {
    const { scene, subdivisions, tileSize } = opts;
    const pool: Mesh[] = [];
    const active = new Set<Mesh>();
    let shadowHooks: ShadowHooks | null = null;

    const createNewMesh = (): Mesh => {
        const id = meshSeq++;
        const mesh = CreateGround(
            `tile-ground-${id}`,
            {
                width: tileSize,
                height: tileSize,
                subdivisions,
                updatable: true,
            },
            scene,
        );
        const mat = new StandardMaterial(`tile-mat-${id}`, scene);
        mat.specularColor = Color3.Black();
        mesh.material = mat;
        mesh.setEnabled(false);
        return mesh;
    };

    return {
        acquire(): Mesh {
            const mesh = pool.pop() ?? createNewMesh();
            // テクスチャが onLoad で設定されるまで描画しない。
            // diffuseTexture=null のまま描画すると WebGPU で null bind エラーになる。
            mesh.setEnabled(false);
            active.add(mesh);
            shadowHooks?.onAcquire(mesh);
            return mesh;
        },

        release(mesh: Mesh): void {
            if (!active.has(mesh)) return;
            shadowHooks?.onRelease(mesh);
            active.delete(mesh);
            mesh.setEnabled(false);
            // テクスチャを解放 — 同フレームの GPU コマンドバッファがまだ
            // 参照している場合があるため、次フレームまで遅延して破棄する。
            const mat = mesh.material as StandardMaterial | null;
            if (mat?.diffuseTexture) {
                const tex = mat.diffuseTexture;
                mat.diffuseTexture = null;
                setTimeout(() => tex.dispose(), 0);
            }
            pool.push(mesh);
        },

        dispose(): void {
            shadowHooks = null;
            for (const mesh of active) {
                mesh.dispose(false, true);
            }
            for (const mesh of pool) {
                mesh.dispose(false, true);
            }
            active.clear();
            pool.length = 0;
        },

        get activeCount(): number {
            return active.size;
        },

        get pooledCount(): number {
            return pool.length;
        },

        setShadowHooks(hooks: ShadowHooks | null): void {
            shadowHooks = hooks;
        },

        forEachActive(cb: (mesh: Mesh) => void): void {
            for (const mesh of active) {
                cb(mesh);
            }
        },
    };
};
