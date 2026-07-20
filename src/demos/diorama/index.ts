/**
 * 箱庭ジオラマビューア（diorama）デモ雛形。
 *
 * @remarks
 * #535「地形ジオラマビューア WebXR対応」のサブタスク #536。本ファイルは後続サブタスクの
 * 土台となる最小限の雛形であり、現時点では地形は描画せず、円形プレースホルダーメッシュ
 * （箱庭の外形サイズ感の確認用）と最小限のライティングのみを表示する。
 * - 地形メッシュ生成・円形クリップの実装は #537 で行う（`JpmapTerrain`/`GlobeScene` の
 *   実寸大 ECEF 前提をそのまま使うか、専用の縮小スケール実装にするかは #537 の
 *   Architect 工程で決定する。そのため本雛形は `JpmapTerrain` に依存しない）。
 * - WebXR (immersive-vr) セッション統合は #538 で行う。
 * - コントローラー操作（地図移動・拡大縮小・箱庭回転・高さ変更・ライティング・
 *   タイル切替・トップ復帰）は #539〜#542 で行う。
 */
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";

const DEMO_MOUNT_ID = "root";

/** プレースホルダー円盤（箱庭の外形サイズ感の確認用）の半径 [m]。 */
const PLACEHOLDER_RADIUS_M = 1;

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する（他デモと同じ規約）。
 * 未指定時は `JpmapTerrain` 既定と同じ自動判定（WebGPU 優先・WebGL2 フォールバック）に委ねる。
 */
const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/** canvas を mountElement に配置する（`JpmapTerrain` 内部初期化と同じスタイル規約）。 */
const createCanvas = (mountElement: HTMLElement): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.outline = "none";
    canvas.style.touchAction = "none";
    mountElement.appendChild(canvas);
    return canvas;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }
    const canvas = createCanvas(mount);
    const engineType = resolveEngine(location.search) ?? "webgpu";
    const engine = await createBabylonEngine(canvas, engineType);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.07, 0.1, 1);

    const camera = new ArcRotateCamera(
        "diorama-camera",
        -Math.PI / 2,
        Math.PI / 3,
        4,
        Vector3.Zero(),
        scene,
    );
    camera.lowerRadiusLimit = 1.5;
    camera.upperRadiusLimit = 20;
    camera.attachControl(canvas, true);

    new HemisphericLight("diorama-light", new Vector3(0, 1, 0), scene);

    // 地形実装（#537）までの一時的なプレースホルダー。箱庭の円形外形サイズ感のみ確認する。
    CreateDisc(
        "diorama-placeholder",
        { radius: PLACEHOLDER_RADIUS_M, tessellation: 64 },
        scene,
    ).rotation.x = Math.PI / 2;

    engine.runRenderLoop(() => {
        scene.render();
    });

    const onResize = (): void => engine.resize();
    window.addEventListener("resize", onResize);
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => engine.resize());
        ro.observe(mount);
    }

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する（他デモと同じ規約）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { scene: unknown }).scene = scene;
        (window as unknown as { engine: unknown }).engine = engine;
    }
};

// `#root` が無い環境（テスト環境等）では副作用としてのデモ起動をスキップする。
if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain diorama demo] failed to start:", err);
    });
}
