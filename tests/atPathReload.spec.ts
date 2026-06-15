import { test, expect } from "./tileCache.fixture";

/**
 * Issue #157: `/viewer/@...` および `/timelapse/@...` のデモ識別子付きパスで
 * 直接アクセス（リロード相当）した際に、HtmlWebpackPlugin が inject する script 等が
 * 相対パスで解決されて 404 になる回帰を防止する E2E テスト。
 *
 * - `/js/` 配下のリクエストが全て成功（response.ok() かつ requestfailed なし）であること
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
        const failedJs: string[] = [];
        // `/js/` チャンクの取得状況を追跡する。タイル取得が継続して
        // `networkidle` に到達しない環境でも、スクリプト読み込みの完了だけを
        // 根拠に判定できるようにする（Issue #157 の趣旨は /js/ ロード成功確認）。
        let pendingJs = 0;
        page.on("request", (request) => {
            if (request.url().includes("/js/")) pendingJs++;
        });
        const onJsSettled = (request: { url(): string }) => {
            if (request.url().includes("/js/")) pendingJs = Math.max(0, pendingJs - 1);
        };
        page.on("requestfinished", onJsSettled);
        page.on("requestfailed", (request) => {
            onJsSettled(request);
            // ネットワーク切断/abort 等で response が発火しないケース（requestfailed）も
            // 取りこぼさず失敗として記録する（/js/ ロード成功検証への忠実性, #157 PR レビュー）。
            if (request.url().includes("/js/")) {
                failedJs.push(`${request.url()} (requestfailed: ${request.failure()?.errorText ?? "unknown"})`);
            }
        });
        page.on("response", (response) => {
            const url = response.url();
            if (url.includes("/js/") && !response.ok()) {
                failedJs.push(`${url} (HTTP ${response.status()})`);
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
        await page.waitForFunction(
            () => {
                const w = window as unknown as {
                    scene?: { isReady: () => boolean };
                };
                return !!w.scene && w.scene.isReady();
            },
            { timeout: 30000 },
        );
        // 遅延チャンクや初期タイル取得が出揃うまで待機することでレースを防ぐ
        // (Issue #157 PR レビュー対応)。タイル取得は継続し得るため全体の
        // `networkidle` ではなく、`/js/` チャンクの取得が完了する（in-flight が
        // 0 に収束する）ことを待つ。
        await expect
            .poll(() => pendingJs, { timeout: 60000, intervals: [250, 500, 1000] })
            .toBe(0);

        expect(failedJs).toEqual([]);
    });
}
