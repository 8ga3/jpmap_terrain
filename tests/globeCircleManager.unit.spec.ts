/**
 * GlobeCircleManager の振る舞い。
 *
 * 内部の GlobePolygonManager をスタブに差し替え、1 サークルが ring（閉ポリゴン・線＋壁）と
 * center（中心 1 点・点＋ラベル）の 2 ノードへ委譲されること、半径/分割数の検証、
 * CRUD/update/dispose の委譲を検証する。
 */
import { jest } from "@jest/globals";

interface AddCall {
    points: { lat: number; lon: number }[];
    closed?: boolean;
    style?: { lineColor?: string; wallColor?: string; wallOpacity?: number };
    pointsEnabled?: boolean;
    lineEnabled?: boolean;
    wallsEnabled?: boolean;
    labelsEnabled?: boolean;
    labels?: ReadonlyArray<string | undefined>;
}
const addCalls: AddCall[] = [];
const removeCalls: string[] = [];
const setEnabledCalls: [string, boolean][] = [];
const setFlattenCalls: boolean[] = [];
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
        setFlatten: (flat: boolean) => setFlattenCalls.push(flat),
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
    setFlattenCalls.length = 0;
    updateCount = 0;
    disposeCount = 0;
});

describe("add", () => {
    it("ring（閉ポリゴン）と center（中心 1 点）の 2 ノードへ委譲する", () => {
        const mgr = makeManager();
        const id = mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000, segments: 16 });
        expect(addCalls.length).toBe(2);
        // ring ノード: 閉ポリゴン・円周点列・頂点マーカー無効。
        expect(addCalls[0].closed).toBe(true);
        expect(addCalls[0].points.length).toBe(16);
        expect(addCalls[0].pointsEnabled).toBe(false);
        // center ノード: 中心 1 点・点マーカー有効・線無効。
        expect(addCalls[1].points.length).toBe(1);
        expect(addCalls[1].pointsEnabled).toBe(true);
        expect(addCalls[1].lineEnabled).toBe(false);
        expect(id).toBe("globe-circle-0");
    });

    it("segments 既定は 64", () => {
        const mgr = makeManager();
        mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000 });
        expect(addCalls[0].points.length).toBe(64);
    });

    it("ラベル指定時は center ノードにラベルを委譲する", () => {
        const mgr = makeManager();
        mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000, label: "中心" });
        expect(addCalls[1].labelsEnabled).toBe(true);
        expect(addCalls[1].labels?.[0]).toBe("中心");
    });

    it("スタイル（色）を ring へ委譲する", () => {
        const mgr = makeManager();
        mgr.add({
            centerLat: 35,
            centerLon: 139,
            radiusMeters: 5000,
            style: { lineColor: "#abcdef" },
        });
        expect(addCalls[0].style?.lineColor).toBe("#abcdef");
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
    it("remove / setEnabled は ring・center 両ノードへ委譲する", () => {
        const mgr = makeManager();
        const id = mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000 });
        mgr.setEnabled(id, false);
        mgr.update();
        mgr.remove(id);
        mgr.dispose();
        // ring=globe-polygon-0 / center=globe-polygon-1 の 2 ノード。
        expect(setEnabledCalls).toEqual([
            ["globe-polygon-0", false],
            ["globe-polygon-1", false],
        ]);
        expect(updateCount).toBe(1);
        expect(removeCalls).toEqual(["globe-polygon-0", "globe-polygon-1"]);
        expect(disposeCount).toBe(1);
    });

    it("setFlatten は内部ポリゴンマネージャへ委譲する", () => {
        const mgr = makeManager();
        mgr.add({ centerLat: 35, centerLon: 139, radiusMeters: 5000 });
        mgr.setFlatten(true);
        mgr.setFlatten(false);
        expect(setFlattenCalls).toEqual([true, false]);
    });
});
