import { createTileCache } from "../src/terrain/tileCache";
import type { TileKey, TileCoord } from "../src/terrain/tileTypes";

const makeEntry = (zoom: number, x: number, y: number) => ({
    coord: { zoom, x, y } as TileCoord,
    elevation: new Float32Array(4),
});

describe("createTileCache", () => {
    it("set/get の基本動作", () => {
        const cache = createTileCache(10);
        const key: TileKey = "14/100/200";
        const entry = makeEntry(14, 100, 200);

        cache.set(key, entry);
        expect(cache.has(key)).toBe(true);
        expect(cache.get(key)).toBe(entry);
        expect(cache.size).toBe(1);
    });

    it("存在しないキーの get は undefined を返す", () => {
        const cache = createTileCache(10);
        expect(cache.get("14/0/0")).toBeUndefined();
    });

    it("capacity 超過時に最古エントリが削除される", () => {
        const cache = createTileCache(3);

        cache.set("14/1/1", makeEntry(14, 1, 1));
        cache.set("14/2/2", makeEntry(14, 2, 2));
        cache.set("14/3/3", makeEntry(14, 3, 3));
        expect(cache.size).toBe(3);

        // 4つ目を追加 → 最古の 14/1/1 が消える
        cache.set("14/4/4", makeEntry(14, 4, 4));
        expect(cache.size).toBe(3);
        expect(cache.has("14/1/1")).toBe(false);
        expect(cache.has("14/2/2")).toBe(true);
        expect(cache.has("14/3/3")).toBe(true);
        expect(cache.has("14/4/4")).toBe(true);
    });

    it("get で LRU が更新される", () => {
        const cache = createTileCache(3);

        cache.set("14/1/1", makeEntry(14, 1, 1));
        cache.set("14/2/2", makeEntry(14, 2, 2));
        cache.set("14/3/3", makeEntry(14, 3, 3));

        // 14/1/1 を get して LRU を更新
        cache.get("14/1/1");

        // 4つ目を追加 → 最古は 14/2/2 になっているはず
        cache.set("14/4/4", makeEntry(14, 4, 4));
        expect(cache.has("14/1/1")).toBe(true);
        expect(cache.has("14/2/2")).toBe(false);
    });

    it("clear で全エントリが削除される", () => {
        const cache = createTileCache(10);
        cache.set("14/1/1", makeEntry(14, 1, 1));
        cache.set("14/2/2", makeEntry(14, 2, 2));

        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.has("14/1/1")).toBe(false);
    });

    it("同じキーで set するとエントリが上書きされる", () => {
        const cache = createTileCache(3);
        const entry1 = makeEntry(14, 1, 1);
        const entry2 = makeEntry(14, 1, 1);

        cache.set("14/1/1", entry1);
        cache.set("14/1/1", entry2);

        expect(cache.size).toBe(1);
        expect(cache.get("14/1/1")).toBe(entry2);
    });
});
