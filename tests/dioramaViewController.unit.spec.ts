/**
 * `dioramaViewController.ts` のunit test。
 *
 * @remarks
 * `DioramaTerrain`（`setView`のみ使用）をモックし、Babylon/DOMに依存せず
 * 純粋にロジックを検証する。
 */
import { describe, it, expect, vi } from "vitest";
import type { DioramaTerrain } from "../src/terrain/diorama/dioramaTerrain";
import { createDioramaViewController } from "../src/demos/diorama/dioramaViewController";
import { DEFAULT_FOOTPRINT_RADIUS_MAX_M } from "../src/demos/diorama/dioramaControllerMapping";

const makeTerrain = (): { terrain: DioramaTerrain; setView: ReturnType<typeof vi.fn> } => {
    const setView = vi.fn(() => Promise.resolve());
    const terrain = { setView } as unknown as DioramaTerrain;
    return { terrain, setView };
};

const INITIAL_CENTER = { lat: 35.3436, lon: 138.7203 };
const INITIAL_FOOTPRINT_RADIUS_M = 800;

describe("createDioramaViewController", () => {
    it("初期状態はコンストラクタに渡した center/footprintRadiusM を返す", () => {
        const { terrain } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);
        expect(vc.getCenter()).toEqual(INITIAL_CENTER);
        expect(vc.getFootprintRadiusM()).toBe(INITIAL_FOOTPRINT_RADIUS_M);
    });

    it("dtSecondsが0以下ならfeedAxesは何もしない", () => {
        const { terrain, setView } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);
        vc.feedAxes({ x: 1, y: 1 }, 1, 0);
        vc.feedAxes({ x: 1, y: 1 }, 1, -1);
        expect(setView).not.toHaveBeenCalled();
    });

    it("パン入力でsetViewが呼ばれ、centerが更新される", async () => {
        const { terrain, setView } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        vc.feedAxes({ x: 1, y: 0 }, 0, 1);
        expect(setView).toHaveBeenCalledTimes(1);
        const patch = setView.mock.calls[0][0];
        expect(patch.center).toBeDefined();
        expect(patch.center.lon).toBeGreaterThan(INITIAL_CENTER.lon); // x=1(東)へ移動
        expect(patch.footprintRadiusM).toBeUndefined();

        await Promise.resolve(); // setViewのPromise解決を待つ（applyingフラグのリセット）
        expect(vc.getCenter().lon).toBeGreaterThan(INITIAL_CENTER.lon);
    });

    it("ズーム入力でsetViewが呼ばれ、footprintRadiusMが更新される（centerは変化しない）", async () => {
        const { terrain, setView } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        vc.feedAxes({ x: 0, y: 0 }, -1, 1); // 前方向=ズームイン(縮小)
        expect(setView).toHaveBeenCalledTimes(1);
        const patch = setView.mock.calls[0][0];
        expect(patch.center).toBeUndefined();
        expect(patch.footprintRadiusM).toBeLessThan(INITIAL_FOOTPRINT_RADIUS_M);

        await Promise.resolve();
        expect(vc.getFootprintRadiusM()).toBeLessThan(INITIAL_FOOTPRINT_RADIUS_M);
    });

    it("パン・ズームを同時に入力すると、1回のsetView呼び出しに両方まとめて渡される", () => {
        const { terrain, setView } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        vc.feedAxes({ x: 1, y: 0 }, -1, 1);

        expect(setView).toHaveBeenCalledTimes(1);
        const patch = setView.mock.calls[0][0];
        expect(patch.center).toBeDefined();
        expect(patch.footprintRadiusM).toBeDefined();
    });

    it("前回のsetViewが完了するまで次のsetViewを発行しない（完了待ち合流）", async () => {
        const { terrain, setView } = makeTerrain();
        let resolveFirst: (() => void) | undefined;
        setView.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirst = resolve;
                }),
        );
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        vc.feedAxes({ x: 1, y: 0 }, 0, 1);
        expect(setView).toHaveBeenCalledTimes(1);

        // 1回目が未解決のまま、さらに入力を続ける。
        vc.feedAxes({ x: 1, y: 0 }, 0, 1);
        vc.feedAxes({ x: 1, y: 0 }, 0, 1);
        // 完了待ちのため、まだ2回目は発行されない。
        expect(setView).toHaveBeenCalledTimes(1);

        resolveFirst?.();
        await Promise.resolve();
        await Promise.resolve();

        // 1回目完了後、蓄積していた移動量をまとめて2回目として発行する。
        vc.feedAxes({ x: 0, y: 0 }, 0, 1); // 溜まった値をflushさせるためのトリガー呼び出し
        expect(setView).toHaveBeenCalledTimes(2);
    });

    it("footprintRadiusMは既定の下限・上限でクランプされる", () => {
        const { terrain, setView } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, 150);

        // 極端に長時間・強いズームアウト入力を与えても上限を超えない。
        vc.feedAxes({ x: 0, y: 0 }, 1, 1000);
        const patch = setView.mock.calls[0][0];
        expect(patch.footprintRadiusM).toBeLessThanOrEqual(DEFAULT_FOOTPRINT_RADIUS_MAX_M);
    });

    it("setViewが失敗した場合、centerとfootprintRadiusMは確定させず次回flushで再送する", async () => {
        const setView = vi.fn().mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(undefined);
        const terrain = { setView } as unknown as DioramaTerrain;
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        vc.feedAxes({ x: 1, y: 0 }, -1, 1); // パン+ズームを同時に送る
        expect(setView).toHaveBeenCalledTimes(1);
        const firstPatch = setView.mock.calls[0][0];

        // 1回目のsetViewが失敗して確定処理が走った後まで待つ。
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // 失敗時は楽観的に確定させないため center は初期値のまま。footprintRadiusM は
        // （setView成功/失敗に関わらず）feedAxes時点で即座に更新される値なので、
        // 失敗の有無に関わらず既に目標値（400）になっている点に注意。
        expect(vc.getCenter()).toEqual(INITIAL_CENTER);
        expect(vc.getFootprintRadiusM()).toBe(firstPatch.footprintRadiusM);

        // 次回のflush（トリガー呼び出し）で、1回目と同じ移動量・目標半径が再送される。
        vc.feedAxes({ x: 0, y: 0 }, 0, 1); // 溜まった値をflushさせるためのトリガー呼び出し
        expect(setView).toHaveBeenCalledTimes(2);
        const secondPatch = setView.mock.calls[1][0];
        expect(secondPatch.center).toEqual(firstPatch.center);
        expect(secondPatch.footprintRadiusM).toBe(firstPatch.footprintRadiusM);

        // 2回目は成功するので、確定処理が反映される。
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(vc.getCenter()).toEqual(firstPatch.center);
        expect(vc.getFootprintRadiusM()).toBe(firstPatch.footprintRadiusM);
    });
});
