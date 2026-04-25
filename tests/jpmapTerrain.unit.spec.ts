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
const createEngineMock = jest.fn(async () => ({
    runRenderLoop: jest.fn(),
    resize: jest.fn(),
    dispose: engineDispose,
}));

jest.unstable_mockModule("../src/lib/internal/engineFactory", () => ({
    createBabylonEngine: createEngineMock,
}));

jest.unstable_mockModule("../src/scenes/default", () => {
    class DefaultScene {
        createScene = jest.fn(async () => ({
            render: jest.fn(),
            dispose: jest.fn(),
        }));
    }
    return { DefaultScene };
});

// jest.unstable_mockModule は hoist されないため、モック登録後に動的 import する。
const { JpmapTerrain } = await import("../src/lib/jpmapTerrain");

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
});
