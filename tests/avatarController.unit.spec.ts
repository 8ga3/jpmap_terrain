/**
 * `src/demos/avatar-controller/movement.ts` の unit test (Issue #270)。
 *
 * 入力ベクトル合成・デッドゾーン・移動・方位計算の純粋関数を検証する。
 */
import { describe, it, expect } from "@jest/globals";

import {
    applyDeadzone,
    combineInputs,
    keyboardVector,
    moveVectorMagnitude,
    movementHeading,
    rotateByAzimuth,
    stepPosition,
} from "../src/demos/avatar-controller/movement";

describe("keyboardVector", () => {
    it("矢印キー上で北方向 (vy=1)", () => {
        const v = keyboardVector(new Set(["ArrowUp"]));
        expect(v).toEqual({ vx: 0, vy: 1 });
    });

    it("W で北、D で東", () => {
        expect(keyboardVector(new Set(["KeyW"]))).toEqual({ vx: 0, vy: 1 });
        expect(keyboardVector(new Set(["KeyD"]))).toEqual({ vx: 1, vy: 0 });
    });

    it("S+A で南西方向", () => {
        const v = keyboardVector(new Set(["KeyS", "KeyA"]));
        expect(v).toEqual({ vx: -1, vy: -1 });
    });

    it("対向キー同時押しは打ち消し合う", () => {
        const v = keyboardVector(new Set(["ArrowUp", "ArrowDown"]));
        expect(v).toEqual({ vx: 0, vy: 0 });
    });

    it("矢印キーと WASD を同時押しでも (1,1) 以下にクランプ", () => {
        const v = keyboardVector(new Set(["ArrowUp", "KeyW", "ArrowRight", "KeyD"]));
        expect(v).toEqual({ vx: 1, vy: 1 });
    });

    it("空の Set は (0,0)", () => {
        expect(keyboardVector(new Set())).toEqual({ vx: 0, vy: 0 });
    });
});

describe("applyDeadzone", () => {
    it("デッドゾーン未満は (0,0)", () => {
        expect(applyDeadzone({ vx: 0.05, vy: 0 }, 0.1)).toEqual({ vx: 0, vy: 0 });
    });

    it("デッドゾーン超過時は (|v|-dz)/(1-dz) で再スケール", () => {
        const v = applyDeadzone({ vx: 0.55, vy: 0 }, 0.1);
        expect(v.vx).toBeCloseTo(0.5, 5);
        expect(v.vy).toBeCloseTo(0, 5);
    });

    it("最大入力 (|v|=1) は (|v|=1) のまま", () => {
        const v = applyDeadzone({ vx: 1, vy: 0 }, 0.1);
        expect(moveVectorMagnitude(v)).toBeCloseTo(1, 5);
    });
});

describe("combineInputs", () => {
    it("複数入力のうち最大強度のものを採用", () => {
        const v = combineInputs([
            { vx: 0.5, vy: 0 },
            { vx: 0, vy: 1 },
        ]);
        // (0,1) のほうが |v| 大
        expect(v.vx).toBeCloseTo(0, 5);
        expect(v.vy).toBeCloseTo(1, 5);
    });

    it("全入力がデッドゾーン未満なら (0,0)", () => {
        const v = combineInputs([
            { vx: 0.01, vy: 0 },
            { vx: 0, vy: 0.02 },
        ]);
        expect(v).toEqual({ vx: 0, vy: 0 });
    });

    it("単一入力のみでも採用される", () => {
        const v = combineInputs([{ vx: 1, vy: 0 }]);
        expect(moveVectorMagnitude(v)).toBeCloseTo(1, 5);
    });
});

describe("stepPosition", () => {
    const LAT = 35.681236;
    const LON = 139.767125;

    it("北方向ベクトルで緯度が増加", () => {
        const p = stepPosition(LAT, LON, { vx: 0, vy: 1 }, 10, 1);
        expect(p.lat).toBeGreaterThan(LAT);
        expect(p.lon).toBeCloseTo(LON, 8);
    });

    it("東方向ベクトルで経度が増加", () => {
        const p = stepPosition(LAT, LON, { vx: 1, vy: 0 }, 10, 1);
        expect(p.lon).toBeGreaterThan(LON);
        expect(p.lat).toBeCloseTo(LAT, 8);
    });

    it("速度 0 では移動しない", () => {
        const p = stepPosition(LAT, LON, { vx: 1, vy: 1 }, 0, 1);
        expect(p).toEqual({ lat: LAT, lon: LON });
    });

    it("dt 0 では移動しない", () => {
        const p = stepPosition(LAT, LON, { vx: 1, vy: 1 }, 10, 0);
        expect(p).toEqual({ lat: LAT, lon: LON });
    });

    it("北方向に 10 m/s × 1s 移動すると約 10m 北上する", () => {
        const p = stepPosition(LAT, LON, { vx: 0, vy: 1 }, 10, 1);
        const dLatM = (p.lat - LAT) * (Math.PI / 180) * 6_371_008.8;
        expect(dLatM).toBeCloseTo(10, 1);
    });
});

describe("movementHeading", () => {
    it("北方向で 0°", () => {
        expect(movementHeading({ vx: 0, vy: 1 })).toBeCloseTo(0, 5);
    });

    it("東方向で 90°", () => {
        expect(movementHeading({ vx: 1, vy: 0 })).toBeCloseTo(90, 5);
    });

    it("南方向で 180°", () => {
        expect(movementHeading({ vx: 0, vy: -1 })).toBeCloseTo(180, 5);
    });

    it("西方向で 270°", () => {
        expect(movementHeading({ vx: -1, vy: 0 })).toBeCloseTo(270, 5);
    });

    it("(0,0) では null", () => {
        expect(movementHeading({ vx: 0, vy: 0 })).toBeNull();
    });
});

describe("moveVectorMagnitude", () => {
    it("(0,0) で 0", () => {
        expect(moveVectorMagnitude({ vx: 0, vy: 0 })).toBe(0);
    });
    it("(3,4) で 5", () => {
        expect(moveVectorMagnitude({ vx: 3, vy: 4 })).toBeCloseTo(5, 10);
    });
});

describe("rotateByAzimuth", () => {
    it("方位角 0°（北向き）では入力をそのまま返す", () => {
        const v = rotateByAzimuth({ vx: 0, vy: 1 }, 0);
        expect(v.vx).toBeCloseTo(0, 10);
        expect(v.vy).toBeCloseTo(1, 10);
    });

    it("方位角 90°（東向き）でジョイスティック上は西方向になる（azimuth は反時計回り正）", () => {
        const v = rotateByAzimuth({ vx: 0, vy: 1 }, 90);
        expect(v.vx).toBeCloseTo(-1, 10);
        expect(v.vy).toBeCloseTo(0, 10);
    });

    it("方位角 180°（南向き）でジョイスティック上は南方向になる", () => {
        const v = rotateByAzimuth({ vx: 0, vy: 1 }, 180);
        expect(v.vx).toBeCloseTo(0, 10);
        expect(v.vy).toBeCloseTo(-1, 10);
    });

    it("方位角 270°（西向き）でジョイスティック上は東方向になる（azimuth は反時計回り正）", () => {
        const v = rotateByAzimuth({ vx: 0, vy: 1 }, 270);
        expect(v.vx).toBeCloseTo(1, 10);
        expect(v.vy).toBeCloseTo(0, 10);
    });

    it("ベクトルの大きさは保存される", () => {
        const v = rotateByAzimuth({ vx: 0.6, vy: 0.8 }, 37);
        expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(1, 10);
    });
});
