/**
 * terrain/diorama/dioramaTexture の単体テスト（純粋関数 computeDioramaTextureLayout のみ）。
 *
 * fetch/canvas を伴う `buildDioramaMosaicTexture` はブラウザ実行が前提のため、
 * ここではタイル数・モザイクサイズ・UV計算のレイアウトロジックのみを検証する。
 */
import { describe, it, expect } from "vitest";

import { computeDioramaTextureLayout } from "../src/terrain/diorama/dioramaTexture";
import { TILE_SIZE, toTileXY } from "../src/terrain/gsiTile";

const TOKYO = { lat: 35.681236, lon: 139.767125 };
const ZOOM = 16;

describe("computeDioramaTextureLayout", () => {
    it("単一点では1タイルのみが必要になる", () => {
        const layout = computeDioramaTextureLayout([TOKYO], ZOOM);
        expect(layout.tiles.length).toBe(1);
        expect(layout.mosaicWidthPx).toBe(TILE_SIZE);
        expect(layout.mosaicHeightPx).toBe(TILE_SIZE);
        expect(layout.uvs.length).toBe(1);
    });

    it("点が跨るタイルの矩形バウンディングボックス分だけタイルを列挙する（重複なし）", () => {
        const { x, y } = toTileXY(TOKYO.lat, TOKYO.lon, ZOOM);
        // 隣接タイル（東・南）にまたがる点を用意し、2x2のバウンディングボックスにする。
        const points = [
            TOKYO,
            { lat: TOKYO.lat - 0.02, lon: TOKYO.lon + 0.02 },
        ];
        const { x: x2, y: y2 } = toTileXY(points[1].lat, points[1].lon, ZOOM);
        expect(x2).toBeGreaterThan(x);
        expect(y2).toBeGreaterThan(y);

        const layout = computeDioramaTextureLayout(points, ZOOM);
        const expectedTileCount = (x2 - x + 1) * (y2 - y + 1);
        expect(layout.tiles.length).toBe(expectedTileCount);
        expect(layout.mosaicWidthPx).toBe((x2 - x + 1) * TILE_SIZE);
        expect(layout.mosaicHeightPx).toBe((y2 - y + 1) * TILE_SIZE);

        // タイル座標に重複がないこと。
        const keys = new Set(layout.tiles.map((t) => `${t.x}/${t.y}`));
        expect(keys.size).toBe(layout.tiles.length);
    });

    it("各タイルのオフセットはバウンディングボックス左上を基準にTILE_SIZE刻み", () => {
        const layout = computeDioramaTextureLayout(
            [TOKYO, { lat: TOKYO.lat - 0.02, lon: TOKYO.lon + 0.02 }],
            ZOOM,
        );
        for (const tile of layout.tiles) {
            expect(tile.offsetX % TILE_SIZE).toBe(0);
            expect(tile.offsetY % TILE_SIZE).toBe(0);
            expect(tile.offsetX).toBeGreaterThanOrEqual(0);
            expect(tile.offsetY).toBeGreaterThanOrEqual(0);
            expect(tile.offsetX).toBeLessThan(layout.mosaicWidthPx);
            expect(tile.offsetY).toBeLessThan(layout.mosaicHeightPx);
        }
    });

    it("UVは [0,1] の範囲に収まる", () => {
        const layout = computeDioramaTextureLayout(
            [TOKYO, { lat: TOKYO.lat - 0.02, lon: TOKYO.lon + 0.02 }],
            ZOOM,
        );
        for (const uv of layout.uvs) {
            expect(uv.u).toBeGreaterThanOrEqual(0);
            expect(uv.u).toBeLessThanOrEqual(1);
            expect(uv.v).toBeGreaterThanOrEqual(0);
            expect(uv.v).toBeLessThanOrEqual(1);
        }
    });

    it("空の点群はRangeError", () => {
        expect(() => computeDioramaTextureLayout([], ZOOM)).toThrow(RangeError);
    });

    it("zoomが非整数はRangeError", () => {
        expect(() => computeDioramaTextureLayout([TOKYO], 16.5)).toThrow(RangeError);
    });

    it("zoomが負数はRangeError", () => {
        expect(() => computeDioramaTextureLayout([TOKYO], -1)).toThrow(RangeError);
    });

    it("latがNaNの点を含む場合はRangeError", () => {
        expect(() => computeDioramaTextureLayout([{ lat: NaN, lon: 0 }], ZOOM)).toThrow(RangeError);
    });

    it("lonがInfinityの点を含む場合はRangeError", () => {
        expect(() =>
            computeDioramaTextureLayout([TOKYO, { lat: 35, lon: Infinity }], ZOOM),
        ).toThrow(RangeError);
    });
});
