/**
 * @jest-environment jsdom
 *
 * `createGlobeSceneController` の UI コントロールパネル配線（#275 Phase 4 / P4-1）の
 * 挙動検証。Copilot レビュー指摘（PR #355）への回帰テスト:
 * - コンパス回転角は丸めて DOM へ書く（浮動小数で毎フレーム書かない）
 * - スケールバー幅は変化時のみ更新する
 * - dispose 後はズーム/コンパスのアニメーション（rAF）が camera を更新せず再スケジュールしない
 */
import { jest } from "@jest/globals";

import { createGlobeSceneController } from "../src/scenes/globeSceneController";
import type { GlobeSceneController } from "../src/scenes/globe";
import { geodeticToEcef } from "../src/terrain/geo/ecef";

interface ObservableStub<T> {
    add: (cb: T) => T;
    remove: (cb: T) => boolean;
    addOnce: (cb: T) => T;
    fire: () => void;
}
const makeObservable = <T extends () => void>(): ObservableStub<T> => {
    const cbs = new Set<T>();
    return {
        add: (cb: T) => {
            cbs.add(cb);
            return cb;
        },
        remove: (cb: T) => cbs.delete(cb),
        addOnce: (cb: T) => {
            cbs.add(cb);
            return cb;
        },
        fire: () => cbs.forEach((cb) => cb()),
    };
};

let rafCallbacks: FrameRequestCallback[] = [];
let originalRaf: typeof requestAnimationFrame;

const makeCamera = () => ({
    center: geodeticToEcef(35, 139, 0),
    radius: 100000,
    yaw: 0,
    pitch: 0,
    fov: 0.8,
});

const makeGcWithScene = (
    camera: ReturnType<typeof makeCamera>,
): {
    gc: GlobeSceneController;
    onBeforeRender: ObservableStub<() => void>;
    disposed: () => boolean;
} => {
    const onBeforeRender = makeObservable<() => void>();
    let disposedFlag = false;
    const gc = {
        camera,
        scene: {
            onBeforeRenderObservable: onBeforeRender,
            onAfterRenderObservable: makeObservable<() => void>(),
        },
        tileManager: {
            isIdle: () => true,
            terrainElevAt: () => null,
            setMapType: jest.fn(),
        },
        dispose: () => {
            disposedFlag = true;
        },
    } as unknown as GlobeSceneController;
    return { gc, onBeforeRender, disposed: () => disposedFlag };
};

const makeCanvas = (): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    // jsdom は clientHeight=0 のため height をフォールバックに使う。
    canvas.height = 600;
    return canvas;
};

beforeEach(() => {
    document.body.innerHTML = "";
    rafCallbacks = [];
    originalRaf = global.requestAnimationFrame;
    global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
});

afterEach(() => {
    global.requestAnimationFrame = originalRaf;
});

describe("globe UI コントロールパネル配線 (#275 P4-1)", () => {
    it("コンパス回転角は 0.1 度に丸めて transform へ書く", () => {
        const camera = makeCamera();
        // ほぼゼロでない方位を作る（丸めの効果を観察する）。
        camera.yaw = 0.123456789;
        const { gc } = makeGcWithScene(camera);
        createGlobeSceneController(gc, "std", undefined, makeCanvas());

        const compass = document.querySelector(".cp-compass") as HTMLElement;
        expect(compass).not.toBeNull();
        const m = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(
            compass.style.transform,
        );
        expect(m).not.toBeNull();
        const deg = Number(m![1]);
        // 0.1 度刻みに丸められている（deg*10 が整数）。
        expect(Number.isInteger(Math.round(deg * 10))).toBe(true);
        expect(deg * 10).toBeCloseTo(Math.round(deg * 10), 9);
    });

    it("スケールバー幅は値が変わらないフレームでは書き換えない", () => {
        const camera = makeCamera();
        const { gc, onBeforeRender } = makeGcWithScene(camera);
        createGlobeSceneController(gc, "std", undefined, makeCanvas());

        // scaleContainer = 地理院タイル attribution の親。その中の div が幅更新対象の bar。
        const attribution = document.querySelector(
            'a[href*="maps.gsi.go.jp"]',
        ) as HTMLElement;
        expect(attribution).not.toBeNull();
        const scaleContainer = attribution.parentElement as HTMLElement;
        const bar = scaleContainer.querySelector("div") as HTMLElement;
        expect(bar).not.toBeNull();

        // 生成時に一度 width が設定済み。以降の width 書き込み回数をスパイする。
        let widthWrites = 0;
        let widthVal = bar.style.width;
        Object.defineProperty(bar.style, "width", {
            get: () => widthVal,
            set: (v: string) => {
                widthVal = v;
                widthWrites++;
            },
            configurable: true,
        });

        // 同条件で再 fire しても width は書き換えない。
        onBeforeRender.fire();
        expect(widthWrites).toBe(0);

        // 距離が大きく変わると（barPx が変化）width を 1 回だけ更新する。
        camera.radius = 100000 * 4;
        onBeforeRender.fire();
        expect(widthWrites).toBe(1);
        // 再度同条件なら書き換えない。
        onBeforeRender.fire();
        expect(widthWrites).toBe(1);
    });

    it("dispose 後はズームアニメーションが camera.radius を更新せず再スケジュールしない", () => {
        const camera = makeCamera();
        const { gc } = makeGcWithScene(camera);
        const c = createGlobeSceneController(gc, "std", undefined, makeCanvas());
        rafCallbacks = []; // 生成時 fire 由来をクリア

        const zoomIn = document.querySelector(
            '[aria-label="ズームイン"]',
        ) as HTMLElement;
        expect(zoomIn).not.toBeNull();
        zoomIn.dispatchEvent(new Event("click"));
        expect(rafCallbacks.length).toBe(1); // animate がスケジュールされた

        const start = performance.now();
        rafCallbacks[0](start + 10); // 1 フレーム進める
        const radiusAfterOneFrame = camera.radius;
        expect(radiusAfterOneFrame).toBeLessThan(100000); // 縮小した
        expect(rafCallbacks.length).toBe(2); // 次フレームを予約

        // dispose 後は次フレームを実行しても radius を更新せず、再スケジュールしない。
        c.dispose();
        const pending = rafCallbacks[1];
        rafCallbacks = [];
        pending(start + 100000);
        expect(camera.radius).toBe(radiusAfterOneFrame); // 変化なし
        expect(rafCallbacks.length).toBe(0); // 再スケジュールなし
    });

    it("dispose 後はコンパスリセットアニメーションが camera を更新せず再スケジュールしない", () => {
        const camera = makeCamera();
        camera.yaw = 1.0;
        camera.pitch = 0.5;
        const { gc } = makeGcWithScene(camera);
        const c = createGlobeSceneController(gc, "std", undefined, makeCanvas());
        rafCallbacks = [];

        const compass = document.querySelector(".cp-compass") as HTMLElement;
        compass.dispatchEvent(new Event("click"));
        expect(rafCallbacks.length).toBe(1);

        const start = performance.now();
        rafCallbacks[0](start + 10);
        const yawAfter = camera.yaw;
        const pitchAfter = camera.pitch;
        expect(rafCallbacks.length).toBe(2);

        c.dispose();
        const pending = rafCallbacks[1];
        rafCallbacks = [];
        pending(start + 100000);
        expect(camera.yaw).toBe(yawAfter);
        expect(camera.pitch).toBe(pitchAfter);
        expect(rafCallbacks.length).toBe(0);
    });

    it("dispose 後は現在地取得のコールバックが camera を更新しない", () => {
        const camera = makeCamera();
        const { gc } = makeGcWithScene(camera);

        let successCb: ((p: unknown) => void) | null = null;
        let errorCb: ((e: unknown) => void) | null = null;
        // @ts-expect-error jsdom には geolocation が無いため最小スタブを差し込む。
        navigator.geolocation = {
            getCurrentPosition: (s: (p: unknown) => void, e: (e: unknown) => void) => {
                successCb = s;
                errorCb = e;
            },
        };

        const c = createGlobeSceneController(gc, "std", undefined, makeCanvas());
        const locateMe = document.querySelector(
            '[aria-label="現在地を表示"]',
        ) as HTMLElement;
        expect(locateMe).not.toBeNull();
        locateMe.dispatchEvent(new Event("click"));
        expect(successCb).not.toBeNull();

        const centerBefore = { ...camera.center };
        c.dispose();
        // dispose 後に成功コールバックが返っても camera.center を更新しない。
        successCb!({ coords: { latitude: 36, longitude: 140 } });
        expect(camera.center).toEqual(centerBefore);
        // error コールバックも例外なく早期 return する。
        expect(() => errorCb!({ message: "denied" })).not.toThrow();
    });
});

describe("globe external frustum / tile camera 配線 (#275 P4-3 / #402)", () => {
    it("setExternalCompassDegrees: 外部指定値を優先し、null で yaw 連動へ復帰する", () => {
        const camera = makeCamera();
        camera.yaw = 0.5;
        const { gc, onBeforeRender } = makeGcWithScene(camera);
        const c = createGlobeSceneController(gc, "std", undefined, makeCanvas());

        const compass = document.querySelector(".cp-compass") as HTMLElement;
        expect(compass).not.toBeNull();

        // 外部指定: 次フレームの updateOverlayUi で rotate(42deg) を書く。
        c.setExternalCompassDegrees(42);
        onBeforeRender.fire();
        expect(compass.style.transform).toBe("rotate(42deg)");

        // null 復帰: yaw 由来の角度へ戻る（42 ではない）。
        c.setExternalCompassDegrees(null);
        onBeforeRender.fire();
        expect(compass.style.transform).not.toBe("rotate(42deg)");
    });

    it("refreshTerrainWithExternalFrustum: detach 中のみ center/radius を上書きする", async () => {
        const camera = makeCamera();
        const { gc } = makeGcWithScene(camera);
        const c = createGlobeSceneController(gc, "std", undefined, makeCanvas());

        const planes = [
            { normal: { x: 0, y: 0, z: 1 }, d: 0 },
            { normal: { x: 0, y: 0, z: -1 }, d: 0 },
            { normal: { x: 1, y: 0, z: 0 }, d: 0 },
            { normal: { x: -1, y: 0, z: 0 }, d: 0 },
            { normal: { x: 0, y: 1, z: 0 }, d: 0 },
            { normal: { x: 0, y: -1, z: 0 }, d: 0 },
        ];
        const camPos = { x: 0, y: 0, z: 0 };

        // detach 前は no-op（center/radius は変わらない）。
        const centerBefore = { ...camera.center };
        const radiusBefore = camera.radius;
        await c.refreshTerrainWithExternalFrustum(36, 140, planes, camPos, 0);
        expect(camera.center).toEqual(centerBefore);
        expect(camera.radius).toBe(radiusBefore);

        // detach 後は center を lat/lon に据え、radius を base*2^-lodBias にする。
        c.detachTileCamera();
        await c.refreshTerrainWithExternalFrustum(36, 140, planes, camPos, 1);
        // terrainElevAt() は null → 標高 0 で center を設定する。
        const expected = geodeticToEcef(36, 140, 0);
        expect(camera.center.x).toBeCloseTo(expected.x, 3);
        expect(camera.center.y).toBeCloseTo(expected.y, 3);
        expect(camera.center.z).toBeCloseTo(expected.z, 3);
        // FOLLOW_TILE_BASE_RADIUS_M(2000) * 2^-1 = 1000。
        expect(camera.radius).toBeCloseTo(1000, 6);

        // lodBias=0 では base 半径そのもの。
        await c.refreshTerrainWithExternalFrustum(36, 140, planes, camPos, 0);
        expect(camera.radius).toBeCloseTo(2000, 6);

        // attach で外部制御を解除すると再び no-op に戻る。
        c.attachTileCamera();
        const centerAfterAttach = { ...camera.center };
        await c.refreshTerrainWithExternalFrustum(10, 10, planes, camPos, 0);
        expect(camera.center).toEqual(centerAfterAttach);
    });
});
