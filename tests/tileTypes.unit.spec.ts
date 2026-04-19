import { toTileKey, tileOffsetToWorld, worldToTileOffset, convertTileZoom, isChildOf, computeSubTileOffset } from "../src/terrain/tileTypes";
import type { TileCoord } from "../src/terrain/tileTypes";

describe("toTileKey", () => {
    it("TileCoord を 'z/x/y' 形式の文字列に変換する", () => {
        const coord: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        expect(toTileKey(coord)).toBe("14/14547/6452");
    });

    it("zoom=0 の場合", () => {
        expect(toTileKey({ zoom: 0, x: 0, y: 0 })).toBe("0/0/0");
    });
});

describe("tileOffsetToWorld", () => {
    it("dx=0, dy=0 のときワールド原点を返す", () => {
        const { wx, wz } = tileOffsetToWorld(0, 0, 100);
        expect(wx).toBe(0);
        expect(wz).toBe(0);
    });

    it("dx=1 で正のX方向にオフセット", () => {
        const { wx, wz } = tileOffsetToWorld(1, 0, 200);
        expect(wx).toBe(200);
        expect(wz).toBe(0);
    });

    it("dy=1 で負のZ方向にオフセット（タイルY軸反転）", () => {
        const { wx, wz } = tileOffsetToWorld(0, 1, 200);
        expect(wx).toBe(0);
        expect(wz).toBe(-200);
    });

    it("dx=-1, dy=-1 の場合", () => {
        const { wx, wz } = tileOffsetToWorld(-1, -1, 150);
        expect(wx).toBe(-150);
        expect(wz).toBe(150);
    });

    it("NaN 入力はそのまま伝播する", () => {
        const { wz } = tileOffsetToWorld(0, NaN, 100);
        expect(wz).toBeNaN();
    });
});

describe("worldToTileOffset", () => {
    it("ワールド原点から dx=0, dy=0 を返す", () => {
        const { dx, dy } = worldToTileOffset(0, 0, 100);
        expect(dx).toBe(0);
        expect(dy).toBe(0);
    });

    it("NaN 入力はそのまま伝播する", () => {
        const { dy } = worldToTileOffset(0, NaN, 100);
        expect(dy).toBeNaN();
    });

    it("tileOffsetToWorld の逆変換が一致する", () => {
        const tileSize = 234.5;
        for (const [origDx, origDy] of [[1, 2], [-3, 4], [0, -1], [5, 5]]) {
            const { wx, wz } = tileOffsetToWorld(origDx, origDy, tileSize);
            const { dx, dy } = worldToTileOffset(wx, wz, tileSize);
            expect(dx).toBe(origDx);
            expect(dy).toBe(origDy);
        }
    });
});

describe("convertTileZoom", () => {
    it("同じzoomなら同じ座標を返す", () => {
        const coord: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        expect(convertTileZoom(coord, 14)).toEqual(coord);
    });

    it("高zoom → 低zoom（1段階）はビット右シフト相当", () => {
        const coord: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const result = convertTileZoom(coord, 13);
        expect(result).toEqual({ zoom: 13, x: 7273, y: 3226 });
    });

    it("高zoom → 低zoom（2段階）", () => {
        const coord: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const result = convertTileZoom(coord, 12);
        expect(result).toEqual({ zoom: 12, x: 3636, y: 1613 });
    });

    it("低zoom → 高zoom（1段階）は左シフト（左上隅）", () => {
        const coord: TileCoord = { zoom: 12, x: 3636, y: 1613 };
        const result = convertTileZoom(coord, 14);
        expect(result).toEqual({ zoom: 14, x: 14544, y: 6452 });
    });
});

describe("isChildOf", () => {
    it("直接の子タイルを判定", () => {
        const child: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const parent: TileCoord = { zoom: 13, x: 7273, y: 3226 };
        expect(isChildOf(child, parent)).toBe(true);
    });

    it("2段階上の親タイルを判定", () => {
        const child: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const parent: TileCoord = { zoom: 12, x: 3636, y: 1613 };
        expect(isChildOf(child, parent)).toBe(true);
    });

    it("異なる親タイルにはfalse", () => {
        const child: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const parent: TileCoord = { zoom: 13, x: 7274, y: 3226 };
        expect(isChildOf(child, parent)).toBe(false);
    });

    it("同じzoomまたは子のzoomが低い場合はfalse", () => {
        const coord: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        expect(isChildOf(coord, coord)).toBe(false);
        expect(isChildOf({ zoom: 12, x: 3636, y: 1613 }, coord)).toBe(false);
    });
});

describe("computeSubTileOffset", () => {
    it("同じzoomではオフセット0", () => {
        const center: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const { fracX, fracY } = computeSubTileOffset(center, 14);
        expect(fracX).toBe(0);
        expect(fracY).toBe(0);
    });

    it("zoom 14→13 のサブタイルオフセット", () => {
        const center: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const { fracX, fracY } = computeSubTileOffset(center, 13);
        // (14547+0.5)/2 - (7273+0.5) = 7273.75 - 7273.5 = 0.25
        expect(fracX).toBeCloseTo(0.25);
        // (6452+0.5)/2 - (3226+0.5) = 3226.25 - 3226.5 = -0.25
        expect(fracY).toBeCloseTo(-0.25);
    });

    it("zoom 14→12 のサブタイルオフセット", () => {
        const center: TileCoord = { zoom: 14, x: 14547, y: 6452 };
        const { fracX, fracY } = computeSubTileOffset(center, 12);
        // (14547+0.5)/4 - (3636+0.5) = 3636.875 - 3636.5 = 0.375
        expect(fracX).toBeCloseTo(0.375);
        // (6452+0.5)/4 - (1613+0.5) = 1613.125 - 1613.5 = -0.375
        expect(fracY).toBeCloseTo(-0.375);
    });

    it("偶数タイル座標ではオフセットが-0.25になる", () => {
        const center: TileCoord = { zoom: 14, x: 14546, y: 6452 };
        const { fracX } = computeSubTileOffset(center, 13);
        // (14546+0.5)/2 - (7273+0.5) = 7273.25 - 7273.5 = -0.25
        expect(fracX).toBeCloseTo(-0.25);
    });

    it("低zoom→高zoom（diff<=0）ではオフセット0", () => {
        const center: TileCoord = { zoom: 12, x: 3636, y: 1613 };
        const { fracX, fracY } = computeSubTileOffset(center, 14);
        expect(fracX).toBe(0);
        expect(fracY).toBe(0);
    });
});
