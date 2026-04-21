/** LRU キャッシュ（標高データ用） */

import { TileKey, TileCoord } from "./tileTypes";

export interface TileCacheEntry {
    coord: TileCoord;
    elevation: Float32Array;
    isOcean?: boolean;
}

export interface TileCache {
    get(key: TileKey): TileCacheEntry | undefined;
    set(key: TileKey, entry: TileCacheEntry): void;
    has(key: TileKey): boolean;
    clear(): void;
    readonly size: number;
}

/** Map の挿入順序を利用した LRU キャッシュを生成 */
export const createTileCache = (capacity: number): TileCache => {
    const map = new Map<TileKey, TileCacheEntry>();

    return {
        get(key: TileKey): TileCacheEntry | undefined {
            const entry = map.get(key);
            if (entry === undefined) return undefined;
            // LRU 更新: delete して re-insert
            map.delete(key);
            map.set(key, entry);
            return entry;
        },

        set(key: TileKey, entry: TileCacheEntry): void {
            if (map.has(key)) {
                map.delete(key);
            }
            map.set(key, entry);
            // capacity 超過時に最古エントリを削除
            if (map.size > capacity) {
                const oldest = map.keys().next().value;
                if (oldest !== undefined) {
                    map.delete(oldest);
                }
            }
        },

        has(key: TileKey): boolean {
            return map.has(key);
        },

        clear(): void {
            map.clear();
        },

        get size(): number {
            return map.size;
        },
    };
};
