import { test, expect } from "./tileCache.fixture";

/**
 * Issue #157: `/viewer/@...` および `/timelapse/@...` のデモ識別子付きパスで
 * 直接アクセス（リロード相当）した際に、HtmlWebpackPlugin が inject する script 等が
 * 相対パスで解決されて 404 になる回帰を防止する E2E テスト。
 *
 * - `/js/` 配下のレスポンスが全て成功 (response.ok()) であること
 * - `<canvas>` が表示され、サイズがゼロでないこと（= 起動した）
 * を確認する。スナップショット比較は flaky 回避のため行わない。
 */

const targets: { name: string; url: string }[] = [
    {
        name: "viewer @-path reload",
        url: "/viewer/@35.681236,139.767125",
    },
    {
        name: "timelapse @-path reload",
        url: "/timelapse/@35.681236,139.767125",
    },
];

for (const target of targets) {
    test(`${target.name} loads scripts and renders canvas`, async ({ page }) => {
        const failedJsResponses: { url: string; status: number }[] = [];
        page.on("response", (response) => {
            const url = response.url();
            if (url.includes("/js/") && !response.ok()) {
                failedJsResponses.push({ url, status: response.status() });
            }
        });

        await page.goto(target.url);
        await page.waitForLoadState("domcontentloaded");

        const canvas = page.locator("canvas").first();
        await expect(canvas).toBeVisible({ timeout: 30000 });

        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);

        // シーン起動完了を待つ（`src/demos/{viewer,timelapse}/index.ts` で
        // NODE_ENV!=='production' 時に `window.scene` を公開している）。
        // `failedJsResponses` を判定する前に、遅延チャンクや初期タイル取得が
        // 出揃うまで待機することでレースを防ぐ (Issue #157 PR レビュー対応)。
        await page.waitForFunction(
            () => {
                const w = window as unknown as {
                    scene?: { isReady: () => boolean };
                };
                return !!w.scene && w.scene.isReady();
            },
            { timeout: 30000 },
        );
        await page.waitForLoadState("networkidle", { timeout: 60000 });

        expect(failedJsResponses).toEqual([]);
    });
}
