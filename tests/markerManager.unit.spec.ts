/**
 * MarkerManager の振る舞い (Issue #167)。
 *
 * Babylon の Mesh / Texture 実体を生成しないよう `../src/terrain/marker` を
 * モック化し、CRUD / enable/disable / 境界判定 / 標高保留→解決 / dispose
 * を検証する。
 */
import { jest } from "@jest/globals";

// `marker` モジュールを軽量スタブに差し替える。実装本体（Babylon）には依存させない。
jest.unstable_mockModule("../src/terrain/marker", () => {
    interface StubNode {
        readonly id: string;
        lat: number;
        lon: number;
        enabled: boolean;
        elevationResolved: boolean;
        disposeCount: number;
        applyTransformCount: number;
        setEnabledLogical: (v: boolean) => void;
        setElevationResolved: (v: boolean) => void;
        applyTransform: (wx: number, elev: number, wz: number) => void;
        update: (
            partial: { enabled?: boolean },
            newLat: number,
            newLon: number,
        ) => void;
        dispose: () => void;
        getHandle: () => Record<string, unknown>;
    }
    const created: StubNode[] = [];
    const createMarkerNode = (
        _scene: unknown,
        id: string,
        options: { lat: number; lon: number; enabled?: boolean },
    ): StubNode => {
        const node: StubNode = {
            id,
            lat: options.lat,
            lon: options.lon,
            enabled: options.enabled ?? true,
            elevationResolved: false,
            disposeCount: 0,
            applyTransformCount: 0,
            setEnabledLogical: (v: boolean) => {
                node.enabled = v;
            },
            setElevationResolved: (v: boolean) => {
                node.elevationResolved = v;
            },
            applyTransform: () => {
                node.applyTransformCount++;
            },
            update: (partial, newLat, newLon) => {
                node.lat = newLat;
                node.lon = newLon;
                if (partial.enabled !== undefined) {
                    node.enabled = partial.enabled;
                }
            },
            dispose: () => {
                node.disposeCount++;
            },
            getHandle: () => ({
                id,
                lat: node.lat,
                lon: node.lon,
                enabled: node.enabled,
                elevationResolved: node.elevationResolved,
            }),
        };
        created.push(node);
        return node;
    };
    return {
        createMarkerNode,
        __getCreated: (): StubNode[] => created,
        __resetCreated: (): void => {
            created.length = 0;
        },
    };
});

const { createMarkerManager } = await import("../src/terrain/markerManager");
const markerStub = await import("../src/terrain/marker");
interface StubMarker {
    enabled: boolean;
    elevationResolved: boolean;
    disposeCount: number;
}
const __getCreated = (
    markerStub as unknown as { __getCreated: () => StubMarker[] }
).__getCreated;
const __resetCreated = (
    markerStub as unknown as { __resetCreated: () => void }
).__resetCreated;

interface FakeObserver {
    callback: () => void;
}

const buildCtx = (
    elevation: number | null = 0,
): {
    ctx: Parameters<typeof createMarkerManager>[0];
    tick: () => void;
    setElevation: (v: number | null) => void;
    unsubscribeCount: () => number;
} => {
    const observers: FakeObserver[] = [];
    const sceneLike = {
        onBeforeRenderObservable: {
            add: (cb: () => void): FakeObserver => {
                const o: FakeObserver = { callback: cb };
                observers.push(o);
                return o;
            },
            remove: (target: FakeObserver): boolean => {
                const i = observers.indexOf(target);
                if (i === -1) return false;
                observers.splice(i, 1);
                return true;
            },
        },
    };
    let elev: number | null = elevation;
    let unsubscribeCalls = 0;
    const ctx = {
        scene: sceneLike as unknown as Parameters<
            typeof createMarkerManager
        >[0]["scene"],
        tileManager: {
            queryElevationAtWorld: (): number | null => elev,
            subscribeTerrainUpdated: (): (() => void) => {
                return () => {
                    unsubscribeCalls++;
                };
            },
        },
        getOrigin: () => ({
            lat: 35.681,
            lon: 139.767,
            gridResidualX: 0,
            gridResidualZ: 0,
        }),
    };
    return {
        ctx,
        tick: () => {
            for (const o of observers.slice()) o.callback();
        },
        setElevation: (v) => {
            elev = v;
        },
        unsubscribeCount: () => unsubscribeCalls,
    };
};

const validOpts = {
    lat: 35.681236,
    lon: 139.767125,
    text: { value: "テスト" },
};

beforeEach(() => {
    __resetCreated();
});

describe("MarkerManager CRUD", () => {
    test("add → get / list で同 id を取得できる", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        const handle = mgr.add("a", validOpts);
        expect(handle.id).toBe("a");
        expect(mgr.get("a")?.id).toBe("a");
        expect(mgr.list()).toEqual(["a"]);
    });

    test("重複 id の add は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        mgr.add("a", validOpts);
        expect(() => mgr.add("a", validOpts)).toThrow(/already exists/);
    });

    test("未存在 id の update は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        expect(() => mgr.update("missing", { enabled: false })).toThrow(
            /not found/,
        );
    });

    test("未存在 id の remove は warn + no-op", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {
            /* silence */
        });
        mgr.remove("missing");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test("remove で list / get から消える", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        mgr.add("a", validOpts);
        mgr.remove("a");
        expect(mgr.get("a")).toBeNull();
        expect(mgr.list()).toEqual([]);
    });

    test("生成順が list の順序に反映される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        mgr.add("c", validOpts);
        mgr.add("a", validOpts);
        mgr.add("b", validOpts);
        expect(mgr.list()).toEqual(["c", "a", "b"]);
    });
});

describe("MarkerManager 境界 / バリデーション", () => {
    test("JAPAN_BOUNDS 外 (lat=0,lon=0) は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        expect(() =>
            mgr.add("a", { lat: 0, lon: 0, text: { value: "x" } }),
        ).toThrow(/JAPAN_BOUNDS/);
    });

    test("update で lat/lon が範囲外なら throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        mgr.add("a", validOpts);
        expect(() => mgr.update("a", { lat: 0, lon: 0 })).toThrow(
            /JAPAN_BOUNDS/,
        );
    });
});

describe("MarkerManager enable / disable", () => {
    test("setEnabled で node.enabled が反映される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        mgr.add("a", validOpts);
        mgr.setEnabled("a", false);
        const node = __getCreated()[0];
        expect(node.enabled).toBe(false);
        mgr.setEnabled("a", true);
        expect(node.enabled).toBe(true);
    });
});

describe("MarkerManager 標高解決", () => {
    test("add 時に elevation が null なら elevationResolved=false", () => {
        const { ctx } = buildCtx(null);
        const mgr = createMarkerManager(ctx);
        mgr.add("a", validOpts);
        const node = __getCreated()[0];
        expect(node.elevationResolved).toBe(false);
    });

    test("tickFrame 後に elevation が解決すれば elevationResolved=true", () => {
        const ctxWrap = buildCtx(null);
        const mgr = createMarkerManager(ctxWrap.ctx);
        mgr.add("a", validOpts);
        const node = __getCreated()[0];
        expect(node.elevationResolved).toBe(false);
        ctxWrap.setElevation(123);
        ctxWrap.tick();
        expect(node.elevationResolved).toBe(true);
    });

    test("update で lat/lon 変更時に elevationResolved が false に戻る", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createMarkerManager(ctxWrap.ctx);
        mgr.add("a", validOpts);
        const node = __getCreated()[0];
        node.elevationResolved = true;
        mgr.update("a", { lat: 35.7, lon: 139.7 });
        expect(node.elevationResolved).toBe(false);
    });
});

describe("MarkerManager dispose", () => {
    test("dispose で全 node の dispose が呼ばれ、terrain subscription が解除される", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createMarkerManager(ctxWrap.ctx);
        mgr.add("a", validOpts);
        mgr.add("b", validOpts);
        const nodes = __getCreated();
        mgr.dispose();
        for (const n of nodes) {
            expect(n.disposeCount).toBeGreaterThan(0);
        }
        expect(ctxWrap.unsubscribeCount()).toBeGreaterThan(0);
    });

    test("dispose 後の add / update / setEnabled は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createMarkerManager(ctx);
        mgr.dispose();
        expect(() => mgr.add("a", validOpts)).toThrow(/disposed/);
        expect(() => mgr.update("a", { enabled: false })).toThrow(/disposed/);
        expect(() => mgr.setEnabled("a", false)).toThrow(/disposed/);
    });
});
