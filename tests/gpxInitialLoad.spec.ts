import { expect, test } from "./tileCache.fixture";

test("GPX Viewer initially displays the bundled sample and allows replacement", async ({
    page,
}) => {
    await page.goto("/gpx.html");

    const status = page.locator("#gpx-status");
    await expect(status).toContainText("剱岳-2025-07-27", { timeout: 60000 });
    await expect(page.locator("#btn-track")).toBeEnabled();
    await expect(page.locator("#gpx-elevation-panel")).toHaveClass(/visible/);

    await page.evaluate(() => {
        const replacementGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>置き換えトラック</name>
    <trkseg>
      <trkpt lat="35.0" lon="139.0"><ele>100</ele><time>2025-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="35.01" lon="139.01"><ele>110</ele><time>2025-01-01T00:01:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
            new File([replacementGpx], "replacement.gpx", {
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
    });

    await expect(status).toContainText("置き換えトラック");
    await expect(status).not.toContainText("剱岳-2025-07-27");
});
