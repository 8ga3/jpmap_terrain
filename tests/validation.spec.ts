import { test, expect } from "@playwright/test";

/**
 * VR テストを時刻依存から切り離すための固定クエリ (Issue #35)。
 * - `dateTime`: 夏至日本時間正午 (UTC 表記) — 太陽高度が高く陰影変動が最小。
 * - `autoSunPosition=false`: 自動更新タイマーを起動させずスナップショットを完全決定的にする。
 */
const FIXED_DATETIME = "2025-06-21T03:00:00Z";
const FIXED_AUTO_SUN_POSITION = "false";

const applyDeterministicSunQuery = (url: URL): void => {
    url.searchParams.set("dateTime", FIXED_DATETIME);
    url.searchParams.set("autoSunPosition", FIXED_AUTO_SUN_POSITION);
};

/**
 * 指定フレーム数だけ requestAnimationFrame を待つ。
 * 描画安定を保証するための共通ヘルパー。
 */
async function waitForFrames(
    page: import("@playwright/test").Page,
    frameCount: number,
    timeout = 10000,
): Promise<void> {
    await page.waitForFunction(
        (n: number) =>
            new Promise((resolve) => {
                let count = 0;
                const tick = (): void => {
                    if (++count >= n) return resolve(true);
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }),
        frameCount,
        { timeout },
    );
}

/**
 * カメラ変更後にタイルが完全に安定するまで待つヘルパー。
 *
 * カメラの azimuth/tilt 変更 → debounce (200ms) → refreshFromCamera → タイル読み込み
 * → terrainUpdated → clampCameraAboveTerrain → radius 変更 → 再度 debounce → ...
 * という連鎖リフレッシュを考慮し、複数ラウンドの networkidle を待つ。
 */
async function waitForTerrainStable(
    page: import("@playwright/test").Page,
): Promise<void> {
    // debounce (200ms) + マージンを待ち、refreshFromCamera が発火するのを保証
    await page.waitForTimeout(350);
    await page.waitForLoadState("networkidle", { timeout: 60000 });
    // 連鎖リフレッシュ（terrain collision → radius 変更 → debounce → 再refresh）対応
    await page.waitForTimeout(350);
    await page.waitForLoadState("networkidle", { timeout: 60000 });
    // 描画安定待ち
    await waitForFrames(page, 15);
}

const scenes: {
    name: string;
    url: string;
    waitForNetworkIdle?: boolean;
    renderCount?: number;
}[] = [
    {
        name: "Default",
        url: "/viewer.html?scene=default",
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
            applyDeterministicSunQuery(sceneUrl);
            await page.goto(
                `${sceneUrl.pathname}${sceneUrl.search}${sceneUrl.hash}`
            );
            if (scene.waitForNetworkIdle) {
                await page.waitForLoadState("networkidle", { timeout: 30000 });
                // タイル読み込み後の描画安定待ち（数フレーム経過で確認）
                await waitForFrames(page, 10);
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
            // スナップショット更新（`--update-snapshots=all`）は定常手順ではありません。
            // UI/描画結果に意図した変更が入った場合のみ実行します。
            // Playwright 1.59+ では `--update-snapshots` のデフォルトが `missing` のため、
            // 既存画像を上書きするには `npm run test:visuals:update` を使用してください。
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
    const sceneUrl = new URL("/viewer.html?scene=default", "http://localhost");
    sceneUrl.searchParams.set("engine", engine);
    applyDeterministicSunQuery(sceneUrl);
    await page.goto(`${sceneUrl.pathname}${sceneUrl.search}`, {
        timeout: 120000,
    });
    await page.waitForFunction(
        () => (window as any).scene && (window as any).scene.isReady(),
        { timeout: 10000 }
    );
    // タイル読み込み完了を待つ
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    // 描画安定待ち（数フレーム経過で確認）
    await waitForFrames(page, 10);
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
        await waitForFrames(page, 5, 5000);

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

        // アニメーション完了をカメラ状態で判定（alpha→-π/2, beta→0.1）
        await page.waitForFunction(
            () => {
                const cam = (window as any).scene?.activeCamera;
                if (!cam) return false;
                const targetAlpha = -Math.PI / 2;
                const targetBeta = 0.1;
                return (
                    Math.abs(cam.alpha - targetAlpha) < 0.01 &&
                    Math.abs(cam.beta - targetBeta) < 0.01
                );
            },
            { timeout: 5000 }
        );

        await expect(page).toHaveScreenshot({
            timeout: 30000,
            maxDiffPixelRatio: 0.02,
        });
        expect(testInfo.errors).toHaveLength(0);
    });
}

// ---------- Skybox 昼夜比較テスト (Issue #35) ----------
//
// チルト角を最大近くまで倒して画面上部に Skybox が映り込むようにし、
// `dateTime` を「昼」「夜」で固定した 2 ケースのスクリーンショットを撮る。
// 両者の差異により Skybox が時刻に追従して変化していることを保証する。
//
// 注意: 本テストは「昼/夜のスナップショットそのもの」を VR ベースラインとして固定する。
// 別ケース同士の自動比較は行わず、開発者が両 PNG を目視で比較して差異を確認する運用とする。

const SKYBOX_TILT_DEG = 75;
const DAY_DATETIME = "2025-06-21T12:00:00+09:00"; // JST 12:00（東京で太陽高度 ~75°）
const NIGHT_DATETIME = "2025-06-21T22:00:00+09:00"; // JST 22:00（東京で太陽高度 ~ -25°）
const SUNRISE_DATETIME = "2025-04-25T05:13:00+09:00"; // JST 05:13（東京で東の空に日の出）
/** 夜明け視点：東を向き地平線付近にカメラを向けて太陽メッシュを画面内に映す */
const SUNRISE_AZIMUTH_DEG = 270; // 東向き
const SUNRISE_LAT = 35.690206;
const SUNRISE_LON = 139.766166;

/**
 * Skybox 比較用シーン準備：固定 dateTime でロード後、`viewer.tilt` を最大まで倒す。
 */
async function waitForSceneWithSkybox(
    page: import("@playwright/test").Page,
    engine: string,
    dateTime: string,
) {
    const sceneUrl = new URL("/viewer.html?scene=default", "http://localhost");
    sceneUrl.searchParams.set("engine", engine);
    sceneUrl.searchParams.set("dateTime", dateTime);
    sceneUrl.searchParams.set("autoSunPosition", FIXED_AUTO_SUN_POSITION);
    await page.goto(`${sceneUrl.pathname}${sceneUrl.search}`, {
        timeout: 120000,
    });
    await page.waitForFunction(
        () => (window as any).scene && (window as any).scene.isReady(),
        { timeout: 10000 }
    );
    await page.waitForLoadState("networkidle", { timeout: 30000 });

    // チルト最大に倒して画面上部に空を映す。
    // `viewer.tilt` setter は内部で beta クランプ済み（upperBetaLimit ≈ 75°）。
    await page.evaluate((tiltValue) => {
        (window as any).viewer.tilt = tiltValue;
    }, SKYBOX_TILT_DEG);

    // タイル再評価 + 連鎖リフレッシュ安定待ち
    await waitForTerrainStable(page);
}

for (const engine of engines) {
    test(`Skybox at noon (day) with ${engine.name}`, async ({
        page,
    }, testInfo) => {
        await waitForSceneWithSkybox(page, engine.param, DAY_DATETIME);
        await expect(page).toHaveScreenshot({
            timeout: 30000,
            maxDiffPixelRatio: 0.02,
        });
        expect(testInfo.errors).toHaveLength(0);
    });

    test(`Skybox at night with ${engine.name}`, async ({
        page,
    }, testInfo) => {
        await waitForSceneWithSkybox(page, engine.param, NIGHT_DATETIME);
        await expect(page).toHaveScreenshot({
            timeout: 30000,
            maxDiffPixelRatio: 0.02,
        });
        expect(testInfo.errors).toHaveLength(0);
    });

    test(`Sunrise sun mesh visible with ${engine.name}`, async ({
        page,
    }, testInfo) => {
        // 東京の夜明け（2025-04-25 JST 05:13）に東向きでカメラを構え、太陽メッシュが画面内に映ることを検証する。
        // パス `/@lat,lon` ではなく `?lat=&lon=` クエリ形式を採用（dev-server の historyApiFallback 互換）。
        const sceneUrl = new URL("/viewer.html?scene=default", "http://localhost");
        sceneUrl.searchParams.set("engine", engine.param);
        sceneUrl.searchParams.set("lat", String(SUNRISE_LAT));
        sceneUrl.searchParams.set("lon", String(SUNRISE_LON));
        sceneUrl.searchParams.set("dateTime", SUNRISE_DATETIME);
        sceneUrl.searchParams.set("autoSunPosition", FIXED_AUTO_SUN_POSITION);
        await page.goto(`${sceneUrl.pathname}${sceneUrl.search}`, {
            timeout: 120000,
        });
        await page.waitForFunction(
            () => (window as any).scene && (window as any).scene.isReady(),
            { timeout: 10000 },
        );
        await page.waitForLoadState("networkidle", { timeout: 30000 });

        // 東向き + チルト最大で地平線+空を画面内に収める
        await page.evaluate(
            ({ tilt, azimuth }) => {
                const viewer = (window as any).viewer;
                viewer.azimuth = azimuth;
                viewer.tilt = tilt;
            },
            { tilt: SKYBOX_TILT_DEG, azimuth: SUNRISE_AZIMUTH_DEG },
        );

        // タイル再評価 + 連鎖リフレッシュ安定待ち
        await waitForTerrainStable(page);

        await expect(page).toHaveScreenshot({
            timeout: 30000,
            maxDiffPixelRatio: 0.02,
        });
        expect(testInfo.errors).toHaveLength(0);
    });
}

// ---------- ポリゴン点編集 API 視覚回帰 (Issue #173) ----------
//
// 4 種の点編集 API (insertPolygonPoint / removePolygonPoint /
// updatePolygonPoint / replacePolygonPoints) を順に適用し、
// 「初期」と「最終 (4 API 適用後)」の 2 枚のスクリーンショットを取得して
// VR baseline とする。WebGL2 のみで実行し、時刻と autoSunPosition を固定する。

const POLYGON_EDIT_TARGET_ID = "yomiuri-closed";

async function waitForPolygonScene(
    page: import("@playwright/test").Page,
): Promise<void> {
    const url = new URL("/polygon.html", "http://localhost");
    url.searchParams.set("engine", "webgl");
    applyDeterministicSunQuery(url);
    await page.goto(`${url.pathname}${url.search}`, { timeout: 120000 });
    await page.waitForFunction(
        () =>
            (window as unknown as { scene?: { isReady: () => boolean } }).scene
                ?.isReady?.() ?? false,
        { timeout: 15000 },
    );
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    await waitForFrames(page, 15);
}

test("Polygon point edit (initial) with WebGL2", async ({
    page,
}, testInfo) => {
    await waitForPolygonScene(page);
    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.02,
    });
    expect(testInfo.errors).toHaveLength(0);
});

test("Polygon point edit (after all edits) with WebGL2", async ({
    page,
}, testInfo) => {
    await waitForPolygonScene(page);

    await page.evaluate((id) => {
        type ViewerLike = {
            insertPolygonPoint: (
                id: string,
                index: number,
                point: { lat: number; lon: number; altitude: number },
            ) => unknown;
            removePolygonPoint: (id: string, index: number) => unknown;
            updatePolygonPoint: (
                id: string,
                index: number,
                partial: { altitude?: number; label?: string | null },
            ) => unknown;
            replacePolygonPoints: (
                id: string,
                points: ReadonlyArray<{
                    lat: number;
                    lon: number;
                    altitude: number;
                }>,
            ) => unknown;
        };
        const viewer = (window as unknown as { viewer: ViewerLike }).viewer;
        viewer.insertPolygonPoint(id, 4, {
            lat: 35.6244,
            lon: 139.5208,
            altitude: 600,
        });
        viewer.removePolygonPoint(id, 0);
        viewer.updatePolygonPoint(id, 0, { altitude: 700 });
        viewer.replacePolygonPoints(id, [
            { lat: 35.6240, lon: 139.5198, altitude: 550 },
            { lat: 35.6250, lon: 139.5198, altitude: 550 },
            { lat: 35.6245, lon: 139.5215, altitude: 650 },
        ]);
    }, POLYGON_EDIT_TARGET_ID);

    await waitForFrames(page, 15);

    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.02,
    });
    expect(testInfo.errors).toHaveLength(0);
});

// ---------- サークル API 視覚回帰 (Issue #201 / #207) ----------
//
// circle デモページ（terrain / absolute / custom-segments の 3 円）を
// ロードし、標高解決後の初期描画スナップショットを VR baseline として取得する。
// WebGL2 のみで実行し、時刻と autoSunPosition を固定する。

async function waitForCircleScene(
    page: import("@playwright/test").Page,
): Promise<void> {
    const url = new URL("/circle.html", "http://localhost");
    url.searchParams.set("engine", "webgl");
    applyDeterministicSunQuery(url);
    await page.goto(`${url.pathname}${url.search}`, { timeout: 120000 });
    await page.waitForFunction(
        () =>
            (window as unknown as { scene?: { isReady: () => boolean } }).scene
                ?.isReady?.() ?? false,
        { timeout: 15000 },
    );
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    await waitForFrames(page, 15);
}

test("Circle demo (initial) with WebGL2", async ({ page }, testInfo) => {
    await waitForCircleScene(page);
    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.02,
    });
    expect(testInfo.errors).toHaveLength(0);
});

test("Circle demo (after updateCircle) with WebGL2", async ({
    page,
}, testInfo) => {
    await waitForCircleScene(page);

    // updateCircle で半径を変更し、再描画後のスナップショットを取得する
    await page.evaluate(() => {
        type ViewerLike = {
            updateCircle: (
                id: string,
                opts: { radius?: number },
            ) => unknown;
        };
        const viewer = (window as unknown as { viewer: ViewerLike }).viewer;
        viewer.updateCircle("yomiuri-terrain", { radius: 600 });
    });

    await waitForFrames(page, 15);

    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.02,
    });
    expect(testInfo.errors).toHaveLength(0);
});
