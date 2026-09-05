/**
 * `src/demos/avatar-controller/cameraControl.ts` の unit test。
 *
 * 右ジョイスティックによるカメラ制御（azimuth/tilt）の純粋関数をテストする。
 */
import { describe, expect, it } from "vitest";

import {
    AZIMUTH_SPEED_DPS,
    computeCameraControl,
    TILT_MAX_DEG,
    TILT_MIN_DEG,
    TILT_SPEED_DPS,
} from "../src/demos/avatar-controller/cameraControl";

describe("computeCameraControl", () => {
    describe("方位角（azimuth）制御", () => {
        // viewer.azimuth 規約は「北=0°・東回り正（時計回り正）」なので、
        // 右スティック右（時計回り）= azimuth 増加、左（反時計回り）= azimuth 減少。
        it("右スティック右入力で azimuth が増加する（時計回り）", () => {
            const result = computeCameraControl(
                { vx: 1, vy: 0 },
                1.0,
                false,
                45,
            );
            expect(result.deltaAzimuth).toBeCloseTo(AZIMUTH_SPEED_DPS, 1);
            expect(result.deltaTilt).toBe(0);
        });

        it("右スティック左入力で azimuth が減少する（反時計回り）", () => {
            const result = computeCameraControl(
                { vx: -1, vy: 0 },
                1.0,
                false,
                45,
            );
            expect(result.deltaAzimuth).toBeCloseTo(-AZIMUTH_SPEED_DPS, 1);
        });

        it("dtSec に比例して変化量が増える", () => {
            const r1 = computeCameraControl({ vx: 1, vy: 0 }, 0.5, false, 45);
            const r2 = computeCameraControl({ vx: 1, vy: 0 }, 1.0, false, 45);
            expect(Math.abs(r2.deltaAzimuth)).toBeCloseTo(
                Math.abs(r1.deltaAzimuth) * 2,
                1,
            );
        });

        it("2D モードでも azimuth は操作可能", () => {
            const result = computeCameraControl({ vx: 1, vy: 0 }, 1.0, true, 0);
            expect(result.deltaAzimuth).not.toBe(0);
        });
    });

    describe("チルト角（tilt）制御", () => {
        it("右スティック後ろ入力で tilt が増加する（水平方向へ）", () => {
            const result = computeCameraControl(
                { vx: 0, vy: -1 },
                0.5,
                false,
                45,
            );
            // 0.5秒 × 60°/s = 30° 増加。45+30=75<MAX(89) なのでクランプされずフル変化
            expect(result.deltaTilt).toBeCloseTo(TILT_SPEED_DPS * 0.5, 1);
        });

        it("右スティック前入力で tilt が減少する（真上方向へ）", () => {
            const result = computeCameraControl(
                { vx: 0, vy: 1 },
                0.5,
                false,
                45,
            );
            // 0.5秒 × 60°/s = 30° 減少。45-30=15>MIN(6) なのでクランプされずフル変化
            expect(result.deltaTilt).toBeCloseTo(-TILT_SPEED_DPS * 0.5, 1);
        });

        it("2D モード時は tilt 変化が 0 になる", () => {
            const result = computeCameraControl(
                { vx: 0, vy: -1 },
                1.0,
                true,
                45,
            );
            expect(result.deltaTilt).toBe(0);
        });

        it("tilt が TILT_MAX_DEG を超えないようクランプされる", () => {
            const result = computeCameraControl(
                { vx: 0, vy: -1 },
                1.0,
                false,
                TILT_MAX_DEG - 5,
            );
            expect(result.deltaTilt).toBeLessThanOrEqual(5);
            expect(TILT_MAX_DEG - 5 + result.deltaTilt).toBeLessThanOrEqual(
                TILT_MAX_DEG,
            );
        });

        it("tilt が TILT_MIN_DEG を下回らないようクランプされる", () => {
            const result = computeCameraControl(
                { vx: 0, vy: 1 },
                1.0,
                false,
                TILT_MIN_DEG + 3,
            );
            expect(TILT_MIN_DEG + 3 + result.deltaTilt).toBeGreaterThanOrEqual(
                TILT_MIN_DEG,
            );
        });
    });

    describe("デッドゾーン", () => {
        it("入力がデッドゾーン未満のとき変化量が 0", () => {
            const result = computeCameraControl(
                { vx: 0.05, vy: 0.05 },
                1.0,
                false,
                45,
            );
            expect(result.deltaAzimuth).toBe(0);
            expect(result.deltaTilt).toBe(0);
        });
    });

    describe("エッジケース", () => {
        it("dtSec が 0 のとき変化量が 0", () => {
            const result = computeCameraControl(
                { vx: 1, vy: -1 },
                0,
                false,
                45,
            );
            expect(result.deltaAzimuth).toBe(0);
            expect(result.deltaTilt).toBe(0);
        });

        it("dtSec が負のとき変化量が 0", () => {
            const result = computeCameraControl(
                { vx: 1, vy: -1 },
                -0.016,
                false,
                45,
            );
            expect(result.deltaAzimuth).toBe(0);
            expect(result.deltaTilt).toBe(0);
        });

        it("入力が (0, 0) のとき変化量が 0", () => {
            const result = computeCameraControl(
                { vx: 0, vy: 0 },
                1.0,
                false,
                45,
            );
            expect(result.deltaAzimuth).toBe(0);
            expect(result.deltaTilt).toBe(0);
        });
    });
});
