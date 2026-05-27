/**
 * `src/demos/avatar-controller/jump.ts` の unit test (Issue #288)。
 *
 * ジャンプ物理: startJump / tickJump / 着地判定 / 方向ロックを検証する。
 */
import { describe, it, expect } from "@jest/globals";

import {
    DEFAULT_GRAVITY,
    DEFAULT_JUMP_HEIGHT,
    isJumping,
    JUMP_IDLE,
    startJump,
    tickJump,
} from "../src/demos/avatar-controller/jump";

describe("startJump", () => {
    it("active=true で初速が正の値になる", () => {
        const state = startJump(DEFAULT_JUMP_HEIGHT, DEFAULT_GRAVITY, { vx: 0, vy: 0 });
        expect(state.active).toBe(true);
        expect(state.velocity).toBeGreaterThan(0);
        expect(state.altitude).toBe(0);
    });

    it("初速が v₀ = √(2*g*h) になる", () => {
        const h = 100;
        const g = 9.81;
        const state = startJump(h, g, { vx: 0, vy: 0 });
        const expected = Math.sqrt(2 * g * h);
        expect(state.velocity).toBeCloseTo(expected, 5);
    });

    it("方向がロックされる", () => {
        const dir = { vx: 0.5, vy: -0.3 };
        const state = startJump(100, 9.81, dir);
        expect(state.lockedDirection).toEqual(dir);
    });

    it("jumpHeight=0 なら初速 0", () => {
        const state = startJump(0, 9.81, { vx: 0, vy: 0 });
        expect(state.velocity).toBe(0);
    });

    it("負の jumpHeight は 0 にクランプされる", () => {
        const state = startJump(-10, 9.81, { vx: 0, vy: 0 });
        expect(state.velocity).toBe(0);
    });
});

describe("tickJump", () => {
    it("上昇中は altitude が増加する", () => {
        const state = startJump(100, 9.81, { vx: 0, vy: 0 });
        const next = tickJump(state, 9.81, 0.016);
        expect(next.altitude).toBeGreaterThan(0);
        expect(next.active).toBe(true);
    });

    it("velocity は重力で減少する", () => {
        const state = startJump(100, 9.81, { vx: 0, vy: 0 });
        const next = tickJump(state, 9.81, 0.016);
        expect(next.velocity).toBeLessThan(state.velocity);
    });

    it("着地すると IDLE に戻る", () => {
        // 大きな dt で確実に着地させる
        const state = startJump(10, 9.81, { vx: 1, vy: 0 });
        const landed = tickJump(state, 9.81, 100);
        expect(landed.active).toBe(false);
        expect(landed.altitude).toBe(0);
        expect(landed.velocity).toBe(0);
    });

    it("active=false なら何もしない", () => {
        const result = tickJump(JUMP_IDLE, 9.81, 0.016);
        expect(result).toBe(JUMP_IDLE);
    });

    it("dtSec <= 0 なら状態を保持する", () => {
        const state = startJump(100, 9.81, { vx: 0, vy: 0 });
        expect(tickJump(state, 9.81, 0)).toBe(state);
        expect(tickJump(state, 9.81, -1)).toBe(state);
    });

    it("lockedDirection はフレーム更新で変化しない", () => {
        const dir = { vx: 0.7, vy: 0.2 };
        const state = startJump(200, 9.81, dir);
        const next = tickJump(state, 9.81, 0.016);
        expect(next.lockedDirection).toEqual(dir);
    });

    it("十分な時間が経つと正確に着地する（放物運動）", () => {
        const h = 50;
        const g = 9.81;
        // 理論的な滞空時間: t = 2 * v₀ / g = 2 * √(2gh) / g
        const v0 = Math.sqrt(2 * g * h);
        const totalTime = (2 * v0) / g;

        // 小さいステップで積分
        let state = startJump(h, g, { vx: 0, vy: 0 });
        const dt = 0.001;
        let time = 0;
        while (state.active && time < totalTime * 2) {
            state = tickJump(state, g, dt);
            time += dt;
        }
        // 着地していること
        expect(state.active).toBe(false);
        // 滞空時間が理論値に近いこと（数値誤差 1% 以内）
        expect(time).toBeCloseTo(totalTime, 1);
    });
});

describe("isJumping", () => {
    it("IDLE では false", () => {
        expect(isJumping(JUMP_IDLE)).toBe(false);
    });

    it("startJump 後は true", () => {
        const state = startJump(100, 9.81, { vx: 0, vy: 0 });
        expect(isJumping(state)).toBe(true);
    });
});
