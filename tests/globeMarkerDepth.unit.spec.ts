/**
 * @jest-environment jsdom
 *
 * マーカーが地形（山など）に正しくオクルードされることの回帰テスト（Issue #451）。
 *
 * NullEngine で `GlobeScene.createSceneWithController` を実体構築し、マーカー用
 * renderingGroup（`marker.RENDERING_GROUP_ID`）が地形と深度バッファを共有する設定
 * （`autoClearDepthStencil = false`）になっていることを検証する。
 * これが true のままだと、深度バッファが毎フレームクリアされマーカーが常に手前に
 * 描画されてしまう（Babylon.js の renderingGroup 既定値）。
 * 実際の見た目（山の裏に隠れるか）は 3DCG のため別ゲート（HITL）。
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";

import { GlobeScene, type GlobeSceneController } from "../src/scenes/globe";
import { RENDERING_GROUP_ID as MARKER_RENDERING_GROUP_ID } from "../src/terrain/marker";

const activeTeardowns: Array<() => void> = [];

afterEach(() => {
    for (const teardown of activeTeardowns.splice(0)) teardown();
});

const build = (): GlobeSceneController => {
    const engine = new NullEngine({
        renderWidth: 800,
        renderHeight: 600,
        deterministicLockstep: false,
        lockstepMaxSteps: 1,
        textureSize: 512,
    });
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const gc = new GlobeScene().createSceneWithController(engine, canvas, {
        lat: 35.36,
        lon: 138.73,
        radius: 60000,
        tilt: 60,
    });
    activeTeardowns.push(() => {
        gc.dispose();
        engine.dispose();
        canvas.remove();
    });
    return gc;
};

describe("マーカーの深度バッファ共有設定（Issue #451）", () => {
    it("マーカー用 renderingGroup は autoClearDepthStencil=false（地形の深度を継承する）", () => {
        const gc = build();
        const setup = gc.scene.getAutoClearDepthStencilSetup(MARKER_RENDERING_GROUP_ID);
        expect(setup?.autoClear).toBe(false);
    });
});
