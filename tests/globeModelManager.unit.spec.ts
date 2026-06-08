/**
 * GlobeModelManager の振る舞い (Issue #275 Phase 3)。
 *
 * Babylon の TransformNode / ImportMeshAsync と marker.ts のローダー登録（importLoaderForUrl）を
 * スタブ化し、ロード完了→接地・起立、ロード前は配置しない、dispose 中のロード結果破棄、
 * CRUD / dispose 後ガードを検証する（Vector3/Quaternion/overlayPlacement は実物）。
 */
import { jest } from "@jest/globals";

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

jest.unstable_mockModule("@babylonjs/core/Meshes/transformNode", () => ({
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
let resolveImport: ((meshes: { parent: unknown; dispose: () => void }[]) => void) | null = null;
const importMeshAsync = jest.fn(
    () =>
        new Promise((res) => {
            resolveImport = (meshes) => res({ meshes, animationGroups: [] });
        }),
);
jest.unstable_mockModule("@babylonjs/core/Loading/sceneLoader", () => ({
    ImportMeshAsync: importMeshAsync,
}));

const importLoaderForUrl = jest.fn(async () => {});
jest.unstable_mockModule("../src/terrain/modelManager", () => ({ importLoaderForUrl }));

const { createGlobeModelManager } = await import("../src/terrain/geo/globeModelManager");
const { describe, it, expect, beforeEach } = await import("@jest/globals");

const makeManager = () => {
    const terrainElevAt: (lat: number, lon: number) => number | null = jest.fn(() => 1000);
    const mgr = createGlobeModelManager({ scene: {} as never, terrainElevAt });
    return { mgr, terrainElevAt };
};

/** ロード完了をシミュレートする（親なしメッシュ 1 つ）。 */
const completeLoad = async (): Promise<void> => {
    // loadModel は先に await importLoaderForUrl → その後 ImportMeshAsync を呼ぶため、
    // resolveImport がセットされるまで 1 ティック待ってから解決する。
    await new Promise((r) => setTimeout(r, 0));
    const mesh = { parent: null as unknown, dispose: jest.fn() };
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
        mgr.add({ url: "x.glb", lat: 35, lon: 139, scale: 10 });
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

    it("ロード完了前は update しても位置は原点のまま（loaded ガード）", () => {
        const { mgr } = makeManager();
        mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        mgr.update(); // まだ loaded=false
        expect(createdRoots[0].position.length()).toBe(0);
    });
});

describe("ライフサイクル", () => {
    it("ロード前に remove するとロード結果は破棄される", async () => {
        const { mgr } = makeManager();
        const id = mgr.add({ url: "x.glb", lat: 35, lon: 139 });
        mgr.remove(id); // cancelled
        await new Promise((r) => setTimeout(r, 0)); // importLoaderForUrl 解決 → ImportMeshAsync 呼び出し待ち
        const mesh = { parent: null as unknown, dispose: jest.fn() };
        resolveImport?.([mesh]);
        await new Promise((r) => setTimeout(r, 0));
        expect(mesh.dispose).toHaveBeenCalled();
        expect(createdRoots[0].disposeCount).toBe(1);
    });

    it("remove 未存在 id は warn + no-op、setEnabled 未存在は throw", () => {
        const { mgr } = makeManager();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
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
        expect(() => mgr.update()).toThrow(/after dispose/);
        expect(() => mgr.dispose()).not.toThrow();
    });
});
