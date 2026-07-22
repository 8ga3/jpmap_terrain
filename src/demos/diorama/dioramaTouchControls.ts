/**
 * diorama デモの「AR非対応環境・AR突入前の通常表示」向けタッチ操作。
 *
 * @remarks
 * `dioramaArControlHud.ts` のGUI（仮想ジョイスティック + ズーム/回転/高さ/
 * タイル切替/リセットボタン）を常時マウントし、AR/XRセッションの有無に関わらず
 * 毎フレーム入力を `DioramaViewController`/`DioramaOrientationController` へ反映する。
 * タイル種別切替・トップ復帰（単発タップ）はHUDのイベント購読
 * （`onTileModeCyclePress`/`onResetToInitialPress`）経由で配線する。
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
 * （`display:none`）にする。タイル切替/リセットボタンは非表示中は
 * `display:none` の子要素としてクリック自体を受け付けなくなるため、
 * `feedAxes` と異なり明示的な `visible` ガードは不要（冒頭の懸念は継続入力
 * （押しっぱなし軸値）特有のもので、単発タップのクリックイベントには当てはまらない）。
 *
 * **非表示中はHUDの軸値を無視する**: `display:none` はDOM上の見た目を隠すのみで、
 * HUD内部の軸値（ボタンの押下状態）が0へリセットされる保証はない
 * （例: ボタンを押下したままAR突入し `display:none` になった場合、
 * ブラウザ実装によっては当該要素への `pointerup`/`keyup` が発火せず、押下中の
 * 軸値が残り続け得る）。非表示中もHUDの軸値をそのままfeedし続けると、
 * 復帰後に気づかぬまま箱庭が動き続ける不具合になり得るため、`setVisible(false)`
 * の間は内部フラグでHUDの軸値を一切読まず、`feedAxes` 自体を呼ばないようにする。
 */
import type { Scene } from "@babylonjs/core/scene";

import type { DioramaViewController } from "./dioramaViewController";
import type { DioramaOrientationController } from "./dioramaOrientationController";
import type { DioramaTileModeController } from "./dioramaTileModeController";
import type { DioramaArControlHud } from "./dioramaArControlHud";

export interface DioramaTouchControls {
    /**
     * HUDの表示/非表示を切り替える（AR中は `webXrArSession.ts` 側からfalseを
     * 渡し、AR専用のHUDとの二重表示を避ける）。非表示中はHUDの軸値を一切
     * 読まない（冒頭のコメント参照）。
     */
    setVisible(visible: boolean): void;
    /** 後始末用の破棄関数。 */
    dispose(): void;
}

/**
 * 常時表示のタッチHUDによる地図移動・拡大縮小・箱庭回転・高さ変更・タイル種別
 * 切替・トップ復帰のセットアップを行う。`index.ts` からデモ起動時に一度だけ
 * 呼ぶこと（AR突入可否に関わらず、デモの生存期間中ずっと有効にする）。
 *
 * @param tileModeController タイル種別の共有状態保持者（HUDタイル切替ボタン＝巡回、
 *   HUDリセットボタン＝トップ復帰の一部）。
 */
export const setupDioramaTouchControls = (
    scene: Scene,
    hud: DioramaArControlHud,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
    tileModeController: DioramaTileModeController,
): DioramaTouchControls => {
    let visible = true;

    const unsubscribeTileModeCycle = hud.onTileModeCyclePress(() => tileModeController.cycle());
    const unsubscribeResetToInitial = hud.onResetToInitialPress(() => {
        viewController.resetToInitial();
        orientationController.resetToInitial();
    });

    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        // 非表示中はHUDの軸値を無視する（冒頭のコメント参照。押下状態が0に
        // リセットされている保証がないため、読み取り自体を行わない）。
        if (!visible) return;
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
        setVisible: (value: boolean): void => {
            visible = value;
            hud.element.style.display = value ? "" : "none";
        },
        dispose: (): void => {
            scene.onBeforeRenderObservable.remove(renderObserver);
            unsubscribeTileModeCycle();
            unsubscribeResetToInitial();
        },
    };
};
