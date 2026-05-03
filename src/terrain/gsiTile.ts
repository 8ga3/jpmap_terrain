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

/** タイル中心の緯度経度を返す（Web メルカトル逆変換） */
export const tileCenterLatLon = (
    x: number,
    y: number,
    zoom: number
): { lat: number; lon: number } => {
    const n = 2 ** zoom;
    const lon = ((x + 0.5) / n) * 360 - 180;
    const lat =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) /
        Math.PI;
    return { lat, lon };
};

/** タイル1辺の実距離[m] */
export const tileEdgeMeters = (lat: number, zoom: number): number => {
    const latClamped = clamp(lat, -85.05112878, 85.05112878);
    const metersPerPixel =
        (156543.03392804097 * Math.cos((latClamped * Math.PI) / 180)) /
        2 ** zoom;
    return metersPerPixel * TILE_SIZE;
};

/**
 * 標高データの「無効値」を表す番兵値。
 *
 * `fillInvalidPixels` が周囲に有効値を一切見つけられず BFS でも埋められなかった
 * ピクセルに書き込まれる。実標高で -100m に達することは現実的にない（海岸線で
 * 観測される負値はせいぜい -数 m 程度）ため、後段の処理で「埋め残し」を一意に
 * 識別できる。
 *
 * このセンチネルが残ったタイルは：
 * - メッシュに直接適用された場合、地表より十分下に沈む（視覚的な凹みではあるが
 *   湖面が押し上げられるよりはマシ）
 * - 隣接タイルのステッチ参照では NaN と同等に扱われ、平均から除外される
 *   （`tileStitching` の `nanMean` 等を参照）
 */
export const NO_DATA_SENTINEL = -100;

/** NaN または NO_DATA_SENTINEL を「無効」とみなす */
export const isInvalidElev = (v: number): boolean =>
    Number.isNaN(v) || v === NO_DATA_SENTINEL;

/** 全ピクセルが無効値（NaN または NO_DATA_SENTINEL）かどうか判定する */
export const isAllNaN = (data: Float32Array): boolean => {
    for (let i = 0; i < data.length; i++) {
        if (!isInvalidElev(data[i])) return false;
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

/** 無効値(NaN/NO_DATA_SENTINEL)を周囲の有効ピクセルからBFS(フロンティア)方式で補間する */
export const fillInvalidPixels = (
    elev: Float32Array,
    width: number,
    height: number
): void => {
    const size = width * height;
    const offsets: readonly [number, number][] = [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],          [1,  0],
        [-1,  1], [0,  1], [1,  1],
    ];

    // BFS: 有効ピクセルに隣接する無効ピクセルをキューに入れ、波状に埋める。
    // 同一ピクセルが複数回キューに入る場合があるが、処理時に埋め済みならスキップする。
    // 各ピクセルの隣接は最大8なので総キュー操作は O(width * height)。

    // フロンティア初期化: 無効値で、かつ隣に有効値があるピクセルを収集
    let frontier: number[] = [];
    for (let i = 0; i < size; i++) {
        if (!isInvalidElev(elev[i])) continue;
        const x = i % width;
        const y = (i - x) / width;
        for (const [dx, dy] of offsets) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            if (!isInvalidElev(elev[ny * width + nx])) {
                frontier.push(i);
                break;
            }
        }
    }

    // BFS ループ
    while (frontier.length > 0) {
        const next: number[] = [];
        for (const idx of frontier) {
            if (!isInvalidElev(elev[idx])) continue; // 既に埋まった
            const x = idx % width;
            const y = (idx - x) / width;
            let sum = 0;
            let count = 0;
            for (const [dx, dy] of offsets) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const v = elev[ny * width + nx];
                if (!isInvalidElev(v)) {
                    sum += v;
                    count++;
                }
            }
            if (count > 0) {
                elev[idx] = sum / count;
                // 新たに埋まったピクセルの隣の無効値を次のフロンティアに追加
                for (const [dx, dy] of offsets) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const ni = ny * width + nx;
                    if (isInvalidElev(elev[ni])) {
                        next.push(ni);
                    }
                }
            }
        }
        frontier = next;
    }

    // 全ピクセル無効等で残った無効値は NO_DATA_SENTINEL にフォールバック。
    // 0 にすると後段の `isAllNaN` 判定で「有効」と誤認されてしまうため、
    // 後で再ステッチ→再 fill が走った際に再度埋め直し対象にできるよう
    // センチネル値で残しておく。
    for (let i = 0; i < size; i++) {
        if (Number.isNaN(elev[i])) elev[i] = NO_DATA_SENTINEL;
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
            // HTTP 成功 = このレイヤーが当該領域をカバーしているとみなす。
            // 全 NaN（湖面など no-data 領域）でも次レイヤーへフォールバックしない。
            // 下位レイヤー（dem5b など）は同じ場所に水面標高を返すことがあり、
            // それを使うと湖面が押し上がる（issue #224）。
            // all-NaN の場合は同レイヤー隣接タイルから後段（refineAllNaNTiles）の
            // NaN 埋めで補間させる。
            // フォールバックは HTTP 取得失敗（404 等：このレイヤー範囲外）でのみ発動。
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
