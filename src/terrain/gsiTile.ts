/** 地理院タイルの座標変換・標高デコード・タイルURL生成 */

export const TILE_SIZE = 256;

/** 地理院タイルの最大ズームレベル */
export const TILE_MAX_ZOOM = 18;

/**
 * 地理院テクスチャ（std/seamlessphoto）が世界全域を被覆する最大ズームレベル。
 *
 * これより高いズームは日本周辺（おおむね `JAPAN_BOUNDS`）のみ配信され、域外は 404 を返す。
 * 全球ビューで域外をズームインしてもタイルが欠けないよう、域外タイルの細分化上限に用いる。
 */
export const WORLD_TEXTURE_MAX_ZOOM = 8;

export const JAPAN_BOUNDS = {
    minLat: 20,
    maxLat: 46,
    minLon: 122,
    maxLon: 154,
} as const;

const DEM_LAYERS = ["dem5a_png", "dem5b_png", "dem_png"] as const;

/** dem_png（全国 DEM）が配信される最大ズーム。これを超える領域は 404 になる。 */
const DEM_PNG_MAX_ZOOM = 14;

/**
 * 同一ズーム合成後も穴（no-data）が `COMPOSITE_HOLE_RATIO` を超えて残るタイルで、粗ズーム dem_png
 * による穴埋めを何段まで遡って試すか。全面 no-data・部分欠測のいずれも対象。
 */
const COARSE_FILL_DEPTH = 5;

/**
 * 同一ズームで下位 DEM レイヤーを合成して穴埋めする発動閾値。
 *
 * 穴（no-data）がタイル全体のこの割合を超えるときだけ dem5b/dem_png を取得して合成する。
 * 整備済みの DEM5 でも、堀・河川・タイル境界などで僅かに no-data が生じる（実測で中央東京の
 * dem5a でも 2〜23%）。こうした微小な穴まで毎回下位レイヤーを取得すると、描画が不必要に変化し
 * （camera-terrain 衝突のパララックスずれ）、software rendering では追加フェッチで安定待ちが
 * タイムアウトする。微小な穴は取得コストに見合わないため合成せず、後段の `fillInvalidPixels` の
 * 局所補間に委ねる。山岳地帯のように穴が大きいタイルだけ合成・粗ズーム補填の対象とする。
 */
const COMPOSITE_HOLE_RATIO = 0.1;

/**
 * タイル取得失敗を表すエラー。`status` に HTTP ステータスを保持する（ネットワーク/タイムアウト等の
 * 非 HTTP 失敗では undefined）。404（決定的な未配信）と一時的な障害を呼び出し側で区別するために使う
 * （globe の粗ズームフォールバック判定など）。
 */
export class TileFetchError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "TileFetchError";
    }
}

export const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

/** 緯度経度 → タイル XY */
export const toTileXY = (
    lat: number,
    lon: number,
    zoom: number,
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
                n,
        ),
        0,
        n - 1,
    );
    return { x, y };
};

/** タイル中心の緯度経度を返す（Web メルカトル逆変換） */
export const tileCenterLatLon = (
    x: number,
    y: number,
    zoom: number,
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
export const decodeGsiElevation = (r: number, g: number, b: number): number => {
    if (r === 128 && g === 0 && b === 0) return NaN;
    const raw = r * 65536 + g * 256 + b;
    return raw < 2 ** 23 ? raw * 0.01 : (raw - 2 ** 24) * 0.01;
};

/**
 * 粗ズーム dem_png（親タイル）の該当領域を最近傍で切り出し、`merged` の残存 no-data 穴だけを
 * その実標高で埋める。全 DEM レイヤーは同一 256px タイルスキームで co-registered
 * なため、親タイル (cz, x>>d, y>>d) の対応サブ領域をピクセル対応で参照できる。
 *
 * @returns 穴埋め後に残った（親側も no-data だった）穴の数。
 */
const fillHolesFromCoarseDem = (
    merged: Float32Array,
    width: number,
    height: number,
    parent: ImageData,
    zoom: number,
    x: number,
    y: number,
    cz: number,
): number => {
    const d = zoom - cz;
    const scale = 1 << d;
    const pw = parent.width;
    const ph = parent.height;
    // 当該タイルが親タイル内で占めるサブ領域（親ピクセル単位）。
    const subW = pw / scale;
    const subH = ph / scale;
    const originX = (x & (scale - 1)) * subW;
    const originY = (y & (scale - 1)) * subH;
    let remaining = 0;
    for (let oy = 0; oy < height; oy++) {
        const sy = Math.min(
            ph - 1,
            Math.round(
                originY + (height > 1 ? oy / (height - 1) : 0) * (subH - 1),
            ),
        );
        for (let ox = 0; ox < width; ox++) {
            const idx = oy * width + ox;
            if (!Number.isNaN(merged[idx])) continue;
            const sx = Math.min(
                pw - 1,
                Math.round(
                    originX + (width > 1 ? ox / (width - 1) : 0) * (subW - 1),
                ),
            );
            const p = (sy * pw + sx) * 4;
            const v = decodeGsiElevation(
                parent.data[p],
                parent.data[p + 1],
                parent.data[p + 2],
            );
            if (!Number.isNaN(v)) merged[idx] = v;
            else remaining++;
        }
    }
    return remaining;
};

/** 無効値(NaN/NO_DATA_SENTINEL)を周囲の有効ピクセルからBFS(フロンティア)方式で補間する */
export const fillInvalidPixels = (
    elev: Float32Array,
    width: number,
    height: number,
): void => {
    const size = width * height;
    const offsets: readonly [number, number][] = [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
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
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height)
                        continue;
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
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new TileFetchError(`Tile fetch failed: ${url}`, res.status);
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

/**
 * 標高タイルを読み込み Float32Array で返す（dem5a → dem5b → dem のレイヤー合成）。
 *
 * DEM5（dem5a/dem5b）はカバレッジに穴があり、山岳地帯では HTTP 200 を返すのに
 * タイルの大半が no-data(128,0,0) になることがある。最初に 200 を返した
 * レイヤーをそのまま採用すると、わずかに残った有効ピクセルが後段の `fillInvalidPixels`
 * でタイル全体に塗り広げられ、地形がフラット化・数百 m ずれ・0m へ崩れる。
 *
 * これを避けるため、穴（no-data）がタイル全体の `COMPOSITE_HOLE_RATIO` を超えるタイルに限り、
 * 各レイヤーをピクセル単位で合成する:
 * - 高解像度（dem5a > dem5b > dem）の有効ピクセルを優先する。
 * - あるレイヤーで no-data だったピクセルだけを、次のレイヤーの有効値で穴埋めする。
 * - 穴が閾値以下になった時点で以降のレイヤーは取得しない。
 *
 * 整備済み DEM5 でも堀・河川・タイル境界で僅かに生じる微小な穴は、下位レイヤーを取得せず後段の
 * `fillInvalidPixels` の局所補間に委ねる（描画変化・追加フェッチを避けるため）。
 *
 * 同一ズームの DEM をすべて合成しても穴が `COMPOSITE_HOLE_RATIO` を超えて残る場合（dem_png の配信上限
 * z14 を超えた z15 等で、同一ズームには穴を埋める実標高が存在しない大穴タイル）は、粗ズーム dem_png を
 * 取得してタイルを実標高で穴埋めする。閾値以下の微小な欠測は後段の `fillInvalidPixels`
 * が局所補間するため、粗ズーム取得は行わない。
 *
 * 全 DEM レイヤーが同一の z/x/y/256px タイルスキームで co-registered なため、合成は
 * リサンプル不要のピクセル対応で行える。
 */
export const loadElevationTile = async (
    zoom: number,
    x: number,
    y: number,
): Promise<Float32Array> => {
    let merged: Float32Array | null = null;
    let width = 0;
    let height = 0;
    let total = 0;
    let holes = 0;
    let lastErr: unknown;
    // 全レイヤーの失敗が決定的な 404（未配信）だけだったか。一時障害（タイムアウト等）が混じる場合は
    // false にして、最終 throw の status を undefined にする（呼び出し側で粗ズームへ倒さず再試行させる）。
    let allDeterministic404 = true;

    for (const layer of DEM_LAYERS) {
        // 穴が閾値以下になれば以降のレイヤーは不要（微小穴は fillInvalidPixels に委ねる）。
        if (merged && holes <= total * COMPOSITE_HOLE_RATIO) break;

        // dem_png は z14 までしか配信されない。z15 以降の同一ズーム dem_png は必ず 404 になるため、
        // 無駄なフェッチを避けてスキップし、後段の粗ズーム dem_png 穴埋めに委ねる。
        if (layer === "dem_png" && zoom > DEM_PNG_MAX_ZOOM) continue;

        const url = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${zoom}/${x}/${y}.png`;
        let img: ImageData;
        try {
            img = await loadImageData(url);
        } catch (e) {
            // 取得失敗（404＝当該領域外のほか、タイムアウト/ネットワーク等の一時障害も含む）→ 次レイヤーへ。
            // 404 以外の一時障害が混じった場合は allDeterministic404 を倒し、最終 throw を非 404 扱いにする。
            lastErr = e;
            if (!(e instanceof TileFetchError) || e.status !== 404)
                allDeterministic404 = false;
            continue;
        }

        if (!merged) {
            width = img.width;
            height = img.height;
            merged = new Float32Array(width * height);
            total = merged.length;
            holes = 0;
            for (let i = 0; i < img.data.length; i += 4) {
                const v = decodeGsiElevation(
                    img.data[i],
                    img.data[i + 1],
                    img.data[i + 2],
                );
                merged[i / 4] = v;
                if (Number.isNaN(v)) holes++;
            }
        } else {
            // no-data の穴だけを当レイヤーの有効値で埋める。
            for (let i = 0; i < img.data.length; i += 4) {
                const idx = i / 4;
                if (!Number.isNaN(merged[idx])) continue;
                const v = decodeGsiElevation(
                    img.data[i],
                    img.data[i + 1],
                    img.data[i + 2],
                );
                if (!Number.isNaN(v)) {
                    merged[idx] = v;
                    holes--;
                }
            }
        }
    }

    if (!merged) {
        throw new TileFetchError(
            `No elevation tile available for z${zoom}/${x}/${y}: ${String(lastErr)}`,
            allDeterministic404 ? 404 : undefined,
        );
    }

    // 同一ズームの DEM をすべて合成しても穴（no-data）が閾値を超えて残る場合は、粗ズーム dem_png を
    // 取得して実標高で穴埋めする。dem_png の配信上限は z14 のため、z15 以降は同一ズームに
    // 穴を埋める実標高が存在せず、DEM5 カバレッジ穴の大きいタイル（例: 山岳で dem5a が 7〜8 割 no-data）が
    // そのまま残ると、わずかな有効ピクセルが後段の `fillInvalidPixels` で塗り広げられ、地形が
    // 「ホールケーキの一切れ」状（フラット／0m／段差）に崩れる。これを防ぐため、穴が `COMPOSITE_HOLE_RATIO`
    // を超えるタイルは粗ズーム dem_png で穴埋めする。z14 以下では同一ズーム dem_png で既に穴が埋まり
    // （holes が閾値以下になり）ここは発動しない。微小な穴（閾値以下）は `fillInvalidPixels` の局所補間に委ねる。
    if (holes > total * COMPOSITE_HOLE_RATIO) {
        const startCz = Math.min(zoom - 1, DEM_PNG_MAX_ZOOM);
        const floorCz = Math.max(0, startCz - (COARSE_FILL_DEPTH - 1));
        // 残り穴が閾値以下になったら打ち切る。微小な欠測（≤ COMPOSITE_HOLE_RATIO）まで粗ズームを
        // 遡って取得するのは無駄なフェッチになるため、後段の `fillInvalidPixels` の局所補間に委ねる。
        for (
            let cz = startCz;
            cz >= floorCz && holes > total * COMPOSITE_HOLE_RATIO;
            cz--
        ) {
            const d = zoom - cz;
            const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${cz}/${x >> d}/${y >> d}.png`;
            try {
                const parent = await loadImageData(url);
                holes = fillHolesFromCoarseDem(
                    merged,
                    width,
                    height,
                    parent,
                    zoom,
                    x,
                    y,
                    cz,
                );
            } catch (e) {
                // 404（未配信）のみ次の粗ズームへ。一時障害（タイムアウト/ネットワーク/5xx 等）は
                // 握りつぶさず伝播し、穴埋め未完のまま誤った標高を返さない。呼び出し側のバックオフ
                // 再取得に委ねる。
                if (e instanceof TileFetchError && e.status === 404) continue;
                throw e;
            }
        }
    }

    return merged;
};

/** 地図タイプ */
export type MapType = "std" | "photo";

/** 標準地図テクスチャURL */
export const stdTextureUrl = (zoom: number, x: number, y: number): string =>
    `https://cyberjapandata.gsi.go.jp/xyz/std/${zoom}/${x}/${y}.png`;

/** 写真地図テクスチャURL */
export const photoTextureUrl = (zoom: number, x: number, y: number): string =>
    `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${zoom}/${x}/${y}.jpg`;

/** 地図タイプに応じたテクスチャURLを返す */
export const textureUrl = (
    mapType: MapType,
    zoom: number,
    x: number,
    y: number,
): string =>
    mapType === "photo"
        ? photoTextureUrl(zoom, x, y)
        : stdTextureUrl(zoom, x, y);
