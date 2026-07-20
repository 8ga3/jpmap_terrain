/**
 * 箱庭ジオラマビューア（diorama）デモ。
 *
 * @remarks
 * 地形を手元サイズの円形「箱庭」として表示するWebXR対応デモ。地形は
 * `terrain/diorama/dioramaTerrain`（放射状グリッド + 実世界DEM/タイル取得 +
 * 縮小スケール）で構築する。GlobeScene（実寸大ECEF楕円体 + floating origin）は
 * 使わない独立実装のため、本デモは `JpmapTerrain` に依存しない。
 * - WebXR (`immersive-ar`) セッション統合（`webXrArSession.ts`）により、箱庭の周りを
 *   歩いて見られるパススルーAR表示に対応する。
 * - コントローラー操作（地図移動・拡大縮小・箱庭回転・高さ変更・ライティング・
 *   タイル切替・トップ復帰）は後続タスクで行う。
 */
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4, Color3 } from "@babylonjs/core/Maths/math.color";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import { createDioramaTerrain } from "../../terrain/diorama/dioramaTerrain";
import { setupDioramaWebXrArButton } from "./webXrArSession";

const DEMO_MOUNT_ID = "root";

/** 既定の箱庭中心（富士山・富士宮口五合目付近の山腹。単調な斜面が見える地点）。 */
const DEFAULT_CENTER = { lat: 35.3436, lon: 138.7203 };
/** 既定の実世界フットプリント半径[m]。 */
const DEFAULT_FOOTPRINT_RADIUS_M = 800;
/** 既定の卓上表示半径[m]（手元サイズ）。 */
const DEFAULT_TABLE_RADIUS_M = 0.35;

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
        DEFAULT_TABLE_RADIUS_M * 3,
        Vector3.Zero(),
        scene,
    );
    camera.lowerRadiusLimit = DEFAULT_TABLE_RADIUS_M * 1.2;
    camera.upperRadiusLimit = DEFAULT_TABLE_RADIUS_M * 15;
    camera.wheelPrecision = 200;
    camera.attachControl(canvas, true);

    new HemisphericLight("diorama-ambient-light", new Vector3(0, 1, 0), scene).intensity = 0.6;
    const sunLight = new DirectionalLight("diorama-sun-light", new Vector3(-0.4, -1, -0.3), scene);
    sunLight.intensity = 0.8;
    sunLight.diffuse = new Color3(1, 0.98, 0.92);

    const dioramaTerrain = await createDioramaTerrain(scene, {
        center: DEFAULT_CENTER,
        footprintRadiusM: DEFAULT_FOOTPRINT_RADIUS_M,
        tableRadiusM: DEFAULT_TABLE_RADIUS_M,
    });

    setupDioramaWebXrArButton(mount, scene, dioramaTerrain.root).catch((err: unknown) => {
        console.error("[jpmap-terrain diorama demo] failed to set up WebXR AR button:", err);
    });

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
        (window as unknown as { dioramaTerrain: unknown }).dioramaTerrain = dioramaTerrain;
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
