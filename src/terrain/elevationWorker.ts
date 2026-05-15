/// <reference lib="webworker" />
/**
 * 標高 → 頂点位置 / 法線変換用 Web Worker エントリ。
 *
 * メインスレッドからは `elevationWorkerPool.ts` 経由で利用される。
 * tileManager から `applyElevation` + `VertexData.ComputeNormals` を
 * オフロードしてメインスレッドのアニメーション乱れを防ぐ目的。
 *
 * 入力 / 出力は Transferable な ArrayBuffer を使い、メモリコピーを避ける。
 */
import {
    computeElevationAndNormalsSync,
    type ElevationComputeRequest,
} from "./elevationCompute";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<ElevationComputeRequest>) => {
    const res = computeElevationAndNormalsSync(e.data);
    ctx.postMessage(res, [res.positions.buffer, res.normals.buffer]);
};
