/**
 * `src/demos/flight/routeLine.ts` の unit test。
 *
 * 回帰防止: リボン mesh の総頂点数と、毎フレーム流し込む頂点カラーバッファの長さが
 * 一致していること（= sideOrientation の DOUBLESIDE による頂点倍化が起きていないこと）を
 * 検証する。倍化すると複製側が未着色のまま白く描画され、リボンが正しく表示されなくなる。
 */
import { describe, it, expect, afterEach } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

import { createRouteLine } from "../src/demos/flight/routeLine";

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

describe("routeLine - ribbon の頂点カラーバッファ整合性", () => {
    it("ribbon の総頂点数と color バッファ長が一致し、全頂点が着色される", () => {
        const engine = makeEngine();
        const scene = new Scene(engine);
        const route = createRouteLine(scene);
        teardowns.push(() => {
            route.dispose();
            scene.dispose();
            engine.dispose();
        });

        // 1 フレーム更新して頂点・カラーを確定させる。
        route.update(
            { angleDeg: 30, centerLat: 35.681, centerLon: 139.767, radiusM: 2000, altitudeM: 500 },
            1000,
        );

        const ribbon = scene.getMeshByName("flightRouteRibbon");
        expect(ribbon).not.toBeNull();

        const totalVertices = ribbon!.getTotalVertices();
        const colors = ribbon!.getVerticesData(VertexBuffer.ColorKind);
        expect(colors).not.toBeNull();
        // color は 1 頂点あたり 4 要素（RGBA）。総頂点数 × 4 と一致すること。
        expect(colors!.length).toBe(totalVertices * 4);

        // 末尾付近の頂点にも色（アルファ含む）が書き込まれていること（未着色=全0でない）。
        const tail = colors!.slice(colors!.length - 8);
        expect(tail.some((v) => v !== 0)).toBe(true);
    });
});
