/**
 * 砲弾バウンド用の地形コリジョンメッシュ (Issue #259)
 *
 * 地形タイル (`tile-ground-*`) はストリーミングで動的にロード・頂点更新されるため、
 * 個々のタイルへ Havok 物理ボディを直接付与すると陳腐化して脆弱になる。
 *
 * そこで「プレイエリアの可視地形を 1 枚のグリッドメッシュにサンプリングし、
 * それに静的 Havok ボディを付ける」ことでストリーミングから分離する。
 * 砲弾はこの不可視コリジョンメッシュに衝突し、Havok が衝突法線込みで
 * 正しくバウンドを計算する（斜面でも自然な反射）。
 */
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

export interface TerrainColliderOptions {
    /** プレイエリアの一辺の長さ (ワールド単位)。中心は原点 */
    areaSize: number;
    /** グリッド分割数（多いほど地形に忠実だがサンプリングが重い） */
    subdivisions: number;
    /** 地面の反発係数 */
    restitution: number;
    /** 地面の摩擦係数 */
    friction: number;
}

export const DEFAULT_COLLIDER_OPTIONS: TerrainColliderOptions = {
    areaSize: 3000,
    subdivisions: 100,
    restitution: 0.5,
    friction: 0.6,
};

export interface TerrainCollider {
    /**
     * 地形をサンプリングし直してコリジョンメッシュ＆物理ボディを再構築する。
     * @param sampleY ワールド (x, z) の地表 Y を返す。取得不可なら null。
     * @returns サンプリング成功率 (0–1)。地形未ロード時は低くなる。
     */
    rebuild(sampleY: (x: number, z: number) => number | null): number;
    dispose(): void;
}

export const createTerrainCollider = (
    scene: Scene,
    options: TerrainColliderOptions = DEFAULT_COLLIDER_OPTIONS,
): TerrainCollider => {
    const { areaSize, subdivisions, restitution, friction } = options;

    const mesh: Mesh = CreateGround(
        "artillery-collider",
        { width: areaSize, height: areaSize, subdivisions, updatable: true },
        scene,
    );
    // 不可視だがジオメトリは保持（物理形状の元になる）
    mesh.isVisible = false;
    mesh.isPickable = false;

    let aggregate: PhysicsAggregate | null = null;

    const rebuild = (sampleY: (x: number, z: number) => number | null): number => {
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (!positions) return 0;

        let hitCount = 0;
        const vertexCount = positions.length / 3;
        let lastValidY = 0;

        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const z = positions[i + 2];
            const y = sampleY(x, z);
            if (y !== null) {
                positions[i + 1] = y;
                lastValidY = y;
                hitCount++;
            } else {
                // 未ロード等で取得失敗 → 直近の有効値で穴埋め（穴あきメッシュを避ける）
                positions[i + 1] = lastValidY;
            }
        }

        mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
        mesh.createNormals(false);
        mesh.refreshBoundingInfo();

        // 旧ボディを破棄して作り直す（頂点が変わったため形状を更新）
        if (aggregate) {
            aggregate.dispose();
            aggregate = null;
        }
        aggregate = new PhysicsAggregate(
            mesh,
            PhysicsShapeType.MESH,
            { mass: 0, restitution, friction },
            scene,
        );

        return vertexCount > 0 ? hitCount / vertexCount : 0;
    };

    const dispose = (): void => {
        if (aggregate) {
            aggregate.dispose();
            aggregate = null;
        }
        mesh.dispose();
    };

    return { rebuild, dispose };
};
