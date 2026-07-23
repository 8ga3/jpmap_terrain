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
 * **パン方向はARカメラ（頭部/デバイス）の現在の水平向き基準**:
 * スティック/タッチジョイスティックの入力を単純に東西・南北へ直接マッピングすると、
 * ユーザーが物理的に向きを変えた際、画面上の「前」と実際の移動方向（絶対座標の北）
 * が一致せず操作しづらい（デスクトップキーボード操作（`dioramaKeyboardControls.ts`）
 * で先に対応済みの問題と同種）。そのため毎フレーム `xr.baseExperience.camera`
 * （`WebXRCamera`）の水平前方向を取得し、パン入力をその向き基準で東西・南北へ
 * 回転変換してから `DioramaViewController` へ渡す。
 *
 * 頭部トラッキング/デバイス姿勢は体の揺れ等で常に微小に変動し不安定なため、
 * 生の向き角をそのまま使うとパン方向が静止中も小刻みに変わってしまう。
 * {@link snapHeadingRad}（`dioramaControllerMapping.ts`）でヒステリシス付き
 * 8方位スナップへ丸めてから使うことで安定させる（回転操作（右スティックX）・
 * 箱庭の向き自体には影響しない。あくまでパン方向の基準のみに使う）。
 *
 * 本モジュールは箱庭の回転（右スティックX）・設置高さ変更（左右トリガー）の
 * 入力も併せて配線する。こちらは `DioramaOrientationController`
 * （`dioramaOrientationController.ts`）が同期的に対象ノードへ反映するため、
 * パン/ズームのような完了待ちの仕組みは不要。
 *
 * さらに、タイル種別切替（A/Xボタン）・AR終了（B/Yボタン）の入力も配線する
 * （{@link trackControllerButtonPresses}）。これらは継続入力（スティック/トリガー）
 * ではなく単発の押下エッジで駆動する。タイル種別切替は
 * `DioramaTileModeController.cycle()` を呼び、AR終了は
 * `xr.baseExperience.exitXRAsync()` を直接呼ぶ（右上の既存ARトグルボタン
 * （`webXrArSession.ts`）と同じ終了経路。呼び出し後の後始末（パススルー解除・
 * 箱庭位置の復元・タッチHUD再表示等）は同ファイルの `onStateChangedObservable`
 * が担うため、本モジュールは `exitXRAsync()` を呼ぶだけでよい）。
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
import type { WebXRControllerComponent } from "@babylonjs/core/XR/motionController/webXRControllerComponent";
import { WebXRFeatureName } from "@babylonjs/core/XR/webXRFeaturesManager";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// `xr-dom-overlay` feature をfeaturesManagerへ登録する副作用 import
// （AR中もコントロールHUDを表示し続けるために使う）。
import "@babylonjs/core/XR/features/WebXRDOMOverlay";

import type { DioramaViewController } from "./dioramaViewController";
import type { DioramaOrientationController } from "./dioramaOrientationController";
import type { DioramaTileModeController } from "./dioramaTileModeController";
import {
    type StickAxes,
    computeHeadingRadFromHorizontal,
    rotateHorizontalUnitVector,
    computePanAxesFromDirectionalInput,
    snapHeadingRad,
} from "./dioramaControllerMapping";
import { getHorizontalDirectionUnit } from "./dioramaHorizontalDirection";
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
    const hud = createDioramaArControlHud({ exitArEnabled: true });
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
export interface ControllerStickState {
    left: StickAxes;
    right: StickAxes;
}
const zeroStickState = (): ControllerStickState => ({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });

/** 左右コントローラーのトリガー押下量（[0,1]）を保持する（未接続時は `0`）。 */
export interface ControllerTriggerState {
    left: number;
    right: number;
}
const zeroTriggerState = (): ControllerTriggerState => ({ left: 0, right: 0 });

/**
 * [-1,1] へクランプする（コントローラー入力とGUI入力の単純加算が範囲を超えないように
 * する）。`NaN`/`Infinity` 等の非有限値は 0 へフォールバックしてからクランプする
 * （`Math.min`/`Math.max` は `NaN` を伝播させ、クランプの保証が崩れてしまうため）。
 */
export const clamp1 = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
/**
 * [0,1] へクランプする（トリガー押下量とGUI高さボタン由来の合算値の範囲を揃える）。
 * `clamp1` と同様、非有限値は 0 へフォールバックしてからクランプする。
 */
export const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

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
 *
 * また、`onMotionControllerInitObservable` 発火のたびに `sticks`/`triggers` を
 * 一旦ニュートラル値へリセットしてから thumbstick/trigger の有無を判定・購読する。
 * リセットしないと、差し替え後のモーションコントローラーに thumbstick/trigger が
 * 無い場合（プロファイルの違い等）に、以後どのobserverからも更新されず前回値
 * （押しっぱなし相当）が残留し続け、回転/高さが暴走する不具合になり得るため。
 * @returns 登録解除関数。
 */
export const trackControllerSticks = (
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
            // 差し替え後のモーションコントローラーに thumbstick/trigger が無い場合、
            // 以後どのobserverからも更新されず前回の値（押しっぱなし相当）が残留し
            // 続けてしまう。再初期化のたびに一旦ニュートラル値へリセットしてから
            // 判定・購読することで、コンポーネントが見つからない場合でも
            // 回転/高さが暴走しないようにする。
            sticks[handedness] = { x: 0, y: 0 };
            triggers[handedness] = 0;

            const thumbstick = motionController.getComponentOfType("thumbstick");
            if (thumbstick) {
                const axisObserver = thumbstick.onAxisValueChangedObservable.add(({ x, y }) => {
                    // 格納時点で[-1,1]へクランプ・非有限値を0へフォールバックする。
                    // ここでサニタイズしないと、コントローラー由来の異常値（NaN等）が
                    // 後段の `clamp1(sticks... + hud...)` で合算後にまとめて0扱いされ、
                    // 同時に加算されるHUD側の正常な入力まで無効化されてしまう。
                    sticks[handedness] = { x: clamp1(x), y: clamp1(y) };
                });
                disposeAxisBinding = () => thumbstick.onAxisValueChangedObservable.remove(axisObserver);
                // バインド時点で既に倒されている場合、`onAxisValueChangedObservable` は
                // その後の「変化」でのみ発火するため、現在値を初期反映しておかないと
                // 検知できない（次項のtriggerと同じ理由）。
                sticks[handedness] = { x: clamp1(thumbstick.axes.x), y: clamp1(thumbstick.axes.y) };
            }

            const trigger = motionController.getComponentOfType("trigger");
            if (trigger) {
                const buttonObserver = trigger.onButtonStateChangedObservable.add((component) => {
                    // sticksと同じ理由で、格納時点で[0,1]へクランプ・非有限値を
                    // 0へフォールバックする。
                    triggers[handedness] = clamp01(component.value);
                });
                disposeTriggerBinding = () => trigger.onButtonStateChangedObservable.remove(buttonObserver);
                // `onMotionControllerInitObservable` 発火時点で既にトリガーが押されている
                // 場合（例: コントローラー接続直後から押しっぱなしのケース）、
                // `onButtonStateChangedObservable` はその後の「状態変化」でのみ発火するため
                // 押しっぱなし状態を取りこぼす。バインド直後に現在値を一度読み取って
                // 反映しておくことで、この取りこぼしを防ぐ。
                triggers[handedness] = clamp01(trigger.value);
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

/**
 * 各ハンドの「プライマリ」「セカンダリ」ボタンのWebXR入力プロファイル上の
 * コンポーネントID（Meta Quest/Oculus Touchプロファイルの慣例に基づく）。
 *
 * @remarks
 * 右手の "a-button"/"b-button"、左手の "x-button"/"y-button" は、
 * `@webxr-input-profiles/motion-controllers` が提供する oculus-touch系
 * プロファイル（Meta Quest含む多くのVR/ARコントローラーが採用）の
 * コンポーネントIDと一致する。`getComponent(id)` は該当コンポーネントが
 * 存在しない場合 `undefined` を返す（例外を投げない）ため、命名が異なる
 * プロファイルでは {@link PRIMARY_SECONDARY_BUTTON_FALLBACK_INDICES} の
 * フォールバックを使う。
 */
const PRIMARY_BUTTON_COMPONENT_ID: Record<"left" | "right", string> = {
    left: "x-button",
    right: "a-button",
};
const SECONDARY_BUTTON_COMPONENT_ID: Record<"left" | "right", string> = {
    left: "y-button",
    right: "b-button",
};
/**
 * 名前付きコンポーネントIDが見つからないプロファイル向けのフォールバック
 * （`getAllComponentsOfType("button")` の配列インデックス。0=プライマリ、
 * 1=セカンダリという一般的な並び順を仮定する）。
 */
const PRIMARY_SECONDARY_BUTTON_FALLBACK_INDICES = { primary: 0, secondary: 1 } as const;

/**
 * 追加されたコントローラーのプライマリ（A/Xボタン）・セカンダリ（B/Yボタン）の
 * 押下エッジ（`default`/`touched` → `pressed` への遷移）を検知し、
 * `onPrimaryPress`/`onSecondaryPress` を呼び出すリスナーを登録する
 * （`trackControllerSticks` と同じライフサイクル管理方針。コントローラーの
 * 追加・再初期化・切断のたびに購読を張り替え、返り値の登録解除関数で
 * 一括解除できる）。
 *
 * `WebXRControllerComponent.changes.pressed` は「このコールバック呼び出しで
 * pressed状態が変化した場合のみ」値を持つため、`current === true` の
 * タイミング（＝押した瞬間、離した瞬間には発火しない）だけを拾うことで
 * 単発トリガーにする（継続的な押しっぱなし判定は不要な操作のため）。
 *
 * @returns 登録解除関数。
 */
export const trackControllerButtonPresses = (
    xr: WebXRDefaultExperience,
    onPrimaryPress: () => void,
    onSecondaryPress: () => void,
): (() => void) => {
    const controllerCleanups = new Map<WebXRInputSource, () => void>();

    const bindPressObserver = (component: WebXRControllerComponent, onPress: () => void): (() => void) => {
        const observer = component.onButtonStateChangedObservable.add((c) => {
            if (c.changes.pressed?.current === true) onPress();
        });
        return () => component.onButtonStateChangedObservable.remove(observer);
    };

    const bindController = (controller: WebXRInputSource): void => {
        const handedness = controller.inputSource.handedness;
        if (handedness !== "left" && handedness !== "right") return;

        let disposePrimaryBinding: (() => void) | null = null;
        let disposeSecondaryBinding: (() => void) | null = null;
        const motionControllerObserver = controller.onMotionControllerInitObservable.add((motionController) => {
            // `trackControllerSticks` と同様、モーションコントローラーの再初期化時に
            // 前回の購読を解除してから登録し直す。
            disposePrimaryBinding?.();
            disposePrimaryBinding = null;
            disposeSecondaryBinding?.();
            disposeSecondaryBinding = null;

            const buttons = motionController.getAllComponentsOfType("button");
            const primary =
                motionController.getComponent(PRIMARY_BUTTON_COMPONENT_ID[handedness]) ??
                buttons[PRIMARY_SECONDARY_BUTTON_FALLBACK_INDICES.primary];
            if (primary) {
                disposePrimaryBinding = bindPressObserver(primary, onPrimaryPress);
            }

            const secondary =
                motionController.getComponent(SECONDARY_BUTTON_COMPONENT_ID[handedness]) ??
                buttons[PRIMARY_SECONDARY_BUTTON_FALLBACK_INDICES.secondary];
            if (secondary) {
                disposeSecondaryBinding = bindPressObserver(secondary, onSecondaryPress);
            }
        });

        controllerCleanups.set(controller, () => {
            controller.onMotionControllerInitObservable.remove(motionControllerObserver);
            disposePrimaryBinding?.();
            disposeSecondaryBinding?.();
        });
    };

    xr.input.controllers.forEach(bindController);
    const addedObserver = xr.input.onControllerAddedObservable.add(bindController);
    const removedObserver = xr.input.onControllerRemovedObservable.add((controller) => {
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

/**
 * AR中のコントローラー/GUI入力による地図移動・拡大縮小・箱庭回転・高さ変更・
 * タイル種別切替・トップ復帰のセットアップを行う。
 * `xrExperience.baseExperience.enterXRAsync(...)` 完了後に呼び、退出/破棄時に
 * 返り値の破棄関数を呼ぶこと。
 *
 * @param hud {@link createDioramaArControlHudForSession} で事前に生成したHUD
 *   （`enterXRAsync` より前に呼んでおく必要がある。冒頭のコメント参照）。
 * @param orientationController 箱庭の回転・高さオフセットの共有状態保持者
 *   （右スティックX＝回転、左右トリガー＝高さ変更）。
 * @param tileModeController タイル種別の共有状態保持者（A/Xボタン・HUDタイル
 *   切替ボタン＝巡回）。
 */
export const setupDioramaArControls = (
    scene: Scene,
    xr: WebXRDefaultExperience,
    hud: DioramaArControlHud,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
    tileModeController: DioramaTileModeController,
): (() => void) => {
    const sticks = zeroStickState();
    const triggers = zeroTriggerState();
    const untrackSticks = trackControllerSticks(xr, sticks, triggers);

    // B/Yボタン・HUDのAR終了ボタンは、いずれも右上の既存ARトグルボタン
    // （`webXrArSession.ts`）と同じ `exitXRAsync()` を呼ぶだけでよい。後始末
    // （パススルー解除・箱庭位置の復元・タッチHUD再表示等）は `webXrArSession.ts`
    // 側の `onStateChangedObservable`（`NOT_IN_XR` 遷移で発火）が担う。
    // `exitXRAsync()` が失敗した場合（Promise reject）に unhandled rejection として
    // 静かに握りつぶされないよう、`catch` で最低限のログ出力を行う。
    const exitAr = (): void => {
        xr.baseExperience.exitXRAsync().catch((err: unknown) => {
            console.error("[jpmap-terrain diorama demo] failed to exit WebXR AR session:", err);
        });
    };
    const untrackButtons = trackControllerButtonPresses(xr, () => tileModeController.cycle(), exitAr);
    const unsubscribeTileModeCycle = hud.onTileModeCyclePress(() => tileModeController.cycle());
    const unsubscribeExitAr = hud.onExitArPress(exitAr);

    // パン方向の基準にする、直近でスナップ済みの向き角[rad]（冒頭のコメント参照）。
    // セッション開始時は基準が無いため `undefined`（初回はヒステリシス無しで
    // 最も近い方位へスナップする）。
    let previousSnappedHeadingRad: number | undefined;

    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        const dtSeconds = scene.getEngine().getDeltaTime() / 1000;
        if (!(dtSeconds > 0)) return;

        // ARカメラ（頭部/デバイス）の現在の水平向きを取得し、揺らぎを抑えるため
        // ヒステリシス付き8方位スナップへ丸める。カメラが真上/真下を向く退化ケースでは
        // `getHorizontalDirectionUnit` が `{x:0, z:0}` を返すため、その場合は前回の
        // 向き（無ければシーン既定のforward=北）を維持する。
        const camera = xr.baseExperience.camera;
        const rawForwardUnit = getHorizontalDirectionUnit(camera, Vector3.Forward(scene.useRightHandedSystem));
        const rawHeadingRad =
            rawForwardUnit.x === 0 && rawForwardUnit.z === 0
                ? (previousSnappedHeadingRad ?? 0)
                : computeHeadingRadFromHorizontal(rawForwardUnit.x, rawForwardUnit.z);
        const snappedHeadingRad = snapHeadingRad(rawHeadingRad, previousSnappedHeadingRad);
        previousSnappedHeadingRad = snappedHeadingRad;
        // 生の向き角からスナップ後の向き角への差分だけ、forward/right単位ベクトルを
        // 回転させる（`rawForwardUnit`が退化ケースの`{0,0}`でも回転結果は`{0,0}`のままで安全）。
        const headingDeltaRad = snappedHeadingRad - rawHeadingRad;
        const forwardUnit = rotateHorizontalUnitVector(rawForwardUnit, headingDeltaRad);
        const rightUnit = rotateHorizontalUnitVector(
            getHorizontalDirectionUnit(camera, Vector3.Right()),
            headingDeltaRad,
        );

        const hudAxes = hud.getPanAxes();
        // Gamepad規約: スティック/ジョイスティックのy軸は前方向（奥へ倒す）が負値。
        const forwardAxis = clamp1(-(sticks.left.y + hudAxes.y));
        const rightAxis = clamp1(sticks.left.x + hudAxes.x);
        const panAxes: StickAxes = computePanAxesFromDirectionalInput(forwardAxis, rightAxis, forwardUnit, rightUnit);
        const zoomAxisY = clamp1(sticks.right.y + hud.getZoomAxis());
        viewController.feedAxes(panAxes, zoomAxisY, dtSeconds);

        // 右スティックX（物理コントローラー）とHUDの回転ボタンの軸値を合算する
        // （パン/ズームと同じ「単純加算してクランプ」方式）。
        const rotationAxisX = clamp1(sticks.right.x + hud.getRotationAxis());
        // HUDの高さボタンは単一の符号付き軸[-1,1]（上昇=正）で表現されるため、
        // 物理トリガー値[0,1]へ変換してから合算・クランプする。
        const hudHeightAxis = hud.getHeightAxis();
        const leftTriggerValue = clamp01(triggers.left + Math.max(0, -hudHeightAxis));
        const rightTriggerValue = clamp01(triggers.right + Math.max(0, hudHeightAxis));
        orientationController.feedAxes(rotationAxisX, leftTriggerValue, rightTriggerValue, dtSeconds);
    });

    return (): void => {
        scene.onBeforeRenderObservable.remove(renderObserver);
        untrackSticks();
        untrackButtons();
        unsubscribeTileModeCycle();
        unsubscribeExitAr();
        hud.dispose();
    };
};

