import { describe, it, expect, afterEach, vi } from "vitest";
import {
    TILE_SIZE,
    JAPAN_BOUNDS,
    clamp,
    toTileXY,
    tileCenterLatLon,
    tileEdgeMeters,
    decodeGsiElevation,
    isAllNaN,
    fillInvalidPixels,
    stdTextureUrl,
    photoTextureUrl,
    textureUrl,
    NO_DATA_SENTINEL,
    loadElevationTile,
    TileFetchError,
} from "../src/terrain/gsiTile";

describe("TILE_SIZE", () => {
    it("256 である", () => {
        expect(TILE_SIZE).toBe(256);
    });
});

describe("JAPAN_BOUNDS", () => {
    it("日本の緯度経度範囲を持つ", () => {
        expect(JAPAN_BOUNDS).toEqual({
            minLat: 20,
            maxLat: 46,
            minLon: 122,
            maxLon: 154,
        });
    });
});

describe("clamp", () => {
    it("範囲内の値はそのまま返す", () => {
        expect(clamp(5, 0, 10)).toBe(5);
    });

    it("min 未満の値は min を返す", () => {
        expect(clamp(-1, 0, 10)).toBe(0);
    });

    it("max 超過の値は max を返す", () => {
        expect(clamp(15, 0, 10)).toBe(10);
    });

    it("境界値 min と一致する場合はそのまま返す", () => {
        expect(clamp(0, 0, 10)).toBe(0);
    });

    it("境界値 max と一致する場合はそのまま返す", () => {
        expect(clamp(10, 0, 10)).toBe(10);
    });

    it("負の範囲でも正しく動作する", () => {
        expect(clamp(-5, -10, -1)).toBe(-5);
        expect(clamp(-15, -10, -1)).toBe(-10);
        expect(clamp(0, -10, -1)).toBe(-1);
    });
});

describe("toTileXY", () => {
    it("東京（緯度35.68, 経度139.69）zoom=14 のタイル座標を返す", () => {
        const { x, y } = toTileXY(35.68, 139.69, 14);
        expect(x).toBe(14549);
        expect(y).toBe(6451);
    });

    it("zoom=0 では x=0, y=0 を返す", () => {
        const { x, y } = toTileXY(0, 0, 0);
        expect(x).toBe(0);
        expect(y).toBe(0);
    });

    it("zoom=1 で経度0, 緯度0 のとき x=1, y=1 を返す", () => {
        const { x, y } = toTileXY(0, 0, 1);
        expect(x).toBe(1);
        expect(y).toBe(1);
    });

    it("極端な緯度はクランプされる", () => {
        const high = toTileXY(90, 0, 10);
        const low = toTileXY(-90, 0, 10);
        expect(high.y).toBe(0);
        expect(low.y).toBe(1023);
    });

    it("経度が 360° 超の場合も正規化される", () => {
        const normal = toTileXY(35, 139, 10);
        const wrapped = toTileXY(35, 139 + 360, 10);
        expect(wrapped.x).toBe(normal.x);
        expect(wrapped.y).toBe(normal.y);
    });

    it("負の経度が正しく変換される", () => {
        const { x, y } = toTileXY(51.5, -0.1, 10);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1024);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(1024);
    });
});

describe("tileEdgeMeters", () => {
    it("赤道（lat=0）zoom=0 で地球半周相当の値を返す", () => {
        const meters = tileEdgeMeters(0, 0);
        // 赤道 zoom=0: 156543.03... * 256 ≈ 40,074,986 m
        expect(meters).toBeCloseTo(40074986, -2);
    });

    it("zoom が上がると距離が半減する", () => {
        const z0 = tileEdgeMeters(35, 0);
        const z1 = tileEdgeMeters(35, 1);
        expect(z1).toBeCloseTo(z0 / 2, 0);
    });

    it("高緯度ほどタイル実距離が短くなる", () => {
        const equator = tileEdgeMeters(0, 14);
        const tokyo = tileEdgeMeters(35, 14);
        const arctic = tileEdgeMeters(70, 14);
        expect(equator).toBeGreaterThan(tokyo);
        expect(tokyo).toBeGreaterThan(arctic);
    });

    it("緯度が極端な値でもクランプされる", () => {
        const result = tileEdgeMeters(90, 14);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result)).toBe(true);
    });
});

describe("decodeGsiElevation", () => {
    it("無効値 (128, 0, 0) で NaN を返す", () => {
        expect(decodeGsiElevation(128, 0, 0)).toBeNaN();
    });

    it("(0, 0, 0) → 0m", () => {
        expect(decodeGsiElevation(0, 0, 0)).toBe(0);
    });

    it("(0, 0, 1) → 0.01m", () => {
        expect(decodeGsiElevation(0, 0, 1)).toBeCloseTo(0.01, 5);
    });

    it("(0, 1, 0) → 2.56m", () => {
        // 256 * 0.01 = 2.56
        expect(decodeGsiElevation(0, 1, 0)).toBeCloseTo(2.56, 5);
    });

    it("(1, 0, 0) → 655.36m", () => {
        // 65536 * 0.01 = 655.36
        expect(decodeGsiElevation(1, 0, 0)).toBeCloseTo(655.36, 5);
    });

    it("2^23 未満の raw 値は正の標高を返す", () => {
        // raw = 2^23 - 1 = 8388607 → 83886.07
        const r = 127, g = 255, b = 255;
        expect(decodeGsiElevation(r, g, b)).toBeCloseTo(83886.07, 2);
    });

    it("2^23 以上の raw 値は負の標高を返す", () => {
        // raw = 2^24 - 1 = 16777215 → (16777215 - 16777216) * 0.01 = -0.01
        expect(decodeGsiElevation(255, 255, 255)).toBeCloseTo(-0.01, 5);
    });

    it("海面付近の負の標高をデコードできる", () => {
        // raw = 2^23 = 8388608 → (8388608 - 16777216) * 0.01 = -83886.08
        expect(decodeGsiElevation(128, 0, 0)).toBeNaN(); // これは無効値
        // raw = 128*65536 + 0*256 + 1 = 8388609 → (8388609 - 16777216) * 0.01 = -83886.07
        expect(decodeGsiElevation(128, 0, 1)).toBeCloseTo(-83886.07, 2);
    });
});

describe("isAllNaN", () => {
    it("全要素が NaN なら true を返す", () => {
        const data = new Float32Array([NaN, NaN, NaN, NaN]);
        expect(isAllNaN(data)).toBe(true);
    });

    it("有効値が1つでもあれば false を返す", () => {
        const data = new Float32Array([NaN, NaN, 0, NaN]);
        expect(isAllNaN(data)).toBe(false);
    });

    it("全要素が有効値なら false を返す", () => {
        const data = new Float32Array([1, 2, 3, 4]);
        expect(isAllNaN(data)).toBe(false);
    });

    it("空配列は true を返す", () => {
        const data = new Float32Array(0);
        expect(isAllNaN(data)).toBe(true);
    });

    it("先頭のみ有効値の場合 false を返す", () => {
        const data = new Float32Array([0, NaN, NaN, NaN]);
        expect(isAllNaN(data)).toBe(false);
    });

    it("末尾のみ有効値の場合 false を返す", () => {
        const data = new Float32Array([NaN, NaN, NaN, 100]);
        expect(isAllNaN(data)).toBe(false);
    });
});

describe("stdTextureUrl", () => {
    it("地理院標準地図タイルURLを返す", () => {
        expect(stdTextureUrl(14, 14547, 6452)).toBe(
            "https://cyberjapandata.gsi.go.jp/xyz/std/14/14547/6452.png"
        );
    });

    it("zoom=0 でもURLを生成できる", () => {
        expect(stdTextureUrl(0, 0, 0)).toBe(
            "https://cyberjapandata.gsi.go.jp/xyz/std/0/0/0.png"
        );
    });
});

describe("photoTextureUrl", () => {
    it("地理院写真地図タイルURLを返す", () => {
        expect(photoTextureUrl(14, 14547, 6452)).toBe(
            "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/14/14547/6452.jpg"
        );
    });

    it("zoom=0 でもURLを生成できる", () => {
        expect(photoTextureUrl(0, 0, 0)).toBe(
            "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/0/0/0.jpg"
        );
    });
});

describe("textureUrl", () => {
    it("std タイプで標準地図URLを返す", () => {
        expect(textureUrl("std", 14, 14547, 6452)).toBe(
            "https://cyberjapandata.gsi.go.jp/xyz/std/14/14547/6452.png"
        );
    });

    it("photo タイプで写真地図URLを返す", () => {
        expect(textureUrl("photo", 14, 14547, 6452)).toBe(
            "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/14/14547/6452.jpg"
        );
    });
});

describe("fillInvalidPixels", () => {
    it("NaN がなければ何も変更しない", () => {
        const data = new Float32Array([1, 2, 3, 4]);
        fillInvalidPixels(data, 2, 2);
        expect(Array.from(data)).toEqual([1, 2, 3, 4]);
    });

    it("周囲の有効値から NaN を補間する", () => {
        // 3x3: 中央だけ NaN
        const data = new Float32Array([
            10, 10, 10,
            10, NaN, 10,
            10, 10, 10,
        ]);
        fillInvalidPixels(data, 3, 3);
        expect(data[4]).toBe(10);
    });

    it("全 NaN の場合は NO_DATA_SENTINEL にフォールバックする", () => {
        const data = new Float32Array([NaN, NaN, NaN, NaN]);
        fillInvalidPixels(data, 2, 2);
        const expected = Array.from({ length: 4 }, () => NO_DATA_SENTINEL);
        expect(Array.from(data)).toEqual(expected);
    });

    it("大きな NaN 領域を完全に埋める（旧16パスでは届かない距離）", () => {
        // 32x32 で右下角 (31,31) のみ有効値 → 左上 (0,0) まで距離31以上
        const W = 32, H = 32;
        const data = new Float32Array(W * H);
        data.fill(NaN);
        data[(H - 1) * W + (W - 1)] = 100;

        fillInvalidPixels(data, W, H);

        // 全ピクセルが埋まっていること
        for (let i = 0; i < data.length; i++) {
            expect(Number.isNaN(data[i])).toBe(false);
        }
        // 元の有効値は 100 のまま
        expect(data[(H - 1) * W + (W - 1)]).toBe(100);
    });

    it("角にだけ有効値がある場合でも全 NaN を埋める", () => {
        // 20x20 で (0,0) のみ有効値
        const W = 20, H = 20;
        const data = new Float32Array(W * H);
        data.fill(NaN);
        data[0] = 50;

        fillInvalidPixels(data, W, H);

        for (let i = 0; i < data.length; i++) {
            expect(Number.isNaN(data[i])).toBe(false);
        }
        expect(data[0]).toBe(50);
    });

    it("エッジから内側に値が伝搬する（湖沼パターン）", () => {
        // 8x8: 外周のみ有効値、内部は NaN
        const W = 8, H = 8;
        const data = new Float32Array(W * H);
        data.fill(NaN);
        for (let x = 0; x < W; x++) {
            data[x] = 200;               // 上辺
            data[(H - 1) * W + x] = 200; // 下辺
        }
        for (let y = 0; y < H; y++) {
            data[y * W] = 200;           // 左辺
            data[y * W + (W - 1)] = 200; // 右辺
        }

        fillInvalidPixels(data, W, H);

        // 全ピクセルが埋まり NaN は残らない
        for (let i = 0; i < data.length; i++) {
            expect(Number.isNaN(data[i])).toBe(false);
        }
        // 外周は元の値のまま
        expect(data[0]).toBe(200);
        expect(data[W - 1]).toBe(200);
    });

    it("有効値と NaN が混在する場合、有効値は変更されない", () => {
        const data = new Float32Array([
            5, NaN, NaN,
            NaN, NaN, NaN,
            NaN, NaN, 15,
        ]);
        fillInvalidPixels(data, 3, 3);
        expect(data[0]).toBe(5);
        expect(data[8]).toBe(15);
        // 全ピクセル埋まっている
        for (let i = 0; i < data.length; i++) {
            expect(Number.isNaN(data[i])).toBe(false);
        }
    });

    it("非正方形（width ≠ height）でも全 NaN を埋める", () => {
        // 4x8: 左端列のみ有効値
        const W = 4, H = 8;
        const data = new Float32Array(W * H);
        data.fill(NaN);
        for (let y = 0; y < H; y++) data[y * W] = 30;

        fillInvalidPixels(data, W, H);

        for (let i = 0; i < data.length; i++) {
            expect(Number.isNaN(data[i])).toBe(false);
        }
        // 左端列は元の値のまま
        for (let y = 0; y < H; y++) {
            expect(data[y * W]).toBe(30);
        }
    });
});

// ---------- loadElevationTile ----------
// loadImageData (module-private) が fetch → createImageBitmap → Canvas を使うため
// ブラウザ API をモックして loadElevationTile のフォールバック挙動をテストする。

/** 指定 RGBA を返す最小 ImageData 風オブジェクト (1×1) を作るヘルパー */
const makeImageDataResult = (r: number, g: number, b: number): ImageData => ({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([r, g, b, 255]),
    colorSpace: "srgb",
});

/**
 * size×size の ImageData を作るヘルパー。先頭 `noDataCount` ピクセルを no-data(128,0,0)、
 * 残りを `rgb`（既定: 0,100,0 → 256.0m）にする。レイヤー合成の閾値判定検証に使う。
 */
const makeImageGrid = (
    size: number,
    noDataCount: number,
    rgb: readonly [number, number, number] = [0, 100, 0],
): ImageData => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        const [r, g, b] = i < noDataCount ? [128, 0, 0] : rgb;
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
    }
    return { width: size, height: size, data, colorSpace: "srgb" };
};

/** loadImageData 内部で使われるブラウザ API をモックするセットアップ */
const setupLoadImageMocks = (imageData: ImageData) => {
    const mockCtx = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => imageData),
    };
    const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
    };
    // node 環境では document が存在しない場合があるため globalThis にセット
    (globalThis as Record<string, unknown>).document = {
        createElement: vi.fn(() => mockCanvas),
    };
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(() =>
        Promise.resolve({ width: imageData.width, height: imageData.height, close: vi.fn() })
    );
};

/**
 * 取得（loadImageData）成功のたびに次の ImageData を順に返すモックセットアップ。
 * レイヤー合成（dem5a → dem5b → dem）の per-pixel 穴埋め挙動を検証するのに使う。
 */
const setupLoadImageSequenceMocks = (sequence: readonly ImageData[]) => {
    let i = 0;
    const cur = () => sequence[Math.min(i, sequence.length - 1)];
    const mockCtx = {
        drawImage: vi.fn(),
        // getImageData は loadImageData の最終ステップ。ここで次の要素へ進める。
        getImageData: vi.fn(() => {
            const data = cur();
            i++;
            return data;
        }),
    };
    const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
    };
    (globalThis as Record<string, unknown>).document = {
        createElement: vi.fn(() => mockCanvas),
    };
    (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(() => {
        const data = cur();
        return Promise.resolve({ width: data.width, height: data.height, close: vi.fn() });
    });
};

describe("loadElevationTile", () => {
    const originalFetch = globalThis.fetch;
    const originalCreateImageBitmap = (globalThis as Record<string, unknown>).createImageBitmap;
    const originalDocument = (globalThis as Record<string, unknown>).document;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        (globalThis as Record<string, unknown>).createImageBitmap = originalCreateImageBitmap;
        (globalThis as Record<string, unknown>).document = originalDocument;
        vi.restoreAllMocks();
    });

    it("dem5a が完全カバー（有効値）なら下位レイヤーを取得しない", async () => {
        // dem5a が有効値 (R=0,G=100,B=0 → 256.0) を返す → 穴が無いので 1 レイヤーで完了
        const validImageData = makeImageDataResult(0, 100, 0);
        setupLoadImageMocks(validImageData);

        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(() =>
            Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response)
        );
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(15, 100, 200);

        // dem5a のみ呼ばれ、dem5b/dem には行かない
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain("dem5a_png");

        expect(elev).toBeInstanceOf(Float32Array);
        expect(elev[0]).toBeCloseTo(256.0);
    });

    it("no-data の穴を下位レイヤーの有効値で合成補填する", async () => {
        // dem5a: 2×2 のうち 3px が no-data → dem5b: 404 → dem_png: 全有効(256.0)
        // 穴がある限り同一ズームの下位レイヤーを取得し、dem_png の有効値で埋める。
        // dem_png が同一ズームで配信される z14 で検証する（z15 以降は dem_png 同一ズームをスキップし
        // 粗ズーム補填に委ねるため、別テストで扱う）。
        const demHoles = makeImageGrid(2, 3); // 3/4 = no-data
        const demFull = makeImageGrid(2, 0); // 全有効
        setupLoadImageSequenceMocks([demHoles, demFull]);

        let callCount = 0;
        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => {
            callCount++;
            // dem5b (2 回目) のみ 404、それ以外は成功
            if (callCount === 2) return Promise.resolve({ ok: false, status: 404 } as Response);
            return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response);
        });
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(14, 100, 200);

        // dem5a(成功・穴) → dem5b(404) → dem_png(成功・穴埋め) で 3 レイヤー試行
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0][0]).toContain("dem5a_png/14/");
        expect(fetchMock.mock.calls[1][0]).toContain("dem5b_png/14/");
        expect(fetchMock.mock.calls[2][0]).toContain("dem_png/14/");

        // 穴が dem の有効値で全て埋まる
        expect(elev.length).toBe(4);
        for (let i = 0; i < elev.length; i++) expect(elev[i]).toBeCloseTo(256.0);
    });

    it("全面 no-data（同一ズームに実標高なし）は粗ズーム dem_png で穴埋めする", async () => {
        // z15: dem5a 全面 no-data(HTTP 200・全画素 128,0,0) → dem5b(z15) 404 → dem_png(z15) は配信上限
        // (z14)超のためスキップ。同一ズームに実標高が無く全面 no-data のため、粗ズーム dem_png(z14) を
        // 取得して穴埋めする。
        const allNoData = makeImageGrid(2, 4); // 4/4 = 全面 no-data
        const coarseFull = makeImageGrid(2, 0); // 粗ズーム dem_png: 全有効(256.0)
        setupLoadImageSequenceMocks([allNoData, coarseFull]);

        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>((input) => {
            // dem5b(z15) は 404。dem5a(z15) と 粗ズーム dem_png(z14) は成功。dem_png(z15) は呼ばれない。
            const url = String(input);
            if (url.includes("dem5b_png")) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response);
        });
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(15, 100, 200);

        // dem5a(z15) → dem5b(z15,404) → dem_png(z14) の 3 取得（dem_png z15 はスキップ）
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0][0]).toContain("dem5a_png/15/");
        expect(fetchMock.mock.calls[1][0]).toContain("dem5b_png/15/");
        // 粗ズームは親タイル座標 (z14, x>>1, y>>1) = (14, 50, 100)
        expect(fetchMock.mock.calls[2][0]).toContain("dem_png/14/50/100.png");

        // 全面 no-data が粗ズーム dem_png の実標高で埋まる
        expect(elev.length).toBe(4);
        for (let i = 0; i < elev.length; i++) expect(elev[i]).toBeCloseTo(256.0);
    });

    it("微小欠測（閾値以下）は同一ズーム合成せず NaN を残す（fillInvalidPixels に委ねる）", async () => {
        // dem5a 4×4 のうち 1px だけ no-data = 6.25% ≤ COMPOSITE_HOLE_RATIO(0.1)。
        // 微小穴のため下位レイヤー(dem5b/dem_png)を取得せず、欠測 1px は NaN のまま後段に委ねる。
        const minorHoles = makeImageGrid(4, 1);
        setupLoadImageMocks(minorHoles);

        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(() =>
            Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response)
        );
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(15, 100, 200);

        // dem5a(成功・微小穴) のみ。閾値以下なので dem5b/dem_png は取得しない。
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain("dem5a_png");
        // 欠測 1px は NaN のまま（後段 fillInvalidPixels が局所補間する）
        expect(Number.isNaN(elev[0])).toBe(true);
        expect(Number.isNaN(elev[1])).toBe(false);
    });

    it("閾値超の部分欠測は、同一ズームで埋まらなければ粗ズーム dem_png で穴埋めする", async () => {
        // dem5a 4×4 のうち 4px no-data = 25% > COMPOSITE_HOLE_RATIO(0.1) → 下位レイヤー合成。
        // dem5b(同一ズーム z15) は 404、dem_png(z15) は配信上限超でスキップ。穴が閾値超のため
        // 粗ズーム dem_png(z14) で穴埋め。
        const partialHoles = makeImageGrid(4, 4);
        const coarseFull = makeImageGrid(4, 0); // 粗ズーム dem_png: 全有効(256.0)
        setupLoadImageSequenceMocks([partialHoles, coarseFull]);

        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>((input) => {
            const url = String(input);
            // dem5b（同一ズーム z15）は 404。粗ズーム dem_png(z14) は成功。dem_png(z15) は呼ばれない。
            if (url.includes("dem5b_png")) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response);
        });
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(15, 100, 200);

        // dem5a(z15) → dem5b(z15,404) → dem_png(z14) の 3 取得（dem_png z15 はスキップ）
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0][0]).toContain("dem5a_png/15/");
        expect(fetchMock.mock.calls[1][0]).toContain("dem5b_png/15/");
        expect(fetchMock.mock.calls[2][0]).toContain("dem_png/14/50/100.png");
        // 25% の欠測が粗ズーム dem_png の実標高で埋まる
        for (let i = 0; i < elev.length; i++) expect(elev[i]).toBeCloseTo(256.0);
    });

    it("全面 no-data で粗ズームも未配信なら NaN のまま（後段の湖面処理に委ねる）", async () => {
        // dem5a 全面 no-data(HTTP 200・全画素 128,0,0) → dem5b(z15) 404 → dem_png(z15) はスキップ
        // → 粗ズーム dem_png(z14..z10) も全て 404。どこにも実標高が無いため all-NaN を維持し、
        // 後段（refineAllNaNTiles 等）に委ねる。
        const allNoData = makeImageGrid(2, 4);
        setupLoadImageMocks(allNoData);

        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>((input) => {
            const url = String(input);
            // dem5a(z15) のみ 200。それ以外（dem5b/粗ズーム dem_png）は全て 404。
            if (url.includes("dem5a_png")) {
                return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response);
            }
            return Promise.resolve({ ok: false, status: 404 } as Response);
        });
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(15, 100, 200);

        // dem5a(200) + dem5b(404) + 粗ズーム dem_png z14..z10(5 段) = 7 取得（dem_png z15 はスキップ）
        expect(fetchMock).toHaveBeenCalledTimes(7);
        for (let i = 0; i < elev.length; i++) expect(Number.isNaN(elev[i])).toBe(true);
    });

    it("粗ズーム補填中の一時障害（非404）は握りつぶさず伝播する", async () => {
        // dem5a 全面 no-data → dem5b(z15) 404 → 粗ズーム dem_png(z14) でネットワーク障害(reject)。
        // 404 と区別し、穴埋め未完のまま誤った標高を返さず例外を伝播する（バックオフ再取得に委ねる）。
        const allNoData = makeImageGrid(2, 4);
        setupLoadImageMocks(allNoData);

        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>((input) => {
            const url = String(input);
            if (url.includes("dem5a_png")) {
                return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response);
            }
            if (url.includes("dem5b_png")) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            // 粗ズーム dem_png(z14): ネットワーク障害（HTTP 404 ではない一時障害）
            return Promise.reject(new Error("network down"));
        });
        globalThis.fetch = fetchMock;

        await expect(loadElevationTile(15, 100, 200)).rejects.toThrow(/network down/);
        // dem5a(200) + dem5b(404) + 粗ズーム dem_png(z14, 一時障害で打ち切り) = 3 取得
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("HTTP 失敗時のみ次レイヤーへフォールバックする", async () => {
        // dem5a → 404, dem5b → 有効データ (R=0, G=100, B=0 → 25600*0.01 = 256.0)
        const validImageData = makeImageDataResult(0, 100, 0);
        setupLoadImageMocks(validImageData);

        let callCount = 0;
        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(() => {
            callCount++;
            if (callCount === 1) {
                // dem5a: HTTP 失敗
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            // dem5b: HTTP 成功
            return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) } as Response);
        });
        globalThis.fetch = fetchMock;

        const elev = await loadElevationTile(15, 100, 200);

        // dem5a → 失敗, dem5b → 成功（有効値で穴なし）→ dem は取得しないので 2 回
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toContain("dem5a_png");
        expect(fetchMock.mock.calls[1][0]).toContain("dem5b_png");

        // dem5b の有効値が返る
        expect(elev).toBeInstanceOf(Float32Array);
        expect(Number.isNaN(elev[0])).toBe(false);
    });

    it("全レイヤー HTTP 失敗時はエラーを投げる", async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve({ ok: false, status: 404 } as Response)
        );
        globalThis.fetch = fetchMock;

        // z14 では dem_png も同一ズームで試行されるため 3 レイヤー全て 404 → throw。
        await expect(loadElevationTile(14, 100, 200)).rejects.toThrow(
            /No elevation tile available/
        );

        // 3 レイヤー全て試行
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("全レイヤー 404（決定的未配信）なら TileFetchError.status=404 を投げる", async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve({ ok: false, status: 404 } as Response)
        );
        globalThis.fetch = fetchMock;

        // status=404 は呼び出し側（globe）が粗ズームフォールバックを発動してよい決定的未配信の合図。
        await expect(loadElevationTile(14, 100, 200)).rejects.toMatchObject({
            name: "TileFetchError",
            status: 404,
        });
    });

    it("一時的な取得失敗が混じる場合は TileFetchError.status=undefined を投げる", async () => {
        const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>((input) => {
            const url = String(input);
            // dem5a はネットワーク障害（reject）、それ以外は 404。一時障害が混じるため決定的 404 ではない。
            if (url.includes("dem5a_png")) return Promise.reject(new Error("network down"));
            return Promise.resolve({ ok: false, status: 404 } as Response);
        });
        globalThis.fetch = fetchMock;

        // status=undefined は一時障害の合図。globe は粗ズームへ倒さずバックオフ再取得する。
        const err = await loadElevationTile(14, 100, 200).catch((e) => e);
        expect(err).toBeInstanceOf(TileFetchError);
        expect((err as TileFetchError).status).toBeUndefined();
    });
});

describe("tileCenterLatLon", () => {
    it("zoom=0 の唯一のタイル中心は (0, 0) である", () => {
        const { lat, lon } = tileCenterLatLon(0, 0, 0);
        expect(lon).toBeCloseTo(0, 5);
        expect(lat).toBeCloseTo(0, 1);
    });

    it("toTileXY で得たタイルの中心は元の座標に近い（zoom=18, 奥多摩）", () => {
        const inputLat = 35.79210805;
        const inputLon = 139.04890088;
        const zoom = 18;
        const { x, y } = toTileXY(inputLat, inputLon, zoom);
        const { lat, lon } = tileCenterLatLon(x, y, zoom);

        // タイル1辺 ≈ 124m → 中心と端の最大差 ≈ 62m ≈ 0.00056°
        expect(Math.abs(lat - inputLat)).toBeLessThan(0.001);
        expect(Math.abs(lon - inputLon)).toBeLessThan(0.001);
    });

    it("lon は (x+0.5)/2^zoom*360-180 の計算式と一致する", () => {
        const zoom = 14;
        const x = 14552;
        const y = 6451;
        const { lon } = tileCenterLatLon(x, y, zoom);
        const expected = ((x + 0.5) / 2 ** zoom) * 360 - 180;
        expect(lon).toBeCloseTo(expected, 10);
    });

    it("toTileXY との往復でタイル中心が同一タイルに属する", () => {
        const zoom = 18;
        const x = 232500;
        const y = 103000;
        const { lat, lon } = tileCenterLatLon(x, y, zoom);
        const back = toTileXY(lat, lon, zoom);
        expect(back.x).toBe(x);
        expect(back.y).toBe(y);
    });
});
