/**
 * 箱庭ジオラマの側面壁・底面（土台）の生成。
 *
 * 地形メッシュ（上面）単体だと平面な布のように浮いて見え、水平（基準面）が
 * 把握しにくい。実物のジオラマ模型（切り出した地層ブロック）のように、外周
 * リングから一定深さ下へ側面壁を張り、底面で閉じることで解決する。
 * 上面メッシュ（`dioramaGrid`/`dioramaTerrain`）とは別の `Mesh`・別材質
 * （土色）として構築する想定の、純粋なジオメトリ生成関数。
 */
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";

/** 側面壁・底面のジオメトリ（Babylon `VertexData` へそのまま渡せる形）。 */
export interface DioramaSkirtGeometry {
    positions: Float32Array;
    indices: Uint32Array;
    normals: Float32Array;
}

/** 側面壁の上端に使う頂点（ローカル平面座標 + 標高）。 */
export interface DioramaSkirtRingPoint {
    x: number;
    y: number;
    z: number;
}

/**
 * 外周リングの頂点列（`buildDioramaGridPoints` の角度順、時計回り）と底面の高さ
 * (`baseY`) から、側面壁 + 底面（中心からの扇形）のジオメトリを構築する。
 *
 * 頂点レイアウト: `[0..n-1]` = 側面壁の上端（外周リングと同位置）、
 * `[n..2n-1]` = 側面壁の下端（同 x,z・y=baseY）、`[2n]` = 底面中心。
 */
export const buildDioramaSkirtGeometry = (
    outerRing: readonly DioramaSkirtRingPoint[],
    baseY: number,
): DioramaSkirtGeometry => {
    const n = outerRing.length;
    if (n < 3) {
        throw new RangeError(`outerRing must have >= 3 points (got ${n})`);
    }

    const vertexCount = n * 2 + 1;
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < n; i++) {
        const p = outerRing[i];
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
        positions[(n + i) * 3] = p.x;
        positions[(n + i) * 3 + 1] = baseY;
        positions[(n + i) * 3 + 2] = p.z;
    }
    const bottomCenterIndex = n * 2;
    positions[bottomCenterIndex * 3] = 0;
    positions[bottomCenterIndex * 3 + 1] = baseY;
    positions[bottomCenterIndex * 3 + 2] = 0;

    const indices: number[] = [];
    // 側面壁（1segmentにつき四角形1枚=三角形2枚）。
    for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const top0 = i;
        const top1 = next;
        const bot0 = n + i;
        const bot1 = n + next;
        indices.push(top0, bot0, bot1);
        indices.push(top0, bot1, top1);
    }
    // 底面（下端の外周から中心への扇形）。
    for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        indices.push(bottomCenterIndex, n + next, n + i);
    }

    const uintIndices = new Uint32Array(indices);
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, uintIndices, normals);

    return { positions, indices: uintIndices, normals };
};
