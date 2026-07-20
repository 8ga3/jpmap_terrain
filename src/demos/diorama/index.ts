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
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4, Color3 } from "@babylonjs/core/Maths/math.color";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import { createDioramaTerrain } from "../../terrain/diorama/dioramaTerrain";
import { setupDioramaWebXrArButton } from "./webXrArSession";
import { createArDebugOverlay } from "./arDebugOverlay";
// [一時的] 実機AR診断用。詳細は primitiveArTest.ts 冒頭コメント参照。診断が終わったら削除する。
import { createPrimitiveArTestObjects } from "./primitiveArTest";

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
    // [実機診断用] devtoolsが使えない実機（Meta Quest 3 / Android Chrome等）でも
    // 画面上で直接ログを確認できるようにする。
    const debugOverlay = createArDebugOverlay(mount);
    debugOverlay.log("start() begin");
    // 他デモは既定で `webgpu` を優先するが、本デモは既定を `webgl2` にする
    // （`?engine=webgpu` で明示指定すれば従来通りWebGPUを使える）。
    //
    // 理由: Babylon.js は WebGPU engine で `scene.createDefaultXRExperienceAsync` /
    // `enterXRAsync` を呼ぶと、XRセッションの `requiredFeatures` へ自動的に
    // `"webgpu"`（WebXR/WebGPU バインディング仕様の機能記述子）を追加する
    // （`WebXRSessionManager.initializeSessionAsync` 参照）。この機能を要求された
    // ブラウザ側のWebXR実装が対応していない場合（Meta Quest Browser 等、
    // 実機検証で確認済み）、`requestSession` がそのまま reject し、
    // WebGLへのフォールバックは行われない（Babylon側が意図的にフォールバックしない
    // 設計のため）。ARが主要機能である本デモでは、対応が枯れている
    // WebGL2 を既定にしてこのリスクを避ける。
    const engineType = resolveEngine(location.search) ?? "webgl2";
    // reverse-Z 深度バッファ（既定で全デモ共通に有効）を無効化する。
    // diorama は卓上サイズ（メートル単位、near/far比が小さい）でreverse-Zを必要としない一方、
    // WebXRカメラはブラウザ提供の生の投影行列をそのまま使う（reverse-Z変換されない、
    // `@babylonjs/core/XR/webXRCamera.js` の `_updateFromXRSession` 参照）ため、
    // reverse-Z前提の深度クリア値・深度比較関数・`zOffset`符号反転と組み合わさると、
    // AR中の深度テストの前提が一致しなくなる。実機（Meta Quest 3 / Androidスマホ）検証で、
    // renderingGroupId/zOffset/メッシュ統合等の深度回避策では解消できなかった不具合
    // （地形/側面壁のオクルージョン不安定・Androidで基本プリミティブすら描画されない）の
    // 根本原因である可能性が高いと判明したため、無効化する。詳細は
    // {@link CreateBabylonEngineOptions.reverseDepthBuffer} 冒頭コメント参照。
    const engine = await createBabylonEngine(canvas, engineType, { reverseDepthBuffer: false });
    debugOverlay.log(`engine created: ${engine.constructor.name}`);


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
    // タッチのピンチズームは既定 (`pinchPrecision`/`angularSensibility` ベースの絶対量)
    // だと「radius がタブレットサイズ相当」の想定でチューニングされており、箱庭の
    // 極小スケール（既定 radius 0.42〜5.25m）では同じ指の動きが radius レンジ全体を
    // 一気に飛び越えるほど過敏になる（実機検証で確認）。`useNaturalPinchZoom` は
    // ピンチ距離の「比率」で radius を更新するためスケール非依存になり、
    // tableRadiusM を変えても再チューニング不要になる。
    camera.useNaturalPinchZoom = true;
    // pan（右クリックドラッグ・Ctrl+左ドラッグ・タッチの2本指ドラッグ等で
    // camera.target をずらす操作）は無効化する。
    // - 円形にクリップされた手元サイズの箱庭は、pan するとフレームアウトしてしまい
    //   戻す手段もないため、プレビュー用途としては「回転（1本指ドラッグ）＋
    //   ズーム（ピンチ/ホイール）」のみに絞るほうが自然（実機検証でのフィードバックを反映）。
    // - 箱庭の実世界中心（緯度経度）・フットプリント半径を変更する「地図移動・拡大縮小」は
    //   #539 で別途 WebXR コントローラー（免入中のQuestサムスティック等）専用の操作として
    //   実装予定であり、本カメラの pan（camera.target シフトのみで実データは変わらない）
    //   とは意味・入力経路が異なる。両者を混同しないよう、本カメラの pan は完全に閉じておく。
    camera.panningSensibility = 0;
    // `noPreventDefault=true` だと wheel/pointer イベントで `preventDefault()` を
    // 呼ばないため、macOS Chrome 等のトラックパッド「ピンチ」（`ctrlKey:true` の wheel
    // イベントとして配信される）がブラウザ既定のページズームに奪われる（実機検証で確認）。
    // 明示的に `false` を渡し、Babylon 側で preventDefault させる。
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
    debugOverlay.log("createDioramaTerrain: done");

    // [一時的] 実機AR診断: `?arPrimitiveTest=1` 指定時、独自構築の地形/側面壁メッシュを隠し、
    // Babylon標準プリミティブ（Cube + Cylinder x2）のみを表示する。地形メッシュ固有の構築方法
    // （独自VertexData等）と、多メッシュAR描画・深度オクルージョンそのものの問題を切り分ける。
    // `dioramaTerrain.root` は実世界メートル→卓上サイズの縮小スケール（tableRadiusM /
    // footprintRadiusM、既定で概ね1/2000）が掛かっているため、そのまま親にすると
    // プリミティブも同じ縮小率で見えなくなる。ARボタンによる配置（AR突入時に
    // `dioramaRoot.position` を書き換える処理）だけを共有したいので、スケール無しの
    // 専用 `TransformNode` を用意し、そちらを ARボタンの対象にする。
    // 詳細は primitiveArTest.ts 冒頭コメント参照。診断が終わったら削除する。
    let arRoot = dioramaTerrain.root;
    if (new URLSearchParams(location.search).get("arPrimitiveTest") === "1") {
        for (const childMesh of dioramaTerrain.root.getChildMeshes()) {
            childMesh.setEnabled(false);
        }
        const primitiveTestRoot = new TransformNode("primitive-test-root", scene);
        createPrimitiveArTestObjects(scene, primitiveTestRoot);
        arRoot = primitiveTestRoot;
        debugOverlay.log("arPrimitiveTest: enabled");
    }

    setupDioramaWebXrArButton(mount, scene, arRoot, debugOverlay).catch((err: unknown) => {
        console.error("[jpmap-terrain diorama demo] failed to set up WebXR AR button:", err);
        debugOverlay.log(`setupDioramaWebXrArButton failed: ${err instanceof Error ? err.message : String(err)}`);
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
