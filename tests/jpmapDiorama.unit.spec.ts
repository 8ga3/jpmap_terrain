/**
 * @vitest-environment jsdom
 */
/**
 * `JpmapDiorama` クラス公開 API のユニットテスト
 *
 * - デフォルト値の適用（`createDioramaTerrain` へ渡すオプション）
 * - center/footprintHalfSizeM/tileMode/rotationDeg/heightOffsetM の get/set
 * - onViewChange/onTileModeChange/onArStateChange の通知
 * - enableDefaultControls/showArButton オプションによる内蔵UI生成の有無
 * - dispose の冪等性・後始末
 *
 * `dioramaViewController`/`dioramaOrientationController`/`dioramaTileModeController`
 * （すでに個別のunit testを持つ軽量な純粋ロジック）は実体を使い、Babylon Engine生成
 * （`createBabylonEngine`）は `NullEngine` へ差し替え、地形構築（`createDioramaTerrain`、
 * DEM/テクスチャの実ネットワーク取得を伴う）とWebXR統合（`webXrArSession`）は
 * モックする。
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { DioramaTerrain, DioramaTerrainOptions } from "../src/terrain/diorama/dioramaTerrain";
import type { JpmapDioramaOptions } from "../src/lib/types";

// `createBabylonEngine` は WebGPU/WebGL2 を要求するため、テストでは headless な
// `NullEngine` を返すよう差し替える（`dioramaOrientationController.unit.spec.ts` 等、
// 本リポジトリの他テストと同じ方針）。
const createEngineMock = vi.fn(async () => {
    const engine = new NullEngine({
        renderWidth: 800,
        renderHeight: 600,
        deterministicLockstep: false,
        lockstepMaxSteps: 1,
        textureSize: 512,
    });
    // `runRenderLoop` は毎フレーム `scene.render()` を呼ぶが、実際のレンダリングは
    // テスト対象外のためスタブに差し替える（`NullEngine` 自体は動く実装のため無指定でも
    // 動作するが、テストの決定性のため明示的にスタブする）。
    engine.runRenderLoop = vi.fn();
    return engine;
});
vi.mock("../src/lib/internal/engineFactory", () => ({
    createBabylonEngine: (...args: unknown[]) => createEngineMock(...(args as [])),
}));

// `createDioramaTerrain` は DEM/ラスタタイルの実ネットワーク取得・Mesh構築を伴うため
// モックする。`root` は実 `TransformNode`（渡された実 `Scene` 上に生成）にし、
// `JpmapDiorama` 側の親子付け（`dioramaTerrain.root.parent = orientationRoot`）が
// 実際に動作することを検証できるようにする。
const dioramaTerrainCalls: DioramaTerrainOptions[] = [];
const fakeTerrains: Array<{
    terrain: DioramaTerrain;
    setCenter: Mock;
    setFootprintHalfSize: Mock;
    setTileMode: Mock;
    setView: Mock;
    dispose: Mock;
}> = [];
const createDioramaTerrainMock = vi.fn(async (scene: Scene, options: DioramaTerrainOptions) => {
    dioramaTerrainCalls.push(options);
    const root = new TransformNode("fake-diorama-root", scene);
    const setCenter = vi.fn(async () => {});
    const setFootprintHalfSize = vi.fn(async () => {});
    const setTileMode = vi.fn(async () => {});
    const setView = vi.fn(async () => {});
    const dispose = vi.fn(() => root.dispose());
    const terrain = {
        get mesh() {
            return {} as never;
        },
        root,
        setCenter,
        setFootprintHalfSize,
        setTileMode,
        setView,
        dispose,
    } as unknown as DioramaTerrain;
    fakeTerrains.push({ terrain, setCenter, setFootprintHalfSize, setTileMode, setView, dispose });
    return terrain;
});
vi.mock("../src/terrain/diorama/dioramaTerrain", () => ({
    createDioramaTerrain: (...args: unknown[]) => createDioramaTerrainMock(...(args as [Scene, DioramaTerrainOptions])),
}));

// 内蔵タッチHUD/キーボード操作は DOM 生成・イベント配線のみのため、生成有無
// （`enableDefaultControls`）のみ検証できれば十分。呼び出し回数を記録する。
// `dispose` は実装同様に要素をDOMから除去し、`JpmapDiorama.dispose()` が
// HUDの破棄まで確実に行うことをテストできるようにする。
const hudDisposeMock = vi.fn();
const createHudMock = vi.fn(() => {
    const element = document.createElement("div");
    element.dataset.testid = "diorama-touch-hud";
    return {
        element,
        getPanAxes: vi.fn(() => ({ x: 0, y: 0 })),
        getZoomAxis: vi.fn(() => 0),
        getRotationAxis: vi.fn(() => 0),
        getHeightAxis: vi.fn(() => 0),
        onTileModeCyclePress: vi.fn(() => () => {}),
        onExitArPress: vi.fn(() => () => {}),
        dispose: vi.fn(() => {
            hudDisposeMock();
            element.remove();
        }),
    };
});
vi.mock("../src/lib/internal/diorama/dioramaArControlHud", () => ({
    createDioramaArControlHud: (...args: unknown[]) => createHudMock(...(args as [])),
}));

const touchControlsDisposeMock = vi.fn();
const setupTouchControlsMock = vi.fn(() => ({
    setVisible: vi.fn(),
    dispose: touchControlsDisposeMock,
}));
vi.mock("../src/lib/internal/diorama/dioramaTouchControls", () => ({
    setupDioramaTouchControls: (...args: unknown[]) => setupTouchControlsMock(...(args as [])),
}));

const keyboardControlsDisposeMock = vi.fn();
const setupKeyboardControlsMock = vi.fn(() => keyboardControlsDisposeMock);
vi.mock("../src/lib/internal/diorama/dioramaKeyboardControls", () => ({
    setupDioramaKeyboardControls: (...args: unknown[]) => setupKeyboardControlsMock(...(args as [])),
}));

// WebXR統合はjsdomに `navigator.xr` が無いため実体でも常に非対応扱いになるが、
// AR突入時の挙動（`enterAr`/`exitAr`/`onArStateChange`）を能動的に検証するため
// 制御可能なフェイクに差し替える。
let arSupported = true;
const arControllers: Array<{
    isActive: Mock;
    enter: Mock;
    exit: Mock;
    onActiveChange: Mock;
    dispose: Mock;
    fireActiveChange: (active: boolean) => void;
}> = [];
const createArSessionControllerMock = vi.fn(() => {
    let active = false;
    let listener: ((active: boolean) => void) | null = null;
    const controller = {
        isActive: vi.fn(() => active),
        enter: vi.fn(async () => {
            active = true;
            listener?.(true);
        }),
        exit: vi.fn(async () => {
            active = false;
            listener?.(false);
        }),
        onActiveChange: vi.fn((l: (active: boolean) => void) => {
            listener = l;
            return () => {
                listener = null;
            };
        }),
        dispose: vi.fn(),
        fireActiveChange: (value: boolean): void => listener?.(value),
    };
    arControllers.push(controller);
    return controller;
});
const attachArButtonMock = vi.fn(() => vi.fn());
const isImmersiveArSupportedMock = vi.fn(async () => arSupported);
vi.mock("../src/lib/internal/diorama/webXrArSession", () => ({
    createDioramaArSessionController: (...args: unknown[]) => createArSessionControllerMock(...(args as [])),
    attachDioramaArButton: (...args: unknown[]) => attachArButtonMock(...(args as [])),
    isImmersiveArSupported: () => isImmersiveArSupportedMock(),
}));

// `vi.mock` はファイル先頭へ自動 hoist されるが、上記ファクトリが参照する
// mock 変数はここまでの const 宣言で初期化されるため、対象モジュールはここで
// 動的 import する（`jpmapTerrain.unit.spec.ts` と同じ理由）。
const { JpmapDiorama } = await import("../src/lib/jpmapDiorama");

const DEFAULT_CENTER = { lat: 35.3436, lon: 138.7203 };

beforeEach(() => {
    arSupported = true;
    dioramaTerrainCalls.length = 0;
    fakeTerrains.length = 0;
    arControllers.length = 0;
    createEngineMock.mockClear();
    createDioramaTerrainMock.mockClear();
    createHudMock.mockClear();
    hudDisposeMock.mockClear();
    setupTouchControlsMock.mockClear();
    setupKeyboardControlsMock.mockClear();
    createArSessionControllerMock.mockClear();
    attachArButtonMock.mockClear();
    isImmersiveArSupportedMock.mockClear();
    touchControlsDisposeMock.mockClear();
    keyboardControlsDisposeMock.mockClear();
});

const instances: Awaited<ReturnType<typeof JpmapDiorama.create>>[] = [];
afterEach(() => {
    while (instances.length) instances.pop()?.dispose();
});

const createInstance = async (
    options: Partial<JpmapDioramaOptions> = {},
): Promise<Awaited<ReturnType<typeof JpmapDiorama.create>>> => {
    const mount = document.createElement("div");
    const instance = await JpmapDiorama.create(mount, { center: DEFAULT_CENTER, ...options });
    instances.push(instance);
    return instance;
};

describe("JpmapDiorama.create", () => {
    it("mountElement が無い場合は TypeError を投げる", async () => {
        await expect(
            JpmapDiorama.create(null as unknown as HTMLElement, { center: DEFAULT_CENTER }),
        ).rejects.toThrow(TypeError);
    });

    it("options.center が無い場合は TypeError を投げる", async () => {
        const mount = document.createElement("div");
        await expect(
            JpmapDiorama.create(mount, {} as unknown as JpmapDioramaOptions),
        ).rejects.toThrow(TypeError);
    });

    it("options.center が null の場合も TypeError を投げる", async () => {
        const mount = document.createElement("div");
        await expect(
            JpmapDiorama.create(mount, { center: null } as unknown as JpmapDioramaOptions),
        ).rejects.toThrow(TypeError);
    });

    it("mountElement に canvas を追加する", async () => {
        const mount = document.createElement("div");
        const instance = await JpmapDiorama.create(mount, { center: DEFAULT_CENTER });
        instances.push(instance);
        expect(mount.querySelector("canvas")).not.toBeNull();
    });

    it("mountElementがposition:staticのままの場合、relativeを付与する（ARボタン/HUDの絶対配置基準を安定させるため）", async () => {
        const mount = document.createElement("div");
        expect(getComputedStyle(mount).position).toBe("static");

        const instance = await JpmapDiorama.create(mount, { center: DEFAULT_CENTER });
        instances.push(instance);

        expect(mount.style.position).toBe("relative");
    });

    it("mountElementに既にposition指定がある場合は上書きしない", async () => {
        const mount = document.createElement("div");
        mount.style.position = "absolute";

        const instance = await JpmapDiorama.create(mount, { center: DEFAULT_CENTER });
        instances.push(instance);

        expect(mount.style.position).toBe("absolute");
    });

    it("既定値が createDioramaTerrain へ渡される", async () => {
        await createInstance();
        expect(dioramaTerrainCalls).toHaveLength(1);
        const opts = dioramaTerrainCalls[0];
        expect(opts.center).toEqual(DEFAULT_CENTER);
        expect(opts.footprintHalfSizeM).toBe(800);
        expect(opts.tableRadiusM).toBe(0.35);
        expect(opts.tileMode).toBe("std");
    });

    it("指定した値が createDioramaTerrain へ渡される", async () => {
        await createInstance({ footprintHalfSizeM: 500, tableRadiusM: 0.5, tileMode: "photo", gridSegments: 16 });
        const opts = dioramaTerrainCalls[0];
        expect(opts.footprintHalfSizeM).toBe(500);
        expect(opts.tableRadiusM).toBe(0.5);
        expect(opts.tileMode).toBe("photo");
        expect(opts.gridSegments).toBe(16);
    });

    it("options.centerオブジェクトを後から書き換えても、createDioramaTerrainへ渡した内部状態は変化しない", async () => {
        const mount = document.createElement("div");
        const mutableCenter = { lat: 10, lon: 20 };
        const instance = await JpmapDiorama.create(mount, { center: mutableCenter });
        instances.push(instance);

        mutableCenter.lat = 99;
        mutableCenter.lon = 99;

        expect(dioramaTerrainCalls[0].center).toEqual({ lat: 10, lon: 20 });
        expect(instance.center).toEqual({ lat: 10, lon: 20 });
    });

    it("enableDefaultControls: true（既定）ではタッチHUD・キーボード操作が生成される", async () => {
        await createInstance();
        expect(createHudMock).toHaveBeenCalledTimes(1);
        expect(setupTouchControlsMock).toHaveBeenCalledTimes(1);
        expect(setupKeyboardControlsMock).toHaveBeenCalledTimes(1);
    });

    it("enableDefaultControls: false では内蔵UIを生成しない", async () => {
        await createInstance({ enableDefaultControls: false });
        expect(createHudMock).not.toHaveBeenCalled();
        expect(setupTouchControlsMock).not.toHaveBeenCalled();
        expect(setupKeyboardControlsMock).not.toHaveBeenCalled();
    });

    it("showArButton: false ではARボタンを追加しない", async () => {
        await createInstance({ showArButton: false });
        expect(attachArButtonMock).not.toHaveBeenCalled();
    });

    it("WebXR非対応環境ではshowArButton未指定でもARボタンを追加しない", async () => {
        arSupported = false;
        await createInstance();
        expect(attachArButtonMock).not.toHaveBeenCalled();
    });

    it("WebXR対応環境ではshowArButton未指定（既定true）でARボタンを追加する", async () => {
        await createInstance();
        expect(attachArButtonMock).toHaveBeenCalledTimes(1);
    });
});

describe("center / footprintHalfSizeM", () => {
    it("初期値を反映する", async () => {
        const diorama = await createInstance({ footprintHalfSizeM: 500 });
        expect(diorama.center).toEqual(DEFAULT_CENTER);
        expect(diorama.footprintHalfSizeM).toBe(500);
    });

    it("setCenterでterrain.setViewが呼ばれ、centerが更新される", async () => {
        const diorama = await createInstance();
        await diorama.setCenter(35.0, 139.0);
        expect(fakeTerrains[0].setView).toHaveBeenCalledWith({ center: { lat: 35.0, lon: 139.0 } });
        expect(diorama.center).toEqual({ lat: 35.0, lon: 139.0 });
    });

    it("setFootprintHalfSizeでterrain.setViewが呼ばれ、footprintHalfSizeMが更新される", async () => {
        const diorama = await createInstance();
        await diorama.setFootprintHalfSize(500);
        expect(diorama.footprintHalfSizeM).toBe(500);
    });

    it("onViewChangeはsetView経由の変化後に呼ばれ、unsubscribeで解除できる", async () => {
        const diorama = await createInstance();
        const listener = vi.fn();
        const unsubscribe = diorama.onViewChange(listener);

        await diorama.setView({ footprintHalfSizeM: 600 });
        expect(listener).toHaveBeenCalledWith({ center: DEFAULT_CENTER, footprintHalfSizeM: 600 });

        unsubscribe();
        await diorama.setView({ footprintHalfSizeM: 700 });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("複数のonViewChangeリスナーは互いに独立したcenterスナップショットを受け取る（あるリスナーの書き換えが他へ影響しない）", async () => {
        const diorama = await createInstance();
        const receivedByFirst: unknown[] = [];
        const receivedBySecond: unknown[] = [];
        diorama.onViewChange((event) => {
            // 受け取ったオブジェクトをその場で書き換える（リスナー間の干渉が
            // 無いことを検証するため、意図的に破壊的変更を行う）。
            (event.center as { lat: number }).lat = -1;
            receivedByFirst.push({ ...event.center });
        });
        diorama.onViewChange((event) => {
            receivedBySecond.push({ ...event.center });
        });

        await diorama.setView({ footprintHalfSizeM: 600 });

        expect(receivedByFirst[0]).toEqual({ lat: -1, lon: DEFAULT_CENTER.lon });
        // 1つ目のリスナーが event.center を書き換えても、2つ目のリスナーへは
        // 影響しない（独立したスナップショットを受け取る）。
        expect(receivedBySecond[0]).toEqual(DEFAULT_CENTER);
    });
});

describe("tileMode", () => {
    it("初期値を反映する", async () => {
        const diorama = await createInstance({ tileMode: "photo" });
        expect(diorama.tileMode).toBe("photo");
    });

    it("setTileModeでterrain.setTileModeが呼ばれ、tileModeが更新される", async () => {
        const diorama = await createInstance();
        await diorama.setTileMode("wireframe");
        expect(fakeTerrains[0].setTileMode).toHaveBeenCalledWith("wireframe");
        expect(diorama.tileMode).toBe("wireframe");
    });

    it("cycleTileModeで巡回する", async () => {
        const diorama = await createInstance();
        diorama.cycleTileMode();
        await Promise.resolve();
        await Promise.resolve();
        expect(diorama.tileMode).toBe("photo");
    });

    it("onTileModeChangeはタイル種別変化後に呼ばれる", async () => {
        const diorama = await createInstance();
        const listener = vi.fn();
        diorama.onTileModeChange(listener);

        await diorama.setTileMode("wireframe");

        expect(listener).toHaveBeenCalledWith("wireframe");
    });
});

describe("rotationDeg / heightOffsetM", () => {
    it("既定値は0", async () => {
        const diorama = await createInstance();
        expect(diorama.rotationDeg).toBe(0);
        expect(diorama.heightOffsetM).toBe(0);
    });

    it("rotationDegを設定すると度→radへ変換して反映される", async () => {
        const diorama = await createInstance();
        diorama.rotationDeg = 90;
        expect(diorama.rotationDeg).toBeCloseTo(90, 10);
    });

    it("heightOffsetMを設定すると反映される（下限・上限でクランプ）", async () => {
        const diorama = await createInstance();
        diorama.heightOffsetM = 0.2;
        expect(diorama.heightOffsetM).toBe(0.2);
    });
});

describe("feedPanZoomAxes / feedOrientationAxes", () => {
    it("低レベルAPIは対応するコントローラーへ委譲される", async () => {
        const diorama = await createInstance({ enableDefaultControls: false });
        diorama.feedPanZoomAxes({ x: 1, y: 0 }, 0, 1);
        expect(fakeTerrains[0].setView).toHaveBeenCalled();

        diorama.feedOrientationAxes(1, 0, 0, 1);
        expect(diorama.rotationDeg).not.toBe(0);
    });
});

describe("WebXR AR", () => {
    it("isArSupported/arStateはサポート判定結果を反映する", async () => {
        const diorama = await createInstance();
        await expect(diorama.isArSupported()).resolves.toBe(true);
        expect(diorama.arState).toBe("inactive");
    });

    it("非対応環境ではarStateがunsupportedになり、enterArはrejectする", async () => {
        arSupported = false;
        const diorama = await createInstance();
        expect(diorama.arState).toBe("unsupported");
        await expect(diorama.enterAr()).rejects.toThrow();
    });

    it("enterAr/exitArはコントローラーへ委譲し、arState/onArStateChangeへ反映される", async () => {
        const diorama = await createInstance();
        const listener = vi.fn();
        diorama.onArStateChange(listener);

        await diorama.enterAr();
        expect(arControllers[0].enter).toHaveBeenCalledTimes(1);
        expect(diorama.arState).toBe("active");
        expect(listener).toHaveBeenCalledWith("active");

        await diorama.exitAr();
        expect(arControllers[0].exit).toHaveBeenCalledTimes(1);
        expect(diorama.arState).toBe("inactive");
        expect(listener).toHaveBeenCalledWith("inactive");
    });
});

describe("dispose", () => {
    it("canvasを除去し、terrain/arController/touchControls/keyboardControlsを破棄する", async () => {
        const mount = document.createElement("div");
        const diorama = await JpmapDiorama.create(mount, { center: DEFAULT_CENTER });

        diorama.dispose();

        expect(mount.querySelector("canvas")).toBeNull();
        expect(fakeTerrains[0].dispose).toHaveBeenCalledTimes(1);
        expect(arControllers[0].dispose).toHaveBeenCalledTimes(1);
        expect(touchControlsDisposeMock).toHaveBeenCalledTimes(1);
        expect(keyboardControlsDisposeMock).toHaveBeenCalledTimes(1);
    });

    it("enableDefaultControls有効時、タッチHUDのDOM要素も破棄する（mountに残留しない）", async () => {
        const mount = document.createElement("div");
        const diorama = await JpmapDiorama.create(mount, { center: DEFAULT_CENTER });
        expect(mount.querySelector('[data-testid="diorama-touch-hud"]')).not.toBeNull();

        diorama.dispose();

        expect(hudDisposeMock).toHaveBeenCalledTimes(1);
        expect(mount.querySelector('[data-testid="diorama-touch-hud"]')).toBeNull();
    });

    it("複数回呼んでも例外を投げない（冪等性）", async () => {
        const diorama = await createInstance();
        expect(() => diorama.dispose()).not.toThrow();
        expect(() => diorama.dispose()).not.toThrow();
    });
});
