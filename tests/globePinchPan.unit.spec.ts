/**
 * @jest-environment jsdom
 *
 * タッチ操作のピンチ／シングルタッチ競合ガードの統合テスト（Issue #424）。
 *
 * NullEngine + jsdom で `GlobeScene.createSceneWithController` を実体構築し、canvas へ
 * PointerEvent 相当を dispatch して以下を検証する:
 *   - 1本指タッチのドラッグでは center が動く（従来のパン挙動）。
 *   - 2本指タッチ（ピンチ）進行中は独自シングルタッチパンが発火せず center が動かない。
 *   - マウス（fine pointer）のドラッグは従来どおりパンする。
 * ピンチズーム自体（GeospatialCamera 側）は対象外。3DCG の見た目は別ゲート（HITL）。
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GlobeScene, type GlobeSceneController } from "../src/scenes/globe";

const makeEngine = (): NullEngine =>
    new NullEngine({
        renderWidth: 800,
        renderHeight: 600,
        deterministicLockstep: false,
        lockstepMaxSteps: 1,
        textureSize: 512,
    });

interface Built {
    gc: GlobeSceneController;
    canvas: HTMLCanvasElement;
    teardown: () => void;
}

const activeTeardowns: Array<() => void> = [];

const build = (): Built => {
    const engine = makeEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const gc = new GlobeScene().createSceneWithController(engine, canvas, {
        lat: 35.36,
        lon: 138.73,
        radius: 60000,
        tilt: 60,
    });
    let torn = false;
    const teardown = (): void => {
        if (torn) return;
        torn = true;
        gc.dispose();
        engine.dispose();
        canvas.remove();
    };
    activeTeardowns.push(teardown);
    return { gc, canvas, teardown };
};

afterEach(() => {
    for (const teardown of activeTeardowns.splice(0)) teardown();
});

interface PointerProps {
    pointerType?: string;
    pointerId?: number;
    button?: number;
    clientX?: number;
    clientY?: number;
}

const dispatchPointer = (
    canvas: HTMLCanvasElement,
    type: string,
    props: PointerProps,
): void => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, {
        pointerType: "touch",
        pointerId: 1,
        button: 0,
        clientX: 0,
        clientY: 0,
        ...props,
    });
    canvas.dispatchEvent(ev);
};

const centerOf = (gc: GlobeSceneController): Vector3 => gc.camera.center.clone();

describe("globe タッチ ピンチ/シングルタッチ競合ガード (#424)", () => {
    it("1本指タッチのドラッグで center が動く", () => {
        const { gc, canvas, teardown } = build();
        const before = centerOf(gc);
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 180, clientY: 160 });
        const moved = Vector3.Distance(before, gc.camera.center);
        expect(moved).toBeGreaterThan(0);
        teardown();
    });

    it("2本指タッチ（ピンチ）進行中は center が動かない", () => {
        const { gc, canvas, teardown } = build();
        // 1本目を接地（この時点ではまだドラッグ可能）。
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
        // 2本目を接地 → マルチタッチ判定。以降パンは無効化されるべき。
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 300, clientY: 300 });
        const before = centerOf(gc);
        // 1本目を動かしてもパンしない。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 180, clientY: 160 });
        const moved = Vector3.Distance(before, gc.camera.center);
        expect(moved).toBe(0);
        teardown();
    });

    it("ピンチ後に全指を離すと次の1本指で再びパンできる", () => {
        const { gc, canvas, teardown } = build();
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 300, clientY: 300 });
        dispatchPointer(canvas, "pointerup", { pointerId: 2, clientX: 300, clientY: 300 });
        dispatchPointer(canvas, "pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
        const before = centerOf(gc);
        dispatchPointer(canvas, "pointerdown", { pointerId: 3, clientX: 100, clientY: 100 });
        dispatchPointer(canvas, "pointermove", { pointerId: 3, clientX: 180, clientY: 160 });
        const moved = Vector3.Distance(before, gc.camera.center);
        expect(moved).toBeGreaterThan(0);
        teardown();
    });

    it("マウス（fine pointer）のドラッグは従来どおりパンする", () => {
        const { gc, canvas, teardown } = build();
        const before = centerOf(gc);
        dispatchPointer(canvas, "pointerdown", { pointerType: "mouse", pointerId: 1, clientX: 100, clientY: 100 });
        dispatchPointer(canvas, "pointermove", { pointerType: "mouse", pointerId: 1, clientX: 180, clientY: 160 });
        const moved = Vector3.Distance(before, gc.camera.center);
        expect(moved).toBeGreaterThan(0);
        teardown();
    });
});
