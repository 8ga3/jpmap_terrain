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
    position: { length: () => number; copyFrom: (v: unknown) => unknown; addInPlace: (v: unknown) => unknown };
    scaling: { setAll: (v: number) => void };
    billboardMode?: number;
    setEnabled: (v: boolean) => void;
    dispose: () => void;
}

const createdLines: StubMesh[] = [];
const createdPoints: StubMesh[] = [];
const createdDrops: StubMesh[] = [];
const createdPlanes: StubMesh[] = [];
const createdRibbons: StubMesh[] = [];
const lineInstanceUpdates: number[] = [];
const dropInstanceUpdates: number[] = [];
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
        position: {
            length: () => 1,
            copyFrom() {
                return this;
            },
            addInPlace() {
                return this;
            },
        },
        scaling: { setAll() {} },
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

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/sphereBuilder", () => ({
    CreateSphere: (name: string) => stub(name, createdPoints),
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/tubeBuilder", () => ({
    CreateTube: (name: string, opts: { instance?: StubMesh }) => {
        if (opts.instance) {
            if (name.includes("outline")) lineInstanceUpdates.push(1);
            else dropInstanceUpdates.push(1);
            return opts.instance;
        }
        const bucket = name.includes("outline") ? createdLines : createdDrops;
        return stub(name, bucket);
    },
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/planeBuilder", () => ({
    CreatePlane: (name: string) => stub(name, createdPlanes),
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/abstractMesh", () => ({
    AbstractMesh: { BILLBOARDMODE_ALL: 7 },
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
        useAlphaFromDiffuseTexture = false;
        diffuseTexture: unknown = null;
        disposeCount = 0;
        constructor(public name: string) {}
        dispose(): void {
            this.disposeCount++;
        }
    },
}));

jest.unstable_mockModule("@babylonjs/core/Materials/Textures/dynamicTexture", () => ({
    DynamicTexture: class {
        hasAlpha = false;
        vScale = 1;
        vOffset = 0;
        disposeCount = 0;
        constructor(public name: string) {}
        getContext(): {
            font: string;
            fillStyle: string;
            strokeStyle: string;
            lineWidth: number;
            textBaseline: string;
            textAlign: string;
            lineJoin: string;
            miterLimit: number;
            measureText: (s: string) => { width: number };
            clearRect: () => void;
            fillRect: () => void;
            strokeText: () => void;
            fillText: () => void;
        } {
            return {
                font: "",
                fillStyle: "",
                strokeStyle: "",
                lineWidth: 1,
                textBaseline: "",
                textAlign: "",
                lineJoin: "",
                miterLimit: 0,
                measureText: (s: string) => ({ width: s.length * 8 }),
                clearRect() {},
                fillRect() {},
                strokeText() {},
                fillText() {},
            };
        }
        update(): void {}
        dispose(): void {
            this.disposeCount++;
        }
    },
}));

// Mesh.DOUBLESIDE 定数のみ使用するため軽量スタブ。
jest.unstable_mockModule("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: { DOUBLESIDE: 2, NO_CAP: 0 },
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
    createdPoints.length = 0;
    createdDrops.length = 0;
    createdPlanes.length = 0;
    createdRibbons.length = 0;
    lineInstanceUpdates.length = 0;
    dropInstanceUpdates.length = 0;
    ribbonInstanceUpdates.length = 0;
});

describe("add / CRUD", () => {
    it("点・垂線・アウトライン線・壁 Ribbon を生成する", () => {
        const { mgr } = makeManager();
        mgr.add({
            points: pts3,
            closed: true,
            labels: ["A", "B", "C"],
            edgeLabels: ["AB", "BC", "CA"],
        });
        expect(createdPoints.length).toBe(3);
        expect(createdDrops.length).toBe(3);
        expect(createdPlanes.length).toBe(6);
        expect(createdLines.length).toBe(1);
        expect(createdRibbons.length).toBe(1);
        expect(createdLines[0].isPickable).toBe(false);
        expect(createdLines[0].renderingGroupId).toBe(1);
        expect(createdRibbons[0].isPickable).toBe(false);
        expect(createdRibbons[0].renderingGroupId).toBe(0);
    });

    it("1 点のみも許容し、線・壁は非表示", () => {
        const { mgr } = makeManager();
        mgr.add({ points: [{ lat: 35, lon: 139 }], labels: ["single"] });
        expect(createdPoints.length).toBe(1);
        expect(createdDrops.length).toBe(1);
        expect(createdLines[0].enabled).toBe(false);
        expect(createdRibbons[0].enabled).toBe(false);
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
        lineInstanceUpdates.length = 0;
        dropInstanceUpdates.length = 0;
        ribbonInstanceUpdates.length = 0;
        mgr.update();
        expect(terrainElevAt).toHaveBeenCalled();
        expect(lineInstanceUpdates.length).toBe(1);
        expect(dropInstanceUpdates.length).toBe(3);
        expect(ribbonInstanceUpdates.length).toBe(1);
    });

    it("wallsEnabled=false は壁の instance 更新をしない", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, wallsEnabled: false });
        lineInstanceUpdates.length = 0;
        ribbonInstanceUpdates.length = 0;
        mgr.update();
        expect(lineInstanceUpdates.length).toBe(1);
        expect(ribbonInstanceUpdates.length).toBe(0);
    });

    it("terrain 標高未解決なら全要素を非表示にする", () => {
        const terrainElevAt: (lat: number, lon: number) => number | null = jest.fn(() => null);
        const mgr = createGlobePolygonManager({ scene: {} as never, terrainElevAt });
        mgr.add({ points: pts3 });
        expect(createdPoints.every((m) => !m.enabled)).toBe(true);
        expect(createdDrops.every((m) => !m.enabled)).toBe(true);
        expect(createdLines[0].enabled).toBe(false);
        expect(createdRibbons[0].enabled).toBe(false);
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

    it("absolute altitudeMode は terrainElevAt を呼ばず解決済み表示する", () => {
        const { mgr, terrainElevAt } = makeManager();
        mgr.add({
            points: pts3.map((p) => ({ ...p, altitude: 500 })),
            altitudeMode: "absolute",
        });
        mgr.update();
        expect(terrainElevAt).not.toHaveBeenCalled();
        expect(createdPoints.every((m) => m.enabled)).toBe(true);
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
