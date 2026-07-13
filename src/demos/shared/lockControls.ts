/**
 * デモ共通の「画面操作ロック」ユーティリティ。
 *
 * 自動カメラ演出中に写真ボタン（地図切替）以外の画面操作を無効化したい
 * プロモーション用デモ（zoomloop / roiorbit 等）で共有する。
 */
import type { JpmapTerrain } from "../../lib/jpmapTerrain";

/**
 * 写真ボタン（`.cp-maptoggle`）以外の操作 UI（コンパス・視点切替・ズーム/現在地ボタン）を
 * 無効化する。要素自体は非表示にせず、クリック/キー操作のみ無効化する。
 * クラス名は `controlPanel.ts` が既に付与している安定した識別子を利用する
 * （`.cp-maptoggle` = 写真ボタンのみ意図的に対象外）。
 */
export const lockControlPanelExceptPhoto = (): void => {
    const targets = document.querySelectorAll<HTMLElement>(
        ".cp-compass, .cp-viewmode, .cp-zoombtn",
    );
    targets.forEach((el) => {
        el.tabIndex = -1;
        el.style.pointerEvents = "none";
        el.setAttribute("aria-disabled", "true");
        if (el instanceof HTMLButtonElement) {
            el.disabled = true;
        }
    });
};

/**
 * カメラ本体へのポインタ/キーボード/ホイール操作を無効化する。
 * `activeCamera.detachControl()` は Babylon の ArcRotateCamera 標準入力
 * （ドラッグ回転・ホイールズーム等）を止めるが、`globe.ts` が canvas に直接
 * 登録しているポインタ/2本指ジェスチャのハンドラ（yaw/pitch 変更用）や、
 * `jpmapTerrain.ts` が登録する wheel ハンドラは対象外で残ってしまう。
 * `canvas.style.pointerEvents = "none"` で canvas 自体を非対話にすることで、
 * それら独自ハンドラも含めて画面操作を確実に無効化する
 * （写真ボタン等の UI は canvas 外の別 DOM 要素のため影響を受けない）。
 * `JpmapTerrain` の公開 API には含まれないデバッグアクセサ `__debugScene` 経由で
 * 取得する（デモ層に閉じた実装であり、ライブラリ本体の挙動には影響しない）。
 */
export const lockCameraInput = (viewer: JpmapTerrain): void => {
    viewer.__debugScene?.activeCamera?.detachControl();
    const canvas = viewer.__debugScene?.getEngine().getRenderingCanvas();
    if (canvas) {
        canvas.style.pointerEvents = "none";
    }
};
