import { test, expect } from "./tileCache.fixture";

/**
 * Issue #457: 標高タイルの地形表現を遠方まで維持する回帰テスト。
 * 本テストのシナリオは富士山から約25km（実際の東京駅〜富士山は約100.5kmあり、
 * 本テストの距離とは異なる。詳細は補足2を参照）。
 *
 * 富士山（山頂）から東南東へ約25km（御殿場付近）の地点を注視点
 * （`avatar-controller.html` の `lat`/`lon`、`GeospatialCamera` の center に相当。
 * カメラ自身の位置ではない）に設定し、低空・水平寄りのチルトで遠景を望む視点を作る。
 * azimuth はカメラ→富士山の測地線ベアリング（約285.8°、西北西）を使い、実際に富士山へ
 * 視線を向ける。**主たる検証はスクリーンショット比較**
 * （富士山の稜線が遠景に破綻なく表示されること）で、`terrainElevAt` による数値検証は
 * 補助的な確認として添える（この距離・視点では zoom>=minZoom が選ばれ、後述の制限に
 * 抵触しないため数値検証も機能する）。
 *
 * 距離・azimuth の選定について（#463 対応）: 従来は azimuth=0（真北向き）・距離50kmで、
 * 実機で富士山が視界に入ることを確認していたが、これは旧実装（帯モデル＋地平線カリングのみ、
 * 真の視錐台判定なし）が実際の視野より広くタイルをカバーしていたための側面効果だった
 * （真北向きでは富士山は本来の視錐台（水平FOV半角約37°）に対し約69°もズレており、真に
 * 視界に入っていなかった）。#463 で真の視錐台カリングを追加した結果、真北向きでは富士山の
 * タイルが（正しく）除外されるようになり、本テストの `terrainElevAt` チェックが失敗するように
 * なった。本テストの主旨（遠景の山岳地形がチルトアップ時に破綻しないこと）を検証するには、
 * 実際に富士山へ視線を向ける必要があるため測地線ベアリングへ修正した。ただし50km時点の
 * ベアリングでは補足1のとおり root zoom が minZoom-1（10）まで下がり、補足2の
 * `terrainElevAt` 制限に抵触してしまうため、zoom>=minZoom を維持できる約25kmまで距離を
 * 詰めた（`globeLod.selectGlobeTiles` を実カメラ状態で直接検証して確認済み）。
 *
 * 補足1（検証で判明した実装上の制約・distCapZoom）: `globeLod.zoomForDist` の
 * `distCapZoom`（「タイル1辺 ≤ カメラ距離」を保証する粗さ下限）により、root zoom が
 * `minZoom`（既定11）から下がる距離のしきい値が存在する（このシナリオでは約25km地点で
 * ちょうど境界に近く、約30km以上では minZoom-1（10）まで下がる）。そのため
 * `globeTileManager.buildReadyTiles` の `t.zoom >= minZoom` 判定（#457 の修正対象）が
 * 及ぼす影響は、この距離では「ロード完了直後の一瞬のフラット表示」を防ぐ程度に限定的で、
 * 静止したスクリーンショット比較では修正前後の差が出ない（`terrainElevAt` は `elevCache` の
 * 生データを直接参照するため、ビルド分岐の変更とは無関係に同じ値を返す）。修正の効果自体は
 * `tests/globeTileManager.unit.spec.ts` の「zoom < minZoom でも近距離なら標高ロード完了を
 * 待つ」テストで直接検証済み。
 *
 * 補足2（`terrainElevAt` 自体の制限、要フォローアップ）: `terrainElevAt` は
 * `gz >= min(minZoom, geomMaxZoom)` の範囲でしか `elevCache` を探索しない
 * （`globeTileManager.ts` の `terrainElevAt` 実装）。そのため実際に東京駅（丸の内）
 * から富士山（約100.5km、zoom=10 が選ばれる）を見るケースで検証したところ、
 * `buildReadyTiles` 側は実DEMをロード完了して正しく建築している（root/accepted
 * タイル数・elevCache 件数を計装して確認済み）にもかかわらず、`terrainElevAt` は
 * 常に null を返すことを確認した。これは #457 の対象外の別制限であり、本テストが
 * 「zoom>=minZoom に収まる近距離」を選んでいるのはこの制限を踏まないための意図的な
 * 選択。100km 級（zoom<minZoom）のケースの数値検証や、その距離での
 * ジオメトリ解像度（zoom=10 では起伏表現がかなり粗い）の扱いは別Issueで追う。
 *
 * 本テストは、遠景でも地形の起伏が破綻なく表示され続けることを保証する
 * 健全性テスト（将来 minZoom や SSE ロジックが変わって本当に破綻した場合の回帰検知）
 * として追加する。
 */

/** 富士山山頂（`GLOBE_SCENE_DEFAULTS` と同一座標）。 */
const FUJI_LAT = 35.3606;
const FUJI_LON = 138.7274;

/**
 * 富士山から東南東へ約25km（御殿場付近）の地点。カメラ自身の位置ではなく、
 * `avatar-controller.html` の `lat`/`lon`（= `GeospatialCamera` の注視点/center）に渡す値。
 */
const CAMERA_LAT = 35.299823;
const CAMERA_LON = 138.992724;

/**
 * カメラの向き [deg]（0=北, +=東回り、`GeospatialCamera.yaw` の規約 "0 = north,
 * π/2 = east" に準拠）。カメラ→富士山の測地線ベアリング（初期方位角）。
 * 注: `src/demos/avatar-controller/cameraControl.ts` の azimuth 規約はこの「東回り正
 * （時計回り正）」に統一済み（#462 で解消）。
 */
const CAMERA_AZIMUTH_TO_FUJI = 285.76;

/** カメラ高度 [m]。地表付近の低空から遠景の富士山を望む構図にする。 */
const CAMERA_ALTITUDE = 1500;
/** チルト [deg]（0=直下, 90=水平）。遠景を見渡すため水平寄りにする。 */
const CAMERA_TILT = 70;

/** 富士山山頂が平坦化（海面 0m 等）されていないとみなす標高下限 [m]。実山頂は約3776m。 */
const MIN_EXPECTED_FUJI_ELEV_M = 2000;

/** 初回ロード（未キャッシュタイル）を見込んだテスト個別タイムアウト。 */
const SCENE_TEST_TIMEOUT_MS = 180000;

interface DemoModelHandle {
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
        { timeout: 90000, polling: 200 },
    );
    await waitForFrames(page, 10);
}

/**
 * `viewer` の初期化完了を待つ。
 * アバター自体は常に東京駅にスポーンする実装（`TOKYO_STATION` 固定）のため、カメラを
 * 50km 遠方に向ける本テストではアバターがカメラ視界外になり `elevationResolved` は
 * 解決されない（視界内タイルのみ標高ロードするのが仕様）。本テストの検証対象は
 * アバターではなく地形（`terrainElevAt`）そのものなので、アバターの標高解決は待たない。
 */
async function waitForViewerReady(
    page: import("@playwright/test").Page,
): Promise<void> {
    await page.waitForFunction(
        () => !!(window as unknown as { viewer?: DemoViewer }).viewer,
        { timeout: 60000 },
    );
}

test("富士山から東南東25km地点から望む地形が海面フラット化せず標高を維持する（#457）", async ({
    page,
}, testInfo) => {
    test.setTimeout(SCENE_TEST_TIMEOUT_MS);

    const url = new URL("/avatar-controller.html", "http://localhost");
    url.searchParams.set("engine", "webgl");
    url.searchParams.set("lat", String(CAMERA_LAT));
    url.searchParams.set("lon", String(CAMERA_LON));
    await page.goto(`${url.pathname}${url.search}`, { timeout: 120000 });

    await waitForViewerReady(page);

    await page.evaluate(
        ({ altitude, tilt, azimuth }) => {
            const viewer = (window as unknown as { viewer: DemoViewer }).viewer;
            viewer.altitude = altitude;
            viewer.tilt = tilt;
            viewer.azimuth = azimuth;
        },
        {
            altitude: CAMERA_ALTITUDE,
            tilt: CAMERA_TILT,
            azimuth: CAMERA_AZIMUTH_TO_FUJI,
        },
    );
    await waitForTerrainStable(page);

    // 主たる検証: スクリーンショットで富士山の稜線が遠景に破綻なく表示されること。
    await expect(page).toHaveScreenshot({
        timeout: 30000,
        maxDiffPixelRatio: 0.05,
    });

    // 補助的な数値確認: 50km 先の富士山山頂標高が海面フラット(0m)へ潰れていないこと。
    // この距離・視点では zoom>=minZoom が選ばれるため terrainElevAt の制限（補足2参照）
    // に抵触せず機能する。
    const fujiElev = await page.evaluate(
        ({ lat, lon }) => {
            const viewer = (window as unknown as { viewer: DemoViewer }).viewer;
            return viewer.terrainElevAt(lat, lon);
        },
        { lat: FUJI_LAT, lon: FUJI_LON },
    );
    expect(fujiElev).not.toBeNull();
    expect(fujiElev as number).toBeGreaterThan(MIN_EXPECTED_FUJI_ELEV_M);

    expect(testInfo.errors).toHaveLength(0);
});
