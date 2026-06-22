/**
 * PolygonManager の単体テスト (Issue #170)。
 *
 * `polygon` モジュール（Babylon 依存）を軽量スタブに差し替え、
 * CRUD / 境界 / altitudeMode / 標高解決 / dispose の挙動を検証する。
 */

import { jest } from "@jest/globals";
import type {
    PolygonOptions,
    PolygonPointOptions,
    PolygonPointPartial,
} from "../src/lib/types";

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
    lastGroundYs: Array<number | null>;
    disposed: boolean;
    setEnabledHistory: boolean[];
    setVerticalsEnabledHistory: boolean[];
    setLabelsEnabledHistory: boolean[];
    setWallsEnabledHistory: boolean[];
    setElevationResolvedHistory: boolean[];
    insertCalls: Array<{ index: number; point: PolygonPointOptions }>;
    removeCalls: number[];
    updateCalls: Array<{ index: number; partial: PolygonPointPartial }>;
    replaceCalls: Array<readonly PolygonPointOptions[]>;
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
            lastGroundYs: [],
            disposed: false,
            setEnabledHistory: [],
            setVerticalsEnabledHistory: [],
            setLabelsEnabledHistory: [],
            setWallsEnabledHistory: [],
            setElevationResolvedHistory: [],
            insertCalls: [],
            removeCalls: [],
            updateCalls: [],
            replaceCalls: [],
        };
        const wrapped = {
            ...node,
            applyTransform: (
                worldPoints: ReadonlyArray<{
                    x: number;
                    y: number;
                    z: number;
                }>,
                groundYs?: ReadonlyArray<number | null>,
            ) => {
                node.applyTransformCalls++;
                node.lastWorldPoints = worldPoints.map((p) => ({
                    x: p.x,
                    y: p.y,
                    z: p.z,
                }));
                if (groundYs) {
                    node.lastGroundYs = groundYs.slice();
                }
            },
            setEnabledLogical: (v: boolean) => {
                node.enabled = v;
                node.setEnabledHistory.push(v);
            },
            setVerticalsEnabledLogical: (v: boolean) => {
                node.setVerticalsEnabledHistory.push(v);
            },
            setLabelsEnabledLogical: (v: boolean) => {
                node.setLabelsEnabledHistory.push(v);
            },
            setWallsEnabledLogical: (v: boolean) => {
                node.setWallsEnabledHistory.push(v);
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
            insertPoint: (index: number, point: PolygonPointOptions) => {
                node.insertCalls.push({ index, point });
                node.points.splice(index, 0, { ...point });
            },
            removePoint: (index: number) => {
                node.removeCalls.push(index);
                node.points.splice(index, 1);
            },
            updatePoint: (
                index: number,
                partial: PolygonPointPartial,
            ) => {
                node.updateCalls.push({ index, partial });
                const cur = node.points[index];
                if (cur) {
                    node.points[index] = {
                        ...cur,
                        ...(partial.lat !== undefined
                            ? { lat: partial.lat }
                            : {}),
                        ...(partial.lon !== undefined
                            ? { lon: partial.lon }
                            : {}),
                        ...(partial.altitude !== undefined
                            ? { altitude: partial.altitude }
                            : {}),
                    };
                }
            },
            replacePoints: (
                points: readonly PolygonPointOptions[],
            ) => {
                node.replaceCalls.push(points.map((p) => ({ ...p })));
                node.points = points.map((p) => ({ ...p }));
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
    it("0 点で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() =>
            mgr.add("a", {
                points: [],
            }),
        ).toThrow(/at least 1/);
    });

    it("1 点でも追加可能（#186 距離計測デモより緩和）", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() =>
            mgr.add("a", {
                points: [{ lat: 35.681, lon: 139.767 }],
            }),
        ).not.toThrow();
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

    it("setVerticalsEnabled が node.setVerticalsEnabledLogical へ委譲される (Issue #171)", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.setVerticalsEnabled("a", false);
        mgr.setVerticalsEnabled("a", true);
        expect(created[0].setVerticalsEnabledHistory).toEqual([false, true]);
    });

    it("setLabelsEnabled が node.setLabelsEnabledLogical へ委譲される (Issue #171)", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.setLabelsEnabled("a", false);
        mgr.setLabelsEnabled("a", true);
        expect(created[0].setLabelsEnabledHistory).toEqual([false, true]);
    });

    it("setWallsEnabled が node.setWallsEnabledLogical へ委譲される (Issue #172)", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.setWallsEnabled("a", false);
        mgr.setWallsEnabled("a", true);
        expect(created[0].setWallsEnabledHistory).toEqual([false, true]);
    });

    it("未存在 id の setVerticalsEnabled / setLabelsEnabled / setWallsEnabled は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() => mgr.setVerticalsEnabled("missing", false)).toThrow(/not found/);
        expect(() => mgr.setLabelsEnabled("missing", false)).toThrow(/not found/);
        expect(() => mgr.setWallsEnabled("missing", false)).toThrow(/not found/);
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
        expect(() => mgr.setVerticalsEnabled("a", false)).toThrow(/disposed/);
        expect(() => mgr.setLabelsEnabled("a", false)).toThrow(/disposed/);
        expect(() => mgr.setWallsEnabled("a", false)).toThrow(/disposed/);
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

describe("PolygonManager update (#173/#395)", () => {
    it("partial をマージして再構築し、更新後のハンドルを返す", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        const newPoints = [
            { lat: validPoints[0].lat + 0.001, lon: validPoints[0].lon },
            { lat: validPoints[1].lat, lon: validPoints[1].lon },
        ];
        const handle = mgr.update("a", { points: newPoints, enabled: false });
        expect(handle.points).toHaveLength(2);
        expect(handle.points[0].lat).toBeCloseTo(newPoints[0].lat);
        expect(handle.enabled).toBe(false);
        // 旧ノードは破棄され新ノードへ差し替わる。
        expect(created[0].disposed).toBe(true);
        expect(created[created.length - 1].disposed).toBe(false);
    });

    it("未存在 id / 不正な points は throw する", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() => mgr.update("missing", { enabled: false })).toThrow(
            /not found/,
        );
        mgr.add("a", { points: validPoints });
        expect(() => mgr.update("a", { points: [] })).toThrow(/at least 1/);
    });
});

describe("PolygonManager 点編集 API (#173)", () => {
    // `created` (mock 内で push される StubNode) の最新エントリを参照することで、
    // PolygonManager が node 側へ委譲したかを履歴で検証する。
    it("insertPoint が node.insertPoint へ委譲され、handle を返す", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        const node = created[created.length - 1];
        const handle = mgr.insertPoint("a", 1, {
            lat: 35.6815,
            lon: 139.7675,
        });
        expect(node.insertCalls).toEqual([
            { index: 1, point: { lat: 35.6815, lon: 139.7675 } },
        ]);
        expect(handle.id).toBe("a");
    });

    it("insertPoint は JAPAN_BOUNDS 外で throw（node 委譲前）", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        expect(() => mgr.insertPoint("a", 0, { lat: 0, lon: 0 })).toThrow(
            /JAPAN_BOUNDS/,
        );
    });

    it("removePoint が node.removePoint へ委譲される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        const node = created[created.length - 1];
        mgr.removePoint("a", 0);
        expect(node.removeCalls).toEqual([0]);
    });

    it("updatePoint が node.updatePoint へ委譲される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        const node = created[created.length - 1];
        mgr.updatePoint("a", 1, { altitude: 50 });
        expect(node.updateCalls).toEqual([
            { index: 1, partial: { altitude: 50 } },
        ]);
    });

    it("updatePoint は lat/lon partial で JAPAN_BOUNDS 検査が走る", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        expect(() =>
            mgr.updatePoint("a", 0, { lat: 0, lon: 0 }),
        ).toThrow(/JAPAN_BOUNDS/);
    });

    it("replacePoints は points.length<1 で throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        expect(() => mgr.replacePoints("a", [])).toThrow(/at least 1/);
    });

    it("replacePoints が node.replacePoints へ委譲される", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        const node = created[created.length - 1];
        const next = [
            { lat: 35.681, lon: 139.767 },
            { lat: 35.682, lon: 139.768 },
        ];
        mgr.replacePoints("a", next);
        expect(node.replaceCalls.length).toBe(1);
        expect(node.replaceCalls[0]).toEqual(next);
    });

    it("未存在 id で insert/remove/update/replace は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        expect(() =>
            mgr.insertPoint("missing", 0, { lat: 35.681, lon: 139.767 }),
        ).toThrow(/not found/);
        expect(() => mgr.removePoint("missing", 0)).toThrow(/not found/);
        expect(() => mgr.updatePoint("missing", 0, { lat: 35.681 })).toThrow(
            /not found/,
        );
        expect(() =>
            mgr.replacePoints("missing", [
                { lat: 35.681, lon: 139.767 },
                { lat: 35.682, lon: 139.768 },
            ]),
        ).toThrow(/not found/);
    });

    it("dispose 後の insert/remove/update/replace は throw", () => {
        const { ctx } = buildCtx(0);
        const mgr = createPolygonManager(ctx);
        mgr.add("a", { points: validPoints });
        mgr.dispose();
        expect(() =>
            mgr.insertPoint("a", 0, { lat: 35.681, lon: 139.767 }),
        ).toThrow(/disposed/);
        expect(() => mgr.removePoint("a", 0)).toThrow(/disposed/);
        expect(() => mgr.updatePoint("a", 0, { lat: 35.681 })).toThrow(
            /disposed/,
        );
        expect(() =>
            mgr.replacePoints("a", [
                { lat: 35.681, lon: 139.767 },
                { lat: 35.682, lon: 139.768 },
            ]),
        ).toThrow(/disposed/);
    });
});
