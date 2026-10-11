import type { Page } from "@playwright/test";
import { expect, test } from "./tileCache.fixture";

const SAMPLE_GPX_PATTERN = /mt_tsurugi.*\.gpx/;
const SAMPLE_TRACK_NAME = "剱岳-2025-07-27";
const REPLACEMENT_TRACK_NAME = "置き換えトラック";

const REPLACEMENT_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${REPLACEMENT_TRACK_NAME}</name>
    <trkseg>
      <trkpt lat="35.0" lon="139.0"><ele>100</ele><time>2025-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="35.01" lon="139.01"><ele>110</ele><time>2025-01-01T00:01:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** 置き換え用 GPX をドラッグ&ドロップ操作として投入する。 */
const dropReplacementGpx = async (page: Page): Promise<void> => {
    await page.evaluate((gpx) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
            new File([gpx], "replacement.gpx", {
                type: "application/gpx+xml",
            }),
        );
        document.dispatchEvent(
            new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer,
            }),
        );
    }, REPLACEMENT_GPX);
};

test("GPX Viewer initially displays the bundled sample and allows replacement", async ({
    page,
}) => {
    await page.goto("/gpx.html");

    const status = page.locator("#gpx-status");
    await expect(status).toContainText(SAMPLE_TRACK_NAME, { timeout: 60000 });
    await expect(page.locator("#btn-track")).toBeEnabled();
    await expect(page.locator("#gpx-elevation-panel")).toHaveClass(/visible/);

    await dropReplacementGpx(page);

    await expect(status).toContainText(REPLACEMENT_TRACK_NAME);
    await expect(status).not.toContainText(SAMPLE_TRACK_NAME);
});

test("GPX Viewer shows an error status when the sample GPX fails to load", async ({
    page,
}) => {
    await page.route(SAMPLE_GPX_PATTERN, async (route) => {
        if (route.request().resourceType() !== "fetch") {
            await route.fallback();
            return;
        }
        await route.fulfill({ status: 500, body: "Internal Server Error" });
    });

    await page.goto("/gpx.html");

    const status = page.locator("#gpx-status");
    await expect(status).toContainText(
        "サンプル GPX の読み込みに失敗しました",
        {
            timeout: 60000,
        },
    );
    await expect(status).toContainText("HTTP 500");
    await expect(status).not.toContainText(SAMPLE_TRACK_NAME);
    await expect(page.locator("#btn-track")).toBeDisabled();

    // 終了時に残る地形タイル取得ルートのエラーを無視する
    await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("GPX Viewer keeps a track dropped while the sample GPX is still loading", async ({
    page,
}) => {
    // サンプル GPX の取得応答を、ドロップ操作が済むまで保留する。
    let releaseSample: () => void = () => {};
    const sampleReleased = new Promise<void>((resolve) => {
        releaseSample = resolve;
    });
    let notifySampleRequested: () => void = () => {};
    const sampleRequested = new Promise<void>((resolve) => {
        notifySampleRequested = resolve;
    });

    await page.route(SAMPLE_GPX_PATTERN, async (route) => {
        if (route.request().resourceType() !== "fetch") {
            await route.fallback();
            return;
        }
        notifySampleRequested();
        await sampleReleased;
        await route.fallback();
    });

    await page.goto("/gpx.html");
    await sampleRequested;

    const status = page.locator("#gpx-status");
    await dropReplacementGpx(page);
    await expect(status).toContainText(REPLACEMENT_TRACK_NAME);

    const sampleResponse = page.waitForResponse(
        (res) =>
            SAMPLE_GPX_PATTERN.test(res.url()) &&
            res.request().resourceType() === "fetch",
    );
    releaseSample();
    await sampleResponse;
    // 応答到着後にサンプルの描画処理が走る余地を与えてから、置換結果が保たれることを確認する。
    await page.waitForTimeout(1000);

    await expect(status).toContainText(REPLACEMENT_TRACK_NAME);
    await expect(status).not.toContainText(SAMPLE_TRACK_NAME);

    await page.unrouteAll({ behavior: "ignoreErrors" });
});
