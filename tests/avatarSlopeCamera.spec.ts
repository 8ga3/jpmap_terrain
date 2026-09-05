import { expect, test } from "./tileCache.fixture";

/**
 * 坂道地形上でアバターを移動させた際のカメラ/スクロール/ズーム回帰防止。
 *
 * 修正前の症状:
 * 1. 画面スクロール時、アバターが画面ギリギリ/画面外に出る
 * 2. ズームでカメラを近づけても移動でカメラ位置が一瞬飛び、最後は離れた位置に移動する
 * 3. 移動中ボタン/ジョイスティックオンでズームイン、離すとズームアウトする
 *
 * `avatar-controller.html`（アバターアニメーション #02 デモ）を、標高差のある
 * よみうりランド付近（既存の polygon/circle VR テストと同一領域。`.tile-cache/`
 * に既にキャッシュ済みのため初回ネットワーク取得コストが小さい）にカメラを
 * 合わせて起動し、地面クリックでアバターをその地点へテレポートさせたうえで
 * 実際にキー入力で移動させる。ピクセル単位の完全決定性が取りづらい
 * 「移動中の一瞬」ではなく、「移動距離」を条件にフレームループを止めることで
 * 再現性を確保する。
 *
 * 注記: 当初は富士山頂付近（山岳地）で検証していたが、標高タイルが疎な領域では
 * DEM フォールバックプロービングが増えて初回ロードが 120s を超えタイムアウト
 * した。既存テストで実績のあるよみうりランド周辺（起伏のある丘陵地）に変更した。
 */

/** よみうりランド付近（起伏のある丘陵地。既存 polygon/circle VR テストと同一領域）。 */
const SLOPE_LAT = 35.6242625;
const SLOPE_LON = 139.5148162;

const SLOPE_CAMERA_ALTITUDE = 700;
const SLOPE_CAMERA_TILT = 55;
const SLOPE_CAMERA_AZIMUTH = 0;

/** キー入力で移動させる目標距離[m]。この距離だけ進んだらキーを離す。 */
const MOVE_DISTANCE_M = 60;
/** 移動フレームループの安全上限（回帰でループが止まらない場合の保険）。 */
const MOVE_SAMPLE_CAP = 600;

/** 初回ロード（未キャッシュタイル混在の可能性）を見込んだテスト個別タイムアウト。 */
const SCENE_TEST_TIMEOUT_MS = 180000;

const METERS_PER_DEGREE_LAT = 111320;

interface DemoModelHandle {
    readonly lat: number;
    readonly lon: number;
    readonly loaded: boolean;
    readonly elevationResolved: boolean;
}

interface DemoViewer {
    altitude: number;
    tilt: number;
    azimuth: number;
    isTerrainIdle: boolean;
    getModel(id: string): DemoModelHandle | null;
    terrainElevAt(latDeg: number, lonDeg: number): number | null;
}

/**
 * ブラウザコンテキスト内で `viewer.altitude`（カメラ高度・ズーム相当）を読む。
 * `page.evaluate` に渡す関数はスタック文字列としてブラウザ側で評価されるため、
 * Node 側のクロージャは参照できない（自己完結した式にする必要がある）。
 */
const readViewerAltitude = (
    page: import("@playwright/test").Page,
): Promise<number> =>
    page.evaluate(
        () => (window as unknown as { viewer: DemoViewer }).viewer.altitude,
    );

/** 指定フレーム数だけ requestAnimationFrame を待つ。 */
async function waitForFrames(
    page: import("@playwright/test").Page,
    frameCount: number,
    timeout = 30000,
): Promise<void> {
    await page.waitForFunction(
        (n: number) =>
            new Promise((resolve) => {
                let count = 0;
                const tick = (): void => {
                    if (++count >= n) {
                        resolve(true);
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }),
        frameCount,
        { timeout },
    );
}

/**
 * タイル読み込み・再ステッチが完全に安定するまで待つ。
 * `viewer.isTerrainIdle`（公開 API）が 5 回連続で true になるまでポーリングする。
 */
async function waitForTerrainStable(
    page: import("@playwright/test").Page,
): Promise<void> {
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        (window as unknown as { _idleCount?: number })._idleCount = 0;
    });
    await page.waitForFunction(
        () => {
            const w = window as unknown as {
                viewer?: { isTerrainIdle: boolean };
                _idleCount?: number;
            };
            if (w.viewer?.isTerrainIdle) {
                w._idleCount = (w._idleCount ?? 0) + 1;
            } else {
                w._idleCount = 0;
            }
            return w._idleCount >= 5;
        },
        { timeout: 60000, polling: 200 },
    );
    await waitForFrames(page, 10);
}

/** アバターモデルのロード + 地表標高解決完了を待つ。 */
async function waitForAvatarModelReady(
    page: import("@playwright/test").Page,
): Promise<void> {
    await page.waitForFunction(
        () => {
            const viewer = (window as unknown as { viewer?: DemoViewer })
                .viewer;
            const model = viewer?.getModel("avatar") ?? null;
            return !!model && model.loaded && model.elevationResolved;
        },
        { timeout: 60000 },
    );
}

/**
 * 坂道シーンを起動し、地面クリックでアバターをカメラ中心付近（勾配地形上）へ
 * テレポートさせるところまで進める。
 */
async function gotoAvatarSlopeScene(
    page: import("@playwright/test").Page,
): Promise<void> {
    // 注意: `parseCameraStateFromUrl` の `?lat=&lon=` クエリ形式は altitude/azimuth/tilt を
    // 読み取らず既定値にフォールバックする（`@lat,lon,alt,az,tilt` パス形式のみ対応）。
    // そのため lat/lon のみ URL で指定し、altitude/tilt/azimuth はロード後に
    // 公開 setter（`viewer.altitude` 等）で明示的に設定する。
    const url = new URL("/avatar-controller.html", "http://localhost");
    url.searchParams.set("engine", "webgl");
    url.searchParams.set("lat", String(SLOPE_LAT));
    url.searchParams.set("lon", String(SLOPE_LON));
    await page.goto(`${url.pathname}${url.search}`, { timeout: 120000 });

    await waitForAvatarModelReady(page);

    await page.evaluate(
        ({ altitude, tilt, azimuth }) => {
            const viewer = (window as unknown as { viewer: DemoViewer }).viewer;
            viewer.altitude = altitude;
            viewer.tilt = tilt;
            viewer.azimuth = azimuth;
        },
        {
            altitude: SLOPE_CAMERA_ALTITUDE,
            tilt: SLOPE_CAMERA_TILT,
            azimuth: SLOPE_CAMERA_AZIMUTH,
        },
    );
    await waitForTerrainStable(page);

    // 事前確認: このシーン中心が実際に勾配のある地形であること（平坦地誤選定の検知）。
    // `terrainElevAt` は公開 API。約100m 東西で数m以上の標高差があることを期待する。
    const elevationDeltaM = await page.evaluate(
        ({ lat, lon }) => {
            const viewer = (window as unknown as { viewer: DemoViewer }).viewer;
            const elevAt = viewer.terrainElevAt(lat, lon);
            const elevOffset = viewer.terrainElevAt(lat, lon + 0.001);
            if (elevAt === null || elevOffset === null) return null;
            return Math.abs(elevAt - elevOffset);
        },
        { lat: SLOPE_LAT, lon: SLOPE_LON },
    );
    expect(elevationDeltaM).not.toBeNull();
    expect(elevationDeltaM as number).toBeGreaterThan(1);

    // 地面クリックでアバターをカメラ中心（勾配地形上）へテレポートさせる。
    // `MAX_CLICK_DISTANCE_M`（5000m）以内であれば `onTerrainClick` が受理する。
    const canvas = page.locator("canvas").first();
    const box = await canvas.boundingBox();
    if (!box)
        throw new Error("[avatarSlopeCamera] canvas bounding box not found");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // テレポート先が坂道シーン中心の近傍であること（東京駅初期スポーンから
    // 離脱できていること）を確認してから安定を待つ。
    await page.waitForFunction(
        ({ lat, lon }: { lat: number; lon: number }) => {
            const viewer = (window as unknown as { viewer?: DemoViewer })
                .viewer;
            const model = viewer?.getModel("avatar") ?? null;
            if (!model?.elevationResolved) return false;
            return (
                Math.abs(model.lat - lat) < 0.05 &&
                Math.abs(model.lon - lon) < 0.05
            );
        },
        { lat: SLOPE_LAT, lon: SLOPE_LON },
        { timeout: 15000 },
    );
    await waitForTerrainStable(page);
}

test("Avatar stays within viewport while moving on sloped terrain with WebGL2", async ({
    page,
}, testInfo) => {
    test.setTimeout(SCENE_TEST_TIMEOUT_MS);
    await gotoAvatarSlopeScene(page);

    // 前進キーを押し続け、一定距離（`MOVE_DISTANCE_M`）進んだ時点で離す。
    // ピクセル単位で完全決定的な「経過フレーム数」ではなく「移動距離」を
    // 停止条件にすることで、実行環境の速度差による flaky を避ける。
    // `sampleCap` はあくまで安全弁（回帰でアバターが動かなくなった場合に
    // 無限ポーリングを避けるためのもの）であり、そちらで打ち切られた場合は
    // 「所定距離を移動できなかった」異常系として明示的にテストを失敗させる
    // （`dist`/`samples` を返し、下記で `reachedCap` を検証する）。
    await page.keyboard.down("KeyW");
    const moveResultHandle = await page.waitForFunction(
        ({ moveDistanceM, sampleCap, metersPerDegLat }) => {
            const w = window as unknown as {
                viewer?: DemoViewer;
                __avatarSlopeStart?: { lat: number; lon: number };
                __avatarSlopeSamples?: number;
            };
            const viewer = w.viewer;
            const model = viewer?.getModel("avatar") ?? null;
            if (!viewer || !model) return false;
            if (!w.__avatarSlopeStart) {
                w.__avatarSlopeStart = { lat: model.lat, lon: model.lon };
                w.__avatarSlopeSamples = 0;
            }
            w.__avatarSlopeSamples = (w.__avatarSlopeSamples ?? 0) + 1;
            const start = w.__avatarSlopeStart;
            const dLat = (model.lat - start.lat) * metersPerDegLat;
            const dLon =
                (model.lon - start.lon) *
                metersPerDegLat *
                Math.cos((start.lat * Math.PI) / 180);
            const dist = Math.hypot(dLat, dLon);
            const samples = w.__avatarSlopeSamples;
            if (dist > moveDistanceM || samples > sampleCap) {
                return { dist, samples };
            }
            return false;
        },
        {
            moveDistanceM: MOVE_DISTANCE_M,
            sampleCap: MOVE_SAMPLE_CAP,
            metersPerDegLat: METERS_PER_DEGREE_LAT,
        },
        { timeout: 30000, polling: "raf" },
    );
    const moveResult = await moveResultHandle.jsonValue();
    // `waitForFunction` はここでは常に truthy（オブジェクト）を返して解決するはずだが、
    // 型上は `false` も取り得るため明示的に narrowing しておく。
    if (moveResult === false) {
        throw new Error(
            "[avatarSlopeCamera] waitForFunction resolved without a result payload",
        );
    }

    // sampleCap（安全弁）で打ち切られていない = 所定距離まで正常に移動できたことを明示的に検証する。
    // ここが崩れる場合、待機が「移動できていない」異常系のまま偽陽性で成功してしまう回帰を防ぐ。
    expect(moveResult.samples).toBeLessThanOrEqual(MOVE_SAMPLE_CAP);
    expect(moveResult.dist).toBeGreaterThan(MOVE_DISTANCE_M);

    // 移動中（キーを離す直前）のスクリーンショット。
    // アバターが画面外/画面ギリギリに出ていないことを確認する。
    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.05,
    });

    await page.keyboard.up("KeyW");
    expect(testInfo.errors).toHaveLength(0);
});

test("Camera altitude does not spike while avatar moves on sloped terrain with WebGL2", async ({
    page,
}, testInfo) => {
    test.setTimeout(SCENE_TEST_TIMEOUT_MS);
    await gotoAvatarSlopeScene(page);

    // 移動前（テレポート直後・静止状態）のスクリーンショット。
    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.02,
    });

    const initialAltitude = await readViewerAltitude(page);

    // 前進キーを押しっぱなしにしつつ、ブラウザ側の rAF ループでフレーム毎に
    // `viewer.altitude`（ズーム相当）をサンプリングする。移動距離
    // (`MOVE_DISTANCE_M`) に到達したら自動的にループを終了する。
    // `sampleCap` は安全弁であり、そちらで打ち切られた場合は「所定距離を
    // 移動できなかった」異常系として `reachedCap` で検知し、後段で明示的に
    // アサートする（偽陽性でテストが成功してしまうのを防ぐ）。
    await page.keyboard.down("KeyW");
    const {
        samples: altitudeSamples,
        finalDistance,
        reachedCap,
    } = await page.evaluate(
        async ({ moveDistanceM, sampleCap, metersPerDegLat }) => {
            const viewer = (window as unknown as { viewer: DemoViewer }).viewer;
            const start = viewer.getModel("avatar");
            if (!start) {
                return {
                    samples: [] as number[],
                    finalDistance: 0,
                    reachedCap: false,
                };
            }
            const startLat = start.lat;
            const startLon = start.lon;
            const samples: number[] = [];
            return await new Promise<{
                samples: number[];
                finalDistance: number;
                reachedCap: boolean;
            }>((resolve) => {
                const tick = (): void => {
                    samples.push(viewer.altitude);
                    const model = viewer.getModel("avatar");
                    const dLat =
                        ((model?.lat ?? startLat) - startLat) * metersPerDegLat;
                    const dLon =
                        ((model?.lon ?? startLon) - startLon) *
                        metersPerDegLat *
                        Math.cos((startLat * Math.PI) / 180);
                    const dist = Math.hypot(dLat, dLon);
                    if (dist > moveDistanceM || samples.length > sampleCap) {
                        resolve({
                            samples,
                            finalDistance: dist,
                            reachedCap: !(dist > moveDistanceM),
                        });
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
        },
        {
            moveDistanceM: MOVE_DISTANCE_M,
            sampleCap: MOVE_SAMPLE_CAP,
            metersPerDegLat: METERS_PER_DEGREE_LAT,
        },
    );
    await page.keyboard.up("KeyW");

    // sampleCap（安全弁）で打ち切られていない = 所定距離まで正常に移動できたことを明示的に検証する。
    expect(reachedCap).toBe(false);
    expect(finalDistance).toBeGreaterThan(MOVE_DISTANCE_M);

    // 移動後、自動スクロールのイージングとタイル安定を待ってから停止状態を確定する。
    await waitForFrames(page, 60);
    await waitForTerrainStable(page);

    // 移動後（停止・安定後）のスクリーンショット。
    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.02,
    });

    expect(altitudeSamples.length).toBeGreaterThan(0);

    // フレーム間の急変（テレポート）が無いこと。
    // 通常のイージング/自動スクロールに伴う変化は緩やかであり、
    // 1 フレームで大きく飛ぶことは無い。
    for (let i = 1; i < altitudeSamples.length; i++) {
        const frameDelta = Math.abs(
            altitudeSamples[i] - altitudeSamples[i - 1],
        );
        expect(frameDelta).toBeLessThan(initialAltitude * 0.3);
    }

    // 移動中を通じてカメラ高度が初期値から大きく乖離しない（ズームイン/アウト
    // が意図せず発生し続けない）こと。
    const maxDeviation = Math.max(
        ...altitudeSamples.map((a) => Math.abs(a - initialAltitude)),
    );
    expect(maxDeviation).toBeLessThan(initialAltitude * 0.5);

    // 移動終了後、カメラ高度が初期値付近まで戻っている（離れた位置に
    // 移動したまま残らない）こと。
    const finalAltitude = await readViewerAltitude(page);
    expect(Math.abs(finalAltitude - initialAltitude)).toBeLessThan(
        initialAltitude * 0.3,
    );

    expect(testInfo.errors).toHaveLength(0);
});
