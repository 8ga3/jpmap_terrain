/**
 * 砲弾バウンド用の地形コリジョンメッシュ
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

/**
 * 既定のコライダー設定。
 *
 * `areaSize` はコライダーグリッドの一辺（中心 = ステージ原点）。砲弾の最大水平射程は
 * 45° / 初速 600 m/s / 重力 180 m/s² で約 2000m（`v²·sin(2θ)/g`）。砲台はステージ
 * 原点から ±750m に置かれるため、最遠方位（東西へ真っ直ぐ）では着弾点が原点から
 * 約 2750m に達する。コライダーがこれを覆わないと最遠弾が地形を貫通してバウンド
 * しないため、半幅 3000m（`areaSize=6000`, 余裕 250m）でプレイエリア全域を覆う。
 *
 * `subdivisions=200` でセル ≈ 30m を維持（近接弾のバウンド精度を保つ）。標高ダイレクト
 * 参照（#436）によりサンプリングは安価なため、頂点数増（40,401）でも数十ms以下で構築
 * できる。
 */
export const DEFAULT_COLLIDER_OPTIONS: TerrainColliderOptions = {
    areaSize: 6000,
    subdivisions: 200,
    restitution: 0.5,
    friction: 0.6,
};

export interface TerrainCollider {
    /**
     * 地形をサンプリングし直してコリジョンメッシュ＆物理ボディを再構築する。
     *
     * サンプリング（頂点ごとのレイキャスト）は重く、グリッド全体を一度に処理すると
     * メインスレッドを長時間ブロックしてページ遷移（戻る操作）を妨げる。これを避けるため
     * フレーム時間予算ごとに処理を分割し、各区切りで `setTimeout(0)` により制御を返す。
     * 区切りごとに `shouldAbort` を確認し、中断要求があれば即座に処理を打ち切る。
     *
     * @param sampleY ワールド (x, z) の地表 Y を返す。取得不可なら null。
     * @param opts.shouldAbort true を返すと構築を中断する（離脱検知時など）。
     * @param opts.frameBudgetMs 1 区切りあたりの処理時間予算 [ms]（既定 8）。
     * @returns サンプリング成功率 (0–1)。中断された場合は null。
     */
    rebuild(
        sampleY: (x: number, z: number) => number | null,
        opts?: { shouldAbort?: () => boolean; frameBudgetMs?: number },
    ): Promise<number | null>;
    dispose(): void;
}

export const createTerrainCollider = (
    scene: Scene,
    options: TerrainColliderOptions = DEFAULT_COLLIDER_OPTIONS,
    /** 生成したコライダーメッシュをステージへ取り込むコールバック（globe で stageRoot へ parent）。 */
    onMeshCreated?: (mesh: Mesh) => void,
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
    onMeshCreated?.(mesh);

    let aggregate: PhysicsAggregate | null = null;

    const rebuild = async (
        sampleY: (x: number, z: number) => number | null,
        opts: { shouldAbort?: () => boolean; frameBudgetMs?: number } = {},
    ): Promise<number | null> => {
        const { shouldAbort } = opts;
        // frameBudgetMs に 0 / 負数 / NaN が渡ると区切り条件が常に真になり、頂点ごとに
        // yield して極端に遅くなる。有限かつ最低 1ms にクランプして事故を防ぐ。
        const frameBudgetMs = Number.isFinite(opts.frameBudgetMs)
            ? Math.max(1, opts.frameBudgetMs as number)
            : 8;
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (!positions) return 0;

        let hitCount = 0;
        const vertexCount = positions.length / 3;
        let lastValidY = 0;

        // サンプリング（レイキャスト）はメインスレッドを長時間占有しうるため、フレーム時間
        // 予算ごとに setTimeout(0) で制御を返し、ブラウザの遷移・入力処理を妨げない。
        let chunkStart = performance.now();
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
            if (performance.now() - chunkStart >= frameBudgetMs) {
                if (shouldAbort?.()) return null;
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (shouldAbort?.()) return null;
                chunkStart = performance.now();
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
