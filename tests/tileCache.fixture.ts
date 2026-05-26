/**
 * Playwright fixture: GSI タイルレスポンスをディスク＋メモリにキャッシュし、
 * テスト間・テストラン間で使い回す。
 *
 * - 標高 PNG (dem*) とテクスチャ PNG/JPG (std, seamlessphoto) を対象
 * - 初回リクエストのみ実ネットワークに出る。以降はキャッシュから即座に返す
 * - ディスクキャッシュは `.tile-cache/` ディレクトリに保存（.gitignore 推奨）
 * - workers: 1 前提のため同期的なディスクI/Oでも問題ない
 */
import { test as base } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const GSI_TILE_PATTERN = /cyberjapandata\.gsi\.go\.jp\/xyz\//;

const CACHE_DIR = path.join(__dirname, "..", ".tile-cache");

interface CacheEntry {
    body: Buffer;
    contentType: string;
    status: number;
}

/** メモリキャッシュ（ディスクから読み込み済みのエントリ）。OOM防止のため上限付き */
const MEMORY_CACHE_MAX = 300;
const memoryCache = new Map<string, CacheEntry>();

function urlToFilename(url: string): string {
    const hash = crypto.createHash("sha256").update(url).digest("hex");
    // URL からパス部分も残して人間が読めるようにする
    const urlPath = new URL(url).pathname.replace(/\//g, "_");
    return `${urlPath.slice(0, 80)}_${hash.slice(0, 16)}`;
}

function ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function readFromDisk(url: string): CacheEntry | null {
    const filename = urlToFilename(url);
    const metaPath = path.join(CACHE_DIR, `${filename}.json`);
    const bodyPath = path.join(CACHE_DIR, `${filename}.bin`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(bodyPath)) {
        return null;
    }
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const body = fs.readFileSync(bodyPath);
        return { body, contentType: meta.contentType, status: meta.status };
    } catch {
        return null;
    }
}

function writeToDisk(url: string, entry: CacheEntry): void {
    ensureCacheDir();
    const filename = urlToFilename(url);
    const metaPath = path.join(CACHE_DIR, `${filename}.json`);
    const bodyPath = path.join(CACHE_DIR, `${filename}.bin`);
    fs.writeFileSync(
        metaPath,
        JSON.stringify({
            url,
            contentType: entry.contentType,
            status: entry.status,
        }),
    );
    fs.writeFileSync(bodyPath, entry.body);
}

function getCache(url: string): CacheEntry | null {
    const mem = memoryCache.get(url);
    if (mem) return mem;
    const disk = readFromDisk(url);
    if (disk) {
        memoryCache.set(url, disk);
        return disk;
    }
    return null;
}

function setCache(url: string, entry: CacheEntry): void {
    if (memoryCache.size >= MEMORY_CACHE_MAX) {
        // 最も古いエントリを削除してメモリを確保
        const oldest = memoryCache.keys().next().value;
        if (oldest !== undefined) memoryCache.delete(oldest);
    }
    memoryCache.set(url, entry);
    writeToDisk(url, entry);
}

/**
 * キャッシュ付きの page fixture。
 * 各テストの page に対して `page.route()` を設定し、
 * GSI タイル URL をインターセプトする。
 */
export const test = base.extend({
    page: async ({ page }, use) => {
        await page.route(GSI_TILE_PATTERN, async (route) => {
            const url = route.request().url();
            const cached = getCache(url);
            if (cached) {
                await route.fulfill({
                    status: cached.status,
                    contentType: cached.contentType,
                    body: cached.body,
                });
                return;
            }
            // キャッシュミス: 実ネットワークへフォールスルーし、レスポンスを保存
            const response = await route.fetch();
            const body = Buffer.from(await response.body());
            const contentType =
                response.headers()["content-type"] ?? "application/octet-stream";
            const entry: CacheEntry = { body, contentType, status: response.status() };
            setCache(url, entry);
            await route.fulfill({
                status: entry.status,
                contentType: entry.contentType,
                body: entry.body,
            });
        });
        await use(page);
    },
});

export { expect } from "@playwright/test";
