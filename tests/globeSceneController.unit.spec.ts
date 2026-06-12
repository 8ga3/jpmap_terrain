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
import {
    createGlobeMarkerManagerAdapter,
    createGlobePolygonManagerAdapter,
    createGlobeCircleManagerAdapter,
    createGlobeModelManagerAdapter,
} from "../src/scenes/globeSceneController";
import type {
    GlobeSceneController,
    GlobeTerrainClickEvent,
    GlobeTerrainClickListener,
    GlobePolygonPointEvent,
    GlobePolygonPointDragEvent,
    GlobePolygonPointListener,
    GlobePolygonPointClickListener,
    GlobePolygonPointDragListener,
} from "../src/scenes/globe";
import type {
    TerrainClickEvent,
    PolygonPointPointerEvent,
    PolygonPointDragEvent,
} from "../src/lib/types";
import type {
    GlobeMarkerManager,
    GlobeMarkerOptions,
} from "../src/terrain/geo/globeMarkerManager";
import type {
    GlobePolygonManager,
    GlobePolygonOptions,
} from "../src/terrain/geo/globePolygonManager";
import type {
    GlobeCircleManager,
    GlobeCircleOptions,
} from "../src/terrain/geo/globeCircleManager";
import type {
    GlobeModelManager,
    GlobeModelOptions,
    GlobeModelUpdate,
    GlobeModelState,
} from "../src/terrain/geo/globeModelManager";
import { geodeticToEcef } from "../src/terrain/geo/ecef";

/** camera のみ参照する軽量スタブ GlobeSceneController を作る。 */
const makeStub = (
    lat: number,
    lon: number,
    radius: number,
    yaw: number,
    pitch: number,
    idle = true,
): {
    gc: GlobeSceneController;
    disposed: () => boolean;
    triggerTerrainClick: (e: GlobeTerrainClickEvent) => void;
    clickListenerCount: () => number;
    triggerPolygonHover: (e: GlobePolygonPointEvent | null) => void;
    triggerPolygonClick: (e: GlobePolygonPointEvent) => void;
    triggerPolygonDragStart: (e: GlobePolygonPointDragEvent) => void;
    triggerPolygonDrag: (e: GlobePolygonPointDragEvent) => void;
    triggerPolygonDragEnd: (e: GlobePolygonPointDragEvent) => void;
    polygonHoverListenerCount: () => number;
} => {
    let disposedFlag = false;
    const camera = {
        center: geodeticToEcef(lat, lon, 0),
        radius,
        yaw,
        pitch,
    };
    const clickListeners: GlobeTerrainClickListener[] = [];
    const hoverListeners: GlobePolygonPointListener[] = [];
    const pointClickListeners: GlobePolygonPointClickListener[] = [];
    const dragStartListeners: GlobePolygonPointDragListener[] = [];
    const dragListeners: GlobePolygonPointDragListener[] = [];
    const dragEndListeners: GlobePolygonPointDragListener[] = [];
    const makeSub =
        <T>(arr: T[]) =>
        (listener: T) => {
            arr.push(listener);
            return () => {
                const i = arr.indexOf(listener);
                if (i >= 0) arr.splice(i, 1);
            };
        };
    const gc = {
        camera,
        // isTerrainIdle / marker アダプタ / mapType 切替が参照する tileManager スタブ。
        tileManager: {
            isIdle: () => idle,
            terrainElevAt: () => null,
            setMapType: jest.fn(),
        },
        subscribeTerrainClick: (listener: GlobeTerrainClickListener) => {
            clickListeners.push(listener);
            return () => {
                const i = clickListeners.indexOf(listener);
                if (i >= 0) clickListeners.splice(i, 1);
            };
        },
        subscribePolygonPointHover: makeSub(hoverListeners),
        subscribePolygonPointClick: makeSub(pointClickListeners),
        subscribePolygonPointDragStart: makeSub(dragStartListeners),
        subscribePolygonPointDrag: makeSub(dragListeners),
        subscribePolygonPointDragEnd: makeSub(dragEndListeners),
        dispose: () => {
            disposedFlag = true;
        },
    } as unknown as GlobeSceneController;
    return {
        gc,
        disposed: () => disposedFlag,
        triggerTerrainClick: (e) => {
            for (const l of clickListeners.slice()) l(e);
        },
        clickListenerCount: () => clickListeners.length,
        triggerPolygonHover: (e) => {
            for (const l of hoverListeners.slice()) l(e);
        },
        triggerPolygonClick: (e) => {
            for (const l of pointClickListeners.slice()) l(e);
        },
        triggerPolygonDragStart: (e) => {
            for (const l of dragStartListeners.slice()) l(e);
        },
        triggerPolygonDrag: (e) => {
            for (const l of dragListeners.slice()) l(e);
        },
        triggerPolygonDragEnd: (e) => {
            for (const l of dragEndListeners.slice()) l(e);
        },
        polygonHoverListenerCount: () => hoverListeners.length,
    };
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

    it("setMapType は実行時切替を tileManager に委譲し getMapType に反映、onMapTypeChange を発火する (#275 P4-1)", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const setMapTypeSpy = (
            gc.tileManager as unknown as { setMapType: jest.Mock }
        ).setMapType;
        const onMapTypeChange = jest.fn();
        const c = createGlobeSceneController(gc, "std", { onMapTypeChange });
        c.setMapType("photo");
        expect(setMapTypeSpy).toHaveBeenCalledWith("photo");
        expect(c.getMapType()).toBe("photo");
        expect(onMapTypeChange).toHaveBeenCalledWith("photo");
        // 同値再 set は no-op（委譲も通知もしない）。
        c.setMapType("photo");
        expect(setMapTypeSpy).toHaveBeenCalledTimes(1);
        expect(onMapTypeChange).toHaveBeenCalledTimes(1);
    });

    it("getMarkerContext は globe 未対応のため throw する", () => {
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        expect(() => c.getMarkerContext()).toThrow(/not supported on the globe backend/);
    });

    it("subscribeTerrainClick は関数を返し、未実装の購読/設定メソッドは例外を投げない", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const { gc } = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(gc, "std");
        expect(typeof c.subscribeTerrainClick(() => {})).toBe("function");
        expect(() => c.setUiVisibility("compass", false)).not.toThrow();
        expect(() => c.setSunShadows(true)).not.toThrow();
        warn.mockRestore();
    });

    it("subscribeTerrainClick は gc のクリックを公開 TerrainClickEvent へ橋渡しし、unsubscribe で解除する", () => {
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const received: TerrainClickEvent[] = [];
        const off = c.subscribeTerrainClick((e) => {
            received.push(e);
        });
        expect(stub.clickListenerCount()).toBe(1);
        const pe = {} as PointerEvent;
        const world = { x: 1, y: 2, z: 3 };
        stub.triggerTerrainClick({
            lat: 35.5,
            lon: 139.5,
            altitude: 120,
            world,
            pointerEvent: pe,
        });
        expect(received).toHaveLength(1);
        expect(received[0].lat).toBe(35.5);
        expect(received[0].lon).toBe(139.5);
        expect(received[0].altitude).toBe(120);
        // world / pointerEvent も橋渡しされる（参照同一性も確認）。
        expect(received[0].world).toEqual({ x: 1, y: 2, z: 3 });
        expect(received[0].world).toBe(world);
        expect(received[0].pointerEvent).toBe(pe);
        // unsubscribe 後はイベントが届かない。
        off();
        expect(stub.clickListenerCount()).toBe(0);
        stub.triggerTerrainClick({
            lat: 0,
            lon: 0,
            altitude: 0,
            world: { x: 0, y: 0, z: 0 },
            pointerEvent: pe,
        });
        expect(received).toHaveLength(1);
    });

    it("subscribePolygonPointHover は gc の hover を公開 PolygonPointPointerEvent|null へ橋渡しする", () => {
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const received: (PolygonPointPointerEvent | null)[] = [];
        const off = c.subscribePolygonPointHover((e) => {
            received.push(e);
        });
        expect(stub.polygonHoverListenerCount()).toBe(1);
        const pe = {} as PointerEvent;
        stub.triggerPolygonHover({ polygonId: "p1", index: 2, pointerEvent: pe });
        stub.triggerPolygonHover(null);
        expect(received).toHaveLength(2);
        expect(received[0]).toEqual({ polygonId: "p1", index: 2, pointerEvent: pe });
        expect(received[0]?.pointerEvent).toBe(pe);
        expect(received[1]).toBeNull();
        off();
        expect(stub.polygonHoverListenerCount()).toBe(0);
        stub.triggerPolygonHover({ polygonId: "p1", index: 0, pointerEvent: pe });
        expect(received).toHaveLength(2);
    });

    it("subscribePolygonPointClick は gc のクリックを公開イベントへ橋渡しする", () => {
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const received: PolygonPointPointerEvent[] = [];
        c.subscribePolygonPointClick((e) => {
            received.push(e);
        });
        const pe = {} as PointerEvent;
        stub.triggerPolygonClick({ polygonId: "p2", index: 5, pointerEvent: pe });
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ polygonId: "p2", index: 5, pointerEvent: pe });
    });

    it("subscribePolygonPointDrag* は lat/lon/groundAltitude/planeLat/planeLon/pointerAltitude を橋渡しする", () => {
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const starts: PolygonPointDragEvent[] = [];
        const drags: PolygonPointDragEvent[] = [];
        const ends: PolygonPointDragEvent[] = [];
        c.subscribePolygonPointDragStart((e) => {
            starts.push(e);
        });
        c.subscribePolygonPointDrag((e) => {
            drags.push(e);
        });
        c.subscribePolygonPointDragEnd((e) => {
            ends.push(e);
        });
        const pe = {} as PointerEvent;
        const ev: GlobePolygonPointDragEvent = {
            polygonId: "p3",
            index: 1,
            pointerEvent: pe,
            lat: 35.1,
            lon: 139.2,
            groundAltitude: 50,
            planeLat: 35.11,
            planeLon: 139.21,
            pointerAltitude: 80,
        };
        stub.triggerPolygonDragStart(ev);
        stub.triggerPolygonDrag(ev);
        stub.triggerPolygonDragEnd(ev);
        for (const arr of [starts, drags, ends]) {
            expect(arr).toHaveLength(1);
            expect(arr[0]).toEqual({
                polygonId: "p3",
                index: 1,
                pointerEvent: pe,
                lat: 35.1,
                lon: 139.2,
                groundAltitude: 50,
                planeLat: 35.11,
                planeLon: 139.21,
                pointerAltitude: 80,
            });
        }
    });

    it("ドラッグ中は dragStart 時の公開 id を維持し、内部 globeId 失効後の drag も同一 id で橋渡しする", () => {
        // distance デモはドラッグ中に removePolygon→addPolygon で内部 globeId を
        // 毎フレーム作り直すため、ジェスチャが掴んだ内部 id は途中で失効する。
        // dragStart 時に解決した公開 id を drag/dragEnd まで使い回すことを検証する。
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const starts: PolygonPointDragEvent[] = [];
        const drags: PolygonPointDragEvent[] = [];
        const ends: PolygonPointDragEvent[] = [];
        c.subscribePolygonPointDragStart((e) => starts.push(e));
        c.subscribePolygonPointDrag((e) => drags.push(e));
        c.subscribePolygonPointDragEnd((e) => ends.push(e));
        const pe = {} as PointerEvent;
        const base = {
            index: 0,
            pointerEvent: pe,
            lat: 35.1,
            lon: 139.2,
            groundAltitude: 50,
            planeLat: 35.11,
            planeLon: 139.21,
            pointerAltitude: 80,
        };
        // dragStart は内部 id "gpA"。以降の drag/dragEnd は失効後の別 id "gpB"/"gpC"。
        stub.triggerPolygonDragStart({ ...base, polygonId: "gpA" });
        stub.triggerPolygonDrag({ ...base, polygonId: "gpB" });
        stub.triggerPolygonDrag({ ...base, polygonId: "gpC" });
        stub.triggerPolygonDragEnd({ ...base, polygonId: "gpC" });
        expect(starts[0].polygonId).toBe("gpA");
        // entries が空のため resolve はフォールバックで生 id を返すが、dragStart で
        // 固定された "gpA" が drag/dragEnd まで維持される（失効 id へすり替わらない）。
        expect(drags.map((d) => d.polygonId)).toEqual(["gpA", "gpA"]);
        expect(ends[0].polygonId).toBe("gpA");
    });

    it("dragEnd 後は activeDragPublicId をクリアし、次ジェスチャへ stale id を持ち越さない", () => {
        // 前ジェスチャの公開 id が次ジェスチャの drag に残留しないことを検証する。
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const drags: PolygonPointDragEvent[] = [];
        c.subscribePolygonPointDragStart(() => {});
        c.subscribePolygonPointDrag((e) => drags.push(e));
        c.subscribePolygonPointDragEnd(() => {});
        const pe = {} as PointerEvent;
        const base = {
            index: 0,
            pointerEvent: pe,
            lat: 35.1,
            lon: 139.2,
            groundAltitude: 50,
            planeLat: 35.11,
            planeLon: 139.21,
            pointerAltitude: 80,
        };
        // ジェスチャ1: dragStart "gpA" → drag → dragEnd。
        stub.triggerPolygonDragStart({ ...base, polygonId: "gpA" });
        stub.triggerPolygonDrag({ ...base, polygonId: "gpA" });
        stub.triggerPolygonDragEnd({ ...base, polygonId: "gpA" });
        // ジェスチャ2: dragStart せず drag のみ。entries 空のためフォールバックで
        // 生 id "gpZ" を返すべき（クリアされていれば "gpA" は残らない）。
        stub.triggerPolygonDrag({ ...base, polygonId: "gpZ" });
        expect(drags.map((d) => d.polygonId)).toEqual(["gpA", "gpZ"]);
    });

    it("dragEnd を購読しない（drag のみ）利用者でも次ジェスチャへ stale id を残さない", () => {
        // 内部 dragEnd ブリッジが drag 購読時にも張られ、activeDragPublicId が
        // クリアされることを検証する。
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const drags: PolygonPointDragEvent[] = [];
        // drag のみ購読（dragStart/dragEnd は購読しない）。
        c.subscribePolygonPointDrag((e) => drags.push(e));
        const pe = {} as PointerEvent;
        const base = {
            index: 0,
            pointerEvent: pe,
            lat: 35.1,
            lon: 139.2,
            groundAltitude: 50,
            planeLat: 35.11,
            planeLon: 139.21,
            pointerAltitude: 80,
        };
        // ジェスチャ1: drag "gpA" → 内部 dragEnd（controller は購読していないが gc は発火）。
        stub.triggerPolygonDrag({ ...base, polygonId: "gpA" });
        stub.triggerPolygonDragEnd({ ...base, polygonId: "gpA" });
        // ジェスチャ2: drag "gpZ"。クリアされていれば生 id "gpZ" になる。
        stub.triggerPolygonDrag({ ...base, polygonId: "gpZ" });
        expect(drags.map((d) => d.polygonId)).toEqual(["gpA", "gpZ"]);
    });

    it("drag 系を全解除すると activeDragPublicId がクリアされ、再購読後に stale id を残さない", () => {
        // 購読ライフサイクル境界（全解除→再購読）で前ジェスチャの id が残らないことを検証する。
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const pe = {} as PointerEvent;
        const base = {
            index: 0,
            pointerEvent: pe,
            lat: 35.1,
            lon: 139.2,
            groundAltitude: 50,
            planeLat: 35.11,
            planeLon: 139.21,
            pointerAltitude: 80,
        };
        // ジェスチャ途中（dragStart→drag）で購読解除する（dragEnd を経ずに activeDragPublicId が残る状況）。
        const drags1: PolygonPointDragEvent[] = [];
        const unsubStart = c.subscribePolygonPointDragStart(() => {});
        const unsubDrag = c.subscribePolygonPointDrag((e) => drags1.push(e));
        stub.triggerPolygonDragStart({ ...base, polygonId: "gpA" });
        stub.triggerPolygonDrag({ ...base, polygonId: "gpA" });
        unsubStart();
        unsubDrag();
        // 再購読し、dragStart を経由しない drag が来ても stale "gpA" を橋渡ししない。
        const drags2: PolygonPointDragEvent[] = [];
        c.subscribePolygonPointDrag((e) => drags2.push(e));
        stub.triggerPolygonDrag({ ...base, polygonId: "gpZ" });
        expect(drags2.map((d) => d.polygonId)).toEqual(["gpZ"]);
    });

    it("subscribePolygonPointDrag は null 許容フィールドをそのまま橋渡しする", () => {
        const stub = makeStub(35, 139, 1000, 0, 0);
        const c = createGlobeSceneController(stub.gc, "std");
        const drags: PolygonPointDragEvent[] = [];
        c.subscribePolygonPointDrag((e) => {
            drags.push(e);
        });
        stub.triggerPolygonDrag({
            polygonId: "p4",
            index: 0,
            pointerEvent: {} as PointerEvent,
            lat: null,
            lon: null,
            groundAltitude: null,
            planeLat: null,
            planeLon: null,
            pointerAltitude: null,
        });
        expect(drags).toHaveLength(1);
        expect(drags[0].lat).toBeNull();
        expect(drags[0].pointerAltitude).toBeNull();
    });

    it("isTerrainIdle は tileManager.isIdle へ委譲する（true/false）", () => {
        const idle = makeStub(35, 139, 1000, 0, 0, true);
        expect(createGlobeSceneController(idle.gc, "std").isTerrainIdle()).toBe(true);
        const busy = makeStub(35, 139, 1000, 0, 0, false);
        expect(createGlobeSceneController(busy.gc, "std").isTerrainIdle()).toBe(false);
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

const makeGlobePolygonStub = (): {
    mgr: GlobePolygonManager;
    added: { id: string; opts: GlobePolygonOptions }[];
    removed: string[];
    enabledCalls: { id: string; enabled: boolean }[];
    disposed: () => boolean;
} => {
    let seq = 0;
    let disposedFlag = false;
    const added: { id: string; opts: GlobePolygonOptions }[] = [];
    const removed: string[] = [];
    const enabledCalls: { id: string; enabled: boolean }[] = [];
    const mgr = {
        add: (opts: GlobePolygonOptions): string => {
            const id = `gp${seq++}`;
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
    } as unknown as GlobePolygonManager;
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

    it("lat/lon を変更する update 直後は elevationResolved=false（planar parity）", () => {
        const stub = makeGlobeMarkerStub();
        // terrainElevAt は常に解決(非 null)を返すが、座標変更直後は false を返すべき。
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 50);
        m.add("p1", { lat: VALID_LAT, lon: VALID_LON, text: { value: "a" } });
        const moved = m.update("p1", { lat: 34, lon: 135 });
        expect(moved.elevationResolved).toBe(false);
        // 座標を変えない update は通常の best-effort 判定（terrainElevAt!==null）に従う。
        const sameCoord = m.update("p1", { text: { value: "c" } });
        expect(sameCoord.elevationResolved).toBe(true);
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

    it("dispose は内部マネージャを破棄せず、追加分のみ remove して以後の add は throw する", () => {
        const stub = makeGlobeMarkerStub();
        const m = createGlobeMarkerManagerAdapter(stub.mgr, () => 0);
        m.add("p1", { ...BASE });
        const addedId = stub.added[0].id;
        m.dispose();
        // 内部 GlobeMarkerManager はシーンが所有・毎フレーム参照するため破棄しない。
        expect(stub.disposed()).toBe(false);
        // アダプタが追加したマーカーのみ remove する。
        expect(stub.removed).toContain(addedId);
        expect(() => m.add("p2", { ...BASE })).toThrow(/disposed/);
    });
});

        describe("createGlobePolygonManagerAdapter (P4-0 Slice 2b-1 polygon overlay)", () => {
            const PTS = [
                { lat: 35.36, lon: 138.72, altitude: 100 },
                { lat: 35.37, lon: 138.73, altitude: 120 },
            ];

            it("add/get/list は globe マネージャへ委譲し、既定補完済みハンドルを返す", () => {
                const stub = makeGlobePolygonStub();
                const m = createGlobePolygonManagerAdapter(stub.mgr, () => 10);
                const h = m.add("poly", {
                    points: PTS,
                    labels: ["A", "B"],
                    edgeLabels: ["AB"],
                    style: { pointColor: "#00ff00" },
                });
                expect(h.id).toBe("poly");
                expect(h.points).toHaveLength(2);
                expect(h.closed).toBe(false);
                expect(h.altitudeMode).toBe("terrain");
                expect(h.labels).toEqual(["A", "B"]);
                expect(h.edgeLabels).toEqual(["AB"]);
                expect(h.style.pointColor).toBe("#00ff00");
                expect(h.style.lineColor).toBe("#ff0000");
                expect(h.elevationResolved).toBe(true);
                expect(m.get("poly")?.id).toBe("poly");
                expect(m.list()).toEqual(["poly"]);
                expect(stub.added[0].opts.points).toHaveLength(2);
            });

            it("terrain 未解決なら elevationResolved=false、absolute は altitude 必須かつ常に true", () => {
                const terrainStub = makeGlobePolygonStub();
                const terrain = createGlobePolygonManagerAdapter(terrainStub.mgr, () => null);
                expect(terrain.add("t", { points: PTS }).elevationResolved).toBe(false);
                const absStub = makeGlobePolygonStub();
                const abs = createGlobePolygonManagerAdapter(absStub.mgr, () => null);
                expect(
                    abs.add("a", { points: PTS, altitudeMode: "absolute" }).elevationResolved,
                ).toBe(true);
                expect(() =>
                    abs.add("bad", {
                        points: [{ lat: 35.36, lon: 138.72 }],
                        altitudeMode: "absolute",
                    }),
                ).toThrow(/requires altitude/);
            });

            it("update と表示フラグ変更は add-then-remove で内部ノードを作り直す", () => {
                const stub = makeGlobePolygonStub();
                const m = createGlobePolygonManagerAdapter(stub.mgr, () => 1);
                m.add("poly", { points: PTS });
                const h = m.update("poly", { closed: true, labelsEnabled: false });
                expect(h.closed).toBe(true);
                expect(h.labelsEnabled).toBe(false);
                expect(stub.removed).toEqual(["gp0"]);
                m.setWallsEnabled("poly", false);
                expect(stub.removed).toEqual(["gp0", "gp1"]);
                expect(m.get("poly")?.wallsEnabled).toBe(false);
            });

            it("setEnabled は委譲し、点編集 API はハンドルを再構築する", () => {
                const stub = makeGlobePolygonStub();
                const m = createGlobePolygonManagerAdapter(stub.mgr, () => 1);
                m.add("poly", { points: PTS });
                m.setEnabled("poly", false);
                expect(stub.enabledCalls).toEqual([{ id: "gp0", enabled: false }]);
                expect(m.get("poly")?.enabled).toBe(false);
                expect(m.insertPoint("poly", 1, { lat: 35.365, lon: 138.725 }).points).toHaveLength(3);
                expect(m.updatePoint("poly", 1, { label: "mid" }).labels?.[1]).toBe("mid");
                expect(m.removePoint("poly", 1).points).toHaveLength(2);
                expect(m.replacePoints("poly", [{ lat: 35.36, lon: 138.72 }]).points).toHaveLength(1);
                expect(m.get("poly")?.labels).toBeUndefined();
            });

            it("rebuild 中の add 例外時は旧 globeId・旧状態を保持する（トランザクション）", () => {
                const stub = makeGlobePolygonStub();
                let failNext = false;
                const baseAdd = stub.mgr.add.bind(stub.mgr);
                (stub.mgr as { add: GlobePolygonManager["add"] }).add = (opts) => {
                    if (failNext) throw new Error("globe add failed");
                    return baseAdd(opts);
                };
                const m = createGlobePolygonManagerAdapter(stub.mgr, () => 1);
                m.add("poly", { points: PTS, wallsEnabled: true });
                failNext = true;
                expect(() => m.setWallsEnabled("poly", false)).toThrow(/globe add failed/);
                // 旧ノードは remove されず、状態も巻き戻る（wallsEnabled=true のまま）。
                expect(stub.removed).toEqual([]);
                expect(m.get("poly")?.wallsEnabled).toBe(true);
            });

            it("remove/list/dispose とエラー条件", () => {
                const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
                const stub = makeGlobePolygonStub();
                const m = createGlobePolygonManagerAdapter(stub.mgr, () => 1);
                expect(() => m.add("bad", { points: [] })).toThrow(/at least 1/);
                m.add("poly", { points: PTS });
                expect(() => m.add("poly", { points: PTS })).toThrow(/already exists/);
                m.remove("poly");
                expect(m.list()).toEqual([]);
                m.remove("missing");
                expect(warn).toHaveBeenCalled();
                // dispose 時に残っているポリゴンのみ remove し、内部マネージャは破棄しない。
                m.add("poly2", { points: PTS });
                const aliveId = stub.added[stub.added.length - 1].id;
                m.dispose();
                expect(stub.disposed()).toBe(false);
                expect(stub.removed).toContain(aliveId);
                expect(() => m.add("x", { points: PTS })).toThrow(/disposed/);
                warn.mockRestore();
            });

            it("resolvePublicPolygonId は内部 globeId を公開 id へ逆引きする", () => {
                const stub = makeGlobePolygonStub();
                const m = createGlobePolygonManagerAdapter(stub.mgr, () => 1);
                m.add("poly", { points: PTS });
                const globeId = stub.added[stub.added.length - 1].id;
                expect(m.resolvePublicPolygonId(globeId)).toBe("poly");
                expect(m.resolvePublicPolygonId("unknown")).toBeNull();
                // remove 後は逆引きできない。
                m.remove("poly");
                expect(m.resolvePublicPolygonId(globeId)).toBeNull();
            });
        });

const makeGlobeCircleStub = (): {
    mgr: GlobeCircleManager;
    added: { id: string; opts: GlobeCircleOptions }[];
    removed: string[];
    enabledCalls: { id: string; enabled: boolean }[];
    disposed: () => boolean;
} => {
    let seq = 0;
    let disposedFlag = false;
    const added: { id: string; opts: GlobeCircleOptions }[] = [];
    const removed: string[] = [];
    const enabledCalls: { id: string; enabled: boolean }[] = [];
    const mgr = {
        add: (opts: GlobeCircleOptions): string => {
            const id = `gc${seq++}`;
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
    } as unknown as GlobeCircleManager;
    return { mgr, added, removed, enabledCalls, disposed: () => disposedFlag };
};

describe("createGlobeCircleManagerAdapter (P4-0 Slice 2b-2 circle overlay)", () => {
    const CENTER = { lat: 35.36, lon: 138.72 };

    it("add/get/list は globe マネージャへ委譲し、既定補完済みハンドルを返す", () => {
        const stub = makeGlobeCircleStub();
        const m = createGlobeCircleManagerAdapter(stub.mgr, () => 10);
        const h = m.add("c1", {
            center: CENTER,
            radius: 5000,
            style: { pointColor: "#00ff00" },
        });
        expect(h.id).toBe("c1");
        expect(h.radius).toBe(5000);
        expect(h.segments).toBe(64);
        expect(h.altitudeMode).toBe("terrain");
        expect(h.pointEnabled).toBe(true);
        expect(h.lineEnabled).toBe(true);
        expect(h.wallEnabled).toBe(true);
        expect(h.labelEnabled).toBe(true);
        expect(h.style.pointColor).toBe("#00ff00");
        expect(h.style.lineColor).toBe("#ff0000");
        // label undefined は自動生成（lat/lon/alt/radius の 4 行）。
        expect(h.label).toContain("radius: 5000.0 m");
        expect(h.elevationResolved).toBe(true);
        expect(m.get("c1")?.id).toBe("c1");
        expect(m.list()).toEqual(["c1"]);
        expect(stub.added[0].opts.radiusMeters).toBe(5000);
    });

    it("label=null は非表示、string はカスタム文字列を保持する", () => {
        const stub = makeGlobeCircleStub();
        const m = createGlobeCircleManagerAdapter(stub.mgr, () => 1);
        expect(m.add("a", { center: CENTER, radius: 100, label: null }).label).toBeNull();
        expect(
            m.add("b", { center: CENTER, radius: 100, label: "custom" }).label,
        ).toBe("custom");
    });

    it("terrain 未解決なら elevationResolved=false、absolute は altitude 必須かつ常に true", () => {
        const terrainStub = makeGlobeCircleStub();
        const terrain = createGlobeCircleManagerAdapter(terrainStub.mgr, () => null);
        expect(terrain.add("t", { center: CENTER, radius: 100 }).elevationResolved).toBe(
            false,
        );
        const absStub = makeGlobeCircleStub();
        const abs = createGlobeCircleManagerAdapter(absStub.mgr, () => null);
        expect(
            abs.add("a", {
                center: { ...CENTER, altitude: 50 },
                radius: 100,
                altitudeMode: "absolute",
            }).elevationResolved,
        ).toBe(true);
        expect(() =>
            abs.add("bad", { center: CENTER, radius: 100, altitudeMode: "absolute" }),
        ).toThrow(/requires center.altitude/);
    });

    it("radius/segments の検証で throw する", () => {
        const stub = makeGlobeCircleStub();
        const m = createGlobeCircleManagerAdapter(stub.mgr, () => 1);
        expect(() => m.add("x", { center: CENTER, radius: 0 })).toThrow(/radius/);
        expect(() => m.add("y", { center: CENTER, radius: 100, segments: 2 })).toThrow(
            /segments/,
        );
    });

    it("update と各トグルは add-then-remove で内部ノードを作り直す", () => {
        const stub = makeGlobeCircleStub();
        const m = createGlobeCircleManagerAdapter(stub.mgr, () => 1);
        m.add("c", { center: CENTER, radius: 100 });
        const h = m.update("c", { radius: 200, labelEnabled: false });
        expect(h.radius).toBe(200);
        expect(h.labelEnabled).toBe(false);
        expect(stub.removed).toEqual(["gc0"]);
        m.setWallEnabled("c", false);
        expect(stub.removed).toEqual(["gc0", "gc1"]);
        expect(m.get("c")?.wallEnabled).toBe(false);
        m.setPointEnabled("c", false);
        m.setLineEnabled("c", false);
        m.setLabelEnabled("c", true);
        expect(m.get("c")?.pointEnabled).toBe(false);
        expect(m.get("c")?.lineEnabled).toBe(false);
        expect(m.get("c")?.labelEnabled).toBe(true);
    });

    it("自動ラベルは center/radius 変更に追従して再生成する", () => {
        const stub = makeGlobeCircleStub();
        const m = createGlobeCircleManagerAdapter(stub.mgr, () => 1);
        m.add("c", { center: CENTER, radius: 100 });
        const h = m.update("c", { radius: 300 });
        expect(h.label).toContain("radius: 300.0 m");
    });

    it("setEnabled は委譲し、remove/dispose は内部マネージャを破棄しない", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const stub = makeGlobeCircleStub();
        const m = createGlobeCircleManagerAdapter(stub.mgr, () => 1);
        m.add("c", { center: CENTER, radius: 100 });
        m.setEnabled("c", false);
        expect(stub.enabledCalls).toEqual([{ id: "gc0", enabled: false }]);
        expect(m.get("c")?.enabled).toBe(false);
        expect(() => m.add("c", { center: CENTER, radius: 100 })).toThrow(/already exists/);
        m.remove("c");
        expect(m.list()).toEqual([]);
        m.remove("missing");
        expect(warn).toHaveBeenCalled();
        m.add("c2", { center: CENTER, radius: 100 });
        const aliveId = stub.added[stub.added.length - 1].id;
        m.dispose();
        expect(stub.disposed()).toBe(false);
        expect(stub.removed).toContain(aliveId);
        expect(() => m.add("x", { center: CENTER, radius: 100 })).toThrow(/disposed/);
        warn.mockRestore();
    });
});
/** GlobeModelManager の軽量スタブ。in-place 更新・get・animation を備える。 */
const makeGlobeModelStub = (): {
    mgr: GlobeModelManager;
    added: { id: string; opts: GlobeModelOptions }[];
    removed: string[];
    importCount: () => number;
    disposed: () => boolean;
    playCalls: { id: string; name?: string }[];
    stopCalls: { id: string; name?: string }[];
    setLoaded: (id: string, loaded: boolean) => void;
} => {
    let seq = 0;
    let disposedFlag = false;
    let imports = 0;
    const added: { id: string; opts: GlobeModelOptions }[] = [];
    const removed: string[] = [];
    const playCalls: { id: string; name?: string }[] = [];
    const stopCalls: { id: string; name?: string }[] = [];
    const states = new Map<string, GlobeModelState>();
    const mgr = {
        add: (opts: GlobeModelOptions): string => {
            const id = `gm${seq++}`;
            imports++;
            added.push({ id, opts });
            states.set(id, {
                url: opts.url,
                lat: opts.lat,
                lon: opts.lon,
                altitude: opts.altitude ?? 0,
                altitudeMode: opts.altitudeMode ?? "terrain",
                rotation: {
                    x: opts.rotation?.x ?? 0,
                    y: opts.rotation?.y ?? 0,
                    z: opts.rotation?.z ?? 0,
                },
                scaling: {
                    x: opts.scaling?.x ?? 1,
                    y: opts.scaling?.y ?? 1,
                    z: opts.scaling?.z ?? 1,
                },
                enabled: opts.enabled ?? true,
                gravity: opts.gravity ?? true,
                loaded: true,
                elevationResolved: (opts.altitudeMode ?? "terrain") === "absolute",
                animationNames: ["walk"],
            });
            return id;
        },
        get: (id: string): GlobeModelState | null => states.get(id) ?? null,
        update: (id: string, partial: GlobeModelUpdate): void => {
            const s = states.get(id);
            if (!s) return;
            if (partial.lat !== undefined) s.lat = partial.lat;
            if (partial.lon !== undefined) s.lon = partial.lon;
            if (partial.altitude !== undefined) s.altitude = partial.altitude;
            if (partial.altitudeMode !== undefined) s.altitudeMode = partial.altitudeMode;
            if (partial.scaling !== undefined) {
                s.scaling = {
                    x: partial.scaling.x ?? s.scaling.x,
                    y: partial.scaling.y ?? s.scaling.y,
                    z: partial.scaling.z ?? s.scaling.z,
                };
            }
            if (partial.enabled !== undefined) s.enabled = partial.enabled;
        },
        remove: (id: string): void => {
            removed.push(id);
            states.delete(id);
        },
        setEnabled: (id: string, enabled: boolean): void => {
            const s = states.get(id);
            if (s) s.enabled = enabled;
        },
        list: (): readonly string[] => Array.from(states.keys()),
        playAnimation: (id: string, name?: string): void => {
            playCalls.push({ id, name });
        },
        stopAnimation: (id: string, name?: string): void => {
            stopCalls.push({ id, name });
        },
        tick: (): void => {},
        dispose: (): void => {
            disposedFlag = true;
        },
    } as unknown as GlobeModelManager;
    return {
        mgr,
        added,
        removed,
        importCount: () => imports,
        disposed: () => disposedFlag,
        playCalls,
        stopCalls,
        setLoaded: (id: string, loaded: boolean): void => {
            const s = states.get(id);
            if (s) s.loaded = loaded;
        },
    };
};

describe("createGlobeModelManagerAdapter (P4-2 model overlay)", () => {
    const POS = { lat: 35.681236, lon: 139.767125 };

    it("add/get/list は globe マネージャへ委譲し、既定補完済みハンドルを返す", () => {
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 100);
        const h = m.add("human", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        expect(h.id).toBe("human");
        expect(h.altitudeMode).toBe("terrain");
        expect(h.gravity).toBe(true);
        expect(h.scaling).toEqual({ x: 1, y: 1, z: 1 });
        expect(h.rotation).toEqual({ x: 0, y: 0, z: 0 });
        expect(h.elevationResolved).toBe(true);
        expect(h.animationNames).toEqual(["walk"]);
        expect(m.get("human")?.id).toBe("human");
        expect(m.list()).toEqual(["human"]);
    });

    it("重複 id は throw、lat/lon 範囲外は throw", () => {
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 1);
        m.add("a", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        expect(() => m.add("a", { url: "a.glb", lat: POS.lat, lon: POS.lon })).toThrow(
            /already exists/,
        );
        expect(() => m.add("b", { url: "a.glb", lat: 999, lon: POS.lon })).toThrow();
    });

    it("url 未指定/空文字は throw（planar 契約と整合）", () => {
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 1);
        expect(() => m.add("a", { url: "", lat: POS.lat, lon: POS.lon })).toThrow(
            /url is required/,
        );
    });

    it("absolute は altitude 必須、terrain 未解決なら elevationResolved=false", () => {
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => null);
        expect(() =>
            m.add("a", { url: "a.glb", lat: POS.lat, lon: POS.lon, altitudeMode: "absolute" }),
        ).toThrow(/requires altitude/);
        const h = m.add("t", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        expect(h.elevationResolved).toBe(false);
    });

    it("update は in-place（import 再実行なし）で反映し、ハンドルを返す", () => {
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 100);
        m.add("a", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        const before = stub.importCount();
        const h = m.update("a", {
            lat: 36,
            altitude: 5,
            scaling: { x: 2, y: 2, z: 2 },
        });
        expect(h.lat).toBe(36);
        expect(h.altitude).toBe(5);
        expect(h.scaling.x).toBe(2);
        expect(stub.importCount()).toBe(before); // 再ロードなし
    });

    it("absolute へ切替える update は altitude 明示が必要", () => {
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 100);
        m.add("a", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        expect(() => m.update("a", { altitudeMode: "absolute" })).toThrow(
            /requires explicit altitude/,
        );
        expect(() =>
            m.update("a", { altitudeMode: "absolute", altitude: 50 }),
        ).not.toThrow();
    });

    it("setEnabled は委譲し、remove/dispose は内部マネージャを破棄しない", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 1);
        m.add("a", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        m.setEnabled("a", false);
        expect(m.get("a")?.enabled).toBe(false);
        m.remove("a");
        expect(m.list()).toEqual([]);
        m.remove("missing");
        expect(warn).toHaveBeenCalled();
        m.add("b", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        m.dispose();
        expect(stub.disposed()).toBe(false);
        expect(() => m.add("c", { url: "a.glb", lat: POS.lat, lon: POS.lon })).toThrow(
            /disposed/,
        );
        warn.mockRestore();
    });

    it("playAnimation は公開 id・[jpmap-terrain] prefix で warn し、条件を満たすときのみ委譲する", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 1);
        m.add("human", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        const gid = stub.added[0].id;

        // 未ロード時は warn して委譲しない（公開 id を含む）。
        stub.setLoaded(gid, false);
        m.playAnimation("human", "walk");
        expect(warn).toHaveBeenCalledWith(
            '[jpmap-terrain] playModelAnimation: model "human" is not loaded yet',
        );
        expect(stub.playCalls).toHaveLength(0);

        // 名前不一致は warn して委譲しない。
        stub.setLoaded(gid, true);
        m.playAnimation("human", "missing");
        expect(warn).toHaveBeenCalledWith(
            '[jpmap-terrain] playModelAnimation: animation "missing" not found in model "human"',
        );
        expect(stub.playCalls).toHaveLength(0);

        // 条件を満たせば内部 gid で委譲する。
        m.playAnimation("human", "walk");
        expect(stub.playCalls).toEqual([{ id: gid, name: "walk" }]);
        warn.mockRestore();
    });

    it("stopAnimation は未ロード/名前不一致では委譲せず warn もしない", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const stub = makeGlobeModelStub();
        const m = createGlobeModelManagerAdapter(stub.mgr, () => 1);
        m.add("human", { url: "a.glb", lat: POS.lat, lon: POS.lon });
        const gid = stub.added[0].id;

        stub.setLoaded(gid, false);
        m.stopAnimation("human");
        expect(stub.stopCalls).toHaveLength(0);

        stub.setLoaded(gid, true);
        m.stopAnimation("human", "missing");
        expect(stub.stopCalls).toHaveLength(0);

        m.stopAnimation("human", "walk");
        expect(stub.stopCalls).toEqual([{ id: gid, name: "walk" }]);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
