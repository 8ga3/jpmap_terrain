/**
 * マーカーが地形（山など）に正しくオクルードされることの回帰テスト。
 *
 * マーカー用 `RENDERING_GROUP_ID` が地形タイルの既定 renderingGroupId（0）と一致することを
 * 検証する。異なるグループにすると、Babylon.js は renderingGroup 間で既定で深度バッファを
 * クリアするため、地形とマーカーの間に空でない中間グループが存在する場合にマーカーが
 * 地形の深度を継承できなくなり、山などに正しく隠れなくなる。
 * 実際の見た目（山の裏に隠れるか）は 3DCG のため別ゲート（HITL）。
 */
import { describe, it, expect } from "vitest";

import { RENDERING_GROUP_ID as MARKER_RENDERING_GROUP_ID } from "../src/terrain/marker";

const TERRAIN_RENDERING_GROUP_ID = 0;

describe("マーカーの renderingGroupId", () => {
    it("地形タイルの既定 renderingGroupId=0 と一致する", () => {
        expect(MARKER_RENDERING_GROUP_ID).toBe(TERRAIN_RENDERING_GROUP_ID);
    });
});
