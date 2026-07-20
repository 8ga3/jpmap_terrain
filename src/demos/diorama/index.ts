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
import { createArDebugOverlay } from "./arDebugOverlay";
// [一時的な診断コード] A/B/Cテクスチャ生成方式の切り分け用。確認後にrevertして削除する。
import { createTextureAbcTest } from "./textureAbcTest";
// [一時的な診断コード] D/Eテスト（メッシュ複雑さ vs テクスチャサイズの切り分け用）。
// 確認後にrevertして削除する。
import { createMosaicOnSimplePlaneTest } from "./textureDeTest";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

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
    const engine = await createBabylonEngine(canvas, engineType);
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

    // [一時的な診断コード] 側面壁・底面（diorama-skirt）を一時的に非表示にし、
    // 地形メッシュ単体の見え方を確認する。確認後にrevertして削除する。
    const skirtMesh = dioramaTerrain.root.getChildMeshes().find((m) => m.name === "diorama-skirt");
    skirtMesh?.setEnabled(false);
    debugOverlay.log(`diorama-skirt hidden: ${skirtMesh ? "ok" : "not found"}`);

    // [一時的な診断コード] Questでの検証用に、URLクエリの手入力が不要な
    // ボタンでの切り替えに変更する。タップするたびに
    // 通常 → ワイヤーフレーム → 緑（無地・テクスチャ無し） → 通常 と巡回する。
    // AR突入前にタップしてモードを決めてからARボタンを押す想定。
    // 確認後にrevertして削除する。
    const terrainMaterial = dioramaTerrain.mesh.material as StandardMaterial | null;
    if (terrainMaterial) {
        const originalDiffuseTexture = terrainMaterial.diffuseTexture;
        const originalDiffuseColor = terrainMaterial.diffuseColor.clone();
        const modes = ["normal", "wireframe", "green"] as const;
        let modeIndex = 0;
        const applyMode = (mode: (typeof modes)[number]): void => {
            terrainMaterial.wireframe = mode === "wireframe";
            if (mode === "green") {
                terrainMaterial.diffuseTexture = null;
                terrainMaterial.diffuseColor = new Color3(0, 0.6, 0.1);
            } else {
                terrainMaterial.diffuseTexture = originalDiffuseTexture;
                terrainMaterial.diffuseColor = originalDiffuseColor;
            }
            debugOverlay.log(`dioramaDebugMode = ${mode}`);
        };
        const debugModeButton = document.createElement("button");
        Object.assign(debugModeButton.style, {
            position: "absolute",
            top: "12px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: "10",
            padding: "8px 12px",
            borderRadius: "10px",
            border: "none",
            background: "rgba(9,18,32,0.72)",
            color: "#fff",
            fontSize: "13px",
            fontWeight: "600",
            cursor: "pointer",
        } satisfies Partial<CSSStyleDeclaration>);
        debugModeButton.textContent = "表示: normal";
        debugModeButton.addEventListener("click", () => {
            modeIndex = (modeIndex + 1) % modes.length;
            const mode = modes[modeIndex];
            applyMode(mode);
            debugModeButton.textContent = `表示: ${mode}`;
        });
        mount.appendChild(debugModeButton);
    }

    // [一時的な診断コード] A（リモートURL直読み・対照群）/ B（canvas→blob→Texture・
    // 本番実装と同じ方式）/ C（canvas→RawTexture・URL読み込みを経由しない方式）の
    // 3枚の板ポリを箱庭の隣に並べる。dioramaTerrain.root の位置を毎フレーム追従
    // させることで、webXrArSession側の変更なしにAR中も一緒に配置される。
    // 確認後にrevertして削除する。
    createTextureAbcTest(scene, DEFAULT_CENTER, 15, "std")
        .then((abcRoot) => {
            abcRoot.position.set(DEFAULT_TABLE_RADIUS_M * 2, 0, 0);
            scene.onBeforeRenderObservable.add(() => {
                abcRoot.position.copyFrom(dioramaTerrain.root.position);
                abcRoot.position.x += DEFAULT_TABLE_RADIUS_M * 2;
            });
            debugOverlay.log("createTextureAbcTest: done");
        })
        .catch((err: unknown) => {
            debugOverlay.log(`createTextureAbcTest failed: ${err instanceof Error ? err.message : String(err)}`);
        });

    // [一時的な診断コード] テストD: 本番と全く同じ関数で生成した複数タイルの
    // モザイクテクスチャを、単純な板ポリに貼る（メッシュの複雑さを除外）。
    // 確認後にrevertして削除する。
    createMosaicOnSimplePlaneTest(scene, DEFAULT_CENTER, DEFAULT_FOOTPRINT_RADIUS_M, 16, "std")
        .then((testDRoot) => {
            testDRoot.position.set(DEFAULT_TABLE_RADIUS_M * 3.5, 0, 0);
            scene.onBeforeRenderObservable.add(() => {
                testDRoot.position.copyFrom(dioramaTerrain.root.position);
                testDRoot.position.x += DEFAULT_TABLE_RADIUS_M * 3.5;
            });
            debugOverlay.log("createMosaicOnSimplePlaneTest (D): done");
        })
        .catch((err: unknown) => {
            debugOverlay.log(`createMosaicOnSimplePlaneTest (D) failed: ${err instanceof Error ? err.message : String(err)}`);
        });

    // テストE（本体メッシュのテクスチャ差し替え）は原因切り分けに使用し、
    // メッシュ側（backFaceCulling）が原因と判明したため無効化した
    // （`dioramaTerrain.ts` の `material.backFaceCulling = false` 参照）。

    setupDioramaWebXrArButton(mount, scene, dioramaTerrain.root, debugOverlay).catch((err: unknown) => {
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
