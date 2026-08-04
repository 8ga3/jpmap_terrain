/**
 * GlobeModelManager の振る舞い。
 *
 * Babylon の TransformNode / ImportMeshAsync と marker.ts のローダー登録（importLoaderForUrl）を
 * スタブ化し、ロード完了→接地・起立、ロード前は配置しない、dispose 中のロード結果破棄、
 * CRUD / dispose 後ガードを検証する（Vector3/Quaternion/overlayPlacement は実物）。
 */
import { vi } from "vitest";

import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";

interface StubNode {
    name: string;
    position: Vector3;
    rotationQuaternion: Quaternion | null;
    scaling: Vector3;
    enabled: boolean;
    disposeCount: number;
    setEnabled: (v: boolean) => void;
    dispose: () => void;
}
const createdRoots: StubNode[] = [];

vi.mock("@babylonjs/core/Meshes/transformNode", () => ({
    TransformNode: class {
        position = new Vector3();
        rotationQuaternion: Quaternion | null = null;
        scaling = new Vector3(1, 1, 1);
        enabled = true;
        disposeCount = 0;
        constructor(public name: string) {
            createdRoots.push(this as unknown as StubNode);
        }
        setEnabled(v: boolean): void {
            this.enabled = v;
        }
        dispose(): void {
            this.disposeCount++;
        }
    },
}));

// ImportMeshAsync は解決を手動制御できる deferred にする。
type StubAg = { name?: string; stop: () => void; play?: (loop?: boolean) => void; dispose: () => void };
let resolveImport:
    | ((meshes: { parent: unknown; dispose: () => void }[], ags?: StubAg[]) => void)
    | null = null;
const importMeshAsync = vi.fn(
    () =>
        new Promise((res) => {
            resolveImport = (meshes, ags = []) => res({ meshes, animationGroups: ags });
        }),
);
vi.mock("@babylonjs/core/Loading/sceneLoader", () => ({
    ImportMeshAsync: importMeshAsync,
}));
vi.mock("@babylonjs/loaders/glTF/glTFFileLoader", () => ({
    GLTFLoaderAnimationStartMode: { NONE: 0, FIRST: 1, ALL: 2 },
}));

const importLoaderForUrl = vi.fn(async () => {});
vi.mock("../src/terrain/modelManager", () => ({ importLoaderForUrl }));

const { createGlobeModelManager } = await import("../src/terrain/geo/globeModelManager");
const { describe, it, expect, beforeEach } = await import("vitest");

const makeManager = () => {
    const terrainElevAt: (lat: number, lon: number) => number | null = vi.fn(() => 1000);
    const mgr = createGlobeModelManager({ scene: {} as never, terrainElevAt });
    return { mgr, terrainElevAt };
};

/** ロード完了をシミュレートする（親なしメッシュ 1 つ）。 */
const completeLoad = async (): Promise<void> => {
    // loadModel は先に await importLoaderForUrl → その後 ImportMeshAsync を呼ぶため、
    // resolveImport がセットされるまで 1 ティック待ってから解決する。
    await new Promise((r) => setTimeout(r, 0));
    const mesh = { parent: null as unknown, dispose: vi.fn() };
    resolveImport?.([mesh]);
    await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
    createdRoots.length = 0;
    resolveImport = null;
    importMeshAsync.mockClear();
    importLoaderForUrl.mockClear();
});

describe("add / load", () => {
    it("add で root を生成し、ロード完了後に接地・起立する", async () => {
        const { mgr } = makeManager();
        mgr.add({ url: "x.glb", lat: 35, lon: 139, scaling: { x: 10, y: 10, z: 10 } });
        expect(createdRoots.length).toBe(1);
        await completeLoad();
        const root = createdRoots[0];
        // 接地: position が地表 ECEF（地心距離 > 6e6）。
        expect(root.position.length()).toBeGreaterThan(6_000_000);
        // 起立: rotationQuaternion が設定される。
        expect(root.rotationQuaternion).not.toBeNull();
        // スケール適用。
        expect(root.scaling.x).toBe(10);
    });

    it("ロード完了前は tick しても位置は原点のまま（loaded ガード）", () => {
        const { mgr } = makeManager();
        mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        mgr.tick(); // まだ loaded=false
        expect(createdRoots[0].position.length()).toBe(0);
    });

    it("AnimationGroup はロード直後に stop されるが保持される（dispose しない）", async () => {
        const { mgr } = makeManager();
        mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await new Promise((r) => setTimeout(r, 0));
        const ag = { stop: vi.fn(), dispose: vi.fn() };
        const mesh = { parent: null as unknown, dispose: vi.fn() };
        resolveImport?.([mesh], [ag]);
        await new Promise((r) => setTimeout(r, 0));
        expect(ag.stop).toHaveBeenCalled();
        // play/stop 制御のため保持する（リーク防止は remove/dispose で行う）。
        expect(ag.dispose).not.toHaveBeenCalled();
    });
});

describe("ライフサイクル", () => {
    it("ロード前に remove するとロード結果は破棄される", async () => {
        const { mgr } = makeManager();
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        mgr.remove(id); // cancelled
        await new Promise((r) => setTimeout(r, 0)); // importLoaderForUrl 解決 → ImportMeshAsync 呼び出し待ち
        const mesh = { parent: null as unknown, dispose: vi.fn() };
        resolveImport?.([mesh]);
        await new Promise((r) => setTimeout(r, 0));
        expect(mesh.dispose).toHaveBeenCalled();
        expect(createdRoots[0].disposeCount).toBe(1);
    });

    it("remove 未存在 id は warn + no-op、setEnabled 未存在は throw", () => {
        const { mgr } = makeManager();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(() => mgr.remove("nope")).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('id "nope" not found'));
        warn.mockRestore();
        expect(() => mgr.setEnabled("nope", false)).toThrow(/not found/);
    });

    it("dispose 後の add/setEnabled/update は throw、二重 dispose は安全", () => {
        const { mgr } = makeManager();
        mgr.dispose();
        expect(() => mgr.add({ url: "x.glb", lat: 35, lon: 139 })).toThrow(/after dispose/);
        expect(() => mgr.setEnabled("x", true)).toThrow(/after dispose/);
        expect(() => mgr.tick()).toThrow(/after dispose/);
        expect(() => mgr.dispose()).not.toThrow();
    });
});

describe("in-place update / get / list", () => {
    it("get は解決済み状態を返し、update は lat/lon/altitude/scaling を反映する", async () => {
        const { mgr } = makeManager();
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await completeLoad();
        mgr.update(id, { lat: 36, lon: 140, altitude: 5, scaling: { x: 2, y: 2, z: 2 } });
        const s = mgr.get(id);
        expect(s).not.toBeNull();
        expect(s?.lat).toBe(36);
        expect(s?.lon).toBe(140);
        expect(s?.altitude).toBe(5);
        expect(s?.scaling.x).toBe(2);
        expect(s?.loaded).toBe(true);
        expect(createdRoots[0].scaling.x).toBe(2);
        // 内部 id を 1 件保持する。
        expect(mgr.list()).toHaveLength(1);
    });

    it("update は import を再実行しない（メッシュ再ロードなし）", async () => {
        const { mgr } = makeManager();
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await completeLoad();
        importMeshAsync.mockClear();
        mgr.update(id, { lat: 36 });
        expect(importMeshAsync).not.toHaveBeenCalled();
    });

    it("get は未存在 id で null、update は未存在 id で throw", () => {
        const { mgr } = makeManager();
        expect(mgr.get("nope")).toBeNull();
        expect(() => mgr.update("nope", { lat: 1 })).toThrow(/not found/);
    });
});

describe("altitude / 接地", () => {
    it("absolute モードは地形標高に依らず配置し elevationResolved=true", async () => {
        const terrainElevAt = vi.fn(() => null as number | null);
        const mgr = createGlobeModelManager({ scene: {} as never, terrainElevAt });
        const id = mgr.add({
            url: "x.glb",
            lat: 35,
            lon: 139,
            altitudeMode: "absolute",
            altitude: 100,
        });
        await completeLoad();
        expect(mgr.get(id)?.elevationResolved).toBe(true);
        expect(createdRoots[0].position.length()).toBeGreaterThan(6_000_000);
    });

    it("terrain+gravity で標高未解決のあいだは非表示（elevationResolved=false）", async () => {
        const terrainElevAt = vi.fn(() => null as number | null);
        const mgr = createGlobeModelManager({ scene: {} as never, terrainElevAt });
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await completeLoad();
        expect(mgr.get(id)?.elevationResolved).toBe(false);
        expect(createdRoots[0].enabled).toBe(false);
    });

    it('add で altitudeMode="absolute" かつ altitude 未指定は throw する', () => {
        const { mgr } = makeManager();
        expect(() =>
            mgr.add({ url: "x.glb", lat: 35, lon: 139, altitudeMode: "absolute" }),
        ).toThrow(/requires altitude/);
    });

    it('update で absolute へ切替時に altitude 未指定は throw する', async () => {
        const { mgr } = makeManager();
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await completeLoad();
        expect(() => mgr.update(id, { altitudeMode: "absolute" })).toThrow(
            /requires explicit altitude/,
        );
        // altitude を同時に指定すれば切替できる。
        expect(() => mgr.update(id, { altitudeMode: "absolute", altitude: 50 })).not.toThrow();
        expect(mgr.get(id)?.altitudeMode).toBe("absolute");
    });
});

describe("拡張子別の pluginOptions（GLTFLoaderAnimationStartMode の動的 import）", () => {
    it("glb/gltf は pluginOptions.gltf.animationStartMode に NONE を渡す", async () => {
        const { mgr } = makeManager();
        mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await completeLoad();
        expect(importMeshAsync).toHaveBeenCalledWith(
            "x.glb",
            expect.anything(),
            { pluginOptions: { gltf: { animationStartMode: 0 } } },
        );
    });

    it("obj/stl は GLTFLoaderAnimationStartMode を動的 import せず pluginOptions は undefined", async () => {
        const { mgr } = makeManager();
        mgr.add({ url: "x.obj", lat: 35, lon: 139 });
        await completeLoad();
        expect(importMeshAsync).toHaveBeenCalledWith(
            "x.obj",
            expect.anything(),
            { pluginOptions: undefined },
        );
    });
});

describe("animation", () => {
    it("playAnimation/stopAnimation は保持した AnimationGroup を制御する", async () => {
        const { mgr } = makeManager();
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        await new Promise((r) => setTimeout(r, 0));
        const ag = { name: "walk", stop: vi.fn(), play: vi.fn(), dispose: vi.fn() };
        const mesh = { parent: null as unknown, dispose: vi.fn() };
        resolveImport?.([mesh], [ag as unknown as StubAg]);
        await new Promise((r) => setTimeout(r, 0));
        expect(mgr.get(id)?.animationNames).toEqual(["walk"]);
        mgr.playAnimation(id, "walk");
        expect(ag.play).toHaveBeenCalledWith(true);
        mgr.stopAnimation(id, "walk");
        expect(ag.stop).toHaveBeenCalled();
    });
});
