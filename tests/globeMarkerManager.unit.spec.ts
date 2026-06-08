/**
 * GlobeMarkerManager の振る舞い (Issue #275 Phase 3)。
 *
 * Babylon の Mesh / Material 実体と marker.ts の描画部を軽量スタブに差し替え、
 * CRUD / enable / update / dispose 後ガード / validateIconUrl 投げ直し /
 * 非 hex 線色フォールバックを検証する（Vector3 / Quaternion / Color3 / overlayPlacement は実物）。
 */
import { jest } from "@jest/globals";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/** スタブ mesh（position / scaling は実 Vector3 で copyFrom/addInPlace/set を効かせる）。 */
interface StubMesh {
    name: string;
    rotationQuaternion: unknown;
    isPickable: boolean;
    renderingGroupId: number;
    scaling: Vector3;
    position: Vector3;
    material: unknown;
    enabled: boolean;
    disposeCount: number;
    setEnabled: (v: boolean) => void;
    dispose: () => void;
}

const createdCylinders: StubMesh[] = [];
const createStubMesh = (name: string): StubMesh => {
    const m: StubMesh = {
        name,
        rotationQuaternion: null,
        isPickable: true,
        renderingGroupId: 0,
        scaling: new Vector3(1, 1, 1),
        position: new Vector3(),
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
    return m;
};

jest.unstable_mockModule("@babylonjs/core/Meshes/meshBuilder", () => ({
    MeshBuilder: {
        CreateCylinder: (name: string): StubMesh => {
            const m = createStubMesh(name);
            createdCylinders.push(m);
            return m;
        },
    },
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: class {
        emissiveColor: unknown = null;
        disableLighting = false;
        disposeCount = 0;
        constructor(public name: string) {}
        dispose(): void {
            this.disposeCount++;
        }
    },
}));

const validateIconUrl = jest.fn((url: string) => {
    if (/^javascript:/i.test(url.trim())) {
        throw new Error("addMarker: icon.url has disallowed scheme: javascript:");
    }
});

const createdIconTexts: { mesh: { enabled: boolean; isPickable: boolean }; disposed: boolean }[] = [];
jest.unstable_mockModule("../src/terrain/marker", () => ({
    RENDERING_GROUP_ID: 1,
    validateIconUrl,
    resolveIcon: (icon?: { url: string }) =>
        icon ? { url: icon.url, width: 24, height: 24 } : null,
    resolveText: (text?: { value: string }) => (text ? { value: text.value } : null),
    createIconTextMesh: (_scene: unknown, _id: string, icon: unknown, text: unknown) => {
        if (!icon && !text) return null;
        const it = {
            mesh: {
                isPickable: true,
                scaling: new Vector3(1, 1, 1),
                position: new Vector3(),
                enabled: true,
                setEnabled(v: boolean) {
                    this.enabled = v;
                },
                dispose() {},
            },
            material: { dispose() {} },
            texture: { dispose() {} },
            heightWorld: 10,
            iconHeightWorld: 0,
            textHeightWorld: 10,
            widthWorld: 10,
            disposed: false,
        };
        createdIconTexts.push(it);
        return it;
    },
}));

const { createGlobeMarkerManager } = await import(
    "../src/terrain/geo/globeMarkerManager"
);
const { describe, it, expect, beforeEach } = await import("@jest/globals");

const makeManager = () => {
    // 2 引数型の変数として宣言し（toHaveBeenCalledWith(lat,lon) のため）、本体は引数未使用の mock。
    const terrainElevAt: (lat: number, lon: number) => number | null = jest.fn(() => 1000);
    const mgr = createGlobeMarkerManager({ scene: {} as never, terrainElevAt });
    return { mgr, terrainElevAt };
};

beforeEach(() => {
    createdCylinders.length = 0;
    createdIconTexts.length = 0;
    validateIconUrl.mockClear();
});

describe("CRUD", () => {
    it("add は一意な id を返し、ポール mesh を生成する", () => {
        const { mgr } = makeManager();
        const id1 = mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        const id2 = mgr.add({ lat: 36, lon: 140, text: { value: "B" } });
        expect(id1).not.toBe(id2);
        expect(createdCylinders.length).toBe(2);
    });

    it("add 直後に初期配置され、原点 (0,0,0) のままにならない", () => {
        const { mgr } = makeManager();
        mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        // update を呼ぶ前でも placeNode により地表へ配置済み（チラつき防止）。
        expect(createdCylinders[0].position.length()).toBeGreaterThan(6_000_000);
    });

    it("ポールは isPickable=false / renderingGroupId=1", () => {
        const { mgr } = makeManager();
        mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        expect(createdCylinders[0].isPickable).toBe(false);
        expect(createdCylinders[0].renderingGroupId).toBe(1);
    });

    it("remove でポール mesh が dispose される", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        mgr.remove(id);
        expect(createdCylinders[0].disposeCount).toBe(1);
    });

    it("setEnabled でポールの表示状態が切り替わる", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        mgr.setEnabled(id, false);
        expect(createdCylinders[0].enabled).toBe(false);
        mgr.setEnabled(id, true);
        expect(createdCylinders[0].enabled).toBe(true);
    });

    it("remove は未存在 id で warn + no-op（throw しない）", () => {
        const { mgr } = makeManager();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        expect(() => mgr.remove("nope")).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('id "nope" not found'));
        warn.mockRestore();
    });

    it("setEnabled は未存在 id で throw する", () => {
        const { mgr } = makeManager();
        expect(() => mgr.setEnabled("nope", false)).toThrow(/not found/);
    });
});

describe("update", () => {
    it("接地・距離スケールでポールの高さ/位置/向きを更新する", () => {
        const { mgr, terrainElevAt } = makeManager();
        mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        const camEcef = new Vector3(7_000_000, 0, 0); // 地表から十分離れた位置
        mgr.update(camEcef);
        expect(terrainElevAt).toHaveBeenCalledWith(35, 139);
        // 線高さ（scaling.y）が正・向き（rotationQuaternion）が設定される。
        expect(createdCylinders[0].scaling.y).toBeGreaterThan(0);
        expect(createdCylinders[0].rotationQuaternion).not.toBeNull();
        // 位置が原点から動いている（地表 ECEF + up*h/2）。
        expect(createdCylinders[0].position.length()).toBeGreaterThan(0);
    });

    it("無効マーカーは update で変化しない（add の初期配置のまま）", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        const yAfterAdd = createdCylinders[0].scaling.y; // add の初期配置で設定済み
        mgr.setEnabled(id, false);
        mgr.update(new Vector3(7_000_000, 0, 0));
        // 無効なので update では更新されない（初期配置の値のまま）。
        expect(createdCylinders[0].scaling.y).toBe(yAfterAdd);
    });

    it("terrainElevAt が null のときは直前標高を保持する（楕円体へ落とさない）", () => {
        // 標高 5000m → 途中で null（前景タイル未ロード相当）に変化させる。
        let elevReturn: number | null = 5000;
        const terrainElevAt: (lat: number, lon: number) => number | null = jest.fn(
            () => elevReturn,
        );
        const mgr = createGlobeMarkerManager({ scene: {} as never, terrainElevAt });
        mgr.add({ lat: 35, lon: 139, text: { value: "A" } }); // lastElev=5000
        const cam = new Vector3(7_000_000, 0, 0);
        mgr.update(cam); // elev=5000
        const after5000 = createdCylinders[0].position.clone();
        elevReturn = null;
        mgr.update(cam); // null → 直前 5000 を維持
        // 位置がほぼ同じ（楕円体面へ落ちて大きく変わらない）。
        expect(Vector3.Distance(createdCylinders[0].position, after5000)).toBeLessThan(1);
        // 5000m 接地は楕円体面(elev=0)より地心距離が大きいことの傍証として十分大きい。
        expect(createdCylinders[0].position.length()).toBeGreaterThan(6_300_000);
    });
});

describe("dispose 後ガード", () => {
    it("dispose 後の add は throw する", () => {
        const { mgr } = makeManager();
        mgr.dispose();
        expect(() => mgr.add({ lat: 35, lon: 139, text: { value: "A" } })).toThrow(
            /after dispose/,
        );
    });

    it("二重 dispose は安全（throw しない）", () => {
        const { mgr } = makeManager();
        mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        mgr.dispose();
        expect(() => mgr.dispose()).not.toThrow();
    });

    it("dispose 後の setEnabled は throw する", () => {
        const { mgr } = makeManager();
        const id = mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        mgr.dispose();
        expect(() => mgr.setEnabled(id, false)).toThrow(/after dispose/);
    });

    it("dispose 後の update は throw する", () => {
        const { mgr } = makeManager();
        mgr.add({ lat: 35, lon: 139, text: { value: "A" } });
        mgr.dispose();
        expect(() => mgr.update(new Vector3(7_000_000, 0, 0))).toThrow(/after dispose/);
    });
});

describe("icon URL 検証の投げ直し", () => {
    it("危険スキームは GlobeMarkerManager.add 由来 + id を含めて投げ直す", () => {
        const { mgr } = makeManager();
        expect(() =>
            mgr.add({ lat: 35, lon: 139, icon: { url: "javascript:alert(1)" } }),
        ).toThrow(/GlobeMarkerManager\.add \(globe-marker-\d+\):/);
        expect(validateIconUrl).toHaveBeenCalled();
    });
});

describe("線色フォールバック", () => {
    it("非 hex の CSS color でも例外にならない（既定色フォールバック）", () => {
        const { mgr } = makeManager();
        expect(() =>
            mgr.add({ lat: 35, lon: 139, text: { value: "A" }, line: { color: "red" } }),
        ).not.toThrow();
    });
});
