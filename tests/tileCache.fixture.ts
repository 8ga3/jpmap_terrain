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
        if (typeof meta.contentType !== "string" || typeof meta.status !== "number") {
            // 旧形式または壊れたメタを削除してキャッシュミス扱いにする
            fs.unlinkSync(metaPath);
            fs.unlinkSync(bodyPath);
            return null;
        }
        const body = fs.readFileSync(bodyPath);
        return { body, contentType: meta.contentType, status: meta.status };
    } catch {
        // JSON 破損や読み取りエラーの場合は残存ファイルを best-effort で削除して
        // 自己修復し、キャッシュミス扱いとする
        try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
        try { fs.unlinkSync(bodyPath); } catch { /* ignore */ }
        return null;
    }
}

function writeToDisk(url: string, entry: CacheEntry): void {
    ensureCacheDir();
    const filename = urlToFilename(url);
    const metaPath = path.join(CACHE_DIR, `${filename}.json`);
    const bodyPath = path.join(CACHE_DIR, `${filename}.bin`);
    // テンポラリファイルへ書き込んでから rename でアトミックに置き換える。
    // 途中でプロセスが中断しても半壊ファイルが残らない。
    const metaTmp = `${metaPath}.tmp`;
    const bodyTmp = `${bodyPath}.tmp`;
    try {
        fs.writeFileSync(
            metaTmp,
            JSON.stringify({
                url,
                contentType: entry.contentType,
                status: entry.status,
            }),
        );
        fs.writeFileSync(bodyTmp, entry.body);
        fs.renameSync(metaTmp, metaPath);
        fs.renameSync(bodyTmp, bodyPath);
    } catch (e) {
        // 書き込み/rename 失敗時は tmp ファイルを削除して例外を伝播する
        try { fs.unlinkSync(metaTmp); } catch { /* ignore */ }
        try { fs.unlinkSync(bodyTmp); } catch { /* ignore */ }
        throw e;
    }
}

function setMemoryCache(url: string, entry: CacheEntry): void {
    if (memoryCache.size >= MEMORY_CACHE_MAX) {
        const oldest = memoryCache.keys().next().value;
        if (oldest !== undefined) memoryCache.delete(oldest);
    }
    memoryCache.set(url, entry);
}

function getCache(url: string): CacheEntry | null {
    const mem = memoryCache.get(url);
    if (mem) return mem;
    const disk = readFromDisk(url);
    if (disk) {
        setMemoryCache(url, disk);
        return disk;
    }
    return null;
}

function setCache(url: string, entry: CacheEntry): void {
    setMemoryCache(url, entry);
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
            const body = await response.body();
            const contentType =
                response.headers()["content-type"] ?? "application/octet-stream";
            // 非2xx またはイメージ以外はキャッシュせずそのまま返す
            if (!response.ok() || !contentType.startsWith("image/")) {
                await route.fulfill({
                    status: response.status(),
                    contentType,
                    body,
                });
                return;
            }
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
