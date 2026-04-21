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
        waitForNetworkIdle: true,
    },
];

const engines = [
    { name: "WebGL2", param: "webgl" },
    { name: "WebGPU", param: "webgpu" },
];

for (const scene of scenes) {
    for (const engine of engines) {
        test(`Render ${scene.name} with ${engine.name}`, async ({
            page,
        }, testInfo) => {
            const sceneUrl = new URL(scene.url, "http://localhost");
            sceneUrl.searchParams.set("engine", engine.param);
            await page.goto(
                `${sceneUrl.pathname}${sceneUrl.search}${sceneUrl.hash}`
            );
            if (scene.waitForNetworkIdle) {
                await page.waitForLoadState("networkidle", { timeout: 30000 });
                // タイル読み込み後の描画安定待ち
                await page.waitForTimeout(3000);
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
                maxDiffPixelRatio: 0.02,
            });
            expect(testInfo.errors).toHaveLength(0);
        });
    }
}

// ---------- UI操作テスト ----------

/** シーン準備の共通ヘルパー */
async function waitForScene(
    page: import("@playwright/test").Page,
    engine: string
) {
    const sceneUrl = new URL("/?scene=default", "http://localhost");
    sceneUrl.searchParams.set("engine", engine);
    await page.goto(`${sceneUrl.pathname}${sceneUrl.search}`, {
        timeout: 120000,
    });
    await page.waitForFunction(
        () => (window as any).scene && (window as any).scene.isReady(),
        { timeout: 10000 }
    );
    // タイル読み込み完了を待つ
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    // 描画安定のための追加待機
    await page.waitForTimeout(3000);
}

for (const engine of engines) {
    test(`Map toggle button with ${engine.name}`, async ({ page }, testInfo) => {
        await waitForScene(page, engine.param);

        // 地図切替ボタンをクリック（標準 → 写真）
        const mapToggle = page.getByRole("button", {
            name: "地図切替: 写真地図に変更",
        });
        await mapToggle.click();

        // ARIAラベルが切り替わるのを待ち、操作反映を確定
        await expect(
            page.getByRole("button", { name: "地図切替: 標準地図に変更" })
        ).toBeVisible({ timeout: 10000 });

        // タイルテクスチャ再読み込みを待つ
        await page.waitForLoadState("networkidle", { timeout: 30000 });

        // 描画安定のため数フレーム待機
        await page.waitForFunction(
            () =>
                new Promise((resolve) => {
                    let count = 0;
                    const tick = () => {
                        if (++count >= 5) return resolve(true);
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                }),
            { timeout: 5000 }
        );

        await expect(page).toHaveScreenshot({
            timeout: 30000,
            maxDiffPixelRatio: 0.02,
        });
        expect(testInfo.errors).toHaveLength(0);
    });

    test(`Compass reset button with ${engine.name}`, async ({ page }, testInfo) => {
        await waitForScene(page, engine.param);

        // 方位磁針ボタンをクリック（北向きリセット）
        const compass = page.getByRole("button", {
            name: "方位磁針: クリックで北向きにリセット",
        });
        await compass.click();

        // アニメーション完了(400ms) + 描画安定待ち
        await page.waitForTimeout(2000);

        await expect(page).toHaveScreenshot({
            timeout: 30000,
            maxDiffPixelRatio: 0.02,
        });
        expect(testInfo.errors).toHaveLength(0);
    });
}
