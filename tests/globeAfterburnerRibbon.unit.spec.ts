/**
 * `src/demos/flight/globeAfterburner.ts` の統合 unit test（実 NullEngine 使用）。
 *
 * 回帰防止: アフターバーナーのトレイル mesh（左右）の総頂点数と頂点カラーバッファ長が
 * 一致していること（= sideOrientation の DOUBLESIDE による頂点倍化が起きていないこと）を
 * 検証する。倍化すると複製側が未着色（白）のまま additive 合成され、炎が白飛びする。
 *
 * 純関数テストは globeAfterburner.unit.spec.ts が Babylon をモックして担当するため、
 * 実描画モジュールを使うこのテストは別ファイルに分離する。
 */
import { describe, it, expect, afterEach } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

import { createGlobeAfterburner } from "../src/demos/flight/globeAfterburner";

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

describe("globeAfterburner - トレイルの頂点カラーバッファ整合性", () => {
    it("左右トレイル mesh の総頂点数と color バッファ長が一致し、全頂点が着色される", () => {
        const engine = makeEngine();
        const scene = new Scene(engine);
        const ab = createGlobeAfterburner(scene);
        teardowns.push(() => {
            ab.dispose();
            scene.dispose();
            engine.dispose();
        });

        ab.start();
        const ctx = {
            centerLat: 35.681,
            centerLon: 139.767,
            radiusM: 2000,
            altitudeM: 500,
            angleDeg: 30,
        };
        // 初回は履歴初期化のみ、2回目で色バッファをアップロードする。
        ab.update(ctx);
        ab.update({ ...ctx, angleDeg: 33 });

        for (const name of ["globe-afterburner-left", "globe-afterburner-right"]) {
            const mesh = scene.getMeshByName(name);
            expect(mesh).not.toBeNull();
            const totalVertices = mesh!.getTotalVertices();
            const colors = mesh!.getVerticesData(VertexBuffer.ColorKind);
            expect(colors).not.toBeNull();
            expect(colors!.length).toBe(totalVertices * 4);
            // 先端付近（バッファ末尾）に色が書き込まれていること。
            const tail = colors!.slice(colors!.length - 8);
            expect(tail.some((v) => v !== 0)).toBe(true);
        }
    });
});
