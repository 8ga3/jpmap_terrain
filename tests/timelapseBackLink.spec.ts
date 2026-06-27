import { test, expect } from "./tileCache.fixture";

/**
 * タイムラプスデモの戻るリンクからポータルへ戻れない不具合の回帰防止。
 *
 * URL が `/timelapse/@lat,lon,...` 形式に書き換えられるようになった結果、
 * 相対パス `href="./"` は `/timelapse/` に解決され、SPA rewrite で
 * 再びタイムラプス HTML へフォールバックされてしまっていた。
 * 戻るリンクは絶対パス `/` を指し、ポータル (`<ul class="demos">`) へ遷移すること。
 */
test("timelapse back-link navigates to portal even after URL is rewritten to /timelapse/@...", async ({ page }) => {
    await page.goto("/timelapse/@35.681236,139.767125");
    await page.waitForLoadState("domcontentloaded");

    const backLink = page.locator(".back-link");
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute("href", "/");

    await backLink.click();
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("ul.demos")).toBeVisible({ timeout: 10000 });
    expect(new URL(page.url()).pathname).toBe("/");
});
