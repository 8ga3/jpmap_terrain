/**
 * 標高 PNG タイルの fetch + decode を Worker 内で実行する。
 *
 * - メインスレッドの `drawImage` + `getImageData` + decode ループによる
 *   フレームスパイク（特に Follow モードでのガタつき）を排除するのが目的
 * - 受信: { id, urls } — DEM レイヤーのフォールバック順に並んだ URL 配列
 * - 返信: 成功時 { id, ok: true, elev, width, height }, 失敗時 { id, ok: false, error }
 * - elev (Float32Array) の buffer は transfer して返す
 */

interface DecodeRequest {
    id: number;
    urls: string[];
    timeoutMs: number;
}

interface DecodeSuccess {
    id: number;
    ok: true;
    elev: Float32Array;
    width: number;
    height: number;
}

interface DecodeFailure {
    id: number;
    ok: false;
    error: string;
}

const NO_DATA_SENTINEL_NAN = NaN;

const decodeGsiElevation = (r: number, g: number, b: number): number => {
    if (r === 128 && g === 0 && b === 0) return NO_DATA_SENTINEL_NAN;
    const raw = r * 65536 + g * 256 + b;
    return raw < 2 ** 23 ? raw * 0.01 : (raw - 2 ** 24) * 0.01;
};

const decodeOne = async (
    url: string,
    timeoutMs: number,
): Promise<{ elev: Float32Array; width: number; height: number }> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Tile fetch failed: ${url} (${res.status})`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const cvs = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cvs.getContext("2d");
    if (!ctx) {
        bmp.close();
        throw new Error("OffscreenCanvas 2D context unavailable");
    }
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    const elev = new Float32Array(bmp.width * bmp.height);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
        elev[i >> 2] = decodeGsiElevation(data[i], data[i + 1], data[i + 2]);
    }
    return { elev, width: bmp.width, height: bmp.height };
};

self.addEventListener("message", (ev: MessageEvent<DecodeRequest>) => {
    const { id, urls, timeoutMs } = ev.data;
    (async () => {
        let lastErr: unknown;
        for (const url of urls) {
            try {
                const r = await decodeOne(url, timeoutMs);
                const reply: DecodeSuccess = {
                    id,
                    ok: true,
                    elev: r.elev,
                    width: r.width,
                    height: r.height,
                };
                (self as unknown as Worker).postMessage(reply, [r.elev.buffer]);
                return;
            } catch (e) {
                lastErr = e;
            }
        }
        const reply: DecodeFailure = {
            id,
            ok: false,
            error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        };
        (self as unknown as Worker).postMessage(reply);
    })();
});

export type { DecodeRequest, DecodeSuccess, DecodeFailure };
