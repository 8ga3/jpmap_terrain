import {
    TILE_SIZE,
    JAPAN_BOUNDS,
    clamp,
    toTileXY,
    tileEdgeMeters,
    decodeGsiElevation,
    isAllNaN,
    fillInvalidPixels,
    stdTextureUrl,
    photoTextureUrl,
    textureUrl,
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

    it("全 NaN の場合は NO_DATA_SENTINEL (-100) にフォールバックする", () => {
        const data = new Float32Array([NaN, NaN, NaN, NaN]);
        fillInvalidPixels(data, 2, 2);
        expect(Array.from(data)).toEqual([-100, -100, -100, -100]);
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
