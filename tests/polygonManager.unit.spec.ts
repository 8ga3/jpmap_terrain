/**
 * PolygonManager の単体テスト (Issue #170)。
 *
 * `polygon` モジュール（Babylon 依存）を軽量スタブに差し替え、
 * CRUD / 境界 / altitudeMode / 標高解決 / dispose の挙動を検証する。
 */

import { jest } from "@jest/globals";
import type { PolygonOptions } from "../src/lib/types";

interface StubNode {
    id: string;
    altitudeMode: "terrain" | "absolute";
    closed: boolean;
    points: Array<{
        lat: number;
        lon: number;
        altitude?: number;
    }>;
    enabled: boolean;
    elevationResolved: boolean;
    applyTransformCalls: number;
    lastWorldPoints: Array<{ x: number; y: number; z: number }>;
    disposed: boolean;
    setEnabledHistory: boolean[];
    setElevationResolvedHistory: boolean[];
}

const created: StubNode[] = [];

jest.unstable_mockModule("../src/terrain/polygon", () => ({
    createPolygonNode: (
        _scene: unknown,
        id: string,
        options: PolygonOptions,
    ): StubNode => {
        const altitudeMode = options.altitudeMode ?? "terrain";
        const node: StubNode = {
            id,
            altitudeMode,
            closed: options.closed ?? false,
            points: options.points.map((p) => ({ ...p })),
            enabled: options.enabled ?? true,
            elevationResolved: altitudeMode === "absolute",
            applyTransformCalls: 0,
            lastWorldPoints: [],
            disposed: false,
            setEnabledHistory: [],
            setElevationResolvedHistory: [],
        };
        const wrapped = {
            ...node,
            applyTransform: (
                worldPoints: ReadonlyArray<{
                    x: number;
                    y: number;
                    z: number;
                }>,
            ) => {
                node.applyTransformCalls++;
                node.lastWorldPoints = worldPoints.map((p) => ({
                    x: p.x,
                    y: p.y,
                    z: p.z,
                }));
            },
            setEnabledLogical: (v: boolean) => {
                node.enabled = v;
                node.setEnabledHistory.push(v);
            },
            setElevationResolved: (v: boolean) => {
                node.elevationResolved = v;
                node.setElevationResolvedHistory.push(v);
            },
            getHandle: () => ({
                id,
                points: node.points.map((p) => ({ ...p })),
                closed: node.closed,
                altitudeMode: node.altitudeMode,
                labels: undefined,
                style: {} as unknown as Record<string, unknown>,
                enabled: node.enabled,
                elevationResolved: node.elevationResolved,
            }),
            dispose: () => {
                node.disposed = true;
            },
        };
        // 内部状態を `created` 経由でテストから観測するため、両方のオブジェクトを
        // 同じプロパティで参照できるよう同一参照で push する。
        created.push(node);
        return wrapped as unknown as StubNode;
    },
}));

const { createPolygonManager } = await import(
    "../src/terrain/polygonManager"
);

interface FakeObserver {
    callback: () => void;
}

const buildCtx = (
    elevation: number | null = 0,
): {
    ctx: Parameters<typeof createPolygonManager>[0];
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
    const ctx: Parameters<typeof createPolygonManager>[0] = {
        scene: sceneLike as unknown as Parameters<
            typeof createPolygonManager
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
        unsubscribeCount: () => unsubscribeCalls,
    };
};

const validPoints = [
    { lat: 35.681, lon: 139.767 },
    { lat: 35.682, lon: 139.768 },
    { lat: 35.683, lon: 139.769 },
];

beforeEach(() => {
    created.length = 0;
});

describe("PolygonManager CRUD", () => {
    it("add → get / list で同 id を取得できる", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        const handle = mgr.add("a", { points: validPoints });
        expect(handle.id).toBe("a");
        expect(mgr.get("a")?.id).toBe("a");
        expect(mgr.list()).toEqual(["a"]);
    });

    it("重複 id で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        expect(() => mgr.add("a", { points: validPoints })).toThrow(
            /already exists/,
        );
    });

    it("remove で list / get から消える", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.remove("a");
        expect(mgr.get("a")).toBeNull();
        expect(mgr.list()).toEqual([]);
    });

    it("未存在 id の remove は warn + no-op", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {
            /* silence */
        });
        mgr.remove("missing");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("PolygonManager バリデーション", () => {
    it("2 点未満で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() =>
            mgr.add("a", {
                points: [{ lat: 35.681, lon: 139.767 }],
            }),
        ).toThrow(/at least 2/);
    });

    it("JAPAN_BOUNDS 外で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() =>
            mgr.add("a", {
                points: [
                    { lat: 35.681, lon: 139.767 },
                    { lat: 0, lon: 0 },
                ],
            }),
        ).toThrow(/JAPAN_BOUNDS/);
    });

    it("absolute モードで altitude 未指定の点があれば throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() =>
            mgr.add("a", {
                altitudeMode: "absolute",
                points: [
                    { lat: 35.681, lon: 139.767, altitude: 100 },
                    { lat: 35.682, lon: 139.768 },
                ],
            }),
        ).toThrow(/requires altitude/);
    });
});

describe("PolygonManager 標高解決", () => {
    it("terrain モードで 1 点でも未解決なら elevationResolved=false", () => {
        const ctxWrap = buildCtx(null);
        const mgr = createPolygonManager(ctxWrap.ctx);
        mgr.add("a", { points: validPoints });
        expect(created[0].elevationResolved).toBe(false);
    });

    it("terrain モードで全頂点解決すれば applyTransform が呼ばれる", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createPolygonManager(ctxWrap.ctx);
        mgr.add("a", { points: validPoints });
        // 初回 add 時にも tickPolygon が呼ばれる
        expect(created[0].applyTransformCalls).toBeGreaterThan(0);
        expect(created[0].elevationResolved).toBe(true);
    });

    it("absolute モードでは elevation が null でも resolved=true で applyTransform が走る", () => {
        const ctxWrap = buildCtx(null);
        const mgr = createPolygonManager(ctxWrap.ctx);
        mgr.add("a", {
            altitudeMode: "absolute",
            points: [
                { lat: 35.681, lon: 139.767, altitude: 100 },
                { lat: 35.682, lon: 139.768, altitude: 200 },
            ],
        });
        expect(created[0].elevationResolved).toBe(true);
        expect(created[0].applyTransformCalls).toBeGreaterThan(0);
    });

    it("terrain モードで altitude を地表標高に加算した値が Y に反映される", () => {
        // tileManager のスタブ標高を 10m に固定 → altitude=5 を加えた wy=15 を期待
        const ctxWrap = buildCtx(10);
        const mgr = createPolygonManager(ctxWrap.ctx);
        mgr.add("a", {
            altitudeMode: "terrain",
            points: [
                { lat: 35.681, lon: 139.767, altitude: 5 },
                { lat: 35.682, lon: 139.768, altitude: 5 },
            ],
        });
        const ys = created[0].lastWorldPoints.map((p) => p.y);
        expect(ys).toEqual([15, 15]);
    });

    it("terrain モードで altitude 未指定なら地表標高そのままが Y に反映される", () => {
        const ctxWrap = buildCtx(20);
        const mgr = createPolygonManager(ctxWrap.ctx);
        mgr.add("a", {
            altitudeMode: "terrain",
            points: [
                { lat: 35.681, lon: 139.767 },
                { lat: 35.682, lon: 139.768 },
            ],
        });
        const ys = created[0].lastWorldPoints.map((p) => p.y);
        expect(ys).toEqual([20, 20]);
    });
});

describe("PolygonManager enable / disable", () => {
    it("setEnabled で node.enabled が反映される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.setEnabled("a", false);
        expect(created[0].setEnabledHistory).toContain(false);
        mgr.setEnabled("a", true);
        expect(created[0].setEnabledHistory).toContain(true);
    });

    it("未存在 id の setEnabled は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() => mgr.setEnabled("missing", false)).toThrow(/not found/);
    });
});

describe("PolygonManager dispose", () => {
    it("dispose で全 node が解放され、terrain subscription が解除される", () => {
        const ctxWrap = buildCtx(0);
        const mgr = createPolygonManager(ctxWrap.ctx);
        mgr.add("a", { points: validPoints });
        mgr.add("b", { points: validPoints });
        mgr.dispose();
        for (const n of created) {
            expect(n.disposed).toBe(true);
        }
        expect(ctxWrap.unsubscribeCount()).toBeGreaterThan(0);
    });

    it("dispose 後の add は throw、setEnabled も throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.dispose();
        expect(() => mgr.add("a", { points: validPoints })).toThrow(/disposed/);
        expect(() => mgr.setEnabled("a", false)).toThrow(/disposed/);
    });

    it("dispose 後の get は null、list は []、remove は no-op", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.dispose();
        // dispose 後は内部 Map がクリアされる
        expect(mgr.get("a")).toBeNull();
        expect(mgr.list()).toEqual([]);
        // remove は warn を出すが throw はしない
        const warn = jest
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        mgr.remove("a");
        warn.mockRestore();
    });
});

describe("PolygonManager update (#170 では未公開)", () => {
    it("内部 update は throw する（#173 で実装）", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        expect(() => mgr.update("a", { enabled: false })).toThrow(
            /not implemented/,
        );
    });
});
