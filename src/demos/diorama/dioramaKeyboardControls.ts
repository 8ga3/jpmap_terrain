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
 * - WASD: 地図中心の移動（パン、カメラの現在の向き基準。後述）
 * - PageUp・R / PageDown・F: フットプリント半径のズーム
 *   （PageUp・R = ズームイン/縮小、PageDown・F = ズームアウト/拡大）
 * - Q / E: 箱庭の回転（Q = 反時計回り相当の負方向、E = 正方向。XRコントローラーの
 *   右スティックXと同じ軸表現へ変換して `DioramaOrientationController` へ渡す）
 * - Z / X: 箱庭の設置高さ変更（Z = 下げる、X = 上げる。XRコントローラーの
 *   左右トリガーと同じ入力表現へ変換する）
 * - T: タイル種別切替（`DioramaTileModeController.cycle()`。std→photo→wireframeの順に巡回）
 *
 * Tは他のキーと異なり「押しっぱなし」ではなく単発トリガーの操作のため、
 * 毎フレームの `pressed` セット走査（後述）ではなく `keydown` ハンドラ内で直接実行し、
 * キーリピート（長押し時に発火し続ける2回目以降の`keydown`、`event.repeat`）は無視する。
 *
 * AR終了操作（B/Yボタン・HUDの「⌂」ボタン、`dioramaArControls.ts`参照）に対応する
 * キーボード割り当ては無い。デスクトップキーボードは「AR非対応/AR突入前のPC単体での
 * 動作確認」用途であり、キーボード操作中にWebXRセッションへ実際に入っている状況は
 * 想定していないため（`immersive-ar`は没入表示でありデスクトップキーボード入力とは
 * 通常同時に使わない）。
 *
 * 矢印キーは意図的にパンへ割り当てない。`ArcRotateCamera.attachControl` は既定で
 * 矢印キーをカメラの軌道回転（alpha/beta）へバインドしており、同じキーを地図移動にも
 * 割り当てると「カメラ回転」と「地図移動」が同時に発生し、実機検証で混乱を招くことを
 * 確認した。矢印キーは Babylon 既定のカメラ操作用として空けておく。
 *
 * **カメラ向き基準のパン**: 単純に「Wキー=常に世界座標の北へ移動」だと、
 * カメラを（矢印キー等で）回転させた後にWASDを押した際、画面上の見た目の向きと
 * 実際の移動方向が一致せず操作しづらい（実機検証で指摘）。そのため、毎フレーム
 * カメラの現在の水平方向（前方向・右方向）を取得し、WASDの入力をその場のカメラ視点
 * 基準からワールド座標（東西・南北）へ回転変換してから `DioramaViewController` へ渡す
 * （AR中の実機カメラ配置（`webXrArSession.ts`）と同様、`camera.getDirection` を使う）。
 *
 * 対象キーは既定のブラウザ動作（PageUp/PageDown によるページスクロール等）を
 * 妨げるため `preventDefault()` する。ただし修飾キー（Ctrl/Cmd/Alt）併用時は
 * ブラウザ標準のショートカット（例: Ctrl+R = ページ再読み込み）を奪わないよう、
 * 素通しにする。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { DioramaViewController } from "./dioramaViewController";
import type { DioramaOrientationController } from "./dioramaOrientationController";
import type { DioramaTileModeController } from "./dioramaTileModeController";
import { computePanAxesFromDirectionalInput, type StickAxes } from "./dioramaControllerMapping";
import { getHorizontalDirectionUnit } from "./dioramaHorizontalDirection";

/** 前進（画面奥へ）・後退・左・右（いずれもカメラ視点基準）のキー割り当て。 */
const PAN_FORWARD_CODES = new Set(["KeyW"]);
const PAN_BACKWARD_CODES = new Set(["KeyS"]);
const PAN_LEFT_CODES = new Set(["KeyA"]);
const PAN_RIGHT_CODES = new Set(["KeyD"]);
const ZOOM_IN_CODES = new Set(["PageUp", "KeyR"]);
const ZOOM_OUT_CODES = new Set(["PageDown", "KeyF"]);
/** 箱庭回転のキー割り当て（Q = 負方向、E = 正方向）。 */
const ROTATE_NEGATIVE_CODES = new Set(["KeyQ"]);
const ROTATE_POSITIVE_CODES = new Set(["KeyE"]);
/** 箱庭の設置高さ変更のキー割り当て（Z = 下げる、X = 上げる）。 */
const HEIGHT_DOWN_CODES = new Set(["KeyZ"]);
const HEIGHT_UP_CODES = new Set(["KeyX"]);
/** タイル種別切替（単発トリガー）のキー割り当て。 */
const TILE_MODE_CYCLE_CODES = new Set(["KeyT"]);

const HANDLED_CODES = new Set<string>([
    ...PAN_FORWARD_CODES,
    ...PAN_BACKWARD_CODES,
    ...PAN_LEFT_CODES,
    ...PAN_RIGHT_CODES,
    ...ZOOM_IN_CODES,
    ...ZOOM_OUT_CODES,
    ...ROTATE_NEGATIVE_CODES,
    ...ROTATE_POSITIVE_CODES,
    ...HEIGHT_DOWN_CODES,
    ...HEIGHT_UP_CODES,
    ...TILE_MODE_CYCLE_CODES,
]);

const anyPressed = (pressed: ReadonlySet<string>, codes: ReadonlySet<string>): boolean => {
    for (const code of codes) {
        if (pressed.has(code)) return true;
    }
    return false;
};

/**
 * diorama デモにキーボード操作（地図移動・拡大縮小・箱庭回転・高さ変更・
 * タイル種別切替）をセットアップする。AR対応可否・ARセッション状態に
 * よらず常時有効にする想定（`index.ts` からデモ起動時に一度だけ呼ぶ）。
 *
 * @param camera パン方向をカメラの現在の向き基準へ補正するために参照する
 *   （`ArcRotateCamera` の水平方向）。
 * @param orientationController 箱庭の回転・高さオフセットの共有状態保持者
 *   （Q/E＝回転、Z/X＝高さ変更）。
 * @param tileModeController タイル種別の共有状態保持者（T＝巡回）。
 * @returns 後始末用の破棄関数。
 */
export const setupDioramaKeyboardControls = (
    scene: Scene,
    camera: ArcRotateCamera,
    viewController: DioramaViewController,
    orientationController: DioramaOrientationController,
    tileModeController: DioramaTileModeController,
): (() => void) => {
    const pressed = new Set<string>();

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!HANDLED_CODES.has(event.code)) return;
        // Tは単発トリガー（「押しっぱなし」の継続入力ではない）ため、
        // `pressed` セットには積まず、ここで直接1回だけ実行する。キーリピート
        // （長押しで発火し続ける2回目以降のkeydown、`event.repeat`）は無視する。
        if (TILE_MODE_CYCLE_CODES.has(event.code)) {
            if (!event.repeat) tileModeController.cycle();
            event.preventDefault();
            return;
        }
        pressed.add(event.code);
        event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
        if (!HANDLED_CODES.has(event.code)) return;
        // pressed の解放は修飾キーの有無に関わらず必ず行う（さもなくば、修飾キーを
        // 押しながらキーを離した場合にそのキーが「押しっぱなし」扱いのまま残り続ける）。
        // preventDefault のみ、ブラウザ標準ショートカット（例: Ctrl+R）を奪わないよう
        // 修飾キー併用時はスキップする（onKeyDownと同じ方針）。
        pressed.delete(event.code);
        if (event.ctrlKey || event.metaKey || event.altKey) return;
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

        let rawForward = 0; // +1 = W（カメラ視点の奥へ）
        let rawRight = 0; // +1 = D（カメラ視点の右へ）
        if (anyPressed(pressed, PAN_FORWARD_CODES)) rawForward += 1;
        if (anyPressed(pressed, PAN_BACKWARD_CODES)) rawForward -= 1;
        if (anyPressed(pressed, PAN_RIGHT_CODES)) rawRight += 1;
        if (anyPressed(pressed, PAN_LEFT_CODES)) rawRight -= 1;

        let panAxes: StickAxes = { x: 0, y: 0 };
        if (rawForward !== 0 || rawRight !== 0) {
            // カメラの現在の水平前方向・右方向へWASD入力を投影し、ワールド座標
            // （東西=x, 南北=z）へ変換する。これにより、カメラを回転させた後も
            // 「W=画面奥へ進む」という直感的な操作が維持される。
            const forward = getHorizontalDirectionUnit(camera, Vector3.Forward(scene.useRightHandedSystem));
            const right = getHorizontalDirectionUnit(camera, Vector3.Right());
            panAxes = computePanAxesFromDirectionalInput(rawForward, rawRight, forward, right);
        }

        let zoomAxisY = 0;
        if (anyPressed(pressed, ZOOM_IN_CODES)) zoomAxisY -= 1;
        if (anyPressed(pressed, ZOOM_OUT_CODES)) zoomAxisY += 1;

        viewController.feedAxes(panAxes, zoomAxisY, dtSeconds);

        let rotationAxisX = 0;
        if (anyPressed(pressed, ROTATE_POSITIVE_CODES)) rotationAxisX += 1;
        if (anyPressed(pressed, ROTATE_NEGATIVE_CODES)) rotationAxisX -= 1;

        // トリガー押下量[0,1]の等価入力として、押されていれば1、そうでなければ0を渡す。
        const leftTriggerValue = anyPressed(pressed, HEIGHT_DOWN_CODES) ? 1 : 0;
        const rightTriggerValue = anyPressed(pressed, HEIGHT_UP_CODES) ? 1 : 0;
        orientationController.feedAxes(rotationAxisX, leftTriggerValue, rightTriggerValue, dtSeconds);
    });

    return (): void => {
        scene.onBeforeRenderObservable.remove(renderObserver);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
    };
};
