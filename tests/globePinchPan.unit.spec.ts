/**
 * @jest-environment jsdom
 *
 * タッチ操作の2本指ジェスチャ統合テスト（Issue #424）。
 *
 * NullEngine + jsdom で `GlobeScene.createSceneWithController` を実体構築し、canvas へ
 * PointerEvent 相当を dispatch して以下を検証する:
 *   - 1本指タッチのドラッグでは center が動く（パン）。
 *   - 2本指（間隔が広い）で平行移動すると center が動き、ひねりで yaw が変わる（移動＋回転）。
 *   - 2本指（間隔が狭い）で縦移動すると pitch が変わり center は動かない（チルト）。
 *   - 2本指中はシングルタッチパン（dragging 経路）が暴発しない。
 *   - マウス（fine pointer）のドラッグは従来どおりパンする。
 * ピンチズーム自体（GeospatialCamera 側）は scene.pick 依存のため本テスト対象外。
 * 3DCG の見た目は別ゲート（HITL）。
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

describe("globe タッチ 2本指ジェスチャ (#424)", () => {
    it("1本指タッチのドラッグで center が動く", () => {
        const { gc, canvas, teardown } = build();
        const before = centerOf(gc);
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 180, clientY: 160 });
        const moved = Vector3.Distance(before, gc.camera.center);
        expect(moved).toBeGreaterThan(0);
        teardown();
    });

    it("2本指（間隔が広い）平行移動で center が動く（移動）", () => {
        const { gc, canvas, teardown } = build();
        // 間隔を広く（spread ≈ 300px > 160）取って 2本指接地。
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 400, clientY: 200 });
        const before = centerOf(gc);
        // 1本目を縦に動かす → 重心が移動し pan が発火する。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 100, clientY: 260 });
        const moved = Vector3.Distance(before, gc.camera.center);
        expect(moved).toBeGreaterThan(0);
        teardown();
    });

    it("2本指（間隔が広い）ひねりで yaw が変わる（回転）", () => {
        const { gc, canvas, teardown } = build();
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 400, clientY: 200 });
        const yawBefore = gc.camera.yaw;
        // 1本目を回り込ませる（ペアの角度が変化）→ yaw が変わる。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 130, clientY: 280 });
        expect(gc.camera.yaw).not.toBe(yawBefore);
        teardown();
    });

    it("2本指（間隔が狭い）縦移動で pitch が変わり center は動かない（チルト）", () => {
        const { gc, canvas, teardown } = build();
        // 間隔を狭く（spread ≈ 60px < 160）取って 2本指接地。
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 200, clientY: 200 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 260, clientY: 200 });
        const pitchBefore = gc.camera.pitch;
        const centerBefore = centerOf(gc);
        // 1本目を縦に動かす → チルト（pitch 変化）、center は不変。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 200, clientY: 150 });
        expect(gc.camera.pitch).not.toBe(pitchBefore);
        expect(Vector3.Distance(centerBefore, gc.camera.center)).toBe(0);
        teardown();
    });

    it("2本指中はシングルタッチパン（dragging 経路）が暴発しない", () => {
        const { gc, canvas, teardown } = build();
        // 間隔を狭く取り、チルトモードにする。1本目移動で pan（center 移動）は起きないこと。
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 200, clientY: 200 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 250, clientY: 200 });
        const before = centerOf(gc);
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 200, clientY: 160 });
        // チルトのみで center は動かない（シングルパンが暴発していない）。
        expect(Vector3.Distance(before, gc.camera.center)).toBe(0);
        teardown();
    });

    it("移動+回転で開始したら、間隔がしきい値未満になってもモードを維持する", () => {
        const { gc, canvas, teardown } = build();
        // 広い間隔（spread=300 > 160）で開始 → panRotate モードに確定。
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 400, clientY: 200 });
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 120, clientY: 210 });
        // 指を近づけて間隔をしきい値未満（spread≈40 < 160）にする。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 360, clientY: 200 });
        const pitchBefore = gc.camera.pitch;
        const before = centerOf(gc);
        // この状態で縦移動してもチルトせず、移動（center 変化）が続く。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 360, clientY: 240 });
        expect(gc.camera.pitch).toBe(pitchBefore);
        expect(Vector3.Distance(before, gc.camera.center)).toBeGreaterThan(0);
        teardown();
    });

    it("チルトで開始したら、間隔がしきい値以上になってもモードを維持する", () => {
        const { gc, canvas, teardown } = build();
        // 狭い間隔（spread=60 < 160）で開始 → tilt モードに確定。
        dispatchPointer(canvas, "pointerdown", { pointerId: 1, clientX: 200, clientY: 200 });
        dispatchPointer(canvas, "pointerdown", { pointerId: 2, clientX: 260, clientY: 200 });
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: 200, clientY: 190 });
        // 指を広げて間隔をしきい値以上（spread≈300 > 160）にする。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: -40, clientY: 190 });
        const before = centerOf(gc);
        const pitchBefore = gc.camera.pitch;
        // この状態で縦移動しても移動せず、チルト（pitch 変化）が続く。
        dispatchPointer(canvas, "pointermove", { pointerId: 1, clientX: -40, clientY: 150 });
        expect(Vector3.Distance(before, gc.camera.center)).toBe(0);
        expect(gc.camera.pitch).not.toBe(pitchBefore);
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

    it("dispose で canvas に登録した全リスナが解除される（pointercancel 等の解除漏れ防止）", () => {
        const engine = makeEngine();
        const canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        // (type, handler) ペアの追加/解除を記録し、対称性を検証する。
        const added = new Set<string>();
        const removed = new Set<string>();
        const key = (type: string, h: EventListenerOrEventListenerObject): string =>
            `${type}::${(h as { name?: string }).name ?? String(h)}`;
        const origAdd = canvas.addEventListener.bind(canvas);
        const origRemove = canvas.removeEventListener.bind(canvas);
        canvas.addEventListener = ((
            type: string,
            h: EventListenerOrEventListenerObject,
            opts?: boolean | AddEventListenerOptions,
        ): void => {
            added.add(key(type, h));
            origAdd(type, h, opts);
        }) as typeof canvas.addEventListener;
        canvas.removeEventListener = ((
            type: string,
            h: EventListenerOrEventListenerObject,
            opts?: boolean | EventListenerOptions,
        ): void => {
            removed.add(key(type, h));
            origRemove(type, h, opts);
        }) as typeof canvas.removeEventListener;

        const gc = new GlobeScene().createSceneWithController(engine, canvas, {
            lat: 35.36,
            lon: 138.73,
            radius: 60000,
            tilt: 60,
        });
        expect(added.has("pointercancel::onPointerCancel")).toBe(true);
        gc.dispose();

        // 追加された全ペアが解除されていること。
        const notRemoved = [...added].filter((k) => !removed.has(k));
        expect(notRemoved).toEqual([]);

        engine.dispose();
        canvas.remove();
    });
});
