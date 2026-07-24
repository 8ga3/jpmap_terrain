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
 * **パン方向は「ユーザー（実機カメラ）の位置と箱庭の位置関係」＋「箱庭自体の回転」基準**:
 * 頭部/デバイスが向いている方向（視線）を基準にすると、ユーザーが物理的に
 * 移動した際に基準が不安定になり分かりにくく、また箱庭自体を回転させた場合の
 * 見た目とも整合しない。そのため、以下の2つから「ユーザーから見て奥（遠ざかる）
 * 方向」を算出し、パン入力の前後・左右の基準とする。
 *
 * 1. 実機カメラの現在位置から箱庭中心への水平方向（`computeHorizontalDisplacement`）。
 *    箱庭の位置（`dioramaRoot.position`）はAR配置後は固定のため、この向きは
 *    ユーザーが物理的に箱庭の周りを移動した場合にのみ変わる（視線の向きより
 *    はるかに安定する）。
 * 2. 箱庭自体の回転角（`orientationController.getRotationRad()`、右スティックXで
 *    ユーザーが回転させた角度）。箱庭を回転させると、同じ物理的な立ち位置でも
 *    「ユーザーから見て奥」が指す実世界の方角（緯度経度上の方角）が変わるため、
 *    上記1の向きから箱庭の回転角を差し引く（打ち消す）ことで、箱庭に組み込まれた
 *    地理座標系（回転前のローカル座標系＝実世界の東西・南北）における
 *    「ユーザーから見て奥」の向きを求める。
 *
 * **ユーザーが箱庭に重なるように立っている場合はデッドゾーン**: 実機カメラと
 * 箱庭中心の水平距離が箱庭の卓上表示半径（`tableRadiusM`）以下の場合、上記1の
 * 向きの算出自体が不安定になる（距離が0に近づくほどわずかな立ち位置のずれで
 * 向きが大きく変わる）ため、有効な安定化手段が無い。そのため、この範囲内では
 * バーチャルジョイスティック/スティックのパン入力自体を無効化する
 * （{@link isInsideDeadZone}、ヒステリシス付き。回転・高さ変更・ズーム等
 * 他の操作には影響しない）。
 *
 * 実機カメラの位置は体の揺れ等で微小に変動するため、生の向き角をそのまま
 * 使うとパン方向が静止中も小刻みに変わり得る。{@link snapHeadingRad}
 * （`webXrStickInput.ts`）でヒステリシス付き8方位スナップへ丸めてから
 * 使うことで安定させる（回転操作（右スティックX）・箱庭の向き自体には影響しない。
 * あくまでパン方向の基準のみに使う）。
 *
 * 本モジュールは箱庭の回転（右スティックX）・設置高さ変更（左右トリガー）の
 * 入力も併せて配線する。こちらは `DioramaOrientationController`
 * （`dioramaOrientationController.ts`）が同期的に対象ノードへ反映するため、
 * パン/ズームのような完了待ちの仕組みは不要。
 *
 * **右スティックは十字ボタン相当の排他動作（X=回転・Y=ズーム）**: 物理スティックは
 * 上下・左右いずれか一方だけを操作するつもりでもわずかに斜めへずれやすく、
 * X/Yを完全に独立して扱うと意図しない同時発火（下へ倒してズームしているつもりが、
 * わずかな左右のずれで回転も発火する等）が起きる。そのため物理スティックの
 * 生入力（`sticks.right`）へは{@link applyDPadGate}（`webXrStickInput.ts`）を
 * 適用し、支配的な軸のみを有効にしてからHUDの軸値と合算する。GUIのズーム/回転
 * ボタンはもともと個別のボタンで排他的なため、本ゲート処理の対象外。
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
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { WebXRFeatureName } from "@babylonjs/core/XR/webXRFeaturesManager";
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
    computeHorizontalDisplacement,
    isInsideDeadZone,
    angleDeltaRad,
    applyDPadGate,
} from "../../lib/webxr/webXrStickInput";
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
 * タイル種別切替・AR終了のセットアップを行う。
 * `xrExperience.baseExperience.enterXRAsync(...)` 完了後に呼び、退出/破棄時に
 * 返り値の破棄関数を呼ぶこと。
 *
 * @param dioramaRoot AR配置後の箱庭中心ノード（`index.ts`が生成する
 *   `placementRoot`。`webXrArSession.ts`が`enterXRAsync`後にユーザー正面の
 *   絶対位置へ配置する）。パン方向算出のため、`.position`（水平位置）を
 *   毎フレーム参照する。
 * @param tableRadiusM 箱庭の卓上表示半径[m]（デッドゾーン半径として使う。
 *   冒頭のコメント参照）。
 * @param hud {@link createDioramaArControlHudForSession} で事前に生成したHUD
 *   （`enterXRAsync` より前に呼んでおく必要がある。冒頭のコメント参照）。
 * @param orientationController 箱庭の回転・高さオフセットの共有状態保持者
 *   （右スティックX＝回転、左右トリガー＝高さ変更）。パン方向算出でも
 *   箱庭の現在の回転角（`getRotationRad()`）を参照する。
 * @param tileModeController タイル種別の共有状態保持者（A/Xボタン・HUDタイル
 *   切替ボタン＝巡回）。
 */
export const setupDioramaArControls = (
    scene: Scene,
    xr: WebXRDefaultExperience,
    dioramaRoot: TransformNode,
    tableRadiusM: number,
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
    // デッドゾーン（ユーザーが箱庭に重なるように立っている状態）の判定結果
    // （ヒステリシス付き、冒頭のコメント参照）。初期状態は「外側」とする
    // （AR配置直後はユーザーと箱庭の間に間隔があるため。`webXrArSession.ts`の
    // `AR_PLACEMENT_DISTANCE_M` 参照）。
    let wasInsideDeadZone = false;

    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        const dtSeconds = scene.getEngine().getDeltaTime() / 1000;
        if (!(dtSeconds > 0)) return;

        // ユーザー（実機カメラ）から箱庭中心への水平方向・距離を算出し、
        // デッドゾーン（ユーザーが箱庭に重なるように立っている状態）かどうかを
        // ヒステリシス付きで判定する（冒頭のコメント参照）。
        const cameraPosition = xr.baseExperience.camera.position;
        const dioramaPosition = dioramaRoot.position;
        const { unit: awayFromUserUnit, distanceM } = computeHorizontalDisplacement(
            cameraPosition.x,
            cameraPosition.z,
            dioramaPosition.x,
            dioramaPosition.z,
        );
        const isNowInsideDeadZone = isInsideDeadZone(distanceM, wasInsideDeadZone, tableRadiusM);
        if (isNowInsideDeadZone && !wasInsideDeadZone) {
            // デッドゾーンへ新規に入った（外側→内側へ遷移した）タイミングで
            // スナップ基準をリセットする。リセットしないと、デッドゾーン内で
            // 立ち位置が大きく変わった場合に、抜けた直後の`snapHeadingRad`が
            // 「入る前の古いスナップ角」を前回値としてヒステリシス判定してしまい、
            // 復帰直後にパン方向の基準が不自然に固着し得る（回帰テスト参照）。
            previousSnappedHeadingRad = undefined;
        }
        wasInsideDeadZone = isNowInsideDeadZone;

        let panAxes: StickAxes = { x: 0, y: 0 };
        if (!wasInsideDeadZone) {
            // 箱庭自体の回転角を打ち消し、箱庭に組み込まれた地理座標系
            // （回転前のローカル座標系＝実世界の東西・南北）における
            // 「ユーザーから見て奥」の向きを求める。
            const localAwayFromUserUnit = rotateHorizontalUnitVector(
                awayFromUserUnit,
                -orientationController.getRotationRad(),
            );
            const rawHeadingRad = computeHeadingRadFromHorizontal(localAwayFromUserUnit.x, localAwayFromUserUnit.z);
            const snappedHeadingRad = snapHeadingRad(rawHeadingRad, previousSnappedHeadingRad);
            previousSnappedHeadingRad = snappedHeadingRad;
            // 生の向き角からスナップ後の向き角への差分だけ、奥方向の単位ベクトルを
            // 回転させる。単純な引き算（`snappedHeadingRad - rawHeadingRad`）は
            // ±π境界を跨ぐと差分がほぼ`±2π`（実際の最短差はほぼ0）になり得るため、
            // `angleDeltaRad`で`(-π, π]`へ正規化した最短差分を使う（`Math.sin`/
            // `Math.cos`へ渡す引数を小さく保ち、数値誤差の増大を避ける）。
            // 右方向は奥方向をさらに90°回転（時計回り）させて求める
            // （`computeHeadingRadFromHorizontal`の規約: 北→東が時計回りのため、
            // 奥方向を基準に+90°した方向が「右」に一致する）。
            const headingDeltaRad = angleDeltaRad(rawHeadingRad, snappedHeadingRad);
            const forwardUnit = rotateHorizontalUnitVector(localAwayFromUserUnit, headingDeltaRad);
            const rightUnit = rotateHorizontalUnitVector(forwardUnit, Math.PI / 2);

            const hudAxes = hud.getPanAxes();
            // Gamepad規約: スティック/ジョイスティックのy軸は前方向（奥へ倒す）が負値。
            const forwardAxis = clamp1(-(sticks.left.y + hudAxes.y));
            const rightAxis = clamp1(sticks.left.x + hudAxes.x);
            panAxes = computePanAxesFromDirectionalInput(forwardAxis, rightAxis, forwardUnit, rightUnit);
        }
        // 右スティックの物理入力は十字ボタン相当の排他動作へ整形する
        // （X=回転・Y=ズームが斜めドリフトで同時発火しないようにする。
        // `dioramaControllerMapping.ts`冒頭のコメント参照）。GUIのズーム/回転
        // ボタン（`hud.getZoomAxis()`/`hud.getRotationAxis()`）はもともと個別の
        // ボタンで排他的なため、本ゲート処理を適用するのは物理スティックの
        // 生入力のみでよい。
        const gatedRightStick = applyDPadGate(sticks.right.x, sticks.right.y);
        const zoomAxisY = clamp1(gatedRightStick.y + hud.getZoomAxis());
        viewController.feedAxes(panAxes, zoomAxisY, dtSeconds);

        // 右スティックX（物理コントローラー、ゲート適用後）とHUDの回転ボタンの
        // 軸値を合算する（パン/ズームと同じ「単純加算してクランプ」方式）。
        const rotationAxisX = clamp1(gatedRightStick.x + hud.getRotationAxis());
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

