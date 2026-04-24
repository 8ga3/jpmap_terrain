import { computePoseForNewTarget, RetargetLimits } from "../src/terrain/cameraRetarget";

const LIMITS: RetargetLimits = {
    lowerBeta: 0.1,
    upperBeta: Math.PI / 2 - Math.PI / 12,
    lowerRadius: 50,
    upperRadius: 75000,
};

/** alpha, beta, radius, target から P を組み立てる（Babylon 規約と同じ式） */
const buildCamPos = (
    alpha: number,
    beta: number,
    radius: number,
    target: { x: number; y: number; z: number },
) => {
    const sinB = Math.sin(beta);
    const cosB = Math.cos(beta);
    return {
        x: target.x + radius * sinB * Math.cos(alpha),
        y: target.y + radius * cosB,
        z: target.z + radius * sinB * Math.sin(alpha),
    };
};

describe("computePoseForNewTarget", () => {
    describe("apply: ワールド位置を保持したまま新ターゲットに再射影", () => {
        it("target を平行移動した場合、新 alpha/beta/radius で同じカメラ位置を復元できる", () => {
            const target = { x: 0, y: 0, z: 0 };
            const alpha = -Math.PI / 2;
            const beta = Math.PI / 3;
            const radius = 4000;
            const camPos = buildCamPos(alpha, beta, radius, target);

            const newTarget = { x: 1000, y: 100, z: -500 };
            const result = computePoseForNewTarget(camPos, newTarget, alpha, LIMITS);
            expect(result.action).toBe("apply");
            if (result.action !== "apply") return;

            const restored = buildCamPos(
                result.alpha,
                result.beta,
                result.radius,
                newTarget,
            );
            expect(restored.x).toBeCloseTo(camPos.x, 6);
            expect(restored.y).toBeCloseTo(camPos.y, 6);
            expect(restored.z).toBeCloseTo(camPos.z, 6);
        });

        it("初期カメラ方位 (alpha=-π/2) で target=原点のとき atan2(Vz,Vx) が -π/2 になる", () => {
            const target = { x: 0, y: 0, z: 0 };
            const alpha = -Math.PI / 2;
            const beta = Math.PI / 3;
            const radius = 4000;
            const camPos = buildCamPos(alpha, beta, radius, target);

            const result = computePoseForNewTarget(camPos, target, alpha, LIMITS);
            expect(result.action).toBe("apply");
            if (result.action !== "apply") return;
            expect(result.alpha).toBeCloseTo(-Math.PI / 2, 6);
            expect(result.beta).toBeCloseTo(beta, 6);
            expect(result.radius).toBeCloseTo(radius, 6);
        });
    });

    describe("skip: limit 逸脱や特異点で既存値を維持させる", () => {
        it("カメラ位置と新ターゲットがほぼ一致するなら degenerate", () => {
            const camPos = { x: 10, y: 10, z: 10 };
            const newTarget = { x: 10, y: 10, z: 10 };
            const result = computePoseForNewTarget(camPos, newTarget, 0, LIMITS);
            expect(result).toEqual({ action: "skip", reason: "degenerate" });
        });

        it("radius が lowerRadius を下回ると radiusOutOfRange", () => {
            const camPos = { x: 0, y: 10, z: 0 };
            const newTarget = { x: 0, y: 0, z: 0 };
            const result = computePoseForNewTarget(camPos, newTarget, 0, LIMITS);
            expect(result).toEqual({ action: "skip", reason: "radiusOutOfRange" });
        });

        it("radius が upperRadius を超えると radiusOutOfRange", () => {
            const camPos = { x: 100000, y: 0, z: 0 };
            const newTarget = { x: 0, y: 0, z: 0 };
            const result = computePoseForNewTarget(camPos, newTarget, 0, LIMITS);
            expect(result).toEqual({ action: "skip", reason: "radiusOutOfRange" });
        });

        it("beta が upperBeta を超える水平視点だと betaOutOfRange", () => {
            // カメラとターゲットがほぼ同じ高さ → beta ≈ π/2 で upperBeta を超える
            const camPos = { x: 1000, y: 0, z: 0 };
            const newTarget = { x: 0, y: 0, z: 0 };
            const result = computePoseForNewTarget(camPos, newTarget, 0, LIMITS);
            expect(result).toEqual({ action: "skip", reason: "betaOutOfRange" });
        });

        it("beta が lowerBeta を下回る真下視点だと betaOutOfRange", () => {
            // カメラがターゲット真上 → beta ≈ 0 で lowerBeta を下回る
            const camPos = { x: 0, y: 1000, z: 0 };
            const newTarget = { x: 0, y: 0, z: 0 };
            const result = computePoseForNewTarget(camPos, newTarget, 0, LIMITS);
            expect(result).toEqual({ action: "skip", reason: "betaOutOfRange" });
        });
    });

    describe("特異点: sin(beta)≈0 のとき alpha は currentAlpha を保持", () => {
        it("真下視点（lowerBeta ちょうど）では currentAlpha が採用される", () => {
            // lowerBeta = 0.1 → sin(0.1) ≈ 0.0998（しきい値 1e-4 を超えるため通常 atan2 が使われる想定）
            // より極端なケース: limits を緩めて sin(beta)=0（真下視点）を許容し、alpha 保持を確認
            const strictLimits: RetargetLimits = { ...LIMITS, lowerBeta: 0 };
            const camPos = { x: 0, y: 1000, z: 0 };
            const newTarget = { x: 0, y: 0, z: 0 };
            const currentAlpha = 1.2345;
            const result = computePoseForNewTarget(camPos, newTarget, currentAlpha, strictLimits);
            expect(result.action).toBe("apply");
            if (result.action !== "apply") return;
            expect(result.alpha).toBe(currentAlpha);
        });
    });
});
