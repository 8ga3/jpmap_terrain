/** 地理院タイルの座標変換・標高デコード・タイルURL生成 */

export const TILE_SIZE = 256;

export const JAPAN_BOUNDS = { minLat: 20, maxLat: 46, minLon: 122, maxLon: 154 } as const;

const DEM_LAYERS = ["dem5a_png", "dem5b_png", "dem_png"] as const;

export const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

/** 緯度経度 → タイル XY */
export const toTileXY = (
    lat: number,
    lon: number,
    zoom: number
): { x: number; y: number } => {
    const latClamped = clamp(lat, -85.05112878, 85.05112878);
    const lonNormalized = ((((lon + 180) % 360) + 360) % 360) - 180;
    const n = 2 ** zoom;
    const x = clamp(Math.floor(((lonNormalized + 180) / 360) * n), 0, n - 1);
    const latRad = (latClamped * Math.PI) / 180;
    const y = clamp(
        Math.floor(
            ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
                2) *
                n
        ),
        0,
        n - 1
    );
    return { x, y };
};

/** タイル1辺の実距離[m] */
export const tileEdgeMeters = (lat: number, zoom: number): number => {
    const latClamped = clamp(lat, -85.05112878, 85.05112878);
    const metersPerPixel =
        (156543.03392804097 * Math.cos((latClamped * Math.PI) / 180)) /
        2 ** zoom;
    return metersPerPixel * TILE_SIZE;
};

/** 全ピクセルが NaN かどうか判定する */
export const isAllNaN = (data: Float32Array): boolean => {
    for (let i = 0; i < data.length; i++) {
        if (!Number.isNaN(data[i])) return false;
    }
    return true;
};

/** 地理院標高タイルのRGBデコード（無効値は NaN） */
export const decodeGsiElevation = (
    r: number,
    g: number,
    b: number
): number => {
    if (r === 128 && g === 0 && b === 0) return NaN;
    const raw = r * 65536 + g * 256 + b;
    return raw < 2 ** 23 ? raw * 0.01 : (raw - 2 ** 24) * 0.01;
};

/** 無効値(NaN)を周囲の有効ピクセルから補間する */
export const fillInvalidPixels = (
    elev: Float32Array,
    width: number,
    height: number
): void => {
    const offsets = [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],          [1,  0],
        [-1,  1], [0,  1], [1,  1],
    ];

    // 距離を広げながら繰り返し補間（最大 16 パス）
    for (let pass = 0; pass < 16; pass++) {
        let filled = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (!Number.isNaN(elev[idx])) continue;

                let sum = 0;
                let count = 0;
                for (const [dx, dy] of offsets) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const v = elev[ny * width + nx];
                    if (!Number.isNaN(v)) {
                        sum += v;
                        count++;
                    }
                }
                if (count > 0) {
                    elev[idx] = sum / count;
                    filled++;
                }
            }
        }
        if (filled === 0) break;
    }

    // 全ピクセル無効等で残った NaN は 0 にフォールバック
    for (let i = 0; i < elev.length; i++) {
        if (Number.isNaN(elev[i])) elev[i] = 0;
    }
};

/** fetch タイムアウト [ms] */
const FETCH_TIMEOUT_MS = 15000;

/** ImageData を fetch して返す（Canvas経由） */
const loadImageData = async (url: string): Promise<ImageData> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Tile fetch failed: ${url}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const cvs = document.createElement("canvas");
    cvs.width = bmp.width;
    cvs.height = bmp.height;
    const ctx = cvs.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return data;
};

/** 標高タイルを読み込み Float32Array で返す（dem5a → dem5b → dem フォールバック） */
export const loadElevationTile = async (
    zoom: number,
    x: number,
    y: number
): Promise<Float32Array> => {
    let lastErr: unknown;
    for (const layer of DEM_LAYERS) {
        const url = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${zoom}/${x}/${y}.png`;
        try {
            const img = await loadImageData(url);
            const elev = new Float32Array(img.width * img.height);
            for (let i = 0; i < img.data.length; i += 4) {
                elev[i / 4] = decodeGsiElevation(
                    img.data[i],
                    img.data[i + 1],
                    img.data[i + 2]
                );
            }
            // 全NaNのタイルはこのレイヤーでは使えない → 次のレイヤーへ
            if (isAllNaN(elev)) {
                lastErr = new Error(`All NaN tile: ${url}`);
                continue;
            }
            return elev;
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(
        `No elevation tile available for z${zoom}/${x}/${y}: ${String(lastErr)}`
    );
};

/** 地図タイプ */
export type MapType = "std" | "photo";

/** 標準地図テクスチャURL */
export const stdTextureUrl = (
    zoom: number,
    x: number,
    y: number
): string => `https://cyberjapandata.gsi.go.jp/xyz/std/${zoom}/${x}/${y}.png`;

/** 写真地図テクスチャURL */
export const photoTextureUrl = (
    zoom: number,
    x: number,
    y: number
): string => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${zoom}/${x}/${y}.jpg`;

/** 地図タイプに応じたテクスチャURLを返す */
export const textureUrl = (
    mapType: MapType,
    zoom: number,
    x: number,
    y: number
): string => mapType === "photo"
    ? photoTextureUrl(zoom, x, y)
    : stdTextureUrl(zoom, x, y);
