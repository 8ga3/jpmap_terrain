/**
 * 標高計算用 Web Worker プール。
 *
 * - Worker をラウンドロビンで使い回し、メインスレッドの sync 処理を分散する
 * - Worker API が利用不能な環境（Vitest / SSR / 古いブラウザ）では同期 fallback
 * - Transferable な ArrayBuffer でメモリコピーを最小化
 *
 * tileManager の `applyElevationDataToMesh` がメインスレッドで実行していた
 * 標高反映 + 法線計算（1 タイルあたり 10〜30ms）を切り出して、
 * 飛行機のアニメーションがガク落ちしないようにすることが目的。
 */
import {
    computeElevationAndNormalsSync,
    type ElevationComputeRequest,
    type ElevationComputeResponse,
} from "./elevationCompute";

interface PendingTask {
    resolve: (res: ElevationComputeResponse) => void;
    reject: (err: unknown) => void;
}

export interface ElevationWorkerPool {
    run(req: ElevationComputeRequest): Promise<ElevationComputeResponse>;
    dispose(): void;
}

const isWorkerAvailable = (): boolean =>
    typeof Worker !== "undefined" && typeof URL !== "undefined";

export const createElevationWorkerPool = (
    poolSize = 2,
): ElevationWorkerPool => {
    // Worker が使えない（テスト / SSR）場合は sync 実装を返す
    if (!isWorkerAvailable()) {
        return {
            run(req: ElevationComputeRequest): Promise<ElevationComputeResponse> {
                return Promise.resolve(computeElevationAndNormalsSync(req));
            },
            dispose(): void {
                /* noop */
            },
        };
    }

    const workers: Worker[] = [];
    const pending = new Map<number, PendingTask>();
    let nextId = 1;
    let rrIdx = 0;
    let disposed = false;

    const createWorker = (): Worker | null => {
        try {
            // `{ type: "module" }` は Vite の推奨パターン。dev では ESM のまま
            // ワーカーを起動し（未指定だと classic worker 扱いで import 文が
            // "Cannot use import statement outside a module" となる）、build では
            // ESM ワーカーとしてバンドルされる。
            const w = new Worker(
                new URL("./elevationWorker.ts", import.meta.url),
                { type: "module" },
            );
            w.onmessage = (e: MessageEvent<ElevationComputeResponse>) => {
                const task = pending.get(e.data.id);
                if (!task) return;
                pending.delete(e.data.id);
                task.resolve(e.data);
            };
            w.onerror = (ev: ErrorEvent) => {
                // workerのエラー時は、未解決タスクをまとめて reject。
                for (const [, task] of pending) {
                    task.reject(ev.error ?? new Error("elevation worker error"));
                }
                pending.clear();
            };
            return w;
        } catch (err) {
            console.warn(
                "[jpmap-terrain] failed to spawn elevation worker; falling back to sync:",
                err,
            );
            return null;
        }
    };

    for (let i = 0; i < poolSize; i++) {
        const w = createWorker();
        if (w) workers.push(w);
    }

    // Worker 生成に全失敗した場合は sync fallback
    if (workers.length === 0) {
        return {
            run(req: ElevationComputeRequest): Promise<ElevationComputeResponse> {
                return Promise.resolve(computeElevationAndNormalsSync(req));
            },
            dispose(): void {
                /* noop */
            },
        };
    }

    return {
        run(req: ElevationComputeRequest): Promise<ElevationComputeResponse> {
            if (disposed) {
                return Promise.resolve(computeElevationAndNormalsSync(req));
            }
            const id = nextId++;
            const worker = workers[rrIdx];
            rrIdx = (rrIdx + 1) % workers.length;
            return new Promise<ElevationComputeResponse>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                const payload: ElevationComputeRequest = { ...req, id };
                // Transferable: positions / elevations / indices の ArrayBuffer を譲渡
                const transfer: ArrayBuffer[] = [
                    payload.positions.buffer as ArrayBuffer,
                    payload.elevations.buffer as ArrayBuffer,
                    payload.indices.buffer as ArrayBuffer,
                ];
                worker.postMessage(payload, transfer);
            });
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const w of workers) w.terminate();
            workers.length = 0;
            for (const [, task] of pending) {
                task.reject(new Error("elevation worker pool disposed"));
            }
            pending.clear();
        },
    };
};
