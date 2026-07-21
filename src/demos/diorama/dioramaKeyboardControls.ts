/**
 * diorama デモのデスクトップ用キーボード操作。
 *
 * @remarks
 * AR（`immersive-ar`）に対応した実機（Meta Quest 3等）が無い、またはAR突入前の
 * 動作確認をPCだけで完結させたいという要望から追加した。AR用のコントローラー
 * 操作（`dioramaArControls.ts`）と同じ `dioramaControllerMapping.ts` の純粋関数・
 * `DioramaViewController`（地図移動・拡大縮小の共有状態保持者）を経由するため、
 * キーボードでの移動はAR突入後も引き継がれる（逆も同様）。
 *
 * キー割り当て（レイアウト非依存の `KeyboardEvent.code` で判定）:
 * - 矢印キー / WASD: 地図中心の移動（パン）
 * - PageUp・R / PageDown・F: フットプリント半径のズーム
 *   （PageUp・R = ズームイン/縮小、PageDown・F = ズームアウト/拡大）
 *
 * 対象キーは既定のブラウザ動作（矢印/PageUp/PageDown によるページスクロール等）を
 * 妨げるため `preventDefault()` する。ただし修飾キー（Ctrl/Cmd/Alt）併用時は
 * ブラウザ標準のショートカット（例: Ctrl+R = ページ再読み込み）を奪わないよう、
 * 素通しにする。
 */
import type { Scene } from "@babylonjs/core/scene";

import type { DioramaViewController } from "./dioramaViewController";
import type { StickAxes } from "./dioramaControllerMapping";

const PAN_UP_CODES = new Set(["ArrowUp", "KeyW"]);
const PAN_DOWN_CODES = new Set(["ArrowDown", "KeyS"]);
const PAN_LEFT_CODES = new Set(["ArrowLeft", "KeyA"]);
const PAN_RIGHT_CODES = new Set(["ArrowRight", "KeyD"]);
const ZOOM_IN_CODES = new Set(["PageUp", "KeyR"]);
const ZOOM_OUT_CODES = new Set(["PageDown", "KeyF"]);

const HANDLED_CODES = new Set<string>([
    ...PAN_UP_CODES,
    ...PAN_DOWN_CODES,
    ...PAN_LEFT_CODES,
    ...PAN_RIGHT_CODES,
    ...ZOOM_IN_CODES,
    ...ZOOM_OUT_CODES,
]);

const anyPressed = (pressed: ReadonlySet<string>, codes: ReadonlySet<string>): boolean => {
    for (const code of codes) {
        if (pressed.has(code)) return true;
    }
    return false;
};

/**
 * diorama デモにキーボード操作（地図移動・拡大縮小）をセットアップする。
 * AR対応可否・ARセッション状態によらず常時有効にする想定
 * （`index.ts` からデモ起動時に一度だけ呼ぶ）。
 *
 * @returns 後始末用の破棄関数。
 */
export const setupDioramaKeyboardControls = (scene: Scene, viewController: DioramaViewController): (() => void) => {
    const pressed = new Set<string>();

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!HANDLED_CODES.has(event.code)) return;
        pressed.add(event.code);
        event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
        if (!HANDLED_CODES.has(event.code)) return;
        pressed.delete(event.code);
        event.preventDefault();
    };
    // ウィンドウ非アクティブ化等でkeyupを取りこぼすと押しっぱなし状態が残り続けるため、
    // blur時に全キーを解放する。
    const onBlur = (): void => pressed.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const renderObserver = scene.onBeforeRenderObservable.add(() => {
        const dtSeconds = scene.getEngine().getDeltaTime() / 1000;
        if (!(dtSeconds > 0)) return;

        let rawX = 0;
        let rawY = 0;
        if (anyPressed(pressed, PAN_RIGHT_CODES)) rawX += 1;
        if (anyPressed(pressed, PAN_LEFT_CODES)) rawX -= 1;
        // y軸規約（スティックのgamepad規約に合わせる）: 前方向（奥へ）が負値。
        if (anyPressed(pressed, PAN_UP_CODES)) rawY -= 1;
        if (anyPressed(pressed, PAN_DOWN_CODES)) rawY += 1;
        // 斜め移動（例: 上+右同時押し）が軸沿い移動よりも速くならないよう、
        // 大きさが1を超える場合は単位ベクトルへ正規化する（スティックの
        // 最大偏倚量が半径1の円に収まる規約と揃える）。
        const magnitude = Math.hypot(rawX, rawY);
        const panAxes: StickAxes = magnitude > 1 ? { x: rawX / magnitude, y: rawY / magnitude } : { x: rawX, y: rawY };

        let zoomAxisY = 0;
        if (anyPressed(pressed, ZOOM_IN_CODES)) zoomAxisY -= 1;
        if (anyPressed(pressed, ZOOM_OUT_CODES)) zoomAxisY += 1;

        viewController.feedAxes(panAxes, zoomAxisY, dtSeconds);
    });

    return (): void => {
        scene.onBeforeRenderObservable.remove(renderObserver);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
    };
};
