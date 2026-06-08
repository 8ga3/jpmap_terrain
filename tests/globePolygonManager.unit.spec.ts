/**
 * GlobePolygonManager の振る舞い (Issue #275 Phase 3)。
 *
 * Babylon のメッシュビルダー（CreateLines / CreateRibbon）・StandardMaterial を軽量スタブに
 * 差し替え、CRUD / enabled / update（再ドレープ）/ dispose 後ガード / 2 点未満の検証 /
 * 非 hex 色フォールバックを検証する（buildDrapedPolygonPaths は実物）。
 */
import { jest } from "@jest/globals";

interface StubMesh {
    name: string;
    color: unknown;
    isPickable: boolean;
    renderingGroupId: number;
    material: unknown;
    enabled: boolean;
    disposeCount: number;
    setEnabled: (v: boolean) => void;
    dispose: () => void;
}

const createdLines: StubMesh[] = [];
const createdRibbons: StubMesh[] = [];
const lineInstanceUpdates: number[] = [];
const ribbonInstanceUpdates: number[] = [];

const stub = (name: string, bucket: StubMesh[]): StubMesh => {
    const m: StubMesh = {
        name,
        color: null,
        isPickable: true,
        // マネージャが 0 を明示設定することを検証するため、非 0 で初期化する。
        renderingGroupId: -1,
        material: null,
        enabled: true,
        disposeCount: 0,
        setEnabled(v: boolean) {
            this.enabled = v;
        },
        dispose() {
            this.disposeCount++;
        },
    };
    bucket.push(m);
    return m;
};

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/linesBuilder", () => ({
    CreateLines: (name: string, opts: { instance?: StubMesh }) => {
        if (opts.instance) {
            lineInstanceUpdates.push(1);
            return opts.instance;
        }
        return stub(name, createdLines);
    },
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/ribbonBuilder", () => ({
    CreateRibbon: (name: string, opts: { instance?: StubMesh }) => {
        if (opts.instance) {
            ribbonInstanceUpdates.push(1);
            return opts.instance;
        }
        return stub(name, createdRibbons);
    },
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: class {
        emissiveColor: unknown = null;
        alpha = 1;
        needDepthPrePass = false;
        disableLighting = false;
        backFaceCulling = true;
        disposeCount = 0;
        constructor(public name: string) {}
        dispose(): void {
            this.disposeCount++;
        }
    },
}));

// Mesh.DOUBLESIDE 定数のみ使用するため軽量スタブ。
jest.unstable_mockModule("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: { DOUBLESIDE: 2 },
}));

const { createGlobePolygonManager } = await import(
    "../src/terrain/geo/globePolygonManager"
);
const { describe, it, expect, beforeEach } = await import("@jest/globals");

const pts3 = [
    { lat: 35.3, lon: 138.7 },
    { lat: 35.4, lon: 138.8 },
    { lat: 35.3, lon: 138.9 },
];

const makeManager = () => {
    const terrainElevAt: (lat: number, lon: number) => number | null = jest.fn(() => 1000);
    const mgr = createGlobePolygonManager({ scene: {} as never, terrainElevAt });
    return { mgr, terrainElevAt };
};

beforeEach(() => {
    createdLines.length = 0;
    createdRibbons.length = 0;
    lineInstanceUpdates.length = 0;
    ribbonInstanceUpdates.length = 0;
});

describe("add / CRUD", () => {
    it("アウトライン線と壁 Ribbon を生成し、isPickable=false / 既定グループ0（地形と交差）", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, closed: true });
        expect(createdLines.length).toBe(1);
        expect(createdRibbons.length).toBe(1);
        expect(createdLines[0].isPickable).toBe(false);
        // 地形と深度交差させるため、マネージャが renderingGroupId=0 を明示設定する
        // （スタブ初期値 -1 から 0 へ変わることで設定を検証）。
        expect(createdLines[0].renderingGroupId).toBe(0);
        expect(createdRibbons[0].isPickable).toBe(false);
        expect(createdRibbons[0].renderingGroupId).toBe(0);
    });

    it("2 点未満は throw", () => {
        const { mgr } = makeManager();
        expect(() => mgr.add({ points: [{ lat: 35, lon: 139 }] })).toThrow(/at least 2/);
    });

    it("remove で線・壁・マテリアルが dispose される", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ points: pts3 });
        mgr.remove(id);
        expect(createdLines[0].disposeCount).toBe(1);
        expect(createdRibbons[0].disposeCount).toBe(1);
        // 壁マテリアルも dispose される（リークしない）。
        const wallMat = createdRibbons[0].material as { disposeCount: number };
        expect(wallMat.disposeCount).toBe(1);
    });

    it("remove 未存在 id は warn + no-op", () => {
        const { mgr } = makeManager();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        expect(() => mgr.remove("nope")).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('id "nope" not found'));
        warn.mockRestore();
    });

    it("setEnabled で線・壁の表示が切り替わる（壁は wallsEnabled も考慮）", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ points: pts3, wallsEnabled: true });
        mgr.setEnabled(id, false);
        expect(createdLines[0].enabled).toBe(false);
        expect(createdRibbons[0].enabled).toBe(false);
        mgr.setEnabled(id, true);
        expect(createdLines[0].enabled).toBe(true);
        expect(createdRibbons[0].enabled).toBe(true);
    });

    it("wallsEnabled=false なら壁は無効で生成される", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, wallsEnabled: false });
        expect(createdRibbons[0].enabled).toBe(false);
    });

    it("半透明壁(alpha<1)は needDepthPrePass=true、不透明なら false", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3 }); // 既定 wallOpacity 0.25 → 半透明
        expect((createdRibbons[0].material as { needDepthPrePass: boolean }).needDepthPrePass).toBe(true);
        mgr.add({ points: pts3, wallOpacity: 1 }); // 不透明
        expect((createdRibbons[1].material as { needDepthPrePass: boolean }).needDepthPrePass).toBe(false);
    });
});

describe("update", () => {
    it("有効ポリゴンは instance 更新される", () => {
        const { mgr, terrainElevAt } = makeManager();
        mgr.add({ points: pts3, closed: true });
        mgr.update();
        expect(terrainElevAt).toHaveBeenCalled();
        expect(lineInstanceUpdates.length).toBe(1);
        expect(ribbonInstanceUpdates.length).toBe(1);
    });

    it("wallsEnabled=false は壁の instance 更新をしない", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, wallsEnabled: false });
        mgr.update();
        expect(lineInstanceUpdates.length).toBe(1);
        expect(ribbonInstanceUpdates.length).toBe(0);
    });
});

describe("topAltitudeMeters（固定高度）", () => {
    it("固定高度指定時は terrainElevAt を呼ばずに一定高度で描く", () => {
        const { mgr, terrainElevAt } = makeManager();
        mgr.add({ points: pts3, closed: true, topAltitudeMeters: 6000 });
        mgr.update();
        // 地形に依らないので terrainElevAt は呼ばれない。
        expect(terrainElevAt).not.toHaveBeenCalled();
    });
});

describe("dispose 後ガード", () => {
    it("dispose 後の add/setEnabled/update は throw、二重 dispose は安全", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ points: pts3 });
        mgr.dispose();
        expect(() => mgr.add({ points: pts3 })).toThrow(/after dispose/);
        expect(() => mgr.setEnabled(id, false)).toThrow(/after dispose/);
        expect(() => mgr.update()).toThrow(/after dispose/);
        expect(() => mgr.dispose()).not.toThrow();
    });
});

describe("色フォールバック", () => {
    it("非 hex の outline/wall 色でも throw しない", () => {
        const { mgr } = makeManager();
        expect(() =>
            mgr.add({ points: pts3, outlineColor: "red", wallColor: "blue" }),
        ).not.toThrow();
    });
});
