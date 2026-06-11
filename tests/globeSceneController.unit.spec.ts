/**
 * `createGlobeSceneController` のカメラ get/set マッピング検証 (Issue #349 / #275 Phase 4 P4-0)。
 *
 * GeospatialCamera を実体ではなく軽量スタブ（center: 実 Vector3 / radius / yaw / pitch）に
 * 差し替え、ECEF 変換（`geo/ecef`）と yaw/pitch ↔ azimuth/tilt（`geo/cameraMapping`）は実物で
 * 往復精度を確認する。overlay 未対応・viewMode "3d" 固定・mapType 切替の暫定挙動もあわせて検証する。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { jest } from "@jest/globals";

import { createGlobeSceneController } from "../src/scenes/globeSceneController";
import { createGlobeMarkerManagerAdapter } from "../src/scenes/globeSceneController";
import type { GlobeSceneController } from "../src/scenes/globe";
import type {
    GlobeMarkerManager,
    GlobeMarkerOptions,
} from "../src/terrain/geo/globeMarkerManager";
import { geodeticToEcef } from "../src/terrain/geo/ecef";

/** camera のみ参照する軽量スタブ GlobeSceneController を作る。 */
const makeStub = (
    lat: number,
    lon: number,
    radius: number,
    yaw: number,
    pitch: number,
): { gc: GlobeSceneController; disposed: () => boolean } => {
    let disposedFlag = false;
    const camera = {
        center: geodeticToEcef(lat, lon, 0),
        radius,
        yaw,
        pitch,
    };
    const gc = {
        camera,
        dispose: () => {
            disposedFlag = true;
        },
    } as unknown as GlobeSceneController;
    return { gc, disposed: () => disposedFlag };
};

describe("createGlobeSceneController (P4-0 globe backend adapter)", () => {
    it("getLat/getLon は center(ECEF) を測地座標へ逆変換して返す", () => {
        const { gc } = makeStub(35.36, 138.72, 60000, 0, Math.PI / 4);
        const c = createGlobeSceneController(gc, "std");
        expect(c.getLat()).toBeCloseTo(35.36, 4);
        expect(c.getLon()).toBeCloseTo(138.72, 4);
        expect(c.getAltitude()).toBe(60000);
    });

    it("setLat/setLon は中心を更新し getLat/getLon と往復一致する", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        c.setLat(36.5);
        c.setLon(140.25);
        expect(c.getLat()).toBeCloseTo(36.5, 4);
        expect(c.getLon()).toBeCloseTo(140.25, 4);
    });

    it("setAltitude は camera.radius に反映される", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        c.setAltitude(2500);
        expect(c.getAltitude()).toBe(2500);
    });

    it("azimuth/tilt は yaw/pitch と往復一致する（度↔rad）", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        c.setAzimuth(90);
        c.setTilt(30);
        expect(c.getAzimuth()).toBeCloseTo(90, 4);
        expect(c.getTilt()).toBeCloseTo(30, 4);
    });

    it("setView は複数パラメータをまとめて反映する", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        c.setView({ lat: 34, lon: 135, altitude: 5000, azimuth: 45, tilt: 60 });
        expect(c.getLat()).toBeCloseTo(34, 4);
        expect(c.getLon()).toBeCloseTo(135, 4);
        expect(c.getAltitude()).toBe(5000);
        expect(c.getAzimuth()).toBeCloseTo(45, 4);
        expect(c.getTilt()).toBeCloseTo(60, 4);
    });

    it("getViewMode は常に 3d、getZoomLevel は undefined", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        expect(c.getViewMode()).toBe("3d");
        expect(c.getZoomLevel()).toBeUndefined();
    });

    it("mapType は 'std'↔'standard' / 'photo' を相互変換する", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "photo");
        expect(c.getMapType()).toBe("photo");
        const c2 = createGlobeSceneController(makeStub(35, 139, 1000, 0, 0).gc, "std");
        expect(c2.getMapType()).toBe("standard");
    });

    it("setMapType は状態のみ保持し warn は一度だけ（実描画は未適用）", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        c.setMapType("photo");
        c.setMapType("photo"); // 同値は no-op（warn しない）
        expect(c.getMapType()).toBe("photo");
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("getMarkerContext は globe 未対応のため throw する", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        expect(() => c.getMarkerContext()).toThrow(/not supported on the globe backend/);
    });

    it("購読 API は no-op unsubscribe を返し、no-op メソッドは例外を投げない", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        expect(typeof c.subscribeTerrainClick(() => {})).toBe("function");
        expect(() => c.setUiVisibility("compass", false)).not.toThrow();
        expect(() => c.setSunShadows(true)).not.toThrow();
        expect(c.isTerrainIdle()).toBe(true);
    });

    it("dispose は GlobeSceneController.dispose へ委譲する", () => {
        const { gc, disposed } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        c.dispose();
        expect(disposed()).toBe(true);
    });
});

/** Vector3 が実体であることの sanity（geodeticToEcef は非ゼロを返す）。 */
it("geodeticToEcef は富士山付近で非ゼロ ECEF を返す（テスト基盤の sanity）", () => {
    const v = geodeticToEcef(35.36, 138.72, 0);
    expect(v).toBeInstanceOf(Vector3);
    expect(v.length()).toBeGreaterThan(6_000_000);
});

/** add/remove/setEnabled/dispose を記録する軽量スタブ GlobeMarkerManager。 */
const makeGlobeMarkerStub = (): {
    mgr: GlobeMarkerManager;
    added: { id: string; opts: GlobeMarkerOptions }[];
    removed: string[];
    enabledCalls: { id: string; enabled: boolean }[];
    disposed: () => boolean;
} => {
    let seq = 0;
    let disposedFlag = false;
    const added: { id: string; opts: GlobeMarkerOptions }[] = [];
    const removed: string[] = [];
    const enabledCalls: { id: string; enabled: boolean }[] = [];
    const mgr = {
        add: (opts: GlobeMarkerOptions): string => {
            const id = `g${seq++}`;
            added.push({ id, opts });
            return id;
        },
        remove: (id: string): void => {
            removed.push(id);
        },
        setEnabled: (id: string, enabled: boolean): void => {
            enabledCalls.push({ id, enabled });
        },
        update: (): void => {},
        dispose: (): void => {
            disposedFlag = true;
        },
    } as unknown as GlobeMarkerManager;
    return { mgr, added, removed, enabledCalls, disposed: () => disposedFlag };
};

describe("createGlobeMarkerManagerAdapter (P4-0 Slice 2a marker overlay)", () => {
    const VALID_LAT = 35.36;
    const VALID_LON = 138.72;
    /** 既定の有効オプション（icon/text の少なくとも一方が必須）。 */
    const BASE = { lat: VALID_LAT, lon: VALID_LON, text: { value: "x" } };

    it("add は globe マネージャへ委譲しハンドルを返す（標高解決済み）", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 100);
        const h = m.add("p1", {
            lat: VALID_LAT,
            lon: VALID_LON,
            icon: { url: "https://example.com/i.png" },
            text: { value: "hello" },
        });
        expect(h.id).toBe("p1");
        expect(h.lat).toBeCloseTo(VALID_LAT, 6);
        expect(h.lon).toBeCloseTo(VALID_LON, 6);
        expect(h.enabled).toBe(true);
        expect(h.icon).toEqual({
            url: "https://example.com/i.png",
            width: 40,
            height: 40,
        });
        expect(h.text?.value).toBe("hello");
        expect(h.line).toEqual({ color: "#000000", width: 4, height: 500 });
        expect(h.elevationResolved).toBe(true);
        expect(stub.added).toHaveLength(1);
        expect(stub.added[0].opts.lat).toBeCloseTo(VALID_LAT, 6);
    });

    it("elevationResolved は terrainElevAt が null のとき false", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => null);
        const h = m.add("p1", { lat: VALID_LAT, lon: VALID_LON, text: { value: "x" } });
        expect(h.elevationResolved).toBe(false);
        expect(h.icon).toBeNull();
        expect(h.text?.value).toBe("x");
    });

    it("icon/text のいずれも無い add は throw する（planar parity）", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        expect(() =>
            m.add("p1", { lat: VALID_LAT, lon: VALID_LON }),
        ).toThrow(/at least one of icon\/text is required/);
    });

    it("同一 id の add は throw する", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        m.add("p1", { ...BASE });
        expect(() => m.add("p1", { ...BASE })).toThrow(/already exists/);
    });

    it("JAPAN_BOUNDS 外の lat/lon は throw する", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        expect(() => m.add("p1", { lat: 0, lon: 0, text: { value: "x" } })).toThrow(
            /JAPAN_BOUNDS/,
        );
    });

    it("get は未知 id で null、既知 id でハンドルを返す", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        expect(m.get("none")).toBeNull();
        m.add("p1", { ...BASE });
        expect(m.get("p1")?.id).toBe("p1");
    });

    it("update は内部ノードを作り直し（add 後に旧 remove）更新後ハンドルを返す", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 50);
        m.add("p1", { lat: VALID_LAT, lon: VALID_LON, text: { value: "a" } });
        const h = m.update("p1", { lat: 34, lon: 135, text: { value: "b" }, enabled: false });
        expect(stub.removed).toEqual(["g0"]);
        expect(stub.added).toHaveLength(2);
        expect(h.lat).toBeCloseTo(34, 6);
        expect(h.lon).toBeCloseTo(135, 6);
        expect(h.text?.value).toBe("b");
        expect(h.enabled).toBe(false);
    });

    it("update は未知 id で throw、範囲外 lat で throw する", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        expect(() => m.update("none", { enabled: false })).toThrow(/not found/);
        m.add("p1", { ...BASE });
        expect(() => m.update("p1", { lat: 0, lon: 0 })).toThrow(/JAPAN_BOUNDS/);
    });

    it("remove は委譲し、未知 id では warn のみで throw しない", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        m.add("p1", { ...BASE });
        m.remove("p1");
        expect(stub.removed).toEqual(["g0"]);
        expect(m.get("p1")).toBeNull();
        m.remove("none");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("setEnabled は委譲しハンドルへ反映する", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        m.add("p1", { ...BASE });
        m.setEnabled("p1", false);
        expect(stub.enabledCalls).toEqual([{ id: "g0", enabled: false }]);
        expect(m.get("p1")?.enabled).toBe(false);
    });

    it("list は登録 id を返す", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        m.add("p1", { ...BASE });
        m.add("p2", { ...BASE });
        expect(m.list()).toEqual(["p1", "p2"]);
    });

    it("dispose は globe マネージャへ委譲し、以後の add は throw する", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        m.add("p1", { ...BASE });
        m.dispose();
        expect(stub.disposed()).toBe(true);
        expect(() => m.add("p2", { ...BASE })).toThrow(/disposed/);
    });
});
