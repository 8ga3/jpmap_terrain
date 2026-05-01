/**
 * CircleManager の単体テスト (Issue #201 / #203)。
 *
 * `circle` モジュール（Babylon 依存）を軽量スタブに差し替え、
 * CRUD / 境界 / altitudeMode / 標高解決 / dispose の挙動を検証する。
 */

import { jest } from "@jest/globals";
import type { CircleOptions } from "../src/lib/types";

interface StubNode {
    id: string;
    altitudeMode: "terrain" | "absolute";
    center: { lat: number; lon: number; altitude?: number };
    radius: number;
    segments: number;
    enabled: boolean;
    pointEnabled: boolean;
    lineEnabled: boolean;
    wallEnabled: boolean;
    labelEnabled: boolean;
    elevationResolved: boolean;
    applyTransformCalls: number;
    lastCenter: { x: number; y: number; z: number } | null;
    lastRing: Array<{ x: number; y: number; z: number }>;
    disposed: boolean;
    setEnabledHistory: boolean[];
    setPointEnabledHistory: boolean[];
    setLineEnabledHistory: boolean[];
    setWallEnabledHistory: boolean[];
    setLabelEnabledHistory: boolean[];
    setElevationResolvedHistory: boolean[];
}

const created: StubNode[] = [];

jest.unstable_mockModule("../src/terrain/circle", () => ({
    createCircleNode: (
        _scene: unknown,
        id: string,
        options: CircleOptions,
    ): StubNode => {
        const altitudeMode = options.altitudeMode ?? "terrain";
        const node: StubNode = {
            id,
            altitudeMode,
            center: { ...options.center },
            radius: options.radius,
            segments: options.segments ?? 64,
            enabled: options.enabled ?? true,
            pointEnabled: options.pointEnabled ?? true,
            lineEnabled: options.lineEnabled ?? true,
            wallEnabled: options.wallEnabled ?? true,
            labelEnabled: options.labelEnabled ?? true,
            elevationResolved: altitudeMode === "absolute",
            applyTransformCalls: 0,
            lastCenter: null,
            lastRing: [],
            disposed: false,
            setEnabledHistory: [],
            setPointEnabledHistory: [],
            setLineEnabledHistory: [],
            setWallEnabledHistory: [],
            setLabelEnabledHistory: [],
            setElevationResolvedHistory: [],
        };
        const wrapped = {
            ...node,
            applyTransform: (
                centerWorld: { x: number; y: number; z: number },
                ringWorld: ReadonlyArray<{ x: number; y: number; z: number }>,
            ) => {
                node.applyTransformCalls++;
                node.lastCenter = {
                    x: centerWorld.x,
                    y: centerWorld.y,
                    z: centerWorld.z,
                };
                node.lastRing = ringWorld.map((p) => ({
                    x: p.x,
                    y: p.y,
                    z: p.z,
                }));
            },
            setEnabledLogical: (v: boolean) => {
                node.enabled = v;
                node.setEnabledHistory.push(v);
            },
            setPointEnabledLogical: (v: boolean) => {
                node.pointEnabled = v;
                node.setPointEnabledHistory.push(v);
            },
            setLineEnabledLogical: (v: boolean) => {
                node.lineEnabled = v;
                node.setLineEnabledHistory.push(v);
            },
            setWallEnabledLogical: (v: boolean) => {
                node.wallEnabled = v;
                node.setWallEnabledHistory.push(v);
            },
            setLabelEnabledLogical: (v: boolean) => {
                node.labelEnabled = v;
                node.setLabelEnabledHistory.push(v);
            },
            setElevationResolved: (v: boolean) => {
                node.elevationResolved = v;
                node.setElevationResolvedHistory.push(v);
            },
            getHandle: () => ({
                id,
                center: { ...node.center },
                radius: node.radius,
                segments: node.segments,
                altitudeMode: node.altitudeMode,
                label: null,
                style: {} as unknown as Record<string, unknown>,
                enabled: node.enabled,
                pointEnabled: node.pointEnabled,
                lineEnabled: node.lineEnabled,
                wallEnabled: node.wallEnabled,
                labelEnabled: node.labelEnabled,
                elevationResolved: node.elevationResolved,
            }),
            dispose: () => {
                node.disposed = true;
            },
        };
        created.push(node);
        return wrapped as unknown as StubNode;
    },
}));

const { createCircleManager } = await import(
    "../src/terrain/circleManager"
);

interface FakeObserver {
    callback: () => void;
}

const buildCtx = (
    elevation: number | null = 0,
): {
    ctx: Parameters<typeof createCircleManager>[0];
    tick: () => void;
    setElevation: (v: number | null) => void;
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
    const ctx: Parameters<typeof createCircleManager>[0] = {
        scene: sceneLike as unknown as Parameters<
            typeof createCircleManager
        >[0]["scene"],
        tileManager: {
            queryElevationAtWorld: (): number | null => elev,
            subscribeTerrainUpdated: (): (() => void) => {
                return () => {
                    /* noop */
                };
            },
        },
        getOrigin: () => ({
            lat: 35.681,
            lon: 139.767,
            gridResidualX: 0,
            gridResidualZ: 0,
        }),
        getCameraPosition: () => ({
            x: 0,
            y: 1000,
            z: 0,
            radius: 1000,
            beta: Math.PI / 4,
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
    };
};

const validCenter = { lat: 35.681, lon: 139.767 };

beforeEach(() => {
    created.length = 0;
});

describe("CircleManager CRUD", () => {
    it("add → get / list で同 id を取得できる", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        const handle = mgr.add("a", { center: validCenter, radius: 100 });
        expect(handle.id).toBe("a");
        expect(mgr.get("a")?.id).toBe("a");
        expect(mgr.list()).toEqual(["a"]);
    });

    it("重複 id で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        expect(() =>
            mgr.add("a", { center: validCenter, radius: 100 }),
        ).toThrow(/already exists/);
    });

    it("remove で list / get から消える", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        mgr.remove("a");
        expect(mgr.get("a")).toBeNull();
        expect(mgr.list()).toEqual([]);
    });

    it("未存在 id の remove は warn + no-op", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {
            /* silence */
        });
        mgr.remove("missing");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("get(未存在) は null", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(mgr.get("missing")).toBeNull();
    });
});

describe("CircleManager バリデーション", () => {
    it("radius <= 0 で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", { center: validCenter, radius: 0 }),
        ).toThrow(/radius/);
        expect(() =>
            mgr.add("a", { center: validCenter, radius: -1 }),
        ).toThrow(/radius/);
    });

    it("radius が CIRCLE_RADIUS_MAX_M を超えると throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", { center: validCenter, radius: 100_001 }),
        ).toThrow(/radius/);
    });

    it("radius が NaN/Infinity で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", { center: validCenter, radius: NaN }),
        ).toThrow(/radius/);
        expect(() =>
            mgr.add("a", { center: validCenter, radius: Infinity }),
        ).toThrow(/radius/);
    });

    it("segments が下限を下回ると throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", {
                center: validCenter,
                radius: 100,
                segments: 4,
            }),
        ).toThrow(/segments/);
    });

    it("segments が整数でないと throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", {
                center: validCenter,
                radius: 100,
                segments: 32.5,
            }),
        ).toThrow(/segments/);
    });

    it("JAPAN_BOUNDS 外の中心で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", { center: { lat: 0, lon: 0 }, radius: 100 }),
        ).toThrow(/JAPAN_BOUNDS/);
    });

    it("absolute モードで center.altitude 未指定なら throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() =>
            mgr.add("a", {
                center: validCenter,
                radius: 100,
                altitudeMode: "absolute",
            }),
        ).toThrow(/altitude/);
    });
});

describe("CircleManager 標高解決", () => {
    it("terrain モードで中心の標高が未解決なら elevationResolved=false", () => {
        const ctxWrap = buildCtx(null);
        const mgr = createCircleManager(ctxWrap.ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        expect(created[0].elevationResolved).toBe(false);
    });

    it("terrain モードで標高解決済みなら applyTransform が呼ばれる", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createCircleManager(ctxWrap.ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        // 初回 add で tickCircle が走る
        expect(created[0].applyTransformCalls).toBeGreaterThan(0);
        expect(created[0].elevationResolved).toBe(true);
    });

    it("absolute モードでは elevation が null でも resolved=true", () => {
        const ctxWrap = buildCtx(null);
        const mgr = createCircleManager(ctxWrap.ctx);
        mgr.add("a", {
            center: { lat: 35.681, lon: 139.767, altitude: 200 },
            radius: 100,
            altitudeMode: "absolute",
        });
        expect(created[0].elevationResolved).toBe(true);
        expect(created[0].applyTransformCalls).toBe(1);
        // 中心 Y は altitude 値を反映
        expect(created[0].lastCenter?.y).toBe(200);
    });

    it("ring の長さは segments と一致する（既定 64）", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createCircleManager(ctxWrap.ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        expect(created[0].lastRing.length).toBe(64);
    });

    it("segments を明示指定すると ring 長が一致する", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createCircleManager(ctxWrap.ctx);
        mgr.add("a", { center: validCenter, radius: 100, segments: 16 });
        expect(created[0].lastRing.length).toBe(16);
    });

    it("ring 各点は中心から半径分離れた位置に生成される（XZ 平面）", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createCircleManager(ctxWrap.ctx);
        mgr.add("a", { center: validCenter, radius: 500, segments: 8 });
        const center = created[0].lastCenter!;
        for (const p of created[0].lastRing) {
            const dx = p.x - center.x;
            const dz = p.z - center.z;
            const dist = Math.hypot(dx, dz);
            expect(dist).toBeCloseTo(500, 3);
        }
    });
});

describe("CircleManager setEnabled 系", () => {
    it("setEnabled / setPointEnabled / setLineEnabled / setWallEnabled / setLabelEnabled が node に伝播", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        mgr.setEnabled("a", false);
        mgr.setPointEnabled("a", false);
        mgr.setLineEnabled("a", false);
        mgr.setWallEnabled("a", false);
        mgr.setLabelEnabled("a", false);
        expect(created[0].setEnabledHistory).toEqual([false]);
        expect(created[0].setPointEnabledHistory).toEqual([false]);
        expect(created[0].setLineEnabledHistory).toEqual([false]);
        expect(created[0].setWallEnabledHistory).toEqual([false]);
        expect(created[0].setLabelEnabledHistory).toEqual([false]);
    });

    it("未存在 id の setEnabled は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        expect(() => mgr.setEnabled("missing", false)).toThrow(/not found/);
    });
});

describe("CircleManager dispose", () => {
    it("dispose で全 node が破棄される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        mgr.add("a", { center: validCenter, radius: 100 });
        mgr.add("b", { center: validCenter, radius: 200 });
        mgr.dispose();
        expect(created[0].disposed).toBe(true);
        expect(created[1].disposed).toBe(true);
        expect(mgr.list()).toEqual([]);
    });

    it("dispose 後の add は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createCircleManager(ctx);
        mgr.dispose();
        expect(() =>
            mgr.add("a", { center: validCenter, radius: 100 }),
        ).toThrow(/disposed/);
    });
});
