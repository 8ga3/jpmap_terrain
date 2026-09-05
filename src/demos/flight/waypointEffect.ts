/**
 * ウェイポイント通過エフェクト — 画面全体の衝撃波リップル。
 *
 * DOM オーバーレイ (#wp-shockwave) に `firing` クラスを付与して
 * CSS keyframes で画面いっぱいに広がる円形リップルを再生する。
 * 3D シーンに依存しないため、カメラ位置・モードに関わらず画面中央から発火。
 *
 * 連射対応: アニメーション中に再発火された場合は再生をリセットする。
 */

import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

const OVERLAY_ID = "wp-shockwave";
const FIRING_CLASS = "firing";

let pendingTimer: number | null = null;

const getOverlay = (): HTMLElement | null => {
    if (typeof document === "undefined") return null;
    return document.getElementById(OVERLAY_ID);
};

/**
 * ウェイポイント通過時の画面衝撃波エフェクトを発火する。
 * 引数 scene/position は API 互換のため受け取るが内部では使用しない
 * (3D 空間ではなく DOM オーバーレイで再生)。
 */
export const createPassEffect = (_scene: Scene, _position: Vector3): void => {
    const el = getOverlay();
    if (!el) return;

    // 連射時はクラスを一旦外して reflow → 再付与してアニメーション再生
    el.classList.remove(FIRING_CLASS);
    // 強制 reflow
    void el.offsetWidth;
    el.classList.add(FIRING_CLASS);

    if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
    }
    pendingTimer = window.setTimeout(() => {
        el.classList.remove(FIRING_CLASS);
        pendingTimer = null;
    }, 900);
};
