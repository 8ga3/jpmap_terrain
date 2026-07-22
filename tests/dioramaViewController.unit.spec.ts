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

    it("resetToInitial()でsetViewが初期center/footprintRadiusMで呼ばれ、成功後にgetCenter/getFootprintRadiusMが初期値に戻る", async () => {
        const { terrain, setView } = makeTerrain();
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        // まず初期値から離れた状態にする。
        vc.feedAxes({ x: 1, y: 0 }, -1, 1);
        await Promise.resolve();
        await Promise.resolve();
        expect(vc.getCenter()).not.toEqual(INITIAL_CENTER);
        expect(vc.getFootprintRadiusM()).not.toBe(INITIAL_FOOTPRINT_RADIUS_M);
        setView.mockClear();

        vc.resetToInitial();

        expect(setView).toHaveBeenCalledTimes(1);
        const patch = setView.mock.calls[0][0];
        expect(patch.center).toEqual(INITIAL_CENTER);
        expect(patch.footprintRadiusM).toBe(INITIAL_FOOTPRINT_RADIUS_M);

        await Promise.resolve();
        await Promise.resolve();
        expect(vc.getCenter()).toEqual(INITIAL_CENTER);
        expect(vc.getFootprintRadiusM()).toBe(INITIAL_FOOTPRINT_RADIUS_M);
    });

    it("resetToInitial()は蓄積中の相対パン差分を破棄し、絶対値の初期centerのみを送信する", async () => {
        const { terrain, setView } = makeTerrain();
        let resolveFirst: (() => void) | undefined;
        setView.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirst = resolve;
                }),
        );
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        // 1回目のsetViewを未解決のまま(applying=true)にし、2回目のfeedAxesで
        // 相対パン差分をpendingへ蓄積させる。
        vc.feedAxes({ x: 1, y: 0 }, 0, 1);
        expect(setView).toHaveBeenCalledTimes(1);
        vc.feedAxes({ x: 1, y: 0 }, 0, 1); // applying中のためflushされず、pendingEastM/Northに蓄積される

        // resetToInitial() 呼び出し時点でも1回目が未解決(applying=true)のため、
        // 即座には送信されない。
        vc.resetToInitial();
        expect(setView).toHaveBeenCalledTimes(1);

        resolveFirst?.();
        await Promise.resolve();
        await Promise.resolve();

        // 1回目完了後、次のflushトリガー（feedAxes呼び出し）で2回目が発行される。
        // 蓄積していた相対パン差分は破棄され、初期centerへの絶対値ジャンプのみが送信される
        // （相対差分がcenterに混入していれば INITIAL_CENTER と一致しなくなる）。
        vc.feedAxes({ x: 0, y: 0 }, 0, 1);
        expect(setView).toHaveBeenCalledTimes(2);
        const secondPatch = setView.mock.calls[1][0];
        expect(secondPatch.center).toEqual(INITIAL_CENTER);
    });

    it("resetToInitial()中にsetViewが失敗した場合、次回flushで同じ初期centerへの絶対値ジャンプが再送される", async () => {
        const setView = vi
            .fn()
            .mockResolvedValueOnce(undefined) // 1回目: 初期値から離れる移動（成功）
            .mockRejectedValueOnce(new Error("network error")) // 2回目: resetToInitial()分（失敗）
            .mockResolvedValueOnce(undefined); // 3回目: 再送分（成功）
        const terrain = { setView } as unknown as DioramaTerrain;
        const vc = createDioramaViewController(terrain, INITIAL_CENTER, INITIAL_FOOTPRINT_RADIUS_M);

        // 初期値から離れた状態にしてから、centerのみ変化した状態で確定させる。
        vc.feedAxes({ x: 1, y: 0 }, 0, 1);
        await Promise.resolve();
        await Promise.resolve();
        expect(vc.getCenter()).not.toEqual(INITIAL_CENTER);
        setView.mockClear();

        vc.resetToInitial();
        expect(setView).toHaveBeenCalledTimes(1);

        // 1回目（reset分）が失敗して確定処理が走った後まで待つ。
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        // 失敗時は楽観的に確定させないため、centerはまだ初期値に戻っていない。
        expect(vc.getCenter()).not.toEqual(INITIAL_CENTER);

        // 次回のflush（トリガー呼び出し）で、同じ初期centerへの絶対値ジャンプが再送される。
        vc.feedAxes({ x: 0, y: 0 }, 0, 1);
        expect(setView).toHaveBeenCalledTimes(2);
        expect(setView.mock.calls[1][0].center).toEqual(INITIAL_CENTER);

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(vc.getCenter()).toEqual(INITIAL_CENTER);
    });
});
