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
 * 参照によりサンプリングは安価なため、頂点数増（40,401）でも数十ms以下で構築
 * できる。
 */
export const DEFAULT_COLLIDER_OPTIONS: TerrainColliderOptions = {
    areaSize: 6000,
    subdivisions: 200,
    restitution: 0.5,
    friction: 0.6,
};

/**
 * コライダーのサンプリング（レイキャストフォールバック）対象とする地形メッシュ名か判定する。
 *
 * globe の LOD 地形タイルは `tile-*`、planar の地形タイルは `tile-ground-*` で、いずれも
 * 実標高のジオメトリを持つ。一方 `base-tile-*` は globeTileManager が常時表示する粗い
 * ベースレイヤ（zoom=2 / 標高を持たない海面平坦メッシュ）であり、地形ではない。
 *
 * これを対象に含めると、プレイエリア外縁のように細かい地形タイルが未ロードの座標で
 * レイがベースレイヤにヒットし、実地形と無関係な Y（実測で -202m。周囲は 700m 超）を
 * **非 null** で返す。呼び出し側はサンプリング成功として扱うため誤りに気付けず、
 * 可視地形とズレた位置で砲弾が跳ねる。そのため名前で明示的に除外する。
 */
export const isColliderTerrainMeshName = (name: string): boolean =>
    name.startsWith("tile-") && !name.startsWith("base-tile-");

/**
 * サンプリングできなかった頂点（`NaN`）を、有効な近傍頂点の平均で波状（BFS）に埋める。
 *
 * 走査順の直前値で埋めると、穴が列方向に広がった場合に隣接頂点間で大きな段差
 * （実測で最大 1,197m / 30m 間隔）が生じ、砲弾が不自然に跳ねる。近傍平均で埋めることで
 * 穴の周囲となだらかに接続する。
 *
 * @param heights row-major の高さ配列（長さ `width * height`）。`NaN` が穴。
 * @returns 埋め残した頂点数（有効値が 1 つも無い場合は全頂点数）。
 */
export const fillMissingHeights = (
    heights: Float32Array,
    width: number,
    height: number,
): number => {
    const size = width * height;
    let remaining = 0;
    for (let i = 0; i < size; i++) if (Number.isNaN(heights[i])) remaining++;
    // 穴が無い / 全面が穴（有効値ゼロでシードが作れない）ならこれ以上できることはない。
    if (remaining === 0 || remaining === size) return remaining;

    // 各頂点が「どの波でキューへ入ったか」。波番号で管理することで、波ごとに
    // 訪問済みフラグを再確保せず重複エンキューを防ぐ（重複を許すとキューが
    // 頂点数の 8 倍ずつ膨らみ続ける）。
    const queuedWave = new Int32Array(size).fill(-1);
    let wave = 0;
    let frontier: number[] = [];
    for (let i = 0; i < size; i++) {
        if (!Number.isNaN(heights[i])) continue;
        const x = i % width;
        const y = (i - x) / width;
        if (!hasValidNeighbor(heights, width, height, x, y)) continue;
        frontier.push(i);
        queuedWave[i] = wave;
    }

    // 同一波内の埋め結果が同波の他頂点へ伝播しないよう、値を算出してから一括で書き戻す。
    while (frontier.length > 0) {
        const values = new Float64Array(frontier.length);
        let filledCount = 0;
        for (let k = 0; k < frontier.length; k++) {
            const idx = frontier[k];
            const x = idx % width;
            const y = (idx - x) / width;
            let sum = 0;
            let n = 0;
            for (const [dx, dy] of NEIGHBOR_OFFSETS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const v = heights[ny * width + nx];
                if (Number.isNaN(v)) continue;
                sum += v;
                n++;
            }
            values[k] = n > 0 ? sum / n : NaN;
            if (n > 0) filledCount++;
        }
        if (filledCount === 0) break; // これ以上埋められない

        for (let k = 0; k < frontier.length; k++) {
            if (Number.isNaN(values[k])) continue;
            heights[frontier[k]] = values[k];
            remaining--;
        }
        if (remaining === 0) break;

        wave++;
        const next: number[] = [];
        for (let k = 0; k < frontier.length; k++) {
            const idx = frontier[k];
            const x = idx % width;
            const y = (idx - x) / width;
            for (const [dx, dy] of NEIGHBOR_OFFSETS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const nIdx = ny * width + nx;
                if (!Number.isNaN(heights[nIdx])) continue;
                if (queuedWave[nIdx] === wave) continue;
                queuedWave[nIdx] = wave;
                next.push(nIdx);
            }
        }
        frontier = next;
    }
    return remaining;
};

const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
];

const hasValidNeighbor = (
    heights: Float32Array,
    width: number,
    height: number,
    x: number,
    y: number,
): boolean => {
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (!Number.isNaN(heights[ny * width + nx])) return true;
    }
    return false;
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
        // 1 パス目: サンプリング結果を格納する（取得できなかった頂点は NaN で穴として残す）。
        // 走査順の直前値で即座に埋めると穴の縁で大きな段差が生じるため、2 パス目の
        // 近傍平均補間（`fillMissingHeights`）に委ねる。
        const gridSize = subdivisions + 1;
        const heights = new Float32Array(vertexCount);

        // サンプリング（レイキャスト）はメインスレッドを長時間占有しうるため、フレーム時間
        // 予算ごとに setTimeout(0) で制御を返し、ブラウザの遷移・入力処理を妨げない。
        let chunkStart = performance.now();
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const z = positions[i + 2];
            const y = sampleY(x, z);
            if (y !== null) {
                heights[i / 3] = y;
                hitCount++;
            } else {
                heights[i / 3] = NaN;
            }
            if (performance.now() - chunkStart >= frameBudgetMs) {
                if (shouldAbort?.()) return null;
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (shouldAbort?.()) return null;
                chunkStart = performance.now();
            }
        }

        // 2 パス目: 穴を近傍平均で埋める。有効値が 1 つも無い場合は埋められないため 0 に倒す。
        fillMissingHeights(heights, gridSize, gridSize);
        for (let v = 0; v < vertexCount; v++) {
            const y = heights[v];
            positions[v * 3 + 1] = Number.isNaN(y) ? 0 : y;
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
