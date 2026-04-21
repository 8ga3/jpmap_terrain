/** 地形メッシュのオブジェクトプール */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

export interface MeshPool {
    acquire(): Mesh;
    release(mesh: Mesh): void;
    dispose(): void;
    readonly activeCount: number;
    readonly pooledCount: number;
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
            scene
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
            mesh.setEnabled(true);
            active.add(mesh);
            return mesh;
        },

        release(mesh: Mesh): void {
            if (!active.has(mesh)) return;
            active.delete(mesh);
            mesh.setEnabled(false);
            // テクスチャを解放、diffuseColor をリセット
            const mat = mesh.material as StandardMaterial | null;
            if (mat) {
                if (mat.diffuseTexture) {
                    mat.diffuseTexture.dispose();
                    mat.diffuseTexture = null;
                }
                mat.diffuseColor = Color3.White();
            }
            pool.push(mesh);
        },

        dispose(): void {
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
    };
};
