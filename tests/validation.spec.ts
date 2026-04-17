import { test, expect } from "@playwright/test";

const scenes: {
    name: string;
    url: string;
    waitForNetworkIdle?: boolean;
    renderCount?: number;
}[] = [
    {
        name: "Default",
        url: "/?scene=default",
    },
];

const engines = ["WebGL2", "WebGPU"];

test.beforeEach(async ({ page }) => {
    await page.goto("/", { timeout: 120000 });
});

for (const scene of scenes) {
    for (const engine of engines) {
        test(`Render ${scene.name} with ${engine}`, async ({
            page,
        }, testInfo) => {
            const sceneUrl = new URL(scene.url, "http://localhost");
            sceneUrl.searchParams.set("engine", engine);
            await page.goto(
                `${sceneUrl.pathname}${sceneUrl.search}${sceneUrl.hash}`
            );
            if (scene.waitForNetworkIdle) {
                await page.waitForLoadState("networkidle");
            }
            if (scene.renderCount) {
                await page.evaluate(() => {
                    const raf = window.requestAnimationFrame;
                    (window as any).renderCount = 0;
                    window.requestAnimationFrame = (
                        cb: FrameRequestCallback
                    ) => {
                        (window as any).renderCount++;
                        return raf(cb);
                    };
                });
            }
            await page.waitForFunction(
                () => (window as any).scene && (window as any).scene.isReady(),
                { timeout: 5000 }
            );
            // reset render count
            await page.evaluate(() => {
                (window as any).renderCount = 0;
            });
            // await page.waitForFunction(() => (window as any).renderCount === scene.renderCount || 1, { timeout: 5000 });
            // 注意:
            // スナップショット更新（--update-snapshots）は定常手順ではありません。
            // UI/描画結果に意図した変更が入った場合のみ実行します。
            await expect(page).toHaveScreenshot({
                timeout: 30000,
            });
            expect(testInfo.errors).toHaveLength(0);
        });
    }
}
