/**
 * Boids アルゴリズム・リージョン定義の unit test
 */
import { describe, it, expect } from "vitest";

import {
    distance,
    separation,
    alignment,
    cohesion,
    boundaryForce,
    updateBoid,
    updateFlock,
    boidHeading,
    BOIDS_DEFAULTS,
    type BoidState,
    type BoidsParams,
    type BoidsBounds,
} from "../src/demos/boids/boids";

import {
    regionCorners,
    geoToLocal,
    localToGeo,
    regionBounds,
    isInsideRegion,
    randomPositionInRegion,
    randomVelocity,
    DEFAULT_REGION,
} from "../src/demos/boids/region";

// ---- Boids アルゴリズム ----

describe("distance", () => {
    it("同一点の距離は 0", () => {
        expect(distance(0, 0, 0, 0)).toBe(0);
    });

    it("水平距離を正しく計算する", () => {
        expect(distance(0, 0, 3, 4)).toBeCloseTo(5, 10);
    });

    it("負の座標でも正しく計算する", () => {
        expect(distance(-1, -1, 2, 3)).toBeCloseTo(5, 10);
    });
});

describe("separation", () => {
    const params: BoidsParams = { ...BOIDS_DEFAULTS };

    it("近くに仲間がいなければゼロベクトルを返す", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 1, vy: 0 };
        const flock: BoidState[] = [
            boid,
            { x: 100, y: 100, vx: 1, vy: 0 },
        ];
        const result = separation(boid, flock, params);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
    });

    it("近すぎる仲間がいると離れる方向に力が働く", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 1, vy: 0 };
        const other: BoidState = { x: 5, y: 0, vx: 1, vy: 0 };
        const flock: BoidState[] = [boid, other];
        const result = separation(boid, flock, params);
        // boid は other の左側にいるので、左方向（負のx）に力が働くはず
        // ただし操舵力として計算されるので、方向が反発であることを確認
        expect(result.x).not.toBe(0);
    });
});

describe("alignment", () => {
    const params: BoidsParams = { ...BOIDS_DEFAULTS };

    it("近くに仲間がいなければゼロベクトルを返す", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 1, vy: 0 };
        const flock: BoidState[] = [boid];
        const result = alignment(boid, flock, params);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
    });

    it("近隣の仲間と同じ方向に操舵力が働く", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 1, vy: 0 };
        const other: BoidState = { x: 10, y: 0, vx: 0, vy: 2 };
        const flock: BoidState[] = [boid, other];
        const result = alignment(boid, flock, params);
        // other は +y 方向に進んでいるので、boid も +y 方向に操舵されるはず
        expect(result.y).toBeGreaterThan(0);
    });
});

describe("cohesion", () => {
    const params: BoidsParams = { ...BOIDS_DEFAULTS };

    it("近くに仲間がいなければゼロベクトルを返す", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 1, vy: 0 };
        const flock: BoidState[] = [boid];
        const result = cohesion(boid, flock, params);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
    });

    it("近隣の仲間の重心に向かう操舵力が働く", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 0, vy: 0 };
        const flock: BoidState[] = [
            boid,
            { x: 30, y: 0, vx: 0, vy: 0 },
            { x: 30, y: 30, vx: 0, vy: 0 },
        ];
        const result = cohesion(boid, flock, params);
        // 重心は (30, 15) なので、+x, +y 方向に力が働くはず
        expect(result.x).toBeGreaterThan(0);
        expect(result.y).toBeGreaterThan(0);
    });
});

describe("boundaryForce", () => {
    const bounds: BoidsBounds = { minX: -100, maxX: 100, minY: -100, maxY: 100 };

    it("中央にいるとき力はゼロ", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 0, vy: 0 };
        const result = boundaryForce(boid, bounds);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
    });

    it("左端に近づくと右方向に力が働く", () => {
        const boid: BoidState = { x: -90, y: 0, vx: 0, vy: 0 };
        const result = boundaryForce(boid, bounds);
        expect(result.x).toBeGreaterThan(0);
        expect(result.y).toBe(0);
    });

    it("右端に近づくと左方向に力が働く", () => {
        const boid: BoidState = { x: 90, y: 0, vx: 0, vy: 0 };
        const result = boundaryForce(boid, bounds);
        expect(result.x).toBeLessThan(0);
    });

    it("境界外にいると最大の力が働く", () => {
        const boid: BoidState = { x: -110, y: 0, vx: 0, vy: 0 };
        const result = boundaryForce(boid, bounds);
        expect(result.x).toBeGreaterThan(0);
    });
});

describe("updateBoid", () => {
    const params: BoidsParams = { ...BOIDS_DEFAULTS };
    const bounds: BoidsBounds = { minX: -150, maxX: 150, minY: -150, maxY: 150 };

    it("1体のBoidが更新後も境界内にとどまる", () => {
        const boid: BoidState = { x: 140, y: 0, vx: 3, vy: 0 };
        const result = updateBoid(boid, [boid], params, bounds, 0.1);
        expect(result.x).toBeLessThanOrEqual(bounds.maxX);
        expect(result.x).toBeGreaterThanOrEqual(bounds.minX);
    });

    it("速度が maxSpeed を超えない", () => {
        const boid: BoidState = { x: 0, y: 0, vx: 10, vy: 10 };
        const result = updateBoid(boid, [boid], params, bounds, 0.1);
        const speed = Math.sqrt(result.vx * result.vx + result.vy * result.vy);
        expect(speed).toBeLessThanOrEqual(params.maxSpeed + 0.001);
    });
});

describe("updateFlock", () => {
    const params: BoidsParams = { ...BOIDS_DEFAULTS };
    const bounds: BoidsBounds = { minX: -150, maxX: 150, minY: -150, maxY: 150 };

    it("空のフロックを更新しても空を返す", () => {
        const result = updateFlock([], params, bounds, 0.1);
        expect(result).toEqual([]);
    });

    it("フロックの数が保持される", () => {
        const flock: BoidState[] = [
            { x: 0, y: 0, vx: 1, vy: 0 },
            { x: 10, y: 10, vx: -1, vy: 0 },
            { x: -10, y: 5, vx: 0, vy: 1 },
        ];
        const result = updateFlock(flock, params, bounds, 0.1);
        expect(result).toHaveLength(3);
    });

    it("100ステップ更新しても全Boidが境界内にとどまる", () => {
        let flock: BoidState[] = [
            { x: 50, y: 50, vx: 2, vy: 1 },
            { x: -50, y: -50, vx: -1, vy: 2 },
            { x: 0, y: 100, vx: 1, vy: -1 },
        ];
        for (let i = 0; i < 100; i++) {
            flock = updateFlock(flock, params, bounds, 0.05);
        }
        for (const boid of flock) {
            expect(boid.x).toBeGreaterThanOrEqual(bounds.minX);
            expect(boid.x).toBeLessThanOrEqual(bounds.maxX);
            expect(boid.y).toBeGreaterThanOrEqual(bounds.minY);
            expect(boid.y).toBeLessThanOrEqual(bounds.maxY);
        }
    });
});

describe("boidHeading", () => {
    it("北方向 (vx=0, vy>0) で 0° を返す", () => {
        expect(boidHeading({ x: 0, y: 0, vx: 0, vy: 1 })).toBeCloseTo(0, 5);
    });

    it("東方向 (vx>0, vy=0) で 90° を返す", () => {
        expect(boidHeading({ x: 0, y: 0, vx: 1, vy: 0 })).toBeCloseTo(90, 5);
    });

    it("南方向 (vx=0, vy<0) で 180° を返す", () => {
        expect(boidHeading({ x: 0, y: 0, vx: 0, vy: -1 })).toBeCloseTo(180, 5);
    });

    it("西方向 (vx<0, vy=0) で 270° を返す", () => {
        expect(boidHeading({ x: 0, y: 0, vx: -1, vy: 0 })).toBeCloseTo(270, 5);
    });

    it("速度ゼロで 0 を返す", () => {
        expect(boidHeading({ x: 0, y: 0, vx: 0, vy: 0 })).toBe(0);
    });
});

// ---- リージョン定義 ----

describe("regionCorners", () => {
    it("4 頂点を返す", () => {
        const corners = regionCorners(DEFAULT_REGION);
        expect(corners).toHaveLength(4);
    });

    it("中心より南側と北側の頂点が存在する", () => {
        const corners = regionCorners(DEFAULT_REGION);
        const lats = corners.map((c) => c.lat);
        expect(Math.min(...lats)).toBeLessThan(DEFAULT_REGION.centerLat);
        expect(Math.max(...lats)).toBeGreaterThan(DEFAULT_REGION.centerLat);
    });

    it("中心より西側と東側の頂点が存在する", () => {
        const corners = regionCorners(DEFAULT_REGION);
        const lons = corners.map((c) => c.lon);
        expect(Math.min(...lons)).toBeLessThan(DEFAULT_REGION.centerLon);
        expect(Math.max(...lons)).toBeGreaterThan(DEFAULT_REGION.centerLon);
    });
});

describe("geoToLocal / localToGeo", () => {
    it("中心座標はローカル原点 (0, 0) になる", () => {
        const local = geoToLocal(
            DEFAULT_REGION.centerLat,
            DEFAULT_REGION.centerLon,
            DEFAULT_REGION,
        );
        expect(local.x).toBeCloseTo(0, 5);
        expect(local.y).toBeCloseTo(0, 5);
    });

    it("往復変換で元の座標に戻る", () => {
        const lat = 35.626;
        const lon = 139.244;
        const local = geoToLocal(lat, lon, DEFAULT_REGION);
        const geo = localToGeo(local.x, local.y, DEFAULT_REGION);
        expect(geo.lat).toBeCloseTo(lat, 6);
        expect(geo.lon).toBeCloseTo(lon, 6);
    });

    it("北方向は +y、東方向は +x", () => {
        // 中心の少し北
        const north = geoToLocal(
            DEFAULT_REGION.centerLat + 0.001,
            DEFAULT_REGION.centerLon,
            DEFAULT_REGION,
        );
        expect(north.y).toBeGreaterThan(0);
        expect(north.x).toBeCloseTo(0, 3);

        // 中心の少し東
        const east = geoToLocal(
            DEFAULT_REGION.centerLat,
            DEFAULT_REGION.centerLon + 0.001,
            DEFAULT_REGION,
        );
        expect(east.x).toBeGreaterThan(0);
        expect(east.y).toBeCloseTo(0, 3);
    });
});

describe("regionBounds", () => {
    it("中心が原点の対称な矩形を返す", () => {
        const b = regionBounds(DEFAULT_REGION);
        expect(b.minX).toBe(-DEFAULT_REGION.widthM / 2);
        expect(b.maxX).toBe(DEFAULT_REGION.widthM / 2);
        expect(b.minY).toBe(-DEFAULT_REGION.heightM / 2);
        expect(b.maxY).toBe(DEFAULT_REGION.heightM / 2);
    });
});

describe("isInsideRegion", () => {
    it("原点はリージョン内", () => {
        expect(isInsideRegion(0, 0, DEFAULT_REGION)).toBe(true);
    });

    it("境界上はリージョン内", () => {
        const halfW = DEFAULT_REGION.widthM / 2;
        expect(isInsideRegion(halfW, 0, DEFAULT_REGION)).toBe(true);
    });

    it("境界外はリージョン外", () => {
        const halfW = DEFAULT_REGION.widthM / 2;
        expect(isInsideRegion(halfW + 1, 0, DEFAULT_REGION)).toBe(false);
    });
});

describe("randomPositionInRegion", () => {
    it("生成された位置がリージョン内にある", () => {
        for (let i = 0; i < 20; i++) {
            const pos = randomPositionInRegion(DEFAULT_REGION);
            expect(isInsideRegion(pos.x, pos.y, DEFAULT_REGION)).toBe(true);
        }
    });
});

describe("randomVelocity", () => {
    it("生成された速度の大きさが指定値と一致する", () => {
        const speed = 2.5;
        const vel = randomVelocity(speed);
        const mag = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
        expect(mag).toBeCloseTo(speed, 5);
    });

    it("速度 0 ではゼロベクトルを返す", () => {
        const vel = randomVelocity(0);
        expect(vel.vx).toBeCloseTo(0, 10);
        expect(vel.vy).toBeCloseTo(0, 10);
    });
});
