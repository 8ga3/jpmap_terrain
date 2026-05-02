/**
 * @jest-environment jsdom
 */
/**
 * Plan Viewer デモの純粋関数ユニットテスト (#38)。
 *
 * - parsePlan: QGC plan JSON のパースとフィルタリング
 * - formatWaypointLabel / formatWaypointEdgeLabel / formatRallyPointLabel
 */
import { describe, it, expect } from "@jest/globals";

import { parsePlan, WAYPOINT_COMMANDS } from "../src/demos/plan/parsePlan";
import {
    formatWaypointLabel,
    formatWaypointEdgeLabel,
    formatRallyPointLabel,
    haversineDistanceMeters,
    formatHorizontalDistance,
    formatAltitudeDelta,
} from "../src/demos/plan/utils";

// ---- parsePlan ----

describe("parsePlan", () => {
    const minimalPlan = {
        fileHeader: { version: 1 },
        mission: {
            plannedHomePosition: [35.0, 139.0, 50],
            items: [],
        },
    };

    it("最小限の plan を正常にパースできる", () => {
        const result = parsePlan(minimalPlan);
        expect(result.homePosition).toEqual({
            lat: 35.0,
            lon: 139.0,
            altitude: 50,
        });
        expect(result.waypoints).toHaveLength(0);
        expect(result.geoFencePolygons).toHaveLength(0);
        expect(result.geoFenceCircles).toHaveLength(0);
        expect(result.rallyPoints).toHaveLength(0);
    });

    it("不正な入力で例外を投げる", () => {
        expect(() => parsePlan(null)).toThrow("not an object");
        expect(() => parsePlan("string")).toThrow("not an object");
        expect(() => parsePlan({})).toThrow("missing mission");
        expect(() => parsePlan({ mission: {} })).toThrow("mission.items is missing or not an array");
        expect(() => parsePlan({ mission: { items: "not-array" } })).toThrow("mission.items is missing or not an array");
    });

    it("NAV_WAYPOINT(16), NAV_TAKEOFF(22), NAV_LAND(21) をウェイポイントとして抽出する", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: {
                plannedHomePosition: [35.0, 139.0, 100],
                items: [
                    { command: 22, frame: 3, params: [0, 0, 0, 0, 35.1, 139.1, 50], coordinate: [35.1, 139.1, 50] },
                    { command: 16, frame: 3, params: [0, 0, 0, 0, 35.2, 139.2, 80], coordinate: [35.2, 139.2, 80] },
                    { command: 178, frame: 3, params: [0, 0, 0, 0, 0, 0, 0] }, // DO_CHANGE_SPEED - スキップ
                    { command: 16, frame: 3, params: [0, 0, 0, 0, 35.3, 139.3, 100], coordinate: [35.3, 139.3, 100] },
                    { command: 21, frame: 3, params: [0, 0, 0, 0, 35.4, 139.4, 0], coordinate: [35.4, 139.4, 0] },
                ],
            },
        };
        const result = parsePlan(plan);
        expect(result.waypoints).toHaveLength(4);
        // 番号は連番でスキップ分を含まない
        expect(result.waypoints[0].number).toBe(1);
        expect(result.waypoints[1].number).toBe(2);
        expect(result.waypoints[2].number).toBe(3);
        expect(result.waypoints[3].number).toBe(4);
        // 高度はホーム相対 (homeAlt=100) + item alt
        expect(result.waypoints[0].altitude).toBe(150); // 50 + 100
        expect(result.waypoints[1].altitude).toBe(180); // 80 + 100
    });

    it("coordinate フィールドがない場合 params[4..6] にフォールバックする", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: {
                plannedHomePosition: [35.0, 139.0, 0],
                items: [
                    { command: 16, frame: 3, params: [0, 0, 0, 0, 35.5, 139.5, 60] },
                ],
            },
        };
        const result = parsePlan(plan);
        expect(result.waypoints).toHaveLength(1);
        expect(result.waypoints[0].lat).toBe(35.5);
        expect(result.waypoints[0].lon).toBe(139.5);
        expect(result.waypoints[0].altitude).toBe(60);
    });

    it("ジオフェンスポリゴンをパースする", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: { plannedHomePosition: [35.0, 139.0, 0], items: [] },
            geoFence: {
                polygons: [
                    {
                        inclusion: true,
                        polygon: [[35.0, 139.0], [35.1, 139.0], [35.1, 139.1], [35.0, 139.1]],
                    },
                ],
                circles: [],
            },
        };
        const result = parsePlan(plan);
        expect(result.geoFencePolygons).toHaveLength(1);
        expect(result.geoFencePolygons[0].inclusion).toBe(true);
        expect(result.geoFencePolygons[0].points).toHaveLength(4);
    });

    it("ジオフェンス円をパースする", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: { plannedHomePosition: [35.0, 139.0, 0], items: [] },
            geoFence: {
                polygons: [],
                circles: [
                    { inclusion: false, circle: { center: [35.5, 139.5], radius: 500 } },
                ],
            },
        };
        const result = parsePlan(plan);
        expect(result.geoFenceCircles).toHaveLength(1);
        expect(result.geoFenceCircles[0].inclusion).toBe(false);
        expect(result.geoFenceCircles[0].center).toEqual({ lat: 35.5, lon: 139.5 });
        expect(result.geoFenceCircles[0].radius).toBe(500);
    });

    it("ラリーポイントをパースする", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: { plannedHomePosition: [35.0, 139.0, 50], items: [] },
            rallyPoints: {
                points: [
                    [35.1, 139.1, 30],
                    [35.2, 139.2, 40],
                ],
            },
        };
        const result = parsePlan(plan);
        expect(result.rallyPoints).toHaveLength(2);
        expect(result.rallyPoints[0].number).toBe(1);
        expect(result.rallyPoints[0].altitude).toBe(80); // 30 + 50(home)
        expect(result.rallyPoints[1].number).toBe(2);
        expect(result.rallyPoints[1].altitude).toBe(90); // 40 + 50(home)
    });

    it("homePosition が未定義でも動作する", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: {
                items: [
                    { command: 16, frame: 3, params: [0, 0, 0, 0, 35.0, 139.0, 100], coordinate: [35.0, 139.0, 100] },
                ],
            },
        };
        const result = parsePlan(plan);
        expect(result.homePosition).toBeNull();
        expect(result.waypoints[0].altitude).toBe(100); // homeAlt=0
    });

    it("lat=0 かつ lon=0 の items はスキップする（QGC ホームポジション指定）", () => {
        const plan = {
            fileHeader: { version: 1 },
            mission: {
                plannedHomePosition: [35.0, 139.0, 100],
                items: [
                    // NAV_TAKEOFF at lat=0,lon=0 → ホームポジション指定のためスキップ
                    { command: 22, frame: 3, params: [0, 0, 0, null, 0, 0, 50] },
                    // 通常ウェイポイント
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.5, 139.5, 80] },
                ],
            },
        };
        const result = parsePlan(plan);
        // NAV_TAKEOFF の lat=0,lon=0 がスキップされ、NAV_WAYPOINT だけ残る
        expect(result.waypoints).toHaveLength(1);
        expect(result.waypoints[0].number).toBe(1);
        expect(result.waypoints[0].lat).toBe(35.5);
        expect(result.waypoints[0].command).toBe(16);
    });

    it("okutama.plan 相当データをパースできる（lat=0,lon=0 のTAKEOFF がスキップされる）", () => {
        // examples/okutama.plan の構造を模したテスト
        const okutamaPlan = {
            fileType: "Plan",
            version: 1,
            groundStation: "QGroundControl",
            geoFence: {
                circles: [
                    {
                        circle: { center: [35.79185330892785, 139.04875075067923], radius: 148.6696453391971 },
                        inclusion: true,
                        version: 1,
                    },
                ],
                polygons: [
                    {
                        inclusion: true,
                        polygon: [
                            [35.78119118423945, 139.0155554596605],
                            [35.780557345975986, 139.02034217849484],
                            [35.78289290329043, 139.03542661940673],
                            [35.78745799934225, 139.04538107075717],
                            [35.78710147819815, 139.0474676808036],
                            [35.78406082046976, 139.04540192053304],
                            [35.78097161325014, 139.0364036553163],
                            [35.77833207231516, 139.02070654713293],
                            [35.779336739702785, 139.01491987915722],
                        ],
                        version: 1,
                    },
                ],
                version: 2,
            },
            mission: {
                cruiseSpeed: 1,
                firmwareType: 3,
                globalPlanAltitudeMode: 1,
                hoverSpeed: 5,
                items: [
                    // NAV_TAKEOFF at lat=0,lon=0 → スキップされるべき
                    { command: 22, frame: 3, params: [0, 0, 0, null, 0, 0, 50], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.79196971850398, 139.04883949344594, 50], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.78655862746033, 139.04593844937483, 75], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.78479187671575, 139.043807961761, 90], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.78177242, 139.03606576, 60], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.780898754866946, 139.03043500185498, 50], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.77935164, 139.02038159, 35], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.77948819, 139.01944443, 32], autoContinue: true, type: "SimpleItem" },
                    { command: 16, frame: 3, params: [0, 0, 0, null, 35.78012772190709, 139.01597313549905, 20], autoContinue: true, type: "SimpleItem" },
                    { command: 21, frame: 3, params: [0, 0, 0, null, 35.7801385, 139.01591839, 0], autoContinue: true, type: "SimpleItem" },
                ],
                plannedHomePosition: [35.79210805, 139.04890088, 522],
                vehicleType: 2,
                version: 2,
            },
            rallyPoints: {
                points: [
                    [35.78970727, 139.04329378, 0],
                    [35.78421729, 139.04349786, 0],
                    [35.78251902, 139.02834407, 0],
                ],
                version: 2,
            },
        };

        const result = parsePlan(okutamaPlan);

        // ホームポジション
        expect(result.homePosition).toEqual({ lat: 35.79210805, lon: 139.04890088, altitude: 522 });

        // NAV_TAKEOFF(lat=0,lon=0) がスキップされ、残り 9 点（NAV_WAYPOINT x8 + NAV_LAND x1）
        expect(result.waypoints).toHaveLength(9);
        expect(result.waypoints[0].number).toBe(1);
        expect(result.waypoints[0].command).toBe(16); // NAV_WAYPOINT
        expect(result.waypoints[0].lat).toBeCloseTo(35.79196971850398);
        // 高度はホーム相対: 50 + 522
        expect(result.waypoints[0].altitude).toBe(572);
        // 最後は NAV_LAND
        expect(result.waypoints[8].command).toBe(21);

        // ジオフェンスポリゴン 1 件
        expect(result.geoFencePolygons).toHaveLength(1);
        expect(result.geoFencePolygons[0].points).toHaveLength(9);

        // ジオフェンス円 1 件
        expect(result.geoFenceCircles).toHaveLength(1);
        expect(result.geoFenceCircles[0].center).toEqual({
            lat: 35.79185330892785,
            lon: 139.04875075067923,
        });

        // ラリーポイント 3 件（高度はホーム相対: 0 + 522）
        expect(result.rallyPoints).toHaveLength(3);
        expect(result.rallyPoints[0].altitude).toBe(522); // 0 + 522
    });
});

describe("WAYPOINT_COMMANDS", () => {
    it("16, 21, 22 を含む", () => {
        expect(WAYPOINT_COMMANDS.has(16)).toBe(true);
        expect(WAYPOINT_COMMANDS.has(21)).toBe(true);
        expect(WAYPOINT_COMMANDS.has(22)).toBe(true);
    });

    it("他のコマンドを含まない", () => {
        expect(WAYPOINT_COMMANDS.has(178)).toBe(false); // DO_CHANGE_SPEED
        expect(WAYPOINT_COMMANDS.has(20)).toBe(false); // NAV_RETURN_TO_LAUNCH
    });
});

// ---- utils ----

describe("formatWaypointLabel", () => {
    it("番号と高度を表示する", () => {
        const wp = { number: 3, lat: 35.0, lon: 139.0, altitude: 150.7, command: 16 };
        expect(formatWaypointLabel(wp)).toBe("#3\n151 m");
    });
});

describe("formatWaypointEdgeLabel", () => {
    it("水平距離と高度差を表示する", () => {
        const a = { number: 1, lat: 35.0, lon: 139.0, altitude: 100, command: 16 };
        const b = { number: 2, lat: 35.0, lon: 139.01, altitude: 150, command: 16 };
        const label = formatWaypointEdgeLabel(a, b);
        expect(label).toContain("m");
        expect(label).toContain("+50 m");
    });
});

describe("formatRallyPointLabel", () => {
    it("R + 番号を返す", () => {
        expect(formatRallyPointLabel(1)).toBe("R1");
        expect(formatRallyPointLabel(5)).toBe("R5");
    });
});

describe("haversineDistanceMeters (plan utils)", () => {
    it("同一点は 0 を返す", () => {
        const p = { lat: 35.0, lon: 139.0 };
        expect(haversineDistanceMeters(p, p)).toBe(0);
    });

    it("東京-大阪は概ね 400 km 前後", () => {
        const tokyo = { lat: 35.6812, lon: 139.7671 };
        const osaka = { lat: 34.6937, lon: 135.5023 };
        const d = haversineDistanceMeters(tokyo, osaka);
        expect(d).toBeGreaterThan(380_000);
        expect(d).toBeLessThan(420_000);
    });
});

describe("formatHorizontalDistance", () => {
    it("1000m 未満は m 表示", () => {
        expect(formatHorizontalDistance(500)).toBe("500 m");
        expect(formatHorizontalDistance(999.4)).toBe("999 m");
    });

    it("1000m 以上は km 表示", () => {
        expect(formatHorizontalDistance(1000)).toBe("1.00 km");
        expect(formatHorizontalDistance(12345)).toBe("12.35 km");
    });

    it("異常値は - を返す", () => {
        expect(formatHorizontalDistance(-1)).toBe("-");
        expect(formatHorizontalDistance(NaN)).toBe("-");
        expect(formatHorizontalDistance(Infinity)).toBe("-");
    });
});

describe("formatAltitudeDelta", () => {
    it("正の値に + 符号", () => {
        expect(formatAltitudeDelta(50)).toBe("+50 m");
    });

    it("負の値に - 符号", () => {
        expect(formatAltitudeDelta(-30)).toBe("-30 m");
    });

    it("0 前後は ±0 m", () => {
        expect(formatAltitudeDelta(0)).toBe("±0 m");
        expect(formatAltitudeDelta(0.3)).toBe("±0 m");
    });

    it("NaN は -", () => {
        expect(formatAltitudeDelta(NaN)).toBe("-");
    });
});
