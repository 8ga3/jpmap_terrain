/**
 * ModelManager の単体テスト (Issue #243)。
 *
 * - `@babylonjs/core/Meshes/transformNode` をスタブ化し Babylon 実体の生成を回避
 * - `./overlayCoords` をスタブ化し `scenes/default` の大きな依存チェーンを断ち切る
 * - `@babylonjs/core/Loading/sceneLoader` と `@babylonjs/loaders/glTF` もスタブ化
 *
 * 検証対象: CRUD / バリデーション / dispose の冪等性 / altitudeMode
 */
import { jest } from "@jest/globals";

// ---- TransformNode スタブ ----
interface FakeTransformNode {
    name: string;
    position: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void };
    rotation: { x: number; y: number; z: number };
    scaling: { x: number; y: number; z: number };
    disposed: boolean;
    dispose: () => void;
}
const createdNodes: FakeTransformNode[] = [];

jest.unstable_mockModule("@babylonjs/core/Meshes/transformNode", () => {
    class TransformNode {
        name: string;
        position: FakeTransformNode["position"];
        rotation: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
        scaling: { x: number; y: number; z: number } = { x: 1, y: 1, z: 1 };
        disposed = false;
        constructor(name: string) {
            this.name = name;
            const pos = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } };
            this.position = pos;
            createdNodes.push(this as unknown as FakeTransformNode);
        }
        dispose() { this.disposed = true; }
    }
    return { TransformNode };
});

// ---- overlayCoords スタブ（scenes/default 依存を断ち切る）----
jest.unstable_mockModule("../src/terrain/overlayCoords", () => ({
    latLonToWorld: () => ({ wx: 0, wz: 0 }),
    assertLatLonInBounds: (lat: number, lon: number, prefix: string) => {
        if (lat < 20 || lat > 50 || lon < 120 || lon > 155) {
            throw new Error(`${prefix}: JAPAN_BOUNDS`);
        }
    },
}));

// ---- SceneLoader スタブ ----
jest.unstable_mockModule("@babylonjs/core/Loading/sceneLoader", () => ({
    SceneLoader: {
        ImportMeshAsync: jest.fn<() => Promise<{ meshes: unknown[]; animationGroups: unknown[] }>>(() =>
            Promise.resolve({ meshes: [], animationGroups: [] }),
        ),
    },
}));

// ---- glTF 動的 import スタブ ----
jest.unstable_mockModule("@babylonjs/loaders/glTF", () => ({}));

// ---- OBJ 動的 import スタブ ----
jest.unstable_mockModule("@babylonjs/loaders/OBJ", () => ({}));

// ---- STL 動的 import スタブ ----
jest.unstable_mockModule("@babylonjs/loaders/STL", () => ({}));

// ---- buildCtx ヘルパー ----
const buildCtx = (elevation: number | null = 0) => {
    const observers: Array<() => void> = [];
    const fakeScene = {
        onBeforeRenderObservable: {
            add: (cb: () => void) => { observers.push(cb); return cb; },
            remove: () => {},
        },
    };
    let elev = elevation;
    const ctx = {
        scene: fakeScene,
        tileManager: {
            queryElevationAtWorld: (): number | null => elev,
            subscribeTerrainUpdated: (): (() => void) => () => {},
        },
        getOrigin: () => ({ lat: 35.681, lon: 139.767, gridResidualX: 0, gridResidualZ: 0 }),
        getCameraPosition: () => ({ x: 0, y: 1000, z: 0, radius: 1000, beta: Math.PI / 4 }),
    };
    return {
        ctx: ctx as unknown as Parameters<
            (typeof import("../src/terrain/modelManager"))["createModelManager"]
        >[0],
        tick: () => { for (const o of observers.slice()) o(); },
        setElevation: (v: number | null) => { elev = v; },
    };
};

const VALID = {
    url: "assets/human.glb",
    lat: 35.681236,
    lon: 139.767125,
    altitudeMode: "terrain" as const,
    altitude: 0,
};

const { createModelManager, importLoaderForUrl } = await import("../src/terrain/modelManager");

beforeEach(() => { createdNodes.length = 0; });

// ---- CRUD ----

describe("ModelManager CRUD", () => {
    test("add → get / list で同 id を取得できる", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        const handle = mgr.add("a", VALID);
        expect(handle.id).toBe("a");
        expect(mgr.get("a")?.id).toBe("a");
        expect(mgr.list()).toEqual(["a"]);
    });

    test("重複 id の add は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.add("a", VALID);
        expect(() => mgr.add("a", VALID)).toThrow(/already exists/);
    });

    test("url 未指定の add は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        expect(() => mgr.add("a", { ...VALID, url: "" })).toThrow(/url is required/);
    });

    test("未存在 id の get は null", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        expect(mgr.get("missing")).toBeNull();
    });

    test("未存在 id の update は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        expect(() => mgr.update("missing", { altitude: 10 })).toThrow(/not found/);
    });

    test("remove で list / get から消える", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.add("a", VALID);
        mgr.remove("a");
        expect(mgr.get("a")).toBeNull();
        expect(mgr.list()).toEqual([]);
    });

    test("未存在 id の remove は warn + no-op", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        mgr.remove("missing");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test("list は追加順を保持する", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.add("c", VALID);
        mgr.add("a", VALID);
        mgr.add("b", VALID);
        expect(mgr.list()).toEqual(["c", "a", "b"]);
    });
});

// ---- バリデーション ----

describe("ModelManager バリデーション", () => {
    test("JAPAN_BOUNDS 外 (lat=0, lon=0) は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        expect(() => mgr.add("a", { ...VALID, lat: 0, lon: 0 })).toThrow(/JAPAN_BOUNDS/);
    });

    test("absolute モードで altitude 未指定は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        expect(() =>
            mgr.add("a", { ...VALID, altitudeMode: "absolute", altitude: undefined }),
        ).toThrow(/altitude/);
    });

    test("update で absolute モードへの切替時に altitude 未指定は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.add("a", VALID);
        expect(() => mgr.update("a", { altitudeMode: "absolute" })).toThrow(/altitude/);
    });

    test("update で lat/lon が範囲外なら throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.add("a", VALID);
        expect(() => mgr.update("a", { lat: 0, lon: 0 })).toThrow(/JAPAN_BOUNDS/);
    });
});

// ---- dispose / 冪等性 ----

describe("ModelManager dispose", () => {
    test("dispose 後の add は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.dispose();
        expect(() => mgr.add("a", VALID)).toThrow(/disposed/);
    });

    test("dispose 後の update は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.dispose();
        expect(() => mgr.update("a", { altitude: 10 })).toThrow(/disposed/);
    });

    test("dispose 後の setEnabled は throw", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.dispose();
        expect(() => mgr.setEnabled("a", true)).toThrow(/disposed/);
    });

    test("dispose を 2 回呼んでも throw しない", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        mgr.dispose();
        expect(() => mgr.dispose()).not.toThrow();
    });
});

// ---- altitudeMode ----

describe("ModelManager altitudeMode", () => {
    test("absolute モードの handle は elevationResolved=true", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        const handle = mgr.add("a", { ...VALID, altitudeMode: "absolute", altitude: 100 });
        expect(handle.altitudeMode).toBe("absolute");
        expect(handle.elevationResolved).toBe(true);
    });

    test("terrain+gravity で elevation=null なら elevationResolved=false", () => {
        const { ctx } = buildCtx(null);
        const mgr = createModelManager(ctx);
        const handle = mgr.add("a", { ...VALID, gravity: true });
        expect(handle.elevationResolved).toBe(false);
    });

    test("ロード前に altitudeMode を absolute に切り替えると elevationResolved が true になる", () => {
        const { ctx } = buildCtx(null);
        const mgr = createModelManager(ctx);
        mgr.add("a", { ...VALID, gravity: true });
        const updated = mgr.update("a", { altitudeMode: "absolute", altitude: 50 });
        expect(updated.elevationResolved).toBe(true);
    });
});

// ---- importLoaderForUrl (Issue #247) ----

describe("importLoaderForUrl", () => {
    test(".glb で glTF ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.glb")).resolves.toBeUndefined();
    });

    test(".gltf で glTF ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.gltf")).resolves.toBeUndefined();
    });

    test(".obj で OBJ ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.obj")).resolves.toBeUndefined();
    });

    test(".stl で STL ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.stl")).resolves.toBeUndefined();
    });

    test("大文字拡張子 (.GLB) も認識される", async () => {
        await expect(importLoaderForUrl("assets/model.GLB")).resolves.toBeUndefined();
    });

    test("クエリ文字列付き URL でも正しくロードされる", async () => {
        await expect(importLoaderForUrl("assets/model.obj?v=1")).resolves.toBeUndefined();
    });

    test("フラグメント付き URL でも正しくロードされる", async () => {
        await expect(importLoaderForUrl("assets/model.stl#section")).resolves.toBeUndefined();
    });

    test("未対応拡張子 (.fbx) は throw", async () => {
        await expect(importLoaderForUrl("assets/model.fbx")).rejects.toThrow(/unsupported file format/);
    });

    test("拡張子なし URL は throw", async () => {
        await expect(importLoaderForUrl("assets/model")).rejects.toThrow(/unsupported file format/);
    });
});

// ---- OBJ / STL フォーマットでの add (Issue #247) ----

describe("ModelManager OBJ/STL add", () => {
    test("OBJ URL での add が成功する", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        const handle = mgr.add("obj-model", { ...VALID, url: "assets/human.obj" });
        expect(handle.id).toBe("obj-model");
        expect(handle.url).toBe("assets/human.obj");
    });

    test("STL URL での add が成功する", () => {
        const { ctx } = buildCtx();
        const mgr = createModelManager(ctx);
        const handle = mgr.add("stl-model", { ...VALID, url: "assets/human.stl" });
        expect(handle.id).toBe("stl-model");
        expect(handle.url).toBe("assets/human.stl");
    });
});
