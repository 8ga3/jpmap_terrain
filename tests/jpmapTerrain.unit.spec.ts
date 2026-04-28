/**
 * @jest-environment jsdom
 */
/**
 * `JpmapTerrain` クラス公開 API のユニットテスト (T3-T4 / Issues #117, #118)
 *
 * - デフォルト値の適用
 * - get/set による状態保持
 * - flyTo による状態更新
 * - mountElement 必須チェック
 * - mountElement 配下に canvas が追加されること (T4)
 * - dispose で canvas が除去されること (T4)
 *
 * Babylon.js Engine / Scene は jsdom で動かないためモックする。
 * Jest は ESM/VM Modules モードで起動しているため
 * `jest.unstable_mockModule` + 動的 import でモックを適用する。
 */

import { jest } from "@jest/globals";

// Engine / Scene 生成はテスト対象外（Babylon.js に委譲）。
// jsdom では WebGPU/WebGL2 を提供できないため、最低限のスタブで差し替える。
const engineDispose = jest.fn();
// engine.resize 呼び出し回数を T7 テストで検証できるよう、最後に作った engine の resize を保持する。
let lastEngineResize: jest.Mock = jest.fn();
// 実際の `createBabylonEngine(canvas, preferred)` のシグネチャに合わせる。
// 関数本体では未使用だが、`createEngineMock.mock.calls[i][1]` で第 2 引数（engine 種別）を
// 検証する用途があるため、可変引数ではなく明示的なパラメータとして宣言する。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const createEngineMock = jest.fn(async (_canvas: unknown, _preferred?: "webgpu" | "webgl2") => {
    const resize = jest.fn();
    lastEngineResize = resize;
    return {
        runRenderLoop: jest.fn(),
        resize,
        dispose: engineDispose,
    };
});

jest.unstable_mockModule("../src/lib/internal/engineFactory", () => ({
    createBabylonEngine: createEngineMock,
}));

// jsdom には ResizeObserver が無いため、テスト用に簡易実装を注入する (T7 / #121)。
// 観測対象 → 観測コールバックを覚えておき、テストから手動で trigger できる。
type RoCallback = (entries: unknown[], observer: unknown) => void;
const resizeObservers: Array<{
    callback: RoCallback;
    targets: Set<Element>;
    disconnect: jest.Mock;
}> = [];
class TestResizeObserver {
    public disconnect: jest.Mock;
    private targets: Set<Element> = new Set();
    constructor(callback: RoCallback) {
        this.disconnect = jest.fn(() => {
            this.targets.clear();
        });
        resizeObservers.push({
            callback,
            targets: this.targets,
            disconnect: this.disconnect,
        });
    }
    observe(target: Element): void {
        this.targets.add(target);
    }
    unobserve(target: Element): void {
        this.targets.delete(target);
    }
}
(globalThis as unknown as { ResizeObserver: typeof TestResizeObserver }).ResizeObserver = TestResizeObserver;
const triggerResizeObservers = (): void => {
    for (const ro of resizeObservers) {
        if (ro.targets.size === 0) continue;
        const entries = Array.from(ro.targets).map((t) => ({ target: t }));
        ro.callback(entries, ro);
    }
};

jest.unstable_mockModule("../src/scenes/default", () => {
    // モック内で refreshTerrain 相当の呼び出し回数を記録し、
    // テストから検証できるよう getter を export する（T5 のバッチ refresh 検証用）。
    let refreshCallCount = 0;
    // T6: setMapType / setUiVisibility の記録もテストから検証できるよう保持する。
    let lastMapType: "standard" | "photo" = "standard";
    const setMapTypeCalls: Array<"standard" | "photo"> = [];
    // T7: controller.dispose の呼び出し回数も検証する。
    let controllerDisposeCount = 0;
    // Issue #35: setSunState 呼び出し履歴を保持する。
    const sunStateCalls: Array<{ dateTime: Date | null }> = [];
    // Issue #39: setSunShadows 呼び出し履歴を保持する。
    const sunShadowsCalls: boolean[] = [];
    // #136: scene.onBeforeRenderObservable のテスト用簡易実装。
    // jpmapTerrain.ts は `add(callback)` の戻り値を `Observer` として保持し、
    // dispose 時に `remove(observer)` する。テストからは `__triggerSceneRender` で
    // 全 observer を疑似発火させる。
    type SceneObserver = { callback: () => void };
    const sceneObservables: Array<{
        observers: SceneObserver[];
        add: (cb: () => void) => SceneObserver;
        remove: (obs: SceneObserver) => boolean;
    }> = [];
    const createSceneObservable = (): {
        add: (cb: () => void) => SceneObserver;
        remove: (obs: SceneObserver) => boolean;
    } => {
        const observers: SceneObserver[] = [];
        const obs = {
            observers,
            add: (cb: () => void): SceneObserver => {
                const o: SceneObserver = { callback: cb };
                observers.push(o);
                return o;
            },
            remove: (target: SceneObserver): boolean => {
                const idx = observers.indexOf(target);
                if (idx === -1) return false;
                observers.splice(idx, 1);
                return true;
            },
        };
        sceneObservables.push(obs);
        return obs;
    };
    const triggerSceneRender = (): void => {
        for (const obs of sceneObservables) {
            // iterate 中の add/remove 安全のため slice
            for (const o of obs.observers.slice()) {
                o.callback();
            }
        }
    };
    type UiTarget =
        | "compass"
        | "zoomButtons"
        | "scaleBar"
        | "mapToggle"
        | "attribution";
    const uiVisibility: Record<UiTarget, boolean> = {
        compass: true,
        zoomButtons: true,
        scaleBar: true,
        mapToggle: true,
        attribution: true,
    };
    type ViewValues = {
        lat?: number;
        lon?: number;
        altitude?: number;
        azimuth?: number;
        tilt?: number;
    };
    class DefaultScene {
        createScene = jest.fn(
            async (
                _engine: unknown,
                _canvas: unknown,
                opts?: {
                    lat?: number;
                    lon?: number;
                    altitude?: number;
                    azimuth?: number;
                    tilt?: number;
                    mapType?: "standard" | "photo";
                    onMapTypeChange?: (mapType: "standard" | "photo") => void;
                    onReady?: (controller: unknown) => void;
                },
            ) => {
                // T5: コントローラのインメモリ実装をテスト用に提供する。
                let lat = opts?.lat ?? 0;
                let lon = opts?.lon ?? 0;
                let altitude = opts?.altitude ?? 0;
                let azimuth = opts?.azimuth ?? 0;
                let tilt = opts?.tilt ?? 0;
                if (opts?.mapType) lastMapType = opts.mapType;
                const refresh = (): void => {
                    refreshCallCount++;
                };
                const applyView = (
                    values: ViewValues,
                    shouldRefresh: boolean,
                ): void => {
                    let centerChanged = false;
                    if (values.lat !== undefined) {
                        lat = values.lat;
                        centerChanged = true;
                    }
                    if (values.lon !== undefined) {
                        lon = values.lon;
                        centerChanged = true;
                    }
                    if (values.altitude !== undefined) altitude = values.altitude;
                    if (values.azimuth !== undefined) azimuth = values.azimuth;
                    if (values.tilt !== undefined) tilt = values.tilt;
                    if (shouldRefresh && centerChanged) refresh();
                };
                opts?.onReady?.({
                    getLat: () => lat,
                    getLon: () => lon,
                    getAltitude: () => altitude,
                    getAzimuth: () => azimuth,
                    getTilt: () => tilt,
                    setLat: (v: number) => applyView({ lat: v }, true),
                    setLon: (v: number) => applyView({ lon: v }, true),
                    setAltitude: (v: number) => applyView({ altitude: v }, true),
                    setAzimuth: (v: number) => applyView({ azimuth: v }, true),
                    setTilt: (v: number) => applyView({ tilt: v }, true),
                    setView: (
                        values: ViewValues,
                        options?: { refreshTerrain?: boolean },
                    ) => applyView(values, options?.refreshTerrain ?? true),
                    getMapType: () => lastMapType,
                    setMapType: (value: "standard" | "photo") => {
                        const prev = lastMapType;
                        lastMapType = value;
                        setMapTypeCalls.push(value);
                        if (prev !== value) {
                            opts?.onMapTypeChange?.(value);
                        }
                    },
                    setUiVisibility: (target: UiTarget, visible: boolean) => {
                        uiVisibility[target] = visible;
                    },
                    setSunState: (_dateTime: Date | null) => {
                        // テスト用: 受信を記録するだけで Babylon 描画は伴わない
                        sunStateCalls.push({ dateTime: _dateTime });
                    },
                    setSunShadows: (enabled: boolean) => {
                        sunShadowsCalls.push(enabled);
                    },
                    getMarkerContext: () => ({
                        scene: { onBeforeRenderObservable: createSceneObservable() },
                        tileManager: {
                            queryElevationAtWorld: () => 0,
                            subscribeTerrainUpdated: () => () => {
                                /* no-op */
                            },
                        },
                        getOrigin: () => ({
                            lat,
                            lon,
                            gridResidualX: 0,
                            gridResidualZ: 0,
                        }),
                    }),
                    dispose: () => {
                        controllerDisposeCount++;
                    },
                });
                return {
                    render: jest.fn(),
                    dispose: jest.fn(),
                    onBeforeRenderObservable: createSceneObservable(),
                };
            },
        );
    }
    return {
        DefaultScene,
        METERS_PER_DEGREE_LAT: 111320,
        __getRefreshCount: (): number => refreshCallCount,
        __resetRefreshCount: (): void => {
            refreshCallCount = 0;
        },
        __getUiVisibility: (): Record<UiTarget, boolean> => ({
            ...uiVisibility,
        }),
        __resetUiVisibility: (): void => {
            uiVisibility.compass = true;
            uiVisibility.zoomButtons = true;
            uiVisibility.scaleBar = true;
            uiVisibility.mapToggle = true;
            uiVisibility.attribution = true;
        },
        __getSetMapTypeCalls: (): Array<"standard" | "photo"> => [
            ...setMapTypeCalls,
        ],
        __resetSetMapTypeCalls: (): void => {
            setMapTypeCalls.length = 0;
        },
        __getLastMapType: (): "standard" | "photo" => lastMapType,
        __setLastMapType: (v: "standard" | "photo"): void => {
            lastMapType = v;
        },
        __getControllerDisposeCount: (): number => controllerDisposeCount,
        __resetControllerDisposeCount: (): void => {
            controllerDisposeCount = 0;
        },
        __getSunStateCalls: (): Array<{ dateTime: Date | null }> => [
            ...sunStateCalls,
        ],
        __resetSunStateCalls: (): void => {
            sunStateCalls.length = 0;
        },
        __getSunShadowsCalls: (): boolean[] => [...sunShadowsCalls],
        __resetSunShadowsCalls: (): void => {
            sunShadowsCalls.length = 0;
        },
        __triggerSceneRender: (): void => triggerSceneRender(),
    };
});

// jest.unstable_mockModule は hoist されないため、モック登録後に動的 import する。
const { JpmapTerrain } = await import("../src/lib/jpmapTerrain");
type UiTarget =
    | "compass"
    | "zoomButtons"
    | "scaleBar"
    | "mapToggle"
    | "attribution";
const sceneMockModule = (await import("../src/scenes/default")) as unknown as {
    __getRefreshCount: () => number;
    __resetRefreshCount: () => void;
    __getUiVisibility: () => Record<UiTarget, boolean>;
    __resetUiVisibility: () => void;
    __getSetMapTypeCalls: () => Array<"standard" | "photo">;
    __resetSetMapTypeCalls: () => void;
    __getLastMapType: () => "standard" | "photo";
    __setLastMapType: (v: "standard" | "photo") => void;
    __getControllerDisposeCount: () => number;
    __resetControllerDisposeCount: () => void;
    __getSunStateCalls: () => Array<{ dateTime: Date | null }>;
    __resetSunStateCalls: () => void;
    __getSunShadowsCalls: () => boolean[];
    __resetSunShadowsCalls: () => void;
    __triggerSceneRender: () => void;
};

describe("JpmapTerrain (skeleton)", () => {
    const createMountElement = (): HTMLElement => document.createElement("div");

    // 生成したビューアを記録し、テスト終了時にまとめて dispose してリスナー残留を防ぐ。
    type Viewer = Awaited<ReturnType<typeof JpmapTerrain.create>>;
    const createdViewers: Viewer[] = [];
    const create: typeof JpmapTerrain.create = async (mount, opts) => {
        const viewer = await JpmapTerrain.create(mount, opts);
        createdViewers.push(viewer);
        return viewer;
    };
    afterEach(() => {
        while (createdViewers.length > 0) {
            const viewer = createdViewers.pop();
            try {
                viewer?.dispose();
            } catch {
                /* dispose の副作用テストでは事前に呼ばれている可能性があり、無視 */
            }
        }
    });

    describe("create", () => {
        it("オプション未指定時に spec/package.md §3.2 のデフォルト値が適用される", async () => {
            const viewer = await create(createMountElement());

            expect(viewer.lat).toBeCloseTo(35.681236);
            expect(viewer.lon).toBeCloseTo(139.767125);
            expect(viewer.altitude).toBe(2000);
            expect(viewer.azimuth).toBe(0);
            expect(viewer.tilt).toBe(45);
            expect(viewer.mapType).toBe("standard");
        });

        it("UI 表示フラグはデフォルトで全て true", async () => {
            const viewer = await create(createMountElement());

            expect(viewer.showCompass).toBe(true);
            expect(viewer.showZoomButtons).toBe(true);
            expect(viewer.showScaleBar).toBe(true);
            expect(viewer.showMapToggle).toBe(true);
            expect(viewer.showAttribution).toBe(true);
        });

        it("オプション指定値が反映される", async () => {
            const viewer = await create(createMountElement(), {
                lat: 36.2333,
                lon: 137.6167,
                altitude: 5000,
                azimuth: 90,
                tilt: 30,
                mapType: "photo",
            });

            expect(viewer.lat).toBe(36.2333);
            expect(viewer.lon).toBe(137.6167);
            expect(viewer.altitude).toBe(5000);
            expect(viewer.azimuth).toBe(90);
            expect(viewer.tilt).toBe(30);
            expect(viewer.mapType).toBe("photo");
        });

        it("mountElement が falsy の場合 TypeError を投げる", async () => {
            await expect(
                JpmapTerrain.create(null as unknown as HTMLElement),
            ).rejects.toThrow(TypeError);
        });
    });

    describe("getter / setter", () => {
        it("位置・カメラ系プロパティが set した値を保持する", async () => {
            const viewer = await create(createMountElement());

            viewer.lat = 40.0;
            viewer.lon = 140.0;
            viewer.altitude = 1234;
            viewer.azimuth = 180;
            viewer.tilt = 60;

            expect(viewer.lat).toBe(40.0);
            expect(viewer.lon).toBe(140.0);
            expect(viewer.altitude).toBe(1234);
            expect(viewer.azimuth).toBe(180);
            expect(viewer.tilt).toBe(60);
        });

        it("UI 表示フラグが set した値を保持する", async () => {
            const viewer = await create(createMountElement());

            viewer.showCompass = false;
            viewer.showZoomButtons = false;
            viewer.showScaleBar = false;
            viewer.showMapToggle = false;
            viewer.showAttribution = false;

            expect(viewer.showCompass).toBe(false);
            expect(viewer.showZoomButtons).toBe(false);
            expect(viewer.showScaleBar).toBe(false);
            expect(viewer.showMapToggle).toBe(false);
            expect(viewer.showAttribution).toBe(false);
        });

        it("mapType が set した値を保持する", async () => {
            const viewer = await create(createMountElement());

            viewer.mapType = "photo";
            expect(viewer.mapType).toBe("photo");

            viewer.mapType = "standard";
            expect(viewer.mapType).toBe("standard");
        });
    });

    describe("flyTo", () => {
        it("lat / lon を必ず更新する", async () => {
            const viewer = await create(createMountElement());

            await viewer.flyTo({ lat: 35.3606, lon: 138.7274 });

            expect(viewer.lat).toBe(35.3606);
            expect(viewer.lon).toBe(138.7274);
        });

        it("省略可能パラメータが渡された場合のみ更新する", async () => {
            const viewer = await create(createMountElement(), {
                altitude: 1000,
                azimuth: 10,
                tilt: 20,
            });

            await viewer.flyTo({ lat: 0, lon: 0, altitude: 9999 });

            expect(viewer.altitude).toBe(9999);
            expect(viewer.azimuth).toBe(10);
            expect(viewer.tilt).toBe(20);
        });

        it("altitude / azimuth / tilt が省略された場合は現在値を維持する", async () => {
            const viewer = await create(createMountElement(), {
                altitude: 3000,
                azimuth: 45,
                tilt: 50,
            });

            await viewer.flyTo({ lat: 1, lon: 2 });

            expect(viewer.altitude).toBe(3000);
            expect(viewer.azimuth).toBe(45);
            expect(viewer.tilt).toBe(50);
        });
    });

    describe("lifecycle stubs", () => {
        it("dispose / resize 呼び出しは例外を投げない", async () => {
            const viewer = await create(createMountElement());

            expect(() => viewer.resize()).not.toThrow();
            expect(() => viewer.dispose()).not.toThrow();
        });
    });

    describe("mount canvas (T4)", () => {
        it("create 時に mountElement 配下へ canvas が追加される", async () => {
            const mount = createMountElement();
            await create(mount);

            const canvases = mount.querySelectorAll("canvas");
            expect(canvases.length).toBe(1);
        });

        it("dispose 時に canvas が mountElement から取り除かれる", async () => {
            const mount = createMountElement();
            const viewer = await create(mount);
            expect(mount.querySelectorAll("canvas").length).toBe(1);

            viewer.dispose();

            expect(mount.querySelectorAll("canvas").length).toBe(0);
        });

        it("生成した canvas に固定 id を付与しない（複数インスタンス共存可）", async () => {
            const mount = createMountElement();
            await create(mount);

            const canvas = mount.querySelector("canvas")!;
            expect(canvas.id).toBe("");
        });

        it("同一ページで複数インスタンスを共存できる", async () => {
            const mountA = createMountElement();
            const mountB = createMountElement();
            await create(mountA);
            await create(mountB);

            expect(mountA.querySelectorAll("canvas").length).toBe(1);
            expect(mountB.querySelectorAll("canvas").length).toBe(1);
        });

        it("初期化途中で例外が発生した場合 canvas を mountElement から除去する", async () => {
            const mount = createMountElement();
            createEngineMock.mockRejectedValueOnce(new Error("engine init failed"));

            await expect(JpmapTerrain.create(mount)).rejects.toThrow("engine init failed");

            expect(mount.querySelectorAll("canvas").length).toBe(0);
        });
    });

    describe("camera controller wiring (T5)", () => {
        it("set した位置・カメラ系プロパティはコントローラ経由で取得しても同じ値になる", async () => {
            const viewer = await create(createMountElement(), {
                lat: 1,
                lon: 2,
                altitude: 100,
                azimuth: 10,
                tilt: 20,
            });

            viewer.lat = 35.0;
            viewer.lon = 140.0;
            viewer.altitude = 1500;
            viewer.azimuth = 90;
            viewer.tilt = 60;

            // get はコントローラから取得される
            expect(viewer.lat).toBe(35.0);
            expect(viewer.lon).toBe(140.0);
            expect(viewer.altitude).toBe(1500);
            expect(viewer.azimuth).toBe(90);
            expect(viewer.tilt).toBe(60);
        });

        it("flyTo は Promise を返し、完了時に最終値へ到達する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
                azimuth: 0,
                tilt: 30,
            });

            await viewer.flyTo({
                lat: 35.3606,
                lon: 138.7274,
                altitude: 8000,
                azimuth: 45,
                tilt: 60,
                duration: 50,
            });

            expect(viewer.lat).toBeCloseTo(35.3606);
            expect(viewer.lon).toBeCloseTo(138.7274);
            expect(viewer.altitude).toBeCloseTo(8000);
            expect(viewer.azimuth).toBeCloseTo(45);
            expect(viewer.tilt).toBeCloseTo(60);
        });

        it("duration=0 では即時に最終値が反映される", async () => {
            const viewer = await create(createMountElement());

            await viewer.flyTo({
                lat: 10,
                lon: 20,
                altitude: 3000,
                duration: 0,
            });

            expect(viewer.lat).toBe(10);
            expect(viewer.lon).toBe(20);
            expect(viewer.altitude).toBe(3000);
        });

        it("連続 flyTo では後勝ちになり、双方の Promise が解決される", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
            });

            const first = viewer.flyTo({
                lat: 50,
                lon: 50,
                altitude: 5000,
                duration: 200,
            });
            // 即座に上書き
            const second = viewer.flyTo({
                lat: 1,
                lon: 2,
                altitude: 1234,
                duration: 30,
            });

            await Promise.all([first, second]);

            // 後勝ちの second が最終値
            expect(viewer.lat).toBeCloseTo(1);
            expect(viewer.lon).toBeCloseTo(2);
            expect(viewer.altitude).toBeCloseTo(1234);
        });

        it("flyTo 中の中間フレームではタイル refresh を発火させず、最終フレームでまとめて refresh する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
            });
            // 初期化中の refresh は対象外。flyTo 開始時点でリセット。
            sceneMockModule.__resetRefreshCount();

            await viewer.flyTo({
                lat: 35,
                lon: 139,
                altitude: 2000,
                duration: 50,
            });

            // バッチ refresh 設計により、中間フレームでは refresh されず、
            // 最終フレーム（または完了相当）で 1 回のみ呼ばれる想定。
            // jsdom 上の RAF タイミングに揺れがあっても 2 回以下に収まることを保証する。
            const count = sceneMockModule.__getRefreshCount();
            expect(count).toBeGreaterThanOrEqual(1);
            expect(count).toBeLessThanOrEqual(2);
        });

        it("単体 setter（lat/lon）はその都度 refresh を発火する", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetRefreshCount();

            viewer.lat = 35;
            viewer.lon = 139;

            // lat/lon それぞれで 1 回ずつ。
            expect(sceneMockModule.__getRefreshCount()).toBe(2);
        });

        it("altitude/azimuth/tilt の単体 setter は refresh を発火しない", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetRefreshCount();

            viewer.altitude = 5000;
            viewer.azimuth = 90;
            viewer.tilt = 45;

            expect(sceneMockModule.__getRefreshCount()).toBe(0);
        });
    });

    describe("UI visibility / mapType (T6)", () => {
        beforeEach(() => {
            sceneMockModule.__resetUiVisibility();
            sceneMockModule.__resetSetMapTypeCalls();
            sceneMockModule.__setLastMapType("standard");
        });

        it("create 直後は controller に各 UI の初期表示状態（既定すべて true）が反映される", async () => {
            await create(createMountElement());
            expect(sceneMockModule.__getUiVisibility()).toEqual({
                compass: true,
                zoomButtons: true,
                scaleBar: true,
                mapToggle: true,
                attribution: true,
            });
        });

        it("showXxx setter は対応する UI の表示状態を controller に反映する", async () => {
            const viewer = await create(createMountElement());

            viewer.showCompass = false;
            viewer.showZoomButtons = false;
            viewer.showScaleBar = false;
            viewer.showMapToggle = false;
            viewer.showAttribution = false;

            expect(sceneMockModule.__getUiVisibility()).toEqual({
                compass: false,
                zoomButtons: false,
                scaleBar: false,
                mapToggle: false,
                attribution: false,
            });

            // get は内部状態を返す
            expect(viewer.showCompass).toBe(false);
            expect(viewer.showZoomButtons).toBe(false);
            expect(viewer.showScaleBar).toBe(false);
            expect(viewer.showMapToggle).toBe(false);
            expect(viewer.showAttribution).toBe(false);

            viewer.showCompass = true;
            expect(sceneMockModule.__getUiVisibility().compass).toBe(true);
            expect(viewer.showCompass).toBe(true);
        });

        it("create に mapType を渡すと controller 経由で getter が返す値も反映される", async () => {
            // モック内 lastMapType は createScene の opts.mapType で初期化される。
            const viewer = await create(createMountElement(), {
                mapType: "photo",
            });
            expect(viewer.mapType).toBe("photo");
        });

        it("mapType setter は controller.setMapType を呼び、getter にも反映される", async () => {
            const viewer = await create(createMountElement());
            expect(viewer.mapType).toBe("standard");

            viewer.mapType = "photo";

            expect(sceneMockModule.__getSetMapTypeCalls()).toEqual(["photo"]);
            expect(viewer.mapType).toBe("photo");

            viewer.mapType = "standard";
            expect(sceneMockModule.__getSetMapTypeCalls()).toEqual([
                "photo",
                "standard",
            ]);
            expect(viewer.mapType).toBe("standard");
        });
    });

    describe("dispose / resize (T7)", () => {
        it("ResizeObserver の通知で engine.resize が呼ばれる", async () => {
            await create(createMountElement());
            const resize = lastEngineResize;
            // 初期化時の resize 呼び出しはまだ無い（runRenderLoop と resize 紐付けは window.resize と RO トリガ経由）。
            expect(resize).toHaveBeenCalledTimes(0);

            triggerResizeObservers();

            expect(resize).toHaveBeenCalledTimes(1);
        });

        it("dispose 後は ResizeObserver / window.resize の通知でも engine.resize が呼ばれない", async () => {
            const viewer = await create(createMountElement());
            const resize = lastEngineResize;
            viewer.dispose();

            triggerResizeObservers();
            window.dispatchEvent(new Event("resize"));

            expect(resize).toHaveBeenCalledTimes(0);
        });

        it("dispose は冪等で、複数回呼んでも例外にならず engine.dispose は 1 回だけ呼ばれる", async () => {
            const viewer = await create(createMountElement());
            engineDispose.mockClear();

            viewer.dispose();
            viewer.dispose();
            viewer.dispose();

            expect(engineDispose).toHaveBeenCalledTimes(1);
        });

        it("dispose 後に同一 mountElement で再 create しても例外にならず canvas が再配置される", async () => {
            const mount = createMountElement();
            const first = await create(mount);
            first.dispose();

            // dispose 後は canvas が外れている
            expect(mount.querySelectorAll("canvas").length).toBe(0);

            const second = await create(mount);

            expect(mount.querySelectorAll("canvas").length).toBe(1);
            // 再度 dispose しても問題ない
            expect(() => second.dispose()).not.toThrow();
            expect(mount.querySelectorAll("canvas").length).toBe(0);
        });

        it("resize() を明示的に呼ぶと engine.resize が呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const resize = lastEngineResize;

            viewer.resize();

            expect(resize).toHaveBeenCalledTimes(1);
        });

        it("dispose で controller.dispose が 1 回呼ばれる（UI 残留対策）", async () => {
            sceneMockModule.__resetControllerDisposeCount();
            const viewer = await create(createMountElement());

            viewer.dispose();
            // 冪等呼び出しでは増えない
            viewer.dispose();

            expect(sceneMockModule.__getControllerDisposeCount()).toBe(1);
        });
    });

    describe("public API surface (T8)", () => {
        it("JpmapTerrain.create は JpmapTerrain インスタンスを返す", async () => {
            const viewer = await create(createMountElement());
            expect(viewer).toBeInstanceOf(JpmapTerrain);
        });

        it("create に engine オプションを渡すと engineFactory に伝播する", async () => {
            createEngineMock.mockClear();
            await create(createMountElement(), { engine: "webgl2" });
            expect(createEngineMock).toHaveBeenCalledTimes(1);
            // createBabylonEngine(canvas, preferredEngine) のシグネチャ
            const callArgs = createEngineMock.mock.calls[0];
            expect(callArgs[1]).toBe("webgl2");
        });

        it("engine 未指定時はデフォルト (webgpu) で engineFactory を呼ぶ", async () => {
            createEngineMock.mockClear();
            await create(createMountElement());
            expect(createEngineMock.mock.calls[0][1]).toBe("webgpu");
        });

        it("dispose 後の getter は最後に保持していた値を返す（コントローラ非経由）", async () => {
            const viewer = await create(createMountElement(), {
                lat: 35,
                lon: 139,
                altitude: 1500,
                azimuth: 30,
                tilt: 60,
                mapType: "photo",
            });
            viewer.dispose();

            // controller が解放された後はキャッシュ値を返す
            expect(viewer.lat).toBe(35);
            expect(viewer.lon).toBe(139);
            expect(viewer.altitude).toBe(1500);
            expect(viewer.azimuth).toBe(30);
            expect(viewer.tilt).toBe(60);
            // mapType の getter は controller 不在で内部値を返す
            expect(viewer.mapType).toBe("photo");
        });

        it("dispose 後の setter は内部値だけ更新し例外にならない", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();

            expect(() => {
                viewer.lat = 10;
                viewer.lon = 20;
                viewer.altitude = 3000;
                viewer.azimuth = 90;
                viewer.tilt = 45;
                viewer.showCompass = false;
                viewer.mapType = "photo";
            }).not.toThrow();

            expect(viewer.lat).toBe(10);
            expect(viewer.lon).toBe(20);
            expect(viewer.altitude).toBe(3000);
            expect(viewer.mapType).toBe("photo");
            expect(viewer.showCompass).toBe(false);
        });

        it("dispose 中に進行中の flyTo はキャンセルされ Promise が resolve する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
            });

            const flying = viewer.flyTo({
                lat: 35,
                lon: 139,
                altitude: 5000,
                duration: 200,
            });
            // 即座に dispose してキャンセル
            viewer.dispose();

            await expect(flying).resolves.toBeUndefined();
        });

        it("flyTo で altitude / azimuth / tilt を省略した場合は現在値を維持する（実反映）", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 2500,
                azimuth: 45,
                tilt: 60,
            });

            await viewer.flyTo({ lat: 1, lon: 2, duration: 0 });

            expect(viewer.altitude).toBe(2500);
            expect(viewer.azimuth).toBe(45);
            expect(viewer.tilt).toBe(60);
        });
    });

    describe("onCameraChange (Issue #136)", () => {
        it("初回登録時には即時発火しない", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();

            viewer.onCameraChange(listener);

            expect(listener).not.toHaveBeenCalled();
        });

        it("カメラ値変更後の onBeforeRender でリスナーが呼ばれる", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
                azimuth: 0,
                tilt: 30,
            });
            const listener = jest.fn();
            viewer.onCameraChange(listener);

            // 1 度目の発火: 値未変更だが初回スナップショット作成のみ。
            sceneMockModule.__triggerSceneRender();
            expect(listener).not.toHaveBeenCalled();

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(1);
            const event = listener.mock.calls[0][0] as {
                lat: number;
                lon: number;
                altitude: number;
                azimuth: number;
                tilt: number;
            };
            expect(event.lat).toBe(35);
            expect(event.lon).toBe(0);
            expect(event.altitude).toBe(1000);
        });

        it("値が変化しなければ発火しない（連続 render でも 1 回のみ）", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender(); // snapshot 初期化

            viewer.lon = 140;
            sceneMockModule.__triggerSceneRender();
            sceneMockModule.__triggerSceneRender();
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("unsubscribe 後は呼ばれず、複数回呼んでも安全", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            const unsubscribe = viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender(); // snapshot 初期化

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();
            expect(listener).toHaveBeenCalledTimes(1);

            unsubscribe();
            unsubscribe(); // 多重呼び出しでも例外にならない
            viewer.lat = 36;
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("同一リスナーを複数回登録した場合は登録回数だけ呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            viewer.onCameraChange(listener);
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender();

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(2);
        });

        it("リスナーが throw しても他リスナーへの伝播が継続する", async () => {
            const viewer = await create(createMountElement());
            const errorSpy = jest
                .spyOn(console, "error")
                .mockImplementation(() => {});
            const failing = jest.fn(() => {
                throw new Error("listener failure");
            });
            const ok = jest.fn();
            viewer.onCameraChange(failing);
            viewer.onCameraChange(ok);
            sceneMockModule.__triggerSceneRender();

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();

            expect(failing).toHaveBeenCalledTimes(1);
            expect(ok).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();

            errorSpy.mockRestore();
        });

        it("dispose 後の onCameraChange は no-op の unsubscribe を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();

            const listener = jest.fn();
            const unsubscribe = viewer.onCameraChange(listener);

            expect(typeof unsubscribe).toBe("function");
            expect(() => unsubscribe()).not.toThrow();
            // dispose 後は scene observer が外れているのでそもそも発火しない
            expect(listener).not.toHaveBeenCalled();
        });

        it("dispose 後はリスナーも発火しない（既登録ぶん）", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender();
            viewer.dispose();

            // dispose 済みの scene observer は除去されているため発火しない
            sceneMockModule.__triggerSceneRender();

            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe("onMapTypeChange (Issue #149)", () => {
        beforeEach(() => {
            sceneMockModule.__resetSetMapTypeCalls();
            sceneMockModule.__setLastMapType("standard");
        });

        it("初回登録時には即時発火しない", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            viewer.onMapTypeChange(listener);
            expect(listener).not.toHaveBeenCalled();
        });

        it("mapType setter で値が変化したらリスナーが呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            viewer.onMapTypeChange(listener);

            viewer.mapType = "photo";

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("photo");
        });

        it("同値再 set では発火しない", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            viewer.onMapTypeChange(listener);

            viewer.mapType = "standard"; // 既定値と同値
            viewer.mapType = "photo";
            viewer.mapType = "photo"; // 同値再 set

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("photo");
        });

        it("unsubscribe 後は呼ばれず、複数回呼んでも安全", async () => {
            const viewer = await create(createMountElement());
            const listener = jest.fn();
            const unsubscribe = viewer.onMapTypeChange(listener);

            viewer.mapType = "photo";
            expect(listener).toHaveBeenCalledTimes(1);

            unsubscribe();
            unsubscribe(); // 多重呼び出しでも例外にならない
            viewer.mapType = "standard";

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("複数リスナーを登録すると全て呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const a = jest.fn();
            const b = jest.fn();
            viewer.onMapTypeChange(a);
            viewer.onMapTypeChange(b);

            viewer.mapType = "photo";

            expect(a).toHaveBeenCalledTimes(1);
            expect(b).toHaveBeenCalledTimes(1);
        });

        it("リスナーが throw しても他リスナーへの伝播が継続する", async () => {
            const viewer = await create(createMountElement());
            const errorSpy = jest
                .spyOn(console, "error")
                .mockImplementation(() => {});
            const failing = jest.fn(() => {
                throw new Error("listener failure");
            });
            const ok = jest.fn();
            viewer.onMapTypeChange(failing);
            viewer.onMapTypeChange(ok);

            viewer.mapType = "photo";

            expect(failing).toHaveBeenCalledTimes(1);
            expect(ok).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();

            errorSpy.mockRestore();
        });

        it("dispose 後の onMapTypeChange は no-op の unsubscribe を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();

            const listener = jest.fn();
            const unsubscribe = viewer.onMapTypeChange(listener);

            expect(typeof unsubscribe).toBe("function");
            expect(() => unsubscribe()).not.toThrow();
            expect(listener).not.toHaveBeenCalled();
        });

        it("初期 options.mapType の反映では発火しない", async () => {
            // create 時に listener はまだ登録されていないため発火対象にはなり得ないが、
            // 念のため「初期化直後にリスナーを付け、その後の操作で初めて発火する」ことを確認する。
            const viewer = await create(createMountElement(), {
                mapType: "photo",
            });
            const listener = jest.fn();
            viewer.onMapTypeChange(listener);

            // 初期 photo に同値再 set → 発火しない
            viewer.mapType = "photo";
            expect(listener).not.toHaveBeenCalled();

            viewer.mapType = "standard";
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("standard");
        });
    });

    describe("sun position (Issue #35)", () => {
        beforeEach(() => {
            sceneMockModule.__resetSunStateCalls();
        });

        it("固定モード（autoSunPosition=false）の初期化で options.dateTime が controller.setSunState に渡る", async () => {
            const dt = new Date("2025-06-21T03:00:00Z");
            await create(createMountElement(), {
                dateTime: dt,
                autoSunPosition: false,
            });
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBeGreaterThanOrEqual(1);
            expect(calls[0].dateTime?.getTime()).toBe(dt.getTime());
        });

        it("autoSunPosition=true で起動した場合、初期化で setSunState が現在時刻で 1 回呼ばれる", async () => {
            const before = Date.now();
            await create(createMountElement(), { autoSunPosition: true });
            const after = Date.now();
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const t = calls[0].dateTime?.getTime() ?? 0;
            expect(t).toBeGreaterThanOrEqual(before);
            expect(t).toBeLessThanOrEqual(after);
        });

        it("autoSunPosition=true 中は 60 秒経過ごとに setSunState が呼ばれる", async () => {
            jest.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: true,
                });
                sceneMockModule.__resetSunStateCalls();
                jest.advanceTimersByTime(60_000);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(1);
                jest.advanceTimersByTime(60_000);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(2);
                viewer.dispose();
                // dispose 後はタイマーが解放され、それ以上呼ばれない
                jest.advanceTimersByTime(60_000 * 5);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(2);
            } finally {
                jest.useRealTimers();
            }
        });

        it("dateTime setter は固定モード中に setSunState を再呼出する", async () => {
            const viewer = await create(createMountElement(), {
                autoSunPosition: false,
            });
            sceneMockModule.__resetSunStateCalls();
            const dt = new Date("2025-12-21T03:00:00Z");
            viewer.dateTime = dt;
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBe(1);
            expect(calls[0].dateTime?.getTime()).toBe(dt.getTime());
        });

        it("autoSunPosition=true 中の dateTime setter は setSunState を呼ばない（auto 優先）", async () => {
            const viewer = await create(createMountElement(), {
                autoSunPosition: true,
            });
            sceneMockModule.__resetSunStateCalls();
            viewer.dateTime = new Date("2025-12-21T03:00:00Z");
            expect(sceneMockModule.__getSunStateCalls().length).toBe(0);
        });

        it("autoSunPosition=false→true 切替で 1 回反映され、true→false 切替で保持値が再反映される", async () => {
            const fixed = new Date("2025-06-21T03:00:00Z");
            const viewer = await create(createMountElement(), {
                dateTime: fixed,
                autoSunPosition: false,
            });
            sceneMockModule.__resetSunStateCalls();

            viewer.autoSunPosition = true;
            // auto 切替直後の即時反映 1 回
            expect(sceneMockModule.__getSunStateCalls().length).toBe(1);

            sceneMockModule.__resetSunStateCalls();
            viewer.autoSunPosition = false;
            // false 復帰時に保持していた dateTime で再反映
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBe(1);
            expect(calls[0].dateTime?.getTime()).toBe(fixed.getTime());
        });

        it("dateTime getter は auto モード中に最後に内部反映した実時刻を返す", async () => {
            jest.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: true,
                });
                const first = viewer.dateTime;
                expect(first).toBeInstanceOf(Date);
                jest.advanceTimersByTime(60_000);
                const second = viewer.dateTime;
                expect(second).toBeInstanceOf(Date);
                expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
            } finally {
                jest.useRealTimers();
            }
        });

        it("Invalid Date を options.dateTime に渡すと console.warn のうえ null フォールバック", async () => {
            const warnSpy = jest
                .spyOn(console, "warn")
                .mockImplementation(() => undefined);
            try {
                const viewer = await create(createMountElement(), {
                    dateTime: new Date("not-a-date"),
                    autoSunPosition: false,
                });
                expect(warnSpy).toHaveBeenCalled();
                expect(viewer.dateTime).toBeNull();
                const calls = sceneMockModule.__getSunStateCalls();
                expect(calls[0].dateTime).toBeNull();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("Invalid Date を dateTime setter に渡しても例外を投げず null フォールバック", async () => {
            const viewer = await create(createMountElement(), {
                autoSunPosition: false,
            });
            const warnSpy = jest
                .spyOn(console, "warn")
                .mockImplementation(() => undefined);
            try {
                viewer.dateTime = new Date("nope");
                expect(warnSpy).toHaveBeenCalled();
                expect(viewer.dateTime).toBeNull();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("dispose 後の自動更新タイマーは停止しており setSunState は呼ばれない", async () => {
            jest.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: true,
                });
                viewer.dispose();
                sceneMockModule.__resetSunStateCalls();
                jest.advanceTimersByTime(60_000 * 10);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });

        it("dispose 後の autoSunPosition setter / dateTime setter はタイマーを再起動しない（リーク防止）", async () => {
            jest.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: false,
                });
                viewer.dispose();
                sceneMockModule.__resetSunStateCalls();
                // dispose 後に setter を呼んでも setInterval は新規起動されない
                viewer.autoSunPosition = true;
                viewer.dateTime = new Date("2025-06-21T03:00:00Z");
                jest.advanceTimersByTime(60_000 * 10);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe("sun shadows (Issue #39)", () => {
        beforeEach(() => {
            sceneMockModule.__resetSunShadowsCalls();
        });

        it("既定値は false。初期化時に setSunShadows(true) は呼ばれない", async () => {
            const viewer = await create(createMountElement());
            expect(viewer.showSunShadows).toBe(false);
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);
        });

        it("options.showSunShadows=true で初期化すると setSunShadows(true) が 1 回呼ばれる", async () => {
            const viewer = await create(createMountElement(), {
                showSunShadows: true,
            });
            expect(viewer.showSunShadows).toBe(true);
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([true]);
        });

        it("setter で値を切り替えると controller.setSunShadows が呼ばれる", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetSunShadowsCalls();

            viewer.showSunShadows = true;
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([true]);

            viewer.showSunShadows = false;
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([
                true,
                false,
            ]);
        });

        it("同値の再 set は controller.setSunShadows を呼ばない", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetSunShadowsCalls();
            viewer.showSunShadows = false; // 既定 false への再 set
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);

            viewer.showSunShadows = true;
            sceneMockModule.__resetSunShadowsCalls();
            viewer.showSunShadows = true; // 再 set
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);
        });

        it("dispose 後の setter は no-op", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            sceneMockModule.__resetSunShadowsCalls();
            viewer.showSunShadows = true;
            expect(viewer.showSunShadows).toBe(false);
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);
        });
    });
});
