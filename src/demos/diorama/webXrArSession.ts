/**
 * diorama デモの WebXR (`immersive-ar`) セッション統合。
 *
 * @remarks
 * **設計方針（VR PoC との違い）**: `feature/533-webxr-vr-viewer` の immersive-vr PoC
 * （`src/demos/viewer/webXrVrSession.ts`）は実寸大の惑星ECEF座標系を扱うため、リグの
 * 毎フレームECEF位置更新・LODバイアス同期など惑星スケール特有の仕組みを必要とした。
 * 一方 diorama は実寸メートルスケールの固定卓上モデルで、AR中の視点移動は
 * 「ユーザーが物理的に歩く」ことで実現するため、本モジュールは PoC よりも単純である。
 * 独自ロジックは「箱庭をユーザー正面に配置する」「パススルー背景にする」
 * 「コントローラー/GUI操作で地図移動・拡大縮小・タイル種別切替・トップ復帰する
 * （`dioramaArControls.ts`）」の3点。
 *
 * **パススルー表示**: diorama シーンはスカイボックス/地面メッシュを持たないため
 * `WebXRBackgroundRemover` feature は使わず、`scene.clearColor.a` をAR突入時に 0、
 * 退出時に元の値へ戻すことでパススルー映像を透過表示する。
 *
 * **箱庭の配置**: `immersive-ar` は `immersive-vr` と異なり、`enterXRAsync` 直後は
 * カメラ姿勢がまだプレースホルダー値で、実機フレームが届くまで実際のトラッキング値に
 * ならない。突入直後に固定のワールド座標へ配置すると実機の初期トラッキング原点と
 * ずれるため、姿勢が安定してから実際のカメラ位置・水平前方向を読み取って相対配置する
 * （{@link placeDioramaRelativeToCamera}）。卓上ジオラマという体裁に合わせ、床面
 * ではなくテーブル高さ相当（{@link AR_TABLE_HEIGHT_M}）に配置する（床検出による
 * 実際のテーブル高さ推定は本Issueの範囲外）。
 *
 * 命名メモ: VR PoC 同様、本リポジトリでは "VR" が Playwright Visual Regression テストの
 * 略称としても使われているため、シンボル名には "WebXr" プレフィックスを用いる。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// `scene.createDefaultXRExperienceAsync` を Scene プロトタイプへ追加する副作用 import。
import "@babylonjs/core/Helpers/sceneHelpers";
import { WebXRSessionManager } from "@babylonjs/core/XR/webXRSessionManager";
import { WebXRState } from "@babylonjs/core/XR/webXRTypes";
import type { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";
import type { WebXRCamera } from "@babylonjs/core/XR/webXRCamera";

import type { DioramaViewController } from "./dioramaViewController";
import type { DioramaOrientationController } from "./dioramaOrientationController";
import type { DioramaTileModeController } from "./dioramaTileModeController";
import type { DioramaTouchControls } from "./dioramaTouchControls";
import { createDioramaArControlHudForSession, setupDioramaArControls } from "./dioramaArControls";
import type { DioramaArControlHud } from "./dioramaArControlHud";


/** 機能検出 (`IsSessionSupportedAsync`) のタイムアウト[ms]。
 *  環境によっては（実デバイス無し等）Promise がいつまでも解決しないことがあるため、
 *  一定時間で諦めて「非対応」扱いにし、デモの起動をブロックしないようにする。
 */
const SUPPORT_CHECK_TIMEOUT_MS = 4000;

/** `promise` が `timeoutMs` 以内に解決しなければ `onTimeout` の値へフォールバックする。 */
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> =>
    new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(onTimeout), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(onTimeout);
            },
        );
    });

/** WebXR (`immersive-ar`) にブラウザ/デバイスが対応しているかを判定する。
 *  {@link SUPPORT_CHECK_TIMEOUT_MS} 以内に応答がない場合は非対応として扱う。
 */
export const isImmersiveArSupported = async (): Promise<boolean> => {
    try {
        if (typeof navigator === "undefined" || !("xr" in navigator)) return false;
        return await withTimeout(
            WebXRSessionManager.IsSessionSupportedAsync("immersive-ar"),
            SUPPORT_CHECK_TIMEOUT_MS,
            false,
        );
    } catch (err) {
        console.warn("[jpmap-terrain diorama demo] WebXR AR support check failed:", err);
        return false;
    }
};

/**
 * ARボタンのスタイル（VR PoC の `styleVrButton` に準じた外観）を適用する。
 *
 * @remarks
 * 配置は右上（`right`）にしている。左上（`left: 12px`）は `public/diorama.html` の
 * 「← デモ一覧へ」back-link が同じ位置を占有しており、重なるとback-link側が
 * クリックを奪ってしまう（back-linkの方がDOM順序で後にあり、pointer-eventsが
 * 有効なため）。
 */
const styleArButton = (button: HTMLButtonElement): void => {
    Object.assign(button.style, {
        position: "absolute",
        top: "12px",
        right: "12px",
        zIndex: "10",
        width: "56px",
        height: "40px",
        borderRadius: "10px",
        border: "none",
        background: "rgba(9,18,32,0.72)",
        color: "#fff",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
    } satisfies Partial<CSSStyleDeclaration>);
    button.textContent = "AR";
    button.setAttribute("aria-label", "ARで表示");
    button.setAttribute("title", "ARで表示 (WebXR)");
};

/**
 * AR突入時、箱庭をユーザー正面へ配置するオフセット[m]（実機カメラ位置から水平前方、
 * 箱庭中心までの距離）。
 *
 * @remarks 実機検証で「もう少し近い方がよい」とのフィードバックを受けて、
 * 当初の1.2mから縮小した。既定の卓上表示半径（{@link module:src/demos/diorama/index.ts}
 * の `DEFAULT_TABLE_RADIUS_M`、0.35m）を踏まえると、この距離で箱庭の手前端が
 * ユーザーの目の前25cm程度になり、手を伸ばして触れられる距離感になる。
 */
const AR_PLACEMENT_DISTANCE_M = 0.6;

/**
 * 卓上（テーブルトップ）ジオラマとして自然に見えるよう、床面（y=0）ではなく
 * このぶんだけ持ち上げた高さに配置する（一般的なローテーブル〜デスク程度の高さを想定した
 * 概算値。床検出（hit-test）による実際のテーブル高さ推定は本Issueの範囲外）。
 */
const AR_TABLE_HEIGHT_M = 0.7;

/**
 * ARセッション突入直後、実機のトラッキング姿勢が反映されるまで待つフレーム数。
 *
 * @remarks
 * `immersive-ar` は `enterXRAsync` 直後、`immersive-vr` と異なりデスクトップカメラの
 * 姿勢を引き継がず、カメラ位置/回転を一旦プレースホルダー値にリセットする
 * （`WebXRExperienceHelper.enterXRAsync` 参照）。実際の値は最初の実機フレームで
 * 上書きされるが、初期化タイミングの揺らぎに対して安全側に倒すため数フレーム待つ。
 */
const AR_PLACEMENT_WAIT_FRAMES = 3;

/** 水平方向がほぼ0（カメラが真上/真下を向いている等の退化ケース）とみなす閾値。 */
const HORIZONTAL_DIRECTION_EPSILON = 1e-6;

/**
 * 実機カメラの現在位置・水平前方向を基準に、箱庭をユーザー正面（テーブル高さ相当）へ
 * 配置する。カメラの向きが正しく反映されている必要があるため、
 * {@link AR_PLACEMENT_WAIT_FRAMES} フレーム待ってから呼ぶこと。
 *
 * @remarks 診断用に配置結果を `console.debug` へ出力する（開発時のみ）。実機での
 * 配置不具合の報告時、この出力内容（カメラ位置・前方向・配置結果）があると
 * 原因切り分けが容易になる。
 */
const placeDioramaRelativeToCamera = (
    scene: Scene,
    dioramaRoot: TransformNode,
    camera: WebXRCamera,
): void => {
    const forward = camera.getDirection(Vector3.Forward(scene.useRightHandedSystem));
    forward.y = 0;
    if (forward.lengthSquared() < HORIZONTAL_DIRECTION_EPSILON) {
        // カメラがほぼ真上/真下を向いている退化ケース。シーンの既定前方向へフォールバックする。
        forward.copyFrom(Vector3.Forward(scene.useRightHandedSystem));
    } else {
        forward.normalize();
    }
    dioramaRoot.position.copyFrom(camera.position);
    dioramaRoot.position.addInPlace(forward.scale(AR_PLACEMENT_DISTANCE_M));
    dioramaRoot.position.y += AR_TABLE_HEIGHT_M - camera.position.y;
    if (process.env.NODE_ENV !== "production") {
        console.debug(
            "[jpmap-terrain diorama demo] AR placement: cameraPosition=%o forward=%o placedPosition=%o",
            camera.position.asArray(),
            forward.asArray(),
            dioramaRoot.position.asArray(),
        );
    }
};

/**
 * diorama デモに ARボタンを追加し、WebXR (`immersive-ar`) セッションの開始/終了、
 * 箱庭のユーザー正面配置、パススルー背景化、コントローラー/GUI操作
 * （地図移動・拡大縮小、`dioramaArControls.ts`）を行うセットアップを行う。
 *
 * WebXR (`immersive-ar`) 非対応環境では機能検出後にボタンを表示しない
 * （VR PoC と同じ合意事項）。
 *
 * @param mount ボタンを配置するコンテナ要素（diorama デモの canvas を含む要素）。
 * @param scene 対象の `Scene`。
 * @param dioramaRoot 箱庭配置の適用先ノード（`index.ts` が生成する `placementRoot`。
 *   AR突入時にユーザー正面へ絶対位置で配置される。回転・高さオフセットは
 *   このノードの子である `orientationRoot` に適用されるため、本関数はそれらに
 *   触れない。`dioramaOrientationController.ts` 冒頭のコメント参照）。
 * @param viewController 地図移動・拡大縮小の共有状態保持者（`dioramaViewController.ts`）。
 *   デスクトップのキーボード操作と共有し、AR突入前後で位置が引き継がれるようにする。
 * @param orientationController 箱庭の回転・高さオフセットの共有状態保持者
 *   （`dioramaOrientationController.ts`）。デスクトップのキーボード操作と共有する。
 * @param tileModeController タイル種別の共有状態保持者（`dioramaTileModeController.ts`）。
 *   デスクトップのキーボード操作と共有する。
 * @param touchControls AR非対応環境・AR突入前の通常表示向けの常時表示タッチHUD
 *   （`dioramaTouchControls.ts`）。AR中は同種のGUIが二重に重なって表示されない
 *   よう、AR突入時に非表示、退出時に再表示する。
 * @returns 後始末用の破棄関数。呼び出し元がデモを終了する際に呼ぶ。
 */
export const setupDioramaWebXrArButton = async (
    mount: HTMLElement,
    scene: Scene,
    dioramaRoot: TransformNode,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
    tileModeController: DioramaTileModeController,
    touchControls: DioramaTouchControls,
): Promise<() => void> => {
    const supported = await isImmersiveArSupported();
    if (!supported) return () => {};

    const button = document.createElement("button");
    styleArButton(button);
    mount.appendChild(button);

    let xr: WebXRDefaultExperience | null = null;
    let entering = false;
    let disposed = false;

    const cleanup = (): void => {
        disposed = true;
        button.remove();
        xr?.dispose();
    };

    button.addEventListener("click", () => {
        if (disposed || entering) return;
        if (xr && xr.baseExperience.state !== WebXRState.NOT_IN_XR) {
            void xr.baseExperience.exitXRAsync();
            return;
        }
        // 前回セッションの `WebXRDefaultExperience`（input/enterExitUI/renderTarget等の
        // リソースを保持する）は enterAr() のたびに新規生成するため、再入場前に破棄
        // しておく（破棄しないと入退場を繰り返すたびにリソースがリークする）。
        xr?.dispose();
        xr = null;
        entering = true;
        void enterAr(
            mount,
            scene,
            dioramaRoot,
            viewController,
            orientationController,
            tileModeController,
            touchControls,
            button,
        )
            .then((created) => {
                // cleanup() が呼ばれた後に enterAr() が解決した場合、生成済みの
                // セッションを保持せずここで破棄する（呼び出し元は既にデモを
                // 終了しているため、以後 xr を参照する経路が無くなりリークするのを防ぐ）。
                // `created` が非nullの場合、enterAr() 内で `touchControls.setVisible(false)`
                // が実行済みだが、`created.dispose()` は `onStateChangedObservable` による
                // `restoreOnExit`（`enterAr()` 内、NOT_IN_XR遷移で発火）を必ずしも
                // 経由しないため、ここで明示的に `setVisible(true)` を呼び、タッチHUDが
                // 非表示のまま残留しないようにする（`setVisible(true)` は冪等なので、
                // 既に表示状態でも無条件に呼んで問題ない）。
                if (disposed) {
                    touchControls.setVisible(true);
                    created?.dispose();
                    return;
                }
                xr = created;
            })
            .finally(() => {
                entering = false;
            });
    });

    return cleanup;
};


/** ARセッションを開始し、パススルー背景化・箱庭配置のセットアップを行う。
 *  セットアップ中に例外が発生した場合は、生成済みリソース（`xr`・シーン状態）を後始末し、
 *  ボタンを通常表示へ戻したうえで `null` を返す（呼び出し元はクリック可能な状態を維持する）。
 */
const enterAr = async (
    mount: HTMLElement,
    scene: Scene,
    dioramaRoot: TransformNode,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
    tileModeController: DioramaTileModeController,
    touchControls: DioramaTouchControls,
    button: HTMLButtonElement,
): Promise<WebXRDefaultExperience | null> => {
    let xr: WebXRDefaultExperience | null = null;
    let hud: DioramaArControlHud | null = null;
    // `setupDioramaArControls` の破棄関数。try節内の`const`にすると、それより後の
    // 処理（`onStateChangedObservable.add`等）で例外が起きた場合に catch から
    // 呼べず、render observer / controller observer が残留する。外側スコープの
    // `let` で保持し、catch でも必ず呼べるようにする。
    let disposeArControls: (() => void) | null = null;
    // AR退出時にデスクトップ表示（通常のシーン状態）へ確実に復元できるよう、
    // 突入前の状態を保存しておく。
    const originalPosition = dioramaRoot.position.clone();
    const originalClearAlpha = scene.clearColor.a;
    try {
        // AR中は本ファイルが生成する別インスタンスのHUD（コントローラー/GUI操作）を
        // 表示するため、通常表示向けの常時表示タッチHUDは非表示にする。
        // `createDioramaArControlHudForSession` によるHUDの生成・`mount` への追加
        // （後述）は `enterXRAsync` 完了前（実機では体感できる遅延があり得る）に
        // 行われるため、非表示化をそれより後（`enterXRAsync` 成功後）に行うと、
        // AR突入処理中に両方のHUDが画面上で二重に重なって表示される期間が生じる。
        // そのため、AR HUDを生成する前の時点で先に非表示化する。
        touchControls.setVisible(false);

        xr = await scene.createDefaultXRExperienceAsync({
            // 本モジュールは歩行のみで移動するため、既定のテレポート/ポインタ選択機能は
            // 無効化し、入力の競合を避ける（VR PoC と同じ理由）。
            disableTeleportation: true,
            disablePointerSelection: true,
            // 独自の ARボタン（本ファイル）で enter/exit を制御するため、Babylon 標準の
            // Enter/Exit UI は無効化する（二重のボタン表示による混乱を避ける）。
            disableDefaultUI: true,
        });

        const xrExperience = xr;

        // AR中のコントローラー/GUI操作用HUD + `dom-overlay` feature の登録は、
        // 必ず `enterXRAsync` より前に行う（`dioramaArControls.ts` 冒頭コメント参照。
        // WebXR仕様上、`dom-overlay` はセッション要求時点でのみ有効化できるため）。
        hud = createDioramaArControlHudForSession(xrExperience, mount);

        if (xrExperience.baseExperience.state === WebXRState.NOT_IN_XR) {
            await xrExperience.baseExperience.enterXRAsync("immersive-ar", "local-floor", xrExperience.renderTarget);
        }

        button.textContent = "終了";
        button.setAttribute("aria-label", "ARを終了");
        button.setAttribute("title", "ARを終了");

        // パススルー表示: フレームバッファの alpha を 0 にし、実世界カメラ映像が
        // 透けて見えるようにする（{@link module:src/demos/diorama/webXrArSession.ts}
        // 冒頭のコメント参照）。
        scene.clearColor.a = 0;

        // コントローラー（thumbstick/trigger）/GUI（画面タッチ）による地図移動・拡大縮小・
        // 箱庭回転・高さ変更（`dioramaArControls.ts` 参照）。ARセッション中を通して有効にする。
        disposeArControls = setupDioramaArControls(
            scene,
            xrExperience,
            hud,
            viewController,
            orientationController,
            tileModeController,
        );

        // 実機のトラッキング姿勢が反映されるまで数フレーム待ってから配置する
        // （{@link AR_PLACEMENT_WAIT_FRAMES} 冒頭のコメント参照）。
        let framesWaited = 0;
        const placementObserver = scene.onBeforeRenderObservable.add(() => {
            framesWaited += 1;
            if (framesWaited < AR_PLACEMENT_WAIT_FRAMES) return;
            scene.onBeforeRenderObservable.remove(placementObserver);
            placeDioramaRelativeToCamera(scene, dioramaRoot, xrExperience.baseExperience.camera);
        });

        const restoreOnExit = (): void => {
            // 配置待ちの途中でセッションが終了した場合、以後 placement を実行しない。
            scene.onBeforeRenderObservable.remove(placementObserver);
            // 破棄後も参照が残っていると、例外経路や `onStateChangedObservable` の
            // 二重発火で破棄関数が二重実行され得るため、呼び出し後に参照をクリアする。
            disposeArControls?.();
            disposeArControls = null;
            dioramaRoot.position.copyFrom(originalPosition);
            scene.clearColor.a = originalClearAlpha;
            touchControls.setVisible(true);
            styleArButton(button);
        };

        xrExperience.baseExperience.onStateChangedObservable.add((state) => {
            if (state === WebXRState.NOT_IN_XR) {
                restoreOnExit();
            }
        });

        return xrExperience;
    } catch (err) {
        console.error("[jpmap-terrain diorama demo] failed to start WebXR AR session:", err);
        // 部分的に確保したリソース（箱庭配置・パススルー背景状態・AR controls・HUD）を
        // 後始末する。`disposeArControls` が設定済み（`setupDioramaArControls` 呼び出し後に
        // 例外が起きたケース）なら、render observer / controller observer の残留を防ぐため
        // 必ず呼ぶ。`touchControls.setVisible(true)` は `setVisible(false)` 呼び出し前に
        // 例外が起きた場合でも冪等（既に表示中なら何もしない）なので無条件に呼ぶ。
        dioramaRoot.position.copyFrom(originalPosition);
        scene.clearColor.a = originalClearAlpha;
        touchControls.setVisible(true);
        disposeArControls?.();
        disposeArControls = null;
        hud?.dispose();
        hud = null;
        xr?.dispose();
        styleArButton(button);
        return null;
    }
};
