/**
 * terrain/diorama/dioramaElevation の単体テスト。
 *
 * - 単一タイル内の点は該当タイルのバイリニア標高を返す
 * - 複数タイルに跨る点群は、タイル座標ごとに `loadElevationTile` が重複なく呼ばれる
 * - タイル取得失敗時は 0m にフォールバックし、処理全体は継続する
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/terrain/gsiTile", async () => {
    const actual = (await vi.importActual(
        "../src/terrain/gsiTile",
    )) as typeof import("../src/terrain/gsiTile");
    return {
        ...actual,
        loadElevationTile: vi.fn(),
    };
});

import { loadElevationTile, TILE_SIZE, toTileXY } from "../src/terrain/gsiTile";
import { fetchDioramaElevations } from "../src/terrain/diorama/dioramaElevation";

const mockLoadElevationTile = vi.mocked(loadElevationTile);

/** 全ピクセルが同じ標高値のタイルを生成する。 */
const constTile = (value: number): Float32Array =>
    new Float32Array(TILE_SIZE * TILE_SIZE).fill(value);

const TOKYO = { lat: 35.681236, lon: 139.767125 };
const ZOOM = 14;

beforeEach(() => {
    mockLoadElevationTile.mockReset();
});

describe("fetchDioramaElevations", () => {
    it("単一点・定数標高タイルではその値を返す", async () => {
        mockLoadElevationTile.mockResolvedValue(constTile(123.5));
        const elevations = await fetchDioramaElevations([TOKYO], ZOOM);
        expect(elevations.length).toBe(1);
        expect(elevations[0]).toBeCloseTo(123.5, 5);
    });

    it("戻り値の順序は入力点群の順序と一致する", async () => {
        mockLoadElevationTile.mockResolvedValue(constTile(100));
        const points = [TOKYO, { lat: TOKYO.lat + 0.0001, lon: TOKYO.lon } , TOKYO];
        const elevations = await fetchDioramaElevations(points, ZOOM);
        expect(elevations.length).toBe(3);
        for (const e of elevations) expect(e).toBeCloseTo(100, 5);
    });

    it("同一タイルに収まる複数点では loadElevationTile は1回だけ呼ばれる", async () => {
        mockLoadElevationTile.mockResolvedValue(constTile(50));
        const nearbyPoints = Array.from({ length: 5 }, (_, i) => ({
            lat: TOKYO.lat + i * 0.00001,
            lon: TOKYO.lon + i * 0.00001,
        }));
        await fetchDioramaElevations(nearbyPoints, ZOOM);
        expect(mockLoadElevationTile).toHaveBeenCalledTimes(1);
    });

    it("異なるタイルに跨る点群では、タイルごとに1回ずつ重複なく呼ばれる", async () => {
        // 十分離れた2点（別タイルになるよう大きくオフセット）。
        const farPoint = { lat: TOKYO.lat + 1, lon: TOKYO.lon + 1 };
        const { x: x1, y: y1 } = toTileXY(TOKYO.lat, TOKYO.lon, ZOOM);
        const { x: x2, y: y2 } = toTileXY(farPoint.lat, farPoint.lon, ZOOM);
        expect(`${x1}/${y1}`).not.toBe(`${x2}/${y2}`);

        mockLoadElevationTile.mockResolvedValue(constTile(10));
        await fetchDioramaElevations([TOKYO, farPoint], ZOOM);
        expect(mockLoadElevationTile).toHaveBeenCalledTimes(2);
    });

    it("タイル取得失敗時は該当点の標高を0mにフォールバックし、例外を投げない", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        mockLoadElevationTile.mockRejectedValue(new Error("network error"));
        const elevations = await fetchDioramaElevations([TOKYO], ZOOM);
        expect(elevations[0]).toBe(0);
        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });
});
