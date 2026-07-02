/**
 * マーカーが地形（山など）に正しくオクルードされることの回帰テスト（Issue #451）。
 *
 * マーカー用 `RENDERING_GROUP_ID` が地形タイルの既定 renderingGroupId（0）と一致することを
 * 検証する。異なるグループにすると、Babylon.js は renderingGroup 間で既定で深度バッファを
 * クリアするため、中間グループ（polygon/circle の頂点球 = 1、ラベル = 2 等）にメッシュが
 * 存在する場合にマーカーが地形の深度を継承できなくなり、山などに正しく隠れなくなる
 * （レビュー指摘: PR #452）。
 * 実際の見た目（山の裏に隠れるか）は 3DCG のため別ゲート（HITL）。
 */
import { describe, it, expect } from "@jest/globals";

import { RENDERING_GROUP_ID as MARKER_RENDERING_GROUP_ID } from "../src/terrain/marker";

const TERRAIN_RENDERING_GROUP_ID = 0;

describe("マーカーの renderingGroupId（Issue #451）", () => {
    it("地形タイルの既定 renderingGroupId=0 と一致する", () => {
        expect(MARKER_RENDERING_GROUP_ID).toBe(TERRAIN_RENDERING_GROUP_ID);
    });
});
