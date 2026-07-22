/**
 * diorama デモの「AR非対応環境・AR突入前の通常表示」向けタッチ操作。
 *
 * @remarks
 * `dioramaArControlHud.ts` のGUI（仮想ジョイスティック + ズーム/回転/高さボタン）を
 * 常時マウントし、AR/XRセッションの有無に関わらず毎フレーム入力を
 * `DioramaViewController`/`DioramaOrientationController` へ反映する。
 *
 * **背景**: 本Issue追加当初、地図移動・拡大縮小・箱庭回転・高さ変更は
 * デスクトップキーボード（`dioramaKeyboardControls.ts`）とAR中のXRコントローラー/
 * GUI（`dioramaArControls.ts`、AR突入時のみ生成される別インスタンスのHUD）にしか
 * 配線されていなかった。物理コントローラー・キーボードのいずれも持たない
 * Androidスマホ等で、AR非対応/AR突入前の「通常表示」のままデモを開くと、
 * 地図移動・拡大縮小・回転・高さ変更のいずれも操作する手段が無い不具合が
 * 実機検証で判明したため、本モジュールを追加した。
 *
 * 本モジュールが使うHUDインスタンスは、AR中に使われるHUD
 * （`webXrArSession.ts`が`enterAr`のたびに生成・破棄する別インスタンス）とは
 * 独立している。`index.ts` がデモ起動時に1つ生成して `mount` へ常時マウントする。
 * ただし両HUDの `element` は同一領域（画面全体）に絶対配置されるため、AR中に
 * 両方を同時表示するとジョイスティック/ボタンが二重に重なって表示されてしまう。
 * そのため本モジュールが返す {@link DioramaTouchControls.setVisible} を
 * `index.ts` 経由で `webXrArSession.ts` のAR入退場処理から呼び、AR中は非表示
 * （`display:none`）にする。非表示中はボタン類がポインタイベントを受け取れず
 * 内部軸値は常に0のままになるため、毎フレームの入力反映ループ自体は止めず
 * 単純化のため常時実行する（0入力のfeedAxesは実質no-opで軽量なため）。
 */
import type { Scene } from "@babylonjs/core/scene";

import type { DioramaViewController } from "./dioramaViewController";
import type { DioramaOrientationController } from "./dioramaOrientationController";
import type { DioramaArControlHud } from "./dioramaArControlHud";

export interface DioramaTouchControls {
    /**
     * HUDの表示/非表示を切り替える（AR中は `webXrArSession.ts` 側からfalseを
     * 渡し、AR専用のHUDとの二重表示を避ける）。
     */
    setVisible(visible: boolean): void;
    /** 後始末用の破棄関数。 */
    dispose(): void;
}

/**
 * 常時表示のタッチHUDによる地図移動・拡大縮小・箱庭回転・高さ変更のセットアップを
 * 行う。`index.ts` からデモ起動時に一度だけ呼ぶこと（AR突入可否に関わらず、
 * デモの生存期間中ずっと有効にする）。
 */
export const setupDioramaTouchControls = (
    scene: Scene,
    hud: DioramaArControlHud,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
): DioramaTouchControls => {
    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        const dtSeconds = scene.getEngine().getDeltaTime() / 1000;
        if (!(dtSeconds > 0)) return;

        viewController.feedAxes(hud.getPanAxes(), hud.getZoomAxis(), dtSeconds);

        // 高さボタンは単一の符号付き軸[-1,1]（上昇=正）で表現されるため、
        // `computeDioramaHeightMetersFromTriggers` の左右トリガー引数へ変換する。
        const heightAxis = hud.getHeightAxis();
        const rightTriggerValue = Math.max(0, heightAxis);
        const leftTriggerValue = Math.max(0, -heightAxis);
        orientationController.feedAxes(hud.getRotationAxis(), leftTriggerValue, rightTriggerValue, dtSeconds);
    });

    return {
        setVisible: (visible: boolean): void => {
            hud.element.style.display = visible ? "" : "none";
        },
        dispose: (): void => {
            scene.onBeforeRenderObservable.remove(renderObserver);
        },
    };
};
