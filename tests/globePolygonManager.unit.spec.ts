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
    lastScale?: number;
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
        scaling: {
            setAll(v: number) {
                m.lastScale = v;
            },
        },
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
        // ラベル（平面）は線より上位グループ(2)で描画し、常に読めるようにする。
        expect(createdPlanes.length).toBeGreaterThan(0);
        expect(createdPlanes.every((p) => p.renderingGroupId === 2)).toBe(true);
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

    it("pointsEnabled=false / verticalsEnabled=false なら点・垂線メッシュを生成しない（円委譲の最適化）", () => {
        const { mgr } = makeManager();
        mgr.add({
            points: pts3,
            pointsEnabled: false,
            verticalsEnabled: false,
        });
        expect(createdPoints.length).toBe(0);
        expect(createdDrops.length).toBe(0);
        // 線・壁は通常どおり生成される。
        expect(createdLines.length).toBe(1);
        expect(createdRibbons.length).toBe(1);
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

describe("setFlatten (#395)", () => {
    it("setFlatten(true) で壁・垂線を無効化し、接地アウトライン/点は残す", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, wallsEnabled: true });
        // 既定（3D）: 壁・垂線・アウトライン・点すべて有効。
        expect(createdRibbons[0].enabled).toBe(true);
        expect(createdDrops.every((d) => d.enabled)).toBe(true);
        expect(createdLines[0].enabled).toBe(true);
        // 2D: 壁・垂線が無効。接地アウトライン・点は維持。
        mgr.setFlatten(true);
        expect(createdRibbons[0].enabled).toBe(false);
        expect(createdDrops.every((d) => d.enabled === false)).toBe(true);
        expect(createdLines[0].enabled).toBe(true);
        expect(createdPoints.every((p) => p.enabled)).toBe(true);
    });

    it("setFlatten(false) で壁・垂線を復元する", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, wallsEnabled: true });
        mgr.setFlatten(true);
        mgr.setFlatten(false);
        expect(createdRibbons[0].enabled).toBe(true);
        expect(createdDrops.every((d) => d.enabled)).toBe(true);
    });

    it("flat 中の update でも壁・垂線は無効のまま", () => {
        const { mgr } = makeManager();
        mgr.add({ points: pts3, wallsEnabled: true });
        mgr.setFlatten(true);
        mgr.update();
        expect(createdRibbons[0].enabled).toBe(false);
        expect(createdDrops.every((d) => d.enabled === false)).toBe(true);
        // アウトラインは update 後も維持。
        expect(createdLines[0].enabled).toBe(true);
    });

    it("dispose 後の setFlatten は throw する", () => {
        const { mgr } = makeManager();
        mgr.dispose();
        expect(() => mgr.setFlatten(true)).toThrow(/after dispose/);
    });
});

describe("flat + flatScale サイズ一定（#395 Task3 続き）", () => {
    it("flat 時は点サイズが高度に依らず pointDiameter*flatScale になる", () => {
        const { mgr } = makeManager();
        mgr.setFlatten(true);
        const flatScale = 4;
        // 低高度ポリゴン。
        mgr.add({
            points: pts3.map((p) => ({ ...p, altitude: 500 })),
            altitudeMode: "absolute",
            style: { pointDiameter: 10 },
        });
        mgr.update(undefined, flatScale);
        expect(createdPoints.length).toBe(3);
        expect(createdPoints.every((p) => p.lastScale === 40)).toBe(true);

        // 高度を 10 倍にしても flat スケールは不変（高度が「生きない」）。
        createdPoints.length = 0;
        mgr.add({
            points: pts3.map((p) => ({ ...p, lat: p.lat + 0.01, altitude: 5000 })),
            altitudeMode: "absolute",
            style: { pointDiameter: 10 },
        });
        mgr.update(undefined, flatScale);
        expect(createdPoints.every((p) => p.lastScale === 40)).toBe(true);
    });

    it("再 add 直後も直近 update の flatScale で配置される（再構築チラつき防止）", () => {
        const { mgr } = makeManager();
        mgr.setFlatten(true);
        mgr.add({ points: pts3, style: { pointDiameter: 10 } });
        mgr.update(undefined, 4);
        // 再構築（remove→add 相当）。次の update を待たずに add 時点で flatScale=4 が適用される。
        createdPoints.length = 0;
        mgr.add({
            points: pts3.map((p) => ({ ...p, lon: p.lon + 0.01 })),
            style: { pointDiameter: 10 },
        });
        expect(createdPoints.every((p) => p.lastScale === 40)).toBe(true);
    });

    it("flat 時は absolute 高度を無視して地形へ接地する（near クリップ回避）", () => {
        const { mgr, terrainElevAt } = makeManager();
        mgr.setFlatten(true);
        mgr.add({
            points: pts3.map((p) => ({ ...p, altitude: 1500 })),
            altitudeMode: "absolute",
        });
        mgr.update(undefined, 4);
        // 3D の absolute は terrainElevAt を呼ばないが、2D（flat）では高度を捨てて
        // 地形標高へ接地するため terrainElevAt が呼ばれる。
        expect(terrainElevAt).toHaveBeenCalled();
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

describe("setContent（in-place 更新, ラベルチラつき対策）", () => {
    it("同じ点数・同幅ラベルなら mesh/texture を再利用し再生成しない（true）", () => {
        const { mgr } = makeManager();
        const id = mgr.add({
            points: pts3,
            closed: true,
            labels: ["AA", "BB", "CC"],
            edgeLabels: ["xx", "yy", "zz"],
        });
        const planesAfterAdd = createdPlanes.length;
        const ok = mgr.setContent(id, {
            points: [
                { lat: 35.31, lon: 138.71 },
                { lat: 35.41, lon: 138.81 },
                { lat: 35.31, lon: 138.91 },
            ],
            // 同じ文字数 → 既存テクスチャ寸法に収まり in-place 再描画。
            labels: ["DD", "EE", "FF"],
            edgeLabels: ["pp", "qq", "rr"],
        });
        expect(ok).toBe(true);
        // 新規 plane（ラベル/点）は作られない＝メッシュ再構築なし。
        expect(createdPlanes.length).toBe(planesAfterAdd);
        // 既存ラベル plane は dispose されない。
        expect(createdPlanes.every((p) => p.disposeCount === 0)).toBe(true);
    });

    it("ラベルが既存テクスチャに収まらない場合のみ当該ラベルを作り直す", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ points: pts3, closed: true, labels: ["A", "B", "C"] });
        const planesAfterAdd = createdPlanes.length;
        const ok = mgr.setContent(id, {
            points: pts3,
            // 1 つだけ大幅に長い → 既存幅を超えるため作り直し（+1 plane, 旧 1 つ dispose）。
            labels: ["AAAAAAAAAAAAAAAAAAAA", "B", "C"],
        });
        expect(ok).toBe(true);
        expect(createdPlanes.length).toBe(planesAfterAdd + 1);
        expect(createdPlanes.filter((p) => p.disposeCount > 0).length).toBe(1);
    });

    it("点数が変わる場合は false を返す（呼び出し側で再構築）", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ points: pts3 });
        const ok = mgr.setContent(id, {
            points: [
                { lat: 35.3, lon: 138.7 },
                { lat: 35.4, lon: 138.8 },
            ],
        });
        expect(ok).toBe(false);
    });

    it("未存在 id は false を返す", () => {
        const { mgr } = makeManager();
        expect(mgr.setContent("missing", { points: pts3 })).toBe(false);
    });
});
