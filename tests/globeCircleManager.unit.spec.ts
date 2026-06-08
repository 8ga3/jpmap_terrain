/**
 * GlobeCircleManager の振る舞い (Issue #275 Phase 3)。
 *
 * 内部の GlobePolygonManager をスタブに差し替え、サークルが「閉ポリゴン + 円周点列」へ委譲される
 * こと、半径/分割数の検証、CRUD/update/dispose の委譲を検証する。
 */
import { jest } from "@jest/globals";

interface AddCall {
    points: { lat: number; lon: number }[];
    closed?: boolean;
    outlineColor?: string;
}
const addCalls: AddCall[] = [];
const removeCalls: string[] = [];
const setEnabledCalls: [string, boolean][] = [];
let updateCount = 0;
let disposeCount = 0;

jest.unstable_mockModule("../src/terrain/geo/globePolygonManager", () => ({
    createGlobePolygonManager: () => ({
        add: (opts: AddCall) => {
            addCalls.push(opts);
            return `globe-polygon-${addCalls.length - 1}`;
        },
        remove: (id: string) => removeCalls.push(id),
        setEnabled: (id: string, e: boolean) => setEnabledCalls.push([id, e]),
        update: () => {
            updateCount++;
        },
        dispose: () => {
            disposeCount++;
        },
    }),
}));

const { createGlobeCircleManager } = await import(
    "../src/terrain/geo/globeCircleManager"
);
const { describe, it, expect, beforeEach } = await import("@jest/globals");

const makeManager = () =>
    createGlobeCircleManager({ scene: {} as never, terrainElevAt: () => 0 });

beforeEach(() => {
    addCalls.length = 0;
    removeCalls.length = 0;
    setEnabledCalls.length = 0;
    updateCount = 0;
    disposeCount = 0;
});

describe("add", () => {
    it("円周点列を持つ閉ポリゴンとして委譲する", () => {
        const mgr = makeManager();
        const id = mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000, segments: 16 });
        expect(addCalls.length).toBe(1);
        expect(addCalls[0].closed).toBe(true);
        expect(addCalls[0].points.length).toBe(16);
        expect(id).toBe("globe-polygon-0");
    });

    it("segments 既定は 64", () => {
        const mgr = makeManager();
        mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000 });
        expect(addCalls[0].points.length).toBe(64);
    });

    it("スタイル（色）を委譲する", () => {
        const mgr = makeManager();
        mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000, outlineColor: "#abcdef" });
        expect(addCalls[0].outlineColor).toBe("#abcdef");
    });

    it("radius <= 0 は throw", () => {
        const mgr = makeManager();
        expect(() => mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 0 })).toThrow(
            /radiusMeters/,
        );
    });

    it("segments が範囲外は throw", () => {
        const mgr = makeManager();
        expect(() =>
            mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000, segments: 2 }),
        ).toThrow(/segments/);
        expect(() =>
            mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000, segments: 1000 }),
        ).toThrow(/segments/);
    });
});

describe("委譲（remove/setEnabled/update/dispose）", () => {
    it("各操作が内部ポリゴンマネージャへ委譲される", () => {
        const mgr = makeManager();
        const id = mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000 });
        mgr.setEnabled(id, false);
        mgr.update();
        mgr.remove(id);
        mgr.dispose();
        expect(setEnabledCalls).toEqual([[id, false]]);
        expect(updateCount).toBe(1);
        expect(removeCalls).toEqual([id]);
        expect(disposeCount).toBe(1);
    });
});
