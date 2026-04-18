import { toTileKey, tileOffsetToWorld, worldToTileOffset } from "../src/terrain/tileTypes";
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
});

describe("worldToTileOffset", () => {
    it("ワールド原点から dx=0, dy=0 を返す", () => {
        const { dx, dy } = worldToTileOffset(0, 0, 100);
        expect(dx).toBe(0);
        expect(dy).toBe(0);
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
