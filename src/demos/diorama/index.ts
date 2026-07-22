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
 * - コントローラー操作（地図移動・拡大縮小・箱庭回転・高さ変更）に対応する。
 *   デスクトップはキーボード（`dioramaKeyboardControls.ts`）、AR中はXRコントローラー/
 *   タッチGUI（`dioramaArControls.ts`）、AR非対応環境・AR突入前の通常表示は
 *   常時表示のタッチHUD（`dioramaTouchControls.ts`）でそれぞれ操作できる。
 *   ライティング・タイル切替・トップ復帰は後続タスクで行う。
 */
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4, Color3 } from "@babylonjs/core/Maths/math.color";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import { createDioramaTerrain } from "../../terrain/diorama/dioramaTerrain";
import { setupDioramaWebXrArButton } from "./webXrArSession";
import { createDioramaViewController } from "./dioramaViewController";
import { createDioramaOrientationController } from "./dioramaOrientationController";
import { setupDioramaKeyboardControls } from "./dioramaKeyboardControls";
import { createDioramaArControlHud } from "./dioramaArControlHud";
import { setupDioramaTouchControls } from "./dioramaTouchControls";

const DEMO_MOUNT_ID = "root";

/** 既定の箱庭中心（富士山・富士宮口五合目付近の山腹。単調な斜面が見える地点）。 */
const DEFAULT_CENTER = { lat: 35.3436, lon: 138.7203 };
/** 既定の実世界フットプリント半径[m]。 */
const DEFAULT_FOOTPRINT_RADIUS_M = 800;
/** 既定の卓上表示半径[m]（手元サイズ）。 */
const DEFAULT_TABLE_RADIUS_M = 0.35;

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する（他デモと同じ規約）。
 * 未指定時は既定で `webgl2` を使う（他デモの既定 `webgpu` とは異なる。理由は
 * {@link start} 内の既定値決定コメント参照）。
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
    // 本デモは既定を `webgl2` にする（他デモの既定 `webgpu` とは異なる）。
    // WebGPU engine で `enterXRAsync` を呼ぶと、XRセッションの `requiredFeatures` へ
    // 自動的に `"webgpu"` が追加されるが、Meta Quest Browser 等はこれを拒否し、
    // WebGLへのフォールバックも行われない（実機検証で確認）。ARが主要機能である
    // 本デモでは対応が枯れている WebGL2 を既定にする。
    const engineType = resolveEngine(location.search) ?? "webgl2";
    // reverse-Z 深度バッファ（既定で全デモ共通に有効）を無効化する。WebXRカメラは
    // ブラウザ提供の生の投影行列をそのまま使う（reverse-Z変換されない、
    // `@babylonjs/core/XR/webXRCamera.js` の `_updateFromXRSession` 参照）ため、
    // reverse-Z前提の深度クリア値・比較関数と組み合わせるとAR中の深度テストが
    // 破綻する（実機検証で確認した地形/側面壁のオクルージョン不具合の根本原因）。
    // diorama は卓上サイズでreverse-Zを必要としないため無効化する。詳細は
    // {@link CreateBabylonEngineOptions.reverseDepthBuffer} 参照。
    const engine = await createBabylonEngine(canvas, engineType, { reverseDepthBuffer: false });

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
    // Babylonの既定 `minZ`（near clip、既定値1）は本デモの `lowerRadiusLimit`
    // （既定0.42m）より大きく、最も寄った状態では箱庭本体がニアクリップされて
    // 消えてしまう（実機/デスクトップ双方で確認）。箱庭の実寸スケール（卓上サイズ、
    // 既定 radius 0.42〜5.25m）に合わせて、ニアクリップをできる限りカメラへ
    // 近づける。`maxZ`も既定（10000）のままだと near:far 比が極端になり深度精度が
    // 悪化するため、本デモで実際に必要な範囲（upperRadiusLimitに十分な余裕を
    // 持たせた程度）へ縮小し、既定と同程度以上の深度精度を保つ。
    camera.minZ = 0.01;
    camera.maxZ = 50;
    camera.wheelPrecision = 200;
    // タッチのピンチズームは既定（絶対量ベース）だと箱庭の極小スケール
    // （既定 radius 0.42〜5.25m）では過敏になる（実機検証で確認）。
    // `useNaturalPinchZoom` はピンチ距離の「比率」で radius を更新するため
    // スケール非依存になる。
    camera.useNaturalPinchZoom = true;
    // pan（camera.target をずらす操作）は無効化する。円形にクリップされた箱庭は
    // pan するとフレームアウトし戻す手段もないため、操作は「回転＋ズーム」のみに
    // 絞る。また、箱庭の実世界中心・フットプリント半径を変更する「地図移動・
    // 拡大縮小」は別途 XRコントローラー専用の操作として実装予定であり、
    // 本カメラの pan とは意味が異なるため混同を避ける。
    camera.panningSensibility = 0;
    // `noPreventDefault=true` だと、macOS Chrome 等のトラックパッド「ピンチ」
    // （`ctrlKey:true` の wheel イベント）がブラウザ既定のページズームに奪われる
    // （実機検証で確認）。`false` を渡し Babylon 側で preventDefault させる。
    camera.attachControl(canvas, false);

    new HemisphericLight("diorama-ambient-light", new Vector3(0, 1, 0), scene).intensity = 0.6;
    const sunLight = new DirectionalLight("diorama-sun-light", new Vector3(-0.4, -1, -0.3), scene);
    sunLight.intensity = 0.8;
    sunLight.diffuse = new Color3(1, 0.98, 0.92);

    const dioramaTerrain = await createDioramaTerrain(scene, {
        center: DEFAULT_CENTER,
        footprintRadiusM: DEFAULT_FOOTPRINT_RADIUS_M,
        tableRadiusM: DEFAULT_TABLE_RADIUS_M,
    });

    // 箱庭の配置・向き・地形を3階層のTransformNodeへ分離する
    // （`dioramaOrientationController.ts` 冒頭のコメント参照）。
    // - placementRoot: AR配置（`webXrArSession.ts`）/デスクトップ既定位置（原点）が
    //   position.x/y/z を絶対値で書く。
    // - orientationRoot: `DioramaOrientationController` が rotation.y（回転）・
    //   position.y（高さオフセット、placementRoot基準のローカル値）を書く。
    // - dioramaTerrain.root: 既存のスケールのみ（無変更）。
    const placementRoot = new TransformNode("diorama-placement-root", scene);
    const orientationRoot = new TransformNode("diorama-orientation-root", scene);
    orientationRoot.parent = placementRoot;
    dioramaTerrain.root.parent = orientationRoot;

    // 地図移動・拡大縮小の共有状態保持者。AR中のコントローラー/GUI操作
    // （`setupDioramaWebXrArButton`経由）とデスクトップのキーボード操作
    // （PC単体でAR無しでも動作確認できるようにする目的）の双方から使われ、
    // どちらで移動しても位置がもう一方に引き継がれる（`dioramaViewController.ts`参照）。
    const viewController = createDioramaViewController(dioramaTerrain, DEFAULT_CENTER, DEFAULT_FOOTPRINT_RADIUS_M);
    // 箱庭の回転・高さオフセットの共有状態保持者（`dioramaOrientationController.ts`参照）。
    // viewControllerと同様、AR/キーボードの双方から使われる。
    const orientationController = createDioramaOrientationController(orientationRoot);
    setupDioramaKeyboardControls(scene, camera, viewController, orientationController);

    // AR非対応環境・AR突入前の通常表示でも、物理コントローラー・キーボードが
    // 無いタッチ専用デバイス（Androidスマホ等）で地図移動・拡大縮小・箱庭回転・
    // 高さ変更を操作できるよう、常時表示のタッチHUDを生成・マウントする
    // （`dioramaTouchControls.ts` 冒頭のコメント参照。AR中に使われる別インスタンスの
    // HUDとは独立しており、二重入力にはならない）。
    const touchHud = createDioramaArControlHud();
    mount.appendChild(touchHud.element);
    const touchControls = setupDioramaTouchControls(scene, touchHud, viewController, orientationController);

    setupDioramaWebXrArButton(
        mount,
        scene,
        placementRoot,
        viewController,
        orientationController,
        touchControls,
    ).catch((err: unknown) => {
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
