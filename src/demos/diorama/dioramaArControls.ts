/**
 * diorama デモのAR中コントローラー/タッチ入力を、`DioramaViewController`
 * （地図移動・拡大縮小の共有状態保持者、`dioramaViewController.ts`）へ橋渡しする。
 *
 * @remarks
 * - Meta Quest等の物理コントローラー（thumbstick）: 左スティック=パン、
 *   右スティックY=ズーム。
 * - Androidスマホ等のハンドヘルドAR（コントローラー無し）: オンスクリーンGUI
 *   （`dioramaArControlHud.ts`）の仮想ジョイスティック・ズームボタンで代替する。
 *   （操作割り当ての全体像は `dioramaControllerMapping.ts` 冒頭コメント参照）
 *
 * 両者は同じ軸表現（[-1,1] の `StickAxes`/ズーム軸値）に正規化し、毎フレーム
 * 単純に加算して1つの入力として扱う（通常はどちらか一方のみが同時に使われるため、
 * 排他制御は行わない）。実際の地形反映・レイテンシ対策（完了待ち合流方式）は
 * `DioramaViewController` が担う。
 *
 * 本モジュールは箱庭の回転（右スティックX）・設置高さ変更（左右トリガー）の
 * 入力も併せて配線する。こちらは `DioramaOrientationController`
 * （`dioramaOrientationController.ts`）が同期的に対象ノードへ反映するため、
 * パン/ズームのような完了待ちの仕組みは不要。
 *
 * **`dom-overlay` featureの有効化タイミングが重要**: WebXR仕様上、
 * `dom-overlay`（GUI HUDを没入セッション中も表示し続けるための機能）は
 * `domOverlay.root` を `XRSession` の**セッション要求（`requestSession`）時点**の
 * `XRSessionInit` に含める必要がある（後から追加登録しても反映されない）。
 * Babylon.js の `WebXRExperienceHelper.enterXRAsync` は、その時点で
 * `featuresManager` に登録済みの feature から `XRSessionInit` を構築して
 * `requestSession` を呼ぶため、`enableFeature(DOM_OVERLAY, ...)` は
 * **`enterXRAsync` より前**に呼ぶ必要がある。これを怠ると、機能登録自体は
 * （Babylon内部的には）エラーなく成功するように見えても、実際のブラウザの
 * WebXRセッションには `dom-overlay` が反映されず、没入中はGUIが一切
 * 表示されない（Androidスマホでの実機検証で確認）。そのため本モジュールは
 * 「HUD生成 + feature登録」（{@link createDioramaArControlHudForSession}、
 * `enterXRAsync` 前に呼ぶ）と「毎フレームの入力反映」
 * （{@link setupDioramaArControls}、`enterXRAsync` 後に呼ぶ）を分離している。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";
import type { WebXRInputSource } from "@babylonjs/core/XR/webXRInputSource";
import { WebXRFeatureName } from "@babylonjs/core/XR/webXRFeaturesManager";
// `xr-dom-overlay` feature をfeaturesManagerへ登録する副作用 import
// （AR中もコントロールHUDを表示し続けるために使う）。
import "@babylonjs/core/XR/features/WebXRDOMOverlay";

import type { DioramaViewController } from "./dioramaViewController";
import type { DioramaOrientationController } from "./dioramaOrientationController";
import type { StickAxes } from "./dioramaControllerMapping";
import { createDioramaArControlHud, type DioramaArControlHud } from "./dioramaArControlHud";

/**
 * AR操作GUI（仮想ジョイスティック+ズームボタン）を生成し、`dom-overlay` feature を
 * 有効化する。**`xrExperience.baseExperience.enterXRAsync(...)` より前に呼ぶこと**
 * （冒頭のコメント参照。`enterXRAsync` 後に呼んでもブラウザ側のWebXRセッションには
 * 反映されない）。
 *
 * @remarks WebXR仕様（DOM Overlays）上、`domOverlay.root` に指定する要素は
 * セッション要求（`requestSession`）の時点で**文書に接続されている
 * （`Node.isConnected`）**必要がある。未接続の要素を渡すと、多くの実装で
 * `requestSession` 自体が失敗し、AR突入直後に即座にデスクトップ表示へ
 * 戻ってしまう（Androidスマホ実機検証で確認）。そのため、HUD要素を
 * `mount` へ追加してから feature を有効化する。
 *
 * @param mount HUD要素を追加する親要素（`setupDioramaWebXrArButton` が
 *   受け取るコンテナ要素と同じものを渡すこと）。
 * @returns 生成したHUD。`setupDioramaArControls` へそのまま渡し、不要になったら
 *   `dispose()` を呼ぶこと（`dispose()` は `mount` からの除去も行う）。
 */
export const createDioramaArControlHudForSession = (
    xr: WebXRDefaultExperience,
    mount: HTMLElement,
): DioramaArControlHud => {
    const hud = createDioramaArControlHud();
    // `domOverlay.root` は文書に接続済みである必要があるため、feature有効化より前に追加する。
    mount.appendChild(hud.element);
    try {
        xr.baseExperience.featuresManager.enableFeature(
            WebXRFeatureName.DOM_OVERLAY,
            "latest",
            { element: hud.element },
            true,
            false,
        );
    } catch (err) {
        // `dom-overlay` 非対応ブラウザでも操作自体は継続できるため、警告のみに留める
        // （HUDはDOM上には存在するが、非対応環境では没入セッション中は見えない可能性がある）。
        console.warn(
            "[jpmap-terrain diorama demo] dom-overlay feature unavailable, AR control HUD may not be visible during the session:",
            err,
        );
    }
    return hud;
};

/** 左右コントローラーのスティック軸を保持する（未接続時は `{0,0}`）。 */
interface ControllerStickState {
    left: StickAxes;
    right: StickAxes;
}
const zeroStickState = (): ControllerStickState => ({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });

/** 左右コントローラーのトリガー押下量（[0,1]）を保持する（未接続時は `0`）。 */
interface ControllerTriggerState {
    left: number;
    right: number;
}
const zeroTriggerState = (): ControllerTriggerState => ({ left: 0, right: 0 });

/**
 * 追加されたコントローラーのthumbstick/trigger入力を `sticks`/`triggers` へ反映する
 * リスナーを登録する（`feature/533-webxr-vr-viewer` の `trackControllerSticks` と
 * 同じ設計。トリガーは箱庭の高さ変更操作向けに本Issueで追加）。
 *
 * @remarks
 * コントローラーごとに登録した `onMotionControllerInitObservable` /
 * `onAxisValueChangedObservable` / `onButtonStateChangedObservable` の Observer を
 * `controllerCleanups` に保持し、コントローラー切断時
 * （`onControllerRemovedObservable`）と本関数の返り値（登録解除関数）呼び出し時の
 * 両方で確実に `remove` する。保持・解除しないと、コントローラーの再初期化時に
 * リスナーが二重登録され入力が二重反映されたり、破棄後もリスナーが残留して
 * メモリリークになる。
 * @returns 登録解除関数。
 */
const trackControllerSticks = (
    xr: WebXRDefaultExperience,
    sticks: ControllerStickState,
    triggers: ControllerTriggerState,
): (() => void) => {
    const controllerCleanups = new Map<WebXRInputSource, () => void>();

    const bindController = (controller: WebXRInputSource): void => {
        const handedness = controller.inputSource.handedness;
        if (handedness !== "left" && handedness !== "right") return;

        // `onMotionControllerInitObservable` は稀に同一コントローラーへ複数回発火し
        // 得る（コントローラーのモーションコントローラーが差し替わるケース）ため、
        // 発火のたびに前回のthumbstick/trigger購読を解除してから登録し直す。
        let disposeAxisBinding: (() => void) | null = null;
        let disposeTriggerBinding: (() => void) | null = null;
        const motionControllerObserver = controller.onMotionControllerInitObservable.add((motionController) => {
            disposeAxisBinding?.();
            disposeAxisBinding = null;
            disposeTriggerBinding?.();
            disposeTriggerBinding = null;

            const thumbstick = motionController.getComponentOfType("thumbstick");
            if (thumbstick) {
                const axisObserver = thumbstick.onAxisValueChangedObservable.add(({ x, y }) => {
                    sticks[handedness] = { x, y };
                });
                disposeAxisBinding = () => thumbstick.onAxisValueChangedObservable.remove(axisObserver);
            }

            const trigger = motionController.getComponentOfType("trigger");
            if (trigger) {
                const buttonObserver = trigger.onButtonStateChangedObservable.add((component) => {
                    triggers[handedness] = component.value;
                });
                disposeTriggerBinding = () => trigger.onButtonStateChangedObservable.remove(buttonObserver);
            }
        });

        controllerCleanups.set(controller, () => {
            controller.onMotionControllerInitObservable.remove(motionControllerObserver);
            disposeAxisBinding?.();
            disposeTriggerBinding?.();
        });
    };

    xr.input.controllers.forEach(bindController);
    const addedObserver = xr.input.onControllerAddedObservable.add(bindController);
    const removedObserver = xr.input.onControllerRemovedObservable.add((controller) => {
        const handedness = controller.inputSource.handedness;
        if (handedness === "left" || handedness === "right") {
            sticks[handedness] = { x: 0, y: 0 };
            triggers[handedness] = 0;
        }
        controllerCleanups.get(controller)?.();
        controllerCleanups.delete(controller);
    });
    return () => {
        xr.input.onControllerAddedObservable.remove(addedObserver);
        xr.input.onControllerRemovedObservable.remove(removedObserver);
        controllerCleanups.forEach((cleanup) => cleanup());
        controllerCleanups.clear();
    };
};

/** [-1,1] へクランプする（コントローラー入力とGUI入力の単純加算が範囲を超えないようにする）。 */
const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/**
 * AR中のコントローラー/GUI入力による地図移動・拡大縮小・箱庭回転・高さ変更の
 * セットアップを行う。`xrExperience.baseExperience.enterXRAsync(...)` 完了後に呼び、
 * 退出/破棄時に返り値の破棄関数を呼ぶこと。
 *
 * @param hud {@link createDioramaArControlHudForSession} で事前に生成したHUD
 *   （`enterXRAsync` より前に呼んでおく必要がある。冒頭のコメント参照）。
 * @param orientationController 箱庭の回転・高さオフセットの共有状態保持者
 *   （右スティックX＝回転、左右トリガー＝高さ変更）。
 */
export const setupDioramaArControls = (
    scene: Scene,
    xr: WebXRDefaultExperience,
    hud: DioramaArControlHud,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
): (() => void) => {
    const sticks = zeroStickState();
    const triggers = zeroTriggerState();
    const untrackSticks = trackControllerSticks(xr, sticks, triggers);

    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        const dtSeconds = scene.getEngine().getDeltaTime() / 1000;
        if (!(dtSeconds > 0)) return;

        const hudAxes = hud.getPanAxes();
        const panAxes: StickAxes = {
            x: clamp1(sticks.left.x + hudAxes.x),
            y: clamp1(sticks.left.y + hudAxes.y),
        };
        const zoomAxisY = clamp1(sticks.right.y + hud.getZoomAxis());
        viewController.feedAxes(panAxes, zoomAxisY, dtSeconds);

        orientationController.feedAxes(sticks.right.x, triggers.left, triggers.right, dtSeconds);
    });

    return (): void => {
        scene.onBeforeRenderObservable.remove(renderObserver);
        untrackSticks();
        hud.dispose();
    };
};
