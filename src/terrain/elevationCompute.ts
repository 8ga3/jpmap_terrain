/**
 * 標高データをメッシュ頂点に反映 + 法線計算する純粋関数群。
 *
 * メインスレッド・Web Worker の両方から参照されるため、
 * `window` / `document` / Babylon API などの DOM 依存は持たない。
 */

export const applyElevationToPositions = (
    positions: Float32Array,
    elevations: Float32Array,
    altitudeOffset: number,
    heightScale: number,
    subdivisions: number,
    tileSize: number,
): void => {
    const cols = subdivisions + 1;
    for (let row = 0; row <= subdivisions; row++) {
        for (let col = 0; col <= subdivisions; col++) {
            const u = col / subdivisions;
            const v = row / subdivisions;
            const sx = Math.min(tileSize - 1, Math.round(u * (tileSize - 1)));
            const sy = Math.min(tileSize - 1, Math.round(v * (tileSize - 1)));
            const elev = elevations[sy * tileSize + sx];
            positions[(row * cols + col) * 3 + 1] =
                (elev + altitudeOffset) * heightScale;
        }
    }
};

/**
 * インデックス付き三角形リストの法線を計算する（Babylon の VertexData.ComputeNormals 互換）。
 *
 * 各頂点について隣接面の重み付き（外積の大きさ = 面積の 2 倍）平均を取り、最後に正規化する。
 */
export const computeNormalsForIndexedMesh = (
    positions: Float32Array,
    indices: Int32Array | Uint32Array | Uint16Array | ArrayLike<number>,
    normals: Float32Array,
): void => {
    for (let i = 0; i < normals.length; i++) normals[i] = 0;

    // Babylon の VertexData.ComputeNormals と符号を合わせるため、
    // 中心頂点を indices[i+1] (= b) とし、エッジを (a-b) × (c-b) で計算する。
    // (b-a) × (c-a) と符号が逆になるため、Babylon ground の winding と組み合わせると
    // 法線が下向きになり、ライティングで真っ黒に描画されてしまう。
    const triCount = indices.length;
    for (let i = 0; i < triCount; i += 3) {
        const a = indices[i] * 3;
        const b = indices[i + 1] * 3;
        const c = indices[i + 2] * 3;

        const e1x = positions[a] - positions[b];
        const e1y = positions[a + 1] - positions[b + 1];
        const e1z = positions[a + 2] - positions[b + 2];
        const e2x = positions[c] - positions[b];
        const e2y = positions[c + 1] - positions[b + 1];
        const e2z = positions[c + 2] - positions[b + 2];

        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;

        normals[a] += nx;
        normals[a + 1] += ny;
        normals[a + 2] += nz;
        normals[b] += nx;
        normals[b + 1] += ny;
        normals[b + 2] += nz;
        normals[c] += nx;
        normals[c + 1] += ny;
        normals[c + 2] += nz;
    }

    for (let i = 0; i < normals.length; i += 3) {
        const x = normals[i];
        const y = normals[i + 1];
        const z = normals[i + 2];
        const len = Math.sqrt(x * x + y * y + z * z);
        if (len > 0) {
            const inv = 1 / len;
            normals[i] = x * inv;
            normals[i + 1] = y * inv;
            normals[i + 2] = z * inv;
        } else {
            normals[i] = 0;
            normals[i + 1] = 1;
            normals[i + 2] = 0;
        }
    }
};

export interface ElevationComputeRequest {
    id: number;
    positions: Float32Array;
    indices: Int32Array | Uint32Array | Uint16Array;
    elevations: Float32Array;
    altitudeOffset: number;
    heightScale: number;
    subdivisions: number;
    tileSize: number;
}

export interface ElevationComputeResponse {
    id: number;
    positions: Float32Array;
    normals: Float32Array;
}

/** 同期版（fallback / sync 経路用）。引数の positions を破壊的に変更する */
export const computeElevationAndNormalsSync = (
    req: ElevationComputeRequest,
): ElevationComputeResponse => {
    applyElevationToPositions(
        req.positions,
        req.elevations,
        req.altitudeOffset,
        req.heightScale,
        req.subdivisions,
        req.tileSize,
    );
    const normals = new Float32Array(req.positions.length);
    computeNormalsForIndexedMesh(req.positions, req.indices, normals);
    return { id: req.id, positions: req.positions, normals };
};
