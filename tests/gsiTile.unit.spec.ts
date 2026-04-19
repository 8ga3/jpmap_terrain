import {
    TILE_SIZE,
    JAPAN_BOUNDS,
    clamp,
    toTileXY,
    tileEdgeMeters,
    decodeGsiElevation,
    stdTextureUrl,
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
