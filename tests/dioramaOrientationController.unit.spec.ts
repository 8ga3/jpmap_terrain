/**
 * `dioramaOrientationController.ts` のunit test（実 NullEngine + TransformNode 使用）。
 */
import { describe, it, expect, afterEach } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { createDioramaOrientationController } from "../src/lib/internal/diorama/dioramaOrientationController";
import {
    DEFAULT_ROTATION_SPEED_RAD_PER_SEC,
    DEFAULT_HEIGHT_SPEED_M_PER_SEC,
    DEFAULT_HEIGHT_OFFSET_MIN_M,
    DEFAULT_HEIGHT_OFFSET_MAX_M,
} from "../src/lib/internal/diorama/dioramaControllerMapping";

const makeEngine = (): NullEngine =>
    new NullEngine({
        renderWidth: 800,
        renderHeight: 600,
        deterministicLockstep: false,
        lockstepMaxSteps: 1,
        textureSize: 512,
    });

const teardowns: Array<() => void> = [];
afterEach(() => {
    while (teardowns.length) teardowns.pop()!();
});

const makeNode = (): { node: TransformNode; scene: Scene } => {
    const engine = makeEngine();
    const scene = new Scene(engine);
    const node = new TransformNode("test-orientation-root", scene);
    teardowns.push(() => {
        scene.dispose();
        engine.dispose();
    });
    return { node, scene };
};

describe("createDioramaOrientationController", () => {
    it("初期状態はノードの現在のrotation.y/position.yを引き継ぐ", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        expect(oc.getRotationRad()).toBe(0);
        expect(oc.getHeightOffsetM()).toBe(0);
    });

    it("dtSecondsが0以下ならfeedAxesは何もしない", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        oc.feedAxes(1, 0, 1, 0);
        oc.feedAxes(1, 0, 1, -1);
        expect(oc.getRotationRad()).toBe(0);
        expect(oc.getHeightOffsetM()).toBe(0);
        expect(node.rotation.y).toBe(0);
        expect(node.position.y).toBe(0);
    });

    it("回転軸入力でrotation.yが累積更新される", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);

        oc.feedAxes(1, 0, 0, 1);
        expect(oc.getRotationRad()).toBeCloseTo(DEFAULT_ROTATION_SPEED_RAD_PER_SEC, 10);
        expect(node.rotation.y).toBeCloseTo(DEFAULT_ROTATION_SPEED_RAD_PER_SEC, 10);

        oc.feedAxes(1, 0, 0, 1);
        expect(oc.getRotationRad()).toBeCloseTo(DEFAULT_ROTATION_SPEED_RAD_PER_SEC * 2, 10);
    });

    it("負の回転入力で逆方向へ累積する", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        oc.feedAxes(-1, 0, 0, 1);
        expect(oc.getRotationRad()).toBeCloseTo(-DEFAULT_ROTATION_SPEED_RAD_PER_SEC, 10);
    });

    it("右トリガー入力でposition.yが上昇する", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        oc.feedAxes(0, 0, 1, 1);
        expect(oc.getHeightOffsetM()).toBeCloseTo(DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
        expect(node.position.y).toBeCloseTo(DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
    });

    it("左トリガー入力でposition.yが下降する", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        oc.feedAxes(0, 1, 0, 1);
        expect(oc.getHeightOffsetM()).toBeCloseTo(-DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
    });

    it("高さオフセットは既定の下限・上限でクランプされる", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        // 極端に長時間の押下でも上限を超えない。
        oc.feedAxes(0, 0, 1, 1000);
        expect(oc.getHeightOffsetM()).toBe(DEFAULT_HEIGHT_OFFSET_MAX_M);
        expect(node.position.y).toBe(DEFAULT_HEIGHT_OFFSET_MAX_M);

        oc.feedAxes(0, 1, 0, 1000);
        expect(oc.getHeightOffsetM()).toBe(DEFAULT_HEIGHT_OFFSET_MIN_M);
    });

    it("回転と高さ変更を同時に入力しても互いに独立して更新される", () => {
        const { node } = makeNode();
        const oc = createDioramaOrientationController(node);
        oc.feedAxes(1, 0, 1, 1);
        expect(oc.getRotationRad()).toBeCloseTo(DEFAULT_ROTATION_SPEED_RAD_PER_SEC, 10);
        expect(oc.getHeightOffsetM()).toBeCloseTo(DEFAULT_HEIGHT_SPEED_M_PER_SEC, 10);
    });

    it("初期状態でノードの既存position.yが可動域外なら生成時にクランプする", () => {
        const { node } = makeNode();
        node.position.y = 999;
        const oc = createDioramaOrientationController(node);
        expect(oc.getHeightOffsetM()).toBe(DEFAULT_HEIGHT_OFFSET_MAX_M);
        expect(node.position.y).toBe(DEFAULT_HEIGHT_OFFSET_MAX_M);
    });

    describe("setRotationRad", () => {
        it("回転角を明示的に設定できる", () => {
            const { node } = makeNode();
            const oc = createDioramaOrientationController(node);
            oc.setRotationRad(1.5);
            expect(oc.getRotationRad()).toBe(1.5);
            expect(node.rotation.y).toBe(1.5);
        });
    });

    describe("setHeightOffsetM", () => {
        it("高さオフセットを明示的に設定できる", () => {
            const { node } = makeNode();
            const oc = createDioramaOrientationController(node);
            oc.setHeightOffsetM(0.2);
            expect(oc.getHeightOffsetM()).toBe(0.2);
            expect(node.position.y).toBe(0.2);
        });

        it("既定の下限・上限でクランプされる", () => {
            const { node } = makeNode();
            const oc = createDioramaOrientationController(node);
            oc.setHeightOffsetM(DEFAULT_HEIGHT_OFFSET_MAX_M + 100);
            expect(oc.getHeightOffsetM()).toBe(DEFAULT_HEIGHT_OFFSET_MAX_M);
            oc.setHeightOffsetM(DEFAULT_HEIGHT_OFFSET_MIN_M - 100);
            expect(oc.getHeightOffsetM()).toBe(DEFAULT_HEIGHT_OFFSET_MIN_M);
        });
    });
});
