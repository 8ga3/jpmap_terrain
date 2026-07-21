/**
 * diorama デモのAR中コントローラー/タッチ入力を、実際の
 * `dioramaTerrain.setCenter`/`setFootprintRadius` 呼び出しへ橋渡しする。
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
 * 排他制御は行わない）。
 *
 * `setCenter`/`setFootprintRadius` は非同期の地形再構築（タイル/DEM再取得）を
 * 伴うため毎フレーム呼ぶとネットワーク負荷が高い。移動量・ズーム後の半径を
 * 一定間隔ごとにまとめて適用する（{@link APPLY_INTERVAL_MS}）。
 *
 * 本モジュールが `center`/`footprintRadiusM` の現在値を単独で保持・更新する
 * （`DioramaTerrain` 自体は現在値のgetterを持たないため）。将来のサブタスク
 * （箱庭回転・高さ変更、タイル切替・トップ復帰等）で同じ値を変更する場合も、
 * 本モジュール経由で行うことを想定する（経路を分けると値がずれるため）。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";
import type { WebXRInputSource } from "@babylonjs/core/XR/webXRInputSource";
import { WebXRFeatureName } from "@babylonjs/core/XR/webXRFeaturesManager";
// `xr-dom-overlay` feature をfeaturesManagerへ登録する副作用 import
// （AR中もコントロールHUDを表示し続けるために使う）。
import "@babylonjs/core/XR/features/WebXRDOMOverlay";

import type { DioramaTerrain } from "../../terrain/diorama/dioramaTerrain";
import type { DioramaCenter } from "../../terrain/diorama/dioramaGrid";
import { offsetToLatLon } from "../../terrain/diorama/dioramaGrid";
import {
    computeDioramaPanMetersFromStick,
    computeFootprintRadiusFactorFromStick,
    clampFootprintRadiusM,
    type StickAxes,
} from "./dioramaControllerMapping";
import { createDioramaArControlHud } from "./dioramaArControlHud";

/** 移動量の適用間隔[ms]（この間隔ごとにまとめて `setCenter`/`setFootprintRadius` を呼ぶ）。 */
const APPLY_INTERVAL_MS = 300;

/** 左右コントローラーのスティック軸を保持する（未接続時は `{0,0}`）。 */
interface ControllerStickState {
    left: StickAxes;
    right: StickAxes;
}
const zeroStickState = (): ControllerStickState => ({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });

/**
 * 追加されたコントローラーのthumbstick入力を `sticks` へ反映するリスナーを登録する
 * （`feature/533-webxr-vr-viewer` の `trackControllerSticks` と同じ設計）。
 * @returns 登録解除関数。
 */
const trackControllerSticks = (xr: WebXRDefaultExperience, sticks: ControllerStickState): (() => void) => {
    const bindController = (controller: WebXRInputSource): void => {
        const handedness = controller.inputSource.handedness;
        if (handedness !== "left" && handedness !== "right") return;
        controller.onMotionControllerInitObservable.add((motionController) => {
            const thumbstick = motionController.getComponentOfType("thumbstick");
            thumbstick?.onAxisValueChangedObservable.add(({ x, y }) => {
                sticks[handedness] = { x, y };
            });
        });
    };
    xr.input.controllers.forEach(bindController);
    const addedObserver = xr.input.onControllerAddedObservable.add(bindController);
    const removedObserver = xr.input.onControllerRemovedObservable.add((controller) => {
        const handedness = controller.inputSource.handedness;
        if (handedness === "left" || handedness === "right") {
            sticks[handedness] = { x: 0, y: 0 };
        }
    });
    return () => {
        xr.input.onControllerAddedObservable.remove(addedObserver);
        xr.input.onControllerRemovedObservable.remove(removedObserver);
    };
};

/** [-1,1] へクランプする（コントローラー入力とGUI入力の単純加算が範囲を超えないようにする）。 */
const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

export interface DioramaArControlsOptions {
    /** AR突入時点の実世界中心（デモの既定中心。トップ復帰機能の基準にもなる想定）。 */
    initialCenter: DioramaCenter;
    /** AR突入時点のフットプリント半径[m]。 */
    initialFootprintRadiusM: number;
}

/**
 * AR中のコントローラー/GUI入力による地図移動・拡大縮小のセットアップを行う。
 * ARセッション開始時に呼び、退出/破棄時に返り値の破棄関数を呼ぶこと。
 */
export const setupDioramaArControls = (
    scene: Scene,
    xr: WebXRDefaultExperience,
    dioramaTerrain: DioramaTerrain,
    options: DioramaArControlsOptions,
): (() => void) => {
    let currentCenter = options.initialCenter;
    let currentFootprintRadiusM = clampFootprintRadiusM(options.initialFootprintRadiusM);
    let lastAppliedFootprintRadiusM = currentFootprintRadiusM;

    const sticks = zeroStickState();
    const untrackSticks = trackControllerSticks(xr, sticks);

    const hud = createDioramaArControlHud();
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

    let pendingEastM = 0;
    let pendingNorthM = 0;
    let lastAppliedAtMs = performance.now();

    const flushIfDue = (nowMs: number): void => {
        if (nowMs - lastAppliedAtMs < APPLY_INTERVAL_MS) return;
        lastAppliedAtMs = nowMs;

        if (pendingEastM !== 0 || pendingNorthM !== 0) {
            currentCenter = offsetToLatLon(currentCenter, pendingEastM, pendingNorthM);
            pendingEastM = 0;
            pendingNorthM = 0;
            dioramaTerrain.setCenter(currentCenter.lat, currentCenter.lon).catch((err: unknown) => {
                console.error("[jpmap-terrain diorama demo] setCenter failed:", err);
            });
        }

        if (currentFootprintRadiusM !== lastAppliedFootprintRadiusM) {
            lastAppliedFootprintRadiusM = currentFootprintRadiusM;
            dioramaTerrain.setFootprintRadius(currentFootprintRadiusM).catch((err: unknown) => {
                console.error("[jpmap-terrain diorama demo] setFootprintRadius failed:", err);
            });
        }
    };

    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        const dtSeconds = scene.getEngine().getDeltaTime() / 1000;
        if (!(dtSeconds > 0)) return;

        const hudAxes = hud.getPanAxes();
        const panAxes: StickAxes = {
            x: clamp1(sticks.left.x + hudAxes.x),
            y: clamp1(sticks.left.y + hudAxes.y),
        };
        const { eastM, northM } = computeDioramaPanMetersFromStick(panAxes, dtSeconds, currentFootprintRadiusM);
        pendingEastM += eastM;
        pendingNorthM += northM;

        const zoomAxisY = clamp1(sticks.right.y + hud.getZoomAxis());
        const factor = computeFootprintRadiusFactorFromStick(zoomAxisY, dtSeconds);
        if (factor !== 1) {
            currentFootprintRadiusM = clampFootprintRadiusM(currentFootprintRadiusM * factor);
        }

        flushIfDue(performance.now());
    });

    return (): void => {
        scene.onBeforeRenderObservable.remove(renderObserver);
        untrackSticks();
        hud.dispose();
    };
};
