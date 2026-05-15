/**
 * 標高タイル decode 用 Worker プール（singleton）。
 *
 * - `loadElevationTile` の fetch + PNG decode + RGB → Float 変換を Worker に逃がす
 * - Worker が利用不可（Jest / SSR / OffscreenCanvas 非対応）の環境では
 *   呼び出し側に `null` を返し、従来の同期パスへフォールバックさせる
 */
import type {
    DecodeRequest,
    DecodeSuccess,
    DecodeFailure,
} from "./elevationDecodeWorker";

type DecodeResponse = DecodeSuccess | DecodeFailure;

interface Pending {
    resolve: (r: DecodeSuccess) => void;
    reject: (err: unknown) => void;
}

export interface ElevationDecodePool {
    decode(urls: string[], timeoutMs: number): Promise<Float32Array>;
    dispose(): void;
}

const isWorkerAvailable = (): boolean =>
    typeof Worker !== "undefined"
    && typeof URL !== "undefined"
    && typeof OffscreenCanvas !== "undefined"
    && typeof createImageBitmap !== "undefined";

let cached: ElevationDecodePool | null = null;
let cacheFailed = false;

const createPool = (poolSize = 2): ElevationDecodePool | null => {
    if (!isWorkerAvailable()) return null;

    const workers: Worker[] = [];
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let rrIdx = 0;
    let disposed = false;

    for (let i = 0; i < poolSize; i++) {
        try {
            const w = new Worker(
                new URL("./elevationDecodeWorker.ts", import.meta.url),
                { type: "module" },
            );
            w.onmessage = (e: MessageEvent<DecodeResponse>) => {
                const task = pending.get(e.data.id);
                if (!task) return;
                pending.delete(e.data.id);
                if (e.data.ok) task.resolve(e.data);
                else task.reject(new Error(e.data.error));
            };
            w.onerror = (ev: ErrorEvent) => {
                for (const [, task] of pending) {
                    task.reject(ev.error ?? new Error("elevation decode worker error"));
                }
                pending.clear();
            };
            workers.push(w);
        } catch (err) {
            console.warn("[jpmap-terrain] failed to spawn elevation decode worker:", err);
        }
    }

    if (workers.length === 0) return null;

    return {
        decode(urls: string[], timeoutMs: number): Promise<Float32Array> {
            if (disposed) return Promise.reject(new Error("decode pool disposed"));
            const id = nextId++;
            const worker = workers[rrIdx];
            rrIdx = (rrIdx + 1) % workers.length;
            return new Promise<Float32Array>((resolve, reject) => {
                pending.set(id, {
                    resolve: (r) => resolve(r.elev),
                    reject,
                });
                const payload: DecodeRequest = { id, urls, timeoutMs };
                worker.postMessage(payload);
            });
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const w of workers) w.terminate();
            workers.length = 0;
            for (const [, task] of pending) {
                task.reject(new Error("decode pool disposed"));
            }
            pending.clear();
        },
    };
};

/** singleton で pool を取得（不可なら null）。 */
export const getElevationDecodePool = (): ElevationDecodePool | null => {
    if (cached) return cached;
    if (cacheFailed) return null;
    const p = createPool();
    if (!p) {
        cacheFailed = true;
        return null;
    }
    cached = p;
    return cached;
};
