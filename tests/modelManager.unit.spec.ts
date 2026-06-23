/**
 * modelManager の `importLoaderForUrl` 単体テスト (Issue #247 / #414)。
 *
 * globe 単一バックエンド化（#414）後、`modelManager` は公開契約 interface と
 * 座標系非依存のローダー解決ユーティリティ `importLoaderForUrl` のみを提供する。
 * ここでは拡張子からの動的 import 振り分けと未対応拡張子の throw を検証する。
 *
 * - `@babylonjs/loaders/glTF` / `OBJ` / `STL` の動的 import をスタブ化する。
 */
import { jest } from "@jest/globals";

// ---- glTF 動的 import スタブ ----
jest.unstable_mockModule("@babylonjs/loaders/glTF", () => ({}));

// ---- OBJ 動的 import スタブ ----
jest.unstable_mockModule("@babylonjs/loaders/OBJ", () => ({}));

// ---- STL 動的 import スタブ ----
jest.unstable_mockModule("@babylonjs/loaders/STL", () => ({}));

const { importLoaderForUrl } = await import("../src/terrain/modelManager");

describe("importLoaderForUrl", () => {
    test(".glb で glTF ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.glb")).resolves.toBeUndefined();
    });

    test(".gltf で glTF ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.gltf")).resolves.toBeUndefined();
    });

    test(".obj で OBJ ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.obj")).resolves.toBeUndefined();
    });

    test(".stl で STL ローダーがインポートされる", async () => {
        await expect(importLoaderForUrl("assets/model.stl")).resolves.toBeUndefined();
    });

    test("大文字拡張子 (.GLB) も認識される", async () => {
        await expect(importLoaderForUrl("assets/model.GLB")).resolves.toBeUndefined();
    });

    test("クエリ文字列付き URL でも正しくロードされる", async () => {
        await expect(importLoaderForUrl("assets/model.obj?v=1")).resolves.toBeUndefined();
    });

    test("フラグメント付き URL でも正しくロードされる", async () => {
        await expect(importLoaderForUrl("assets/model.stl#section")).resolves.toBeUndefined();
    });

    test("未対応拡張子 (.fbx) は throw", async () => {
        await expect(importLoaderForUrl("assets/model.fbx")).rejects.toThrow(/unsupported file format/);
    });

    test("拡張子なし URL は throw", async () => {
        await expect(importLoaderForUrl("assets/model")).rejects.toThrow(/unsupported file format/);
    });
});
