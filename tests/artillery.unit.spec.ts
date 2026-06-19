/**
 * Artillery Game ユニットテスト (Issue #259)
 *
 * 弾道計算 (ballistics.ts) とゲームロジック (gameLogic.ts) の純粋関数テスト。
 */
import {
    degToRad,
    radToDeg,
    computeLaunchVector,
    powderToSpeed,
    haversineDistance,
    bearing,
    MAX_SPEED,
    MIN_SPEED,
} from "../src/demos/artillery/ballistics";
import {
    createInitialState,
    nextTurn,
    addScore,
    isHit,
    opponent,
    HIT_RADIUS,
    type CannonState,
} from "../src/demos/artillery/gameLogic";
import { resolveArtilleryTerrainEngine } from "../src/demos/artillery/terrainEngine";

describe("resolveArtilleryTerrainEngine", () => {
    it("returns undefined engine when terrainEngine is not specified", () => {
        const r = resolveArtilleryTerrainEngine("");
        expect(r.engine).toBeUndefined();
    });

    it("passes through planar", () => {
        const r = resolveArtilleryTerrainEngine("?terrainEngine=planar");
        expect(r.engine).toBe("planar");
    });

    it("passes through globe (now supported via stageFrame ENU physics)", () => {
        const r = resolveArtilleryTerrainEngine("?terrainEngine=globe");
        expect(r.engine).toBe("globe");
    });

    it("ignores unknown values (treated as unspecified)", () => {
        const r = resolveArtilleryTerrainEngine("?terrainEngine=foo");
        expect(r.engine).toBeUndefined();
    });

    it("resolves globe even when combined with other query params", () => {
        const r = resolveArtilleryTerrainEngine(
            "?lat=35&terrainEngine=globe&engine=webgpu",
        );
        expect(r.engine).toBe("globe");
    });
});

describe("ballistics", () => {
    describe("degToRad / radToDeg", () => {
        it("converts 0° to 0 rad", () => {
            expect(degToRad(0)).toBe(0);
        });
        it("converts 180° to π", () => {
            expect(degToRad(180)).toBeCloseTo(Math.PI);
        });
        it("round-trips", () => {
            expect(radToDeg(degToRad(45))).toBeCloseTo(45);
        });
    });

    describe("computeLaunchVector", () => {
        it("at 0° elevation and 0° azimuth shoots north (+Z)", () => {
            const v = computeLaunchVector(0, 0, 100);
            expect(v.x).toBeCloseTo(0);
            expect(v.y).toBeCloseTo(0);
            expect(v.z).toBeCloseTo(100);
        });

        it("at 90° elevation shoots straight up (+Y)", () => {
            const v = computeLaunchVector(90, 0, 100);
            expect(v.x).toBeCloseTo(0);
            expect(v.y).toBeCloseTo(100);
            expect(v.z).toBeCloseTo(0, 0);
        });

        it("at 45° elevation has equal Y and horizontal components", () => {
            const v = computeLaunchVector(45, 0, 100);
            const horizontal = Math.sqrt(v.x ** 2 + v.z ** 2);
            expect(v.y).toBeCloseTo(horizontal, 0);
        });

        it("at 0° elevation and 90° azimuth shoots east (+X)", () => {
            const v = computeLaunchVector(0, 90, 100);
            expect(v.x).toBeCloseTo(100);
            expect(v.y).toBeCloseTo(0);
            expect(v.z).toBeCloseTo(0, 0);
        });

        it("at 0° elevation and 180° azimuth shoots south (-Z)", () => {
            const v = computeLaunchVector(0, 180, 100);
            expect(v.x).toBeCloseTo(0, 0);
            expect(v.y).toBeCloseTo(0);
            expect(v.z).toBeCloseTo(-100);
        });

        it("speed magnitude is preserved", () => {
            const v = computeLaunchVector(30, 60, 50);
            const magnitude = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
            expect(magnitude).toBeCloseTo(50);
        });
    });

    describe("powderToSpeed", () => {
        it("powder 0 returns MIN_SPEED", () => {
            expect(powderToSpeed(0)).toBe(MIN_SPEED);
        });

        it("powder 100 returns MAX_SPEED", () => {
            expect(powderToSpeed(100)).toBe(MAX_SPEED);
        });

        it("powder 50 returns midpoint", () => {
            expect(powderToSpeed(50)).toBeCloseTo(
                MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.5,
            );
        });

        it("clamps negative values", () => {
            expect(powderToSpeed(-10)).toBe(MIN_SPEED);
        });

        it("clamps values over 100", () => {
            expect(powderToSpeed(150)).toBe(MAX_SPEED);
        });
    });

    describe("haversineDistance", () => {
        it("same point returns 0", () => {
            expect(haversineDistance(35.0, 139.0, 35.0, 139.0)).toBeCloseTo(0);
        });

        it("Tokyo to Osaka is ~400km", () => {
            const d = haversineDistance(35.68, 139.77, 34.69, 135.50);
            expect(d).toBeGreaterThan(380000);
            expect(d).toBeLessThan(420000);
        });

        it("1 degree latitude is ~111km", () => {
            const d = haversineDistance(35.0, 139.0, 36.0, 139.0);
            expect(d).toBeGreaterThan(110000);
            expect(d).toBeLessThan(112000);
        });
    });

    describe("bearing", () => {
        it("due north is 0°", () => {
            expect(bearing(35.0, 139.0, 36.0, 139.0)).toBeCloseTo(0, 0);
        });

        it("due east is ~90°", () => {
            expect(bearing(35.0, 139.0, 35.0, 140.0)).toBeCloseTo(90, 0);
        });

        it("due south is ~180°", () => {
            expect(bearing(36.0, 139.0, 35.0, 139.0)).toBeCloseTo(180, 0);
        });

        it("due west is ~270°", () => {
            expect(bearing(35.0, 140.0, 35.0, 139.0)).toBeCloseTo(270, 0);
        });
    });
});

describe("gameLogic", () => {
    const redCannon: CannonState = {
        team: "red",
        lat: 35.0,
        lon: 139.0,
        altitude: 100,
        azimuthDeg: 90,
    };
    const blueCannon: CannonState = {
        team: "blue",
        lat: 35.01,
        lon: 139.01,
        altitude: 100,
        azimuthDeg: 270,
    };

    describe("opponent", () => {
        it("red → blue", () => {
            expect(opponent("red")).toBe("blue");
        });
        it("blue → red", () => {
            expect(opponent("blue")).toBe("red");
        });
    });

    describe("createInitialState", () => {
        it("starts with red turn and 0 scores", () => {
            const state = createInitialState(redCannon, blueCannon);
            expect(state.turn).toBe("red");
            expect(state.scoreRed).toBe(0);
            expect(state.scoreBlue).toBe(0);
        });
    });

    describe("nextTurn", () => {
        it("toggles turn from red to blue", () => {
            const state = createInitialState(redCannon, blueCannon);
            const next = nextTurn(state);
            expect(next.turn).toBe("blue");
        });
        it("toggles turn from blue to red", () => {
            const state = { ...createInitialState(redCannon, blueCannon), turn: "blue" as const };
            const next = nextTurn(state);
            expect(next.turn).toBe("red");
        });
    });

    describe("addScore", () => {
        it("increments red score", () => {
            const state = createInitialState(redCannon, blueCannon);
            const result = addScore(state, "red");
            expect(result.scoreRed).toBe(1);
            expect(result.scoreBlue).toBe(0);
        });
        it("increments blue score", () => {
            const state = createInitialState(redCannon, blueCannon);
            const result = addScore(state, "blue");
            expect(result.scoreRed).toBe(0);
            expect(result.scoreBlue).toBe(1);
        });
    });

    describe("isHit", () => {
        it("returns true when within hit radius", () => {
            expect(isHit(0, 0, 0, 10, 10, 10, 100)).toBe(true);
        });
        it("returns false when outside hit radius", () => {
            expect(isHit(0, 0, 0, 100, 100, 100, 10)).toBe(false);
        });
        it("uses default HIT_RADIUS", () => {
            expect(isHit(0, 0, 0, 0, 0, HIT_RADIUS - 1)).toBe(true);
            expect(isHit(0, 0, 0, 0, 0, HIT_RADIUS + 1)).toBe(false);
        });
        it("exact boundary is a hit", () => {
            expect(isHit(0, 0, 0, HIT_RADIUS, 0, 0)).toBe(true);
        });
    });
});
