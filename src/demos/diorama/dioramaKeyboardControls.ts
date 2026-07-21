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
import type { StickAxes } from "./dioramaControllerMapping";

/** 前進（画面奥へ）・後退・左・右（いずれもカメラ視点基準）のキー割り当て。 */
const PAN_FORWARD_CODES = new Set(["KeyW"]);
const PAN_BACKWARD_CODES = new Set(["KeyS"]);
const PAN_LEFT_CODES = new Set(["KeyA"]);
const PAN_RIGHT_CODES = new Set(["KeyD"]);
const ZOOM_IN_CODES = new Set(["PageUp", "KeyR"]);
const ZOOM_OUT_CODES = new Set(["PageDown", "KeyF"]);

const HANDLED_CODES = new Set<string>([
    ...PAN_FORWARD_CODES,
    ...PAN_BACKWARD_CODES,
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

/** 水平方向がほぼ0（カメラが真上/真下を向いている等の退化ケース）とみなす閾値。 */
const HORIZONTAL_DIRECTION_EPSILON = 1e-6;

/**
 * カメラのローカル軸（`Vector3.Forward()`/`Vector3.Right()`）をワールド空間へ変換し、
 * 水平面（XZ平面、東西・南北に相当）へ投影した単位ベクトルを返す。カメラが
 * 真上/真下を向く退化ケースでは `{x:0, z:0}` を返す（呼び出し側で無視される）。
 */
const getHorizontalDirectionUnit = (camera: ArcRotateCamera, localAxis: Vector3): { x: number; z: number } => {
    const dir = camera.getDirection(localAxis);
    const lenSq = dir.x * dir.x + dir.z * dir.z;
    if (lenSq < HORIZONTAL_DIRECTION_EPSILON) return { x: 0, z: 0 };
    const invLen = 1 / Math.sqrt(lenSq);
    return { x: dir.x * invLen, z: dir.z * invLen };
};

/**
 * diorama デモにキーボード操作（地図移動・拡大縮小）をセットアップする。
 * AR対応可否・ARセッション状態によらず常時有効にする想定
 * （`index.ts` からデモ起動時に一度だけ呼ぶ）。
 *
 * @param camera パン方向をカメラの現在の向き基準へ補正するために参照する
 *   （`ArcRotateCamera` の水平方向）。
 * @returns 後始末用の破棄関数。
 */
export const setupDioramaKeyboardControls = (
    scene: Scene,
    camera: ArcRotateCamera,
    viewController: DioramaViewController,
): (() => void) => {
    const pressed = new Set<string>();

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!HANDLED_CODES.has(event.code)) return;
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
            let eastUnit = rawForward * forward.x + rawRight * right.x;
            let northUnit = rawForward * forward.z + rawRight * right.z;
            // 斜め移動（例: 前進+右同時押し）が軸沿い移動よりも速くならないよう、
            // 大きさが1を超える場合は単位ベクトルへ正規化する（スティックの
            // 最大偏倚量が半径1の円に収まる規約と揃える）。
            const magnitude = Math.hypot(eastUnit, northUnit);
            if (magnitude > 1) {
                eastUnit /= magnitude;
                northUnit /= magnitude;
            }
            // `computeDioramaPanMetersFromStick` の規約（x=東、y軸は前方向が負値）に合わせる。
            // `-0`（northUnit===0のとき-northUnitが-0になる）を避けるため`+0`で正規化する。
            panAxes = { x: eastUnit, y: -northUnit + 0 };
        }

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
