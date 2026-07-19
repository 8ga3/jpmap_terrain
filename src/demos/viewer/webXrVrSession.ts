/**
 * viewer デモの WebXR (immersive-vr) 対応 PoC。
 *
 * @remarks
 * **暫定実装（PoC）である旨の注記**: 本モジュールはデモ層 (`src/demos/viewer`) に閉じた
 * PoC実装であり、`JpmapTerrain` の公開APIではない `__debugScene`（`@internal`）や
 * `src/terrain/geo` 配下の内部モジュールへ直接依存している。これは
 * `src/demos/flight` / `src/demos/roiorbit` が採用している「外部カメラ（Follow
 * カメラ等）で地形 LOD を駆動する」既存パターンを踏襲したもの。
 * 動作が安定した段階で `JpmapTerrain` 公開APIへ昇格することを前提とする
 * （フォローアップ Issue で検討）。
 *
 * 設計:
 * - WebXR カメラ (`WebXRCamera`) は毎フレーム実機のヘッドセット姿勢で local position /
 *   rotationQuaternion を上書きするため、直接 ECEF 絶対座標を書き込めない。
 *   そのため「リグ」(`TransformNode`) を親に設定し（Babylon 公式の
 *   "Moving the camera" パターン）、リグの position/rotationQuaternion を
 *   現在の lat/lon + 地表からの高さ（altitude）から算出した ECEF 位置・東西南北基底で
 *   毎フレーム更新する。
 * - パン（左スティック）・ズーム（右スティック、高度）は
 *   {@link module:src/demos/viewer/webXrControllerMapping.ts} の純粋関数に委譲する。
 * - B/Y ボタン（`EXIT_BUTTON_INDEX`）で VR セッションを終了する（没入中は 2D DOM
 *   ボタンに触れられないため）。ブラウザ標準の Gamepad API（`XRInputSource.gamepad`）を
 *   毎フレームポーリングする方式（`pollExitButton`）。当初はグリップ（squeeze）を
 *   使っていたが、コントローラーを握る動作で誤操作が多いとの実機フィードバックを受けて
 *   変更した。Babylon の高レベル API（`motionController.getComponentOfType(...)`）は
 *   実機で反応しない事例を確認したため、プロファイル解決を経由しないこちらを採用している。
 * - 地形 LOD は `viewer.detachTileCamera()` + `viewer.refreshTerrainWithExternalFrustum`
 *   （flight/roiorbit デモと同じ「外部カメラ frustum」パターン、C案）で追従させる。
 *   `lodBias` も渡し、内部で上書きされる `camera.radius`（マーカー/ポリゴン/サークルの
 *   距離ベース自動スケール計算にも使われる）を実際の地表高度と一致させる
 *   （{@link computeLodBiasForAltitude} 参照。実機検証で「近距離マーカーが巨大表示される」
 *   不具合を確認・修正済み）。
 * - `viewer.altitude`（desktop ArcRotateCamera の `radius`＝注視点からの距離）は VR の
 *   地表高度としてそのまま使わない。既定の 2000m を使うと空しか見えない高度に
 *   なるため（実機検証で確認済み）、VR 突入時は控えめな既定高度
 *   （{@link DEFAULT_VR_HOVER_HEIGHT_M}）を使う。
 * - WebXR セッションの `depthNear`/`depthFar`（近遠クリップ、実際の地表高度に応じて
 *   毎フレーム間引きつつ動的更新、{@link updateXrDepthRange}）は
 *   `WebXRSessionManager.updateRenderState({ depthNear, depthFar })` を呼んで設定する。
 *   **重要**: `camera.minZ`/`camera.maxZ` を設定するだけでは実描画に一切反映されない
 *   （`WebXRCamera.updateFromXRFrame` がブラウザ提供の `XRView.projectionMatrix` を
 *   そのままコピーする実装のため、通常の `Camera.getProjectionMatrix()` の
 *   `minZ`/`maxZ` ベース計算を経由しない）。当初はこれに気づかず `camera.minZ`/`maxZ`
 *   のみを設定しており、実質何も変わっていなかった（実機検証で z-fighting が解消しない
 *   ことから発覚）。またデスクトップの `GeospatialClippingBehavior` の式（惑星半径の
 *   1割≒638km を far clip の下限にする）は reverse-Z 前提の設計であり、
 *   **WebXR カメラは `engine.useReverseDepthBuffer`（reverse-Z）の恩恵を受けられない**
 *   （同じ理由でブラウザ提供の投影行列を直接使うため）ため、そのまま流用すると低高度で
 *   地球楕円体の背景球と地形タイルが z-fighting する。VR は局所的な地表観覧が主目的の
 *   ため、地平線距離ベースのより狭い範囲を使う式（{@link computeVrCameraClipPlanes}）に
 *   変更している。
 * - タイル LOD の SSE（画面誤差）評価は desktop 側の `GeospatialCamera`（`globe-camera`）の
 *   `fov`/ビューポート寸法を使う（`refreshTerrainWithExternalFrustum` 内部の `syncTiles`
 *   参照）。desktop の既定 fov（Babylon 既定値、約46°）は Meta Quest 3 実機の実際の
 *   視野角（約90〜100°）よりかなり狭く、この不一致が LOD 判定を実際より保守的（過剰に
 *   高精細）にし、タイル数超過による表示欠けやタイル境界の不整合（スカートの可視化）の
 *   一因になっていた（実機検証で確認）。毎フレーム `xr.baseExperience.camera.fov`
 *   （ブラウザの実 FOV を反映する、Babylon が自動更新）を `globe-camera` へ同期する。
 *
 * 命名メモ: このリポジトリでは "VR" は Playwright の Visual Regression テストの略称としても
 * 使われている。本ファイル内では区別のため "WebXr" プレフィックスを用いる
 * （UI 上のボタン表示文言としての "VR" はユーザー向けの一般的な表記のため使用する）。
 */
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3, Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
// `scene.createDefaultXRExperienceAsync` を Scene プロトタイプへ追加する副作用 import。
import "@babylonjs/core/Helpers/sceneHelpers";
import { WebXRSessionManager } from "@babylonjs/core/XR/webXRSessionManager";
import { WebXRState } from "@babylonjs/core/XR/webXRTypes";
import type { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";
import type { WebXRInputSource } from "@babylonjs/core/XR/webXRInputSource";

import type { JpmapTerrain } from "../../lib/jpmapTerrain";
import { geodeticToEcefToRef, ecefToGeodeticToRef, type Geodetic } from "../../terrain/geo/ecef";
import { geographicTangentBasisToRef, panCenterOnSphereToRef } from "../../terrain/geo/cameraMapping";
import { clampAltitude } from "../../terrain/urlState";
import {
    computeAltitudeFactorFromStick,
    computeLodBiasForAltitude,
    computePanMetersFromStick,
    computeVrCameraClipPlanes,
    DEFAULT_ALTITUDE_ZOOM_RATE_PER_SEC,
    PLANET_RADIUS_M_FOR_CLIP_PLANES,
    resolveVrHoverHeightM,
    resolveVrLodEffectiveRadiusM,
} from "./webXrControllerMapping";

/** 左スティックのパン速度（高度1mあたりの秒速係数）。既存ドラッグパンに近い体感になるよう暫定調整。 */
const PAN_SPEED_PER_ALTITUDE_M_PER_SEC = 0.6;
/** 1フレームの dt 上限[s]（タブ非アクティブ復帰時等の巨大な dt でカメラが飛ばないようにする）。 */
const MAX_DT_SEC = 0.05;
/** 地形タイル frustum 更新の最小間隔[ms]（flight/roiorbit デモと同じ値）。 */
const TILE_REFRESH_INTERVAL_MS = 300;

/**
 * XR セッションの `depthNear`/`depthFar` を、実際の地表高度（地心距離 - 惑星半径）に応じて更新する。
 * 計算式は {@link computeVrCameraClipPlanes} 参照（デスクトップの `GeospatialClippingBehavior`
 * とは異なり、reverse-Z の恩恵を受けられない WebXR カメラ向けに調整した式）。
 *
 * @remarks
 * **重要**: WebXR セッション中、実際のレンダリングに使われる投影行列は
 * `WebXRCamera.updateFromXRFrame` がブラウザ提供の `XRView.projectionMatrix` を
 * **そのままコピー**して構築する（Babylon の `Camera.getProjectionMatrix()` の
 * 通常の `minZ`/`maxZ` ベース計算を経由しない）。そのため、`camera.minZ`/`camera.maxZ`
 * を設定するだけでは実際の描画・本関数が使う frustum culling の双方に**一切反映されない**
 * （as-if no-op。以前の実装はこの誤りにより実質的に無効だった）。
 * ブラウザ側の near/far を実際に変更するには、WebXR 標準 API の
 * `XRSession.updateRenderState({ depthNear, depthFar })`（Babylon では
 * `WebXRSessionManager.updateRenderState`）を呼ぶ必要がある。
 *
 * @param positionEcef カメラのおおよその ECEF 絶対位置（`rig.position` を想定）。
 *   `camera.globalPosition` はワールド行列の再計算タイミング次第で 1 フレーム遅延した
 *   値を返し得るため、`updateRig` 内で当フレーム分をすでに計算済みの位置を渡す。
 * 呼び出し頻度は `TILE_REFRESH_INTERVAL_MS` で間引く（`updateRenderState` は
 * 「次フレームから反映」の仕様であり毎フレーム呼ぶ必要はなく、頻繁な呼び出しは
 * 避けたほうがよいとされる）。
 */
const updateXrDepthRange = (
    sessionManager: WebXRSessionManager,
    positionEcef: Vector3,
    camera: { minZ: number; maxZ: number },
): void => {
    const altitudeM = positionEcef.length() - PLANET_RADIUS_M_FOR_CLIP_PLANES;
    const { minZ, maxZ } = computeVrCameraClipPlanes(altitudeM);
    // camera.minZ/maxZ は実描画には使われないが、Babylon 内部の他のカリング/ヘルパーが
    // 参照する可能性があるため一貫性のために設定しておく（実質的な z-fighting 対策は
    // 下記 updateRenderState 呼び出しが担う）。
    camera.minZ = minZ;
    camera.maxZ = maxZ;
    sessionManager.updateRenderState({ depthNear: minZ, depthFar: maxZ });
};

/** 機能検出 (`IsSessionSupportedAsync`) のタイムアウト[ms]。
 *  環境によっては（実デバイス無し等）Promise がいつまでも解決しないことがあるため、
 *  一定時間で諦めて「非対応」扱いにし、デモの起動をブロックしないようにする。
 */
const SUPPORT_CHECK_TIMEOUT_MS = 4000;

/** `promise` が `timeoutMs` 以内に解決しなければ `onTimeout` の値へフォールバックする。 */
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> =>
    new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(onTimeout), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(onTimeout);
            },
        );
    });

/** WebXR (immersive-vr) にブラウザ/デバイスが対応しているかを判定する。
 *  {@link SUPPORT_CHECK_TIMEOUT_MS} 以内に応答がない場合は非対応として扱う。
 */
export const isImmersiveVrSupported = async (): Promise<boolean> => {
    try {
        if (typeof navigator === "undefined" || !("xr" in navigator)) return false;
        return await withTimeout(
            WebXRSessionManager.IsSessionSupportedAsync("immersive-vr"),
            SUPPORT_CHECK_TIMEOUT_MS,
            false,
        );
    } catch (err) {
        console.warn("[jpmap-terrain viewer demo] WebXR support check failed:", err);
        return false;
    }
};

/** VRボタンのスタイル（既存 controlPanel のボタン群に近い外観）を適用する。 */
const styleVrButton = (button: HTMLButtonElement): void => {
    Object.assign(button.style, {
        position: "absolute",
        top: "12px",
        left: "12px",
        zIndex: "10",
        width: "56px",
        height: "40px",
        borderRadius: "10px",
        border: "none",
        background: "rgba(9,18,32,0.72)",
        color: "#fff",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
    } satisfies Partial<CSSStyleDeclaration>);
    button.textContent = "VR";
    button.setAttribute("aria-label", "VRで表示");
    button.setAttribute("title", "VRで表示 (WebXR)");
};

/** 左手・右手のスティック軸 `{x,y}` を保持する（未接続時は `{0,0}`）。 */
interface StickState {
    left: { x: number; y: number };
    right: { x: number; y: number };
}

const zeroStick = (): StickState => ({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });

/** 追加されたコントローラーの thumbstick 入力を `sticks` へ反映するリスナーを登録する。 */
const trackControllerSticks = (xr: WebXRDefaultExperience, sticks: StickState): void => {
    const bindController = (controller: WebXRInputSource): void => {
        const handedness = controller.inputSource.handedness;
        if (handedness !== "left" && handedness !== "right") return;
        controller.onMotionControllerInitObservable.add((motionController) => {
            const thumbstick = motionController.getComponentOfType("thumbstick");
            thumbstick?.onAxisValueChangedObservable.add(({ x, y }) => {
                sticks[handedness].x = x;
                sticks[handedness].y = y;
            });
        });
    };
    xr.input.controllers.forEach(bindController);
    xr.input.onControllerAddedObservable.add(bindController);
    xr.input.onControllerRemovedObservable.add((controller) => {
        const handedness = controller.inputSource.handedness;
        if (handedness === "left" || handedness === "right") {
            sticks[handedness] = { x: 0, y: 0 };
        }
    });
};

/**
 * WebXR "xr-standard" Gamepad マッピングにおける B/Y ボタン（セカンダリボタン）の
 * インデックス。Meta Quest Touch 系コントローラーでは右手 = B、左手 = Y だが、
 * どちらも `gamepadIndices.button: 5`（`buttons[4]` が A/X、`buttons[5]` が B/Y）で
 * 共通（Babylon の `webXROculusTouchMotionController` プロファイル定義で確認）。
 *
 * 当初はグリップ（squeeze, `buttons[1]`）を終了トリガーに使っていたが、コントローラーを
 * 握る動作で意図せず押してしまう誤操作が多いとの実機フィードバックを受けて変更した。
 * @see https://www.w3.org/TR/webxr-gamepads-module-1/#xr-standard-heuristics
 */
const EXIT_BUTTON_INDEX = 5;

/**
 * 左右コントローラーの B/Y ボタンを毎フレームポーリングし、押下エッジ
 * （前フレーム非押下 → 今フレーム押下）で `onExitRequested` を呼ぶ。
 *
 * Babylon の `motionController.getComponentOfType(...)`（プロファイル解決に依存する
 * 高レベル API）ではなく、ブラウザ標準の `XRInputSource.gamepad`（生の Gamepad API、
 * プロファイル解決を経由しない）を直接参照する。squeeze 使用時に実機で
 * `getComponentOfType("squeeze")` が反応しない事例を確認したため、より低レベルで
 * 確実な経路を採用している。
 *
 * `updateRig`（`scene.onBeforeRenderObservable`）から毎フレーム呼ぶ想定。
 */
const pollExitButton = (
    xr: WebXRDefaultExperience,
    wasPressed: Map<string, boolean>,
    onExitRequested: () => void,
): void => {
    xr.input.controllers.forEach((controller) => {
        const button = controller.inputSource.gamepad?.buttons[EXIT_BUTTON_INDEX];
        if (!button) return;
        const key = controller.uniqueId;
        if (button.pressed && !wasPressed.get(key)) {
            onExitRequested();
        }
        wasPressed.set(key, button.pressed);
    });
};

/** VRセッション中、毎フレーム呼ばれる「リグ」更新に必要な作業バッファ（GC 回避）。 */
interface RigUpdateScratch {
    centerEcef: Vector3;
    eastRef: Vector3;
    northRef: Vector3;
    tangentMove: Vector3;
    pannedEcef: Vector3;
    geodetic: Geodetic;
    rigMatrix: Matrix;
    rawFrustumPlanes: Plane[];
    frustumViewOnly: Matrix;
    frustumTransform: Matrix;
    frustumPlanesResult: { normal: { x: number; y: number; z: number }; d: number }[];
    cameraPositionResult: { x: number; y: number; z: number };
}

const createScratch = (): RigUpdateScratch => ({
    centerEcef: new Vector3(),
    eastRef: new Vector3(),
    northRef: new Vector3(),
    tangentMove: new Vector3(),
    pannedEcef: new Vector3(),
    geodetic: { latDeg: 0, lonDeg: 0, altMeters: 0 },
    rigMatrix: new Matrix(),
    rawFrustumPlanes: Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0)),
    frustumViewOnly: new Matrix(),
    frustumTransform: new Matrix(),
    frustumPlanesResult: Array.from({ length: 6 }, () => ({ normal: { x: 0, y: 0, z: 0 }, d: 0 })),
    cameraPositionResult: { x: 0, y: 0, z: 0 },
});

/**
 * VR中に非表示にする既存 UI の `JpmapTerrain` 公開プロパティ名
 * （`showCompass` 等の `show*` boolean プロパティ）。
 */
const HIDDEN_UI_PROPS_DURING_VR = [
    "showCompass",
    "showZoomButtons",
    "showLocateMe",
    "showScaleBar",
    "showMapToggle",
    "showViewModeButton",
] as const satisfies readonly (keyof JpmapTerrain)[];

/** VR突入前の表示状態を保存し、復元するための処理をまとめる。 */
const hideUiForVr = (viewer: JpmapTerrain): (() => void) => {
    const previous = HIDDEN_UI_PROPS_DURING_VR.map((prop) => viewer[prop] as boolean);
    HIDDEN_UI_PROPS_DURING_VR.forEach((prop) => {
        (viewer[prop] as boolean) = false;
    });
    return () => {
        HIDDEN_UI_PROPS_DURING_VR.forEach((prop, i) => {
            (viewer[prop] as boolean) = previous[i];
        });
    };
};

/**
 * viewerデモに VRボタンを追加し、WebXR (immersive-vr) セッションの開始/終了、
 * カメラリグの位置同期、コントローラー入力によるパン/ズームを行う PoC をセットアップする。
 *
 * WebXR 非対応環境では機能検出後にボタンを表示しない（合意事項）。
 *
 * @param mount ボタンを配置するコンテナ要素（viewer の canvas を含む要素）。
 * @param viewer 対象の {@link JpmapTerrain} インスタンス。
 * @returns 後始末用の破棄関数。呼び出し元がデモを終了する際に呼ぶ。
 */
export const setupWebXrVrButton = async (
    mount: HTMLElement,
    viewer: JpmapTerrain,
): Promise<() => void> => {
    const supported = await isImmersiveVrSupported();
    if (!supported) return () => {};

    const scene = viewer.__debugScene;
    if (!scene) return () => {};

    const button = document.createElement("button");
    styleVrButton(button);
    mount.appendChild(button);

    let xr: WebXRDefaultExperience | null = null;
    let disposed = false;

    const cleanup = (): void => {
        disposed = true;
        button.remove();
        xr?.dispose();
    };

    button.addEventListener("click", () => {
        if (disposed) return;
        if (xr && xr.baseExperience.state === WebXRState.IN_XR) {
            void xr.baseExperience.exitXRAsync();
            return;
        }
        void enterVr(scene, viewer, button).then((created) => {
            xr = created;
        });
    });

    return cleanup;
};

/** VRセッションを開始し、リグ・コントローラー入力・地形追従のセットアップを行う。
 *  セットアップ中に例外が発生した場合は、生成済みリソース（`xr`・UI状態）を後始末し、
 *  ボタンを通常表示へ戻したうえで `null` を返す（呼び出し元はクリック可能な状態を維持する）。
 */
const enterVr = async (
    scene: Scene,
    viewer: JpmapTerrain,
    button: HTMLButtonElement,
): Promise<WebXRDefaultExperience | null> => {
    let xr: WebXRDefaultExperience | null = null;
    let restoreUi: (() => void) | null = null;
    let earthMesh: ReturnType<Scene["getMeshByName"]> = null;
    let earthMeshWasEnabled: boolean | null = null;
    try {
        const engine = scene.getEngine();
        xr = await scene.createDefaultXRExperienceAsync({
            // 本 PoC は独自のスティック操作でパン/ズームを行うため、既定のテレポート/
            // ポインタ選択機能は無効化し、入力の競合を避ける。
            disableTeleportation: true,
            disablePointerSelection: true,
            // 独自の VR ボタン（本ファイル）で enter/exit を制御するため、Babylon 標準の
            // Enter/Exit UI は無効化する（二重のボタン表示による混乱を避ける）。
            disableDefaultUI: true,
        });

        if (xr.baseExperience.state === WebXRState.NOT_IN_XR) {
            await xr.baseExperience.enterXRAsync(
                "immersive-vr",
                "local-floor",
                xr.renderTarget,
            );
        }

        // VRセッション中はボタンの文言を「終了」に切り替え、クリックで exitXRAsync できるようにする
        // （`setupWebXrVrButton` 側のクリックハンドラが `state === IN_XR` を見て分岐する）。
        button.textContent = "終了";
        button.setAttribute("aria-label", "VRを終了");
        button.setAttribute("title", "VRを終了");
        // depthNear/depthFar は updateRig 内で updateXrDepthRange により間引きつつ動的に
        // 更新するため、ここでの初期値設定は不要（初回呼び出しで即座に反映される）。

        // 既存 terrain camera の自動タイル更新・canvas ポインタ操作は、VR中は使わない
        // （flight/roiorbit デモの「外部カメラ」パターンと同じ切り替え）。
        viewer.detachTileCamera();
        restoreUi = hideUiForVr(viewer);

        // 背景の地球楕円体球（globe-earth）を VR 中は非表示にする。本来は DEM no-data 領域
        // （海上等）やタイル未生成領域のフォールバック背景だが、VR は近距離の局所観覧が
        // 主目的でこの球が視界の大半を占めることはなく、むしろタイル間の LOD 不整合等で
        // 隙間ができた際に目立つ青色の露出として実機検証で指摘された。表示する積極的な
        // 理由がないため、VR中は非表示にし終了時に元の状態へ復元する。
        earthMesh = scene.getMeshByName("globe-earth");
        earthMeshWasEnabled = earthMesh?.isEnabled(false) ?? null;
        earthMesh?.setEnabled(false);

        // XR カメラを親に持つ「リグ」を作成し、リグの position/rotation を
        // lat/lon/altitude から算出した ECEF で毎フレーム駆動する。
        const rig = new TransformNode("webxr-viewer-rig", scene);
        xr.baseExperience.camera.parent = rig;
        xr.baseExperience.camera.position.set(0, 0, 0);
        xr.baseExperience.camera.rotationQuaternion = Quaternion.Identity();
        rig.rotationQuaternion = Quaternion.Identity();

        // desktop の GeospatialCamera（タイル LOD の SSE 評価が fov を参照する）。
        // 実際の VR ヘッドセット FOV を毎フレーム同期するために保持する
        // （下記コメント・updateRig 内 fov 同期処理参照）。
        const desktopCamera = scene.getCameraByName("globe-camera");
        const originalFov = desktopCamera?.fov;

        let lat = viewer.lat;
        let lon = viewer.lon;
        // `viewer.altitude`（desktop ArcRotateCamera の radius）は継承しない。既定 2000m を
        // そのまま VR の地表高度に使うと空しか見えない高度になるため（実機検証で確認済み）、
        // VR向けの控えめな既定高度を使う（DEFAULT_VR_HOVER_HEIGHT_M 参照）。
        let altitude = resolveVrHoverHeightM(location.search);

        const sticks = zeroStick();
        trackControllerSticks(xr, sticks);
        let exitRequested = false;
        const exitButtonWasPressed = new Map<string, boolean>();

        const scratch = createScratch();
        let lastTileRefreshMs = 0;
        let tileRefreshInFlight = false;
        // depthNear/depthFar 更新（updateXrDepthRange）用の間引きタイマー。
        // `XRSession.updateRenderState` は毎フレーム呼ぶ必要がなく、頻繁な呼び出しは
        // 避けたほうがよいとされるため、タイル refresh と同じ間隔で間引く。
        let lastDepthRangeUpdateMs = 0;

        const updateRig = (): void => {
            // B/Y ボタンでの終了リクエストを最優先で処理する。
            pollExitButton(xr!, exitButtonWasPressed, () => {
                exitRequested = true;
            });
            if (exitRequested) {
                exitRequested = false;
                void xr!.baseExperience.exitXRAsync();
                return;
            }

            // タイル LOD の SSE 評価が使う desktop カメラの fov を、実際のヘッドセット FOV へ
            // 同期する（{@link module:src/demos/viewer/webXrVrSession.ts} 冒頭のコメント参照。
            // 狭い desktop 既定値のままだと LOD 判定が過剰に高精細になる不具合を実機検証で確認）。
            if (desktopCamera) {
                desktopCamera.fov = xr!.baseExperience.camera.fov;
            }

            const dtSec = Math.min(MAX_DT_SEC, Math.max(0, engine.getDeltaTime() / 1000));

            // 右スティック(前後) → 高度（ズーム）。ここでの altitude は「地表からの高さ」であり、
            // 海抜高度ではない（DEFAULT_VR_HOVER_HEIGHT_M のコメント参照）。
            const altitudeFactor = computeAltitudeFactorFromStick(
                sticks.right.y,
                dtSec,
                DEFAULT_ALTITUDE_ZOOM_RATE_PER_SEC,
            );
            altitude = clampAltitude(altitude * altitudeFactor);

            // 左スティック → 地図平面移動（パン）。
            const pan = computePanMetersFromStick(
                sticks.left,
                dtSec,
                altitude,
                PAN_SPEED_PER_ALTITUDE_M_PER_SEC,
            );
            let terrainElevM = viewer.terrainElevAt(lat, lon) ?? 0;
            geodeticToEcefToRef(lat, lon, terrainElevM + altitude, scratch.centerEcef);
            if (
                (pan.eastM !== 0 || pan.northM !== 0) &&
                geographicTangentBasisToRef(scratch.centerEcef, scratch.eastRef, scratch.northRef)
            ) {
                scratch.tangentMove
                    .copyFrom(scratch.eastRef)
                    .scaleInPlace(pan.eastM)
                    .addInPlace(scratch.northRef.scale(pan.northM));
                panCenterOnSphereToRef(scratch.centerEcef, scratch.tangentMove, scratch.pannedEcef);
                ecefToGeodeticToRef(scratch.pannedEcef, scratch.geodetic);
                lat = scratch.geodetic.latDeg;
                lon = scratch.geodetic.lonDeg;
                // 新しい lat/lon の地形標高を取り直し、地表からの高さ(altitude)を正本として
                // ECEF 位置を引き直す（パン中間点の高度は使わない）。
                terrainElevM = viewer.terrainElevAt(lat, lon) ?? terrainElevM;
                geodeticToEcefToRef(lat, lon, terrainElevM + altitude, scratch.centerEcef);
            }

            rig.position.copyFrom(scratch.centerEcef);
            // z-fighting 対策: 実際の地表高度に応じて XR セッションの depthNear/depthFar
            // （実際にレンダリングへ反映される、`updateXrDepthRange` のコメント参照）を
            // 間引きつつ動的更新する。
            const nowMsForDepthRange = performance.now();
            if (nowMsForDepthRange - lastDepthRangeUpdateMs >= TILE_REFRESH_INTERVAL_MS) {
                lastDepthRangeUpdateMs = nowMsForDepthRange;
                updateXrDepthRange(xr!.baseExperience.sessionManager, scratch.centerEcef, xr!.baseExperience.camera);
            }
            // リグの向き: X=東, Y=地心up, Z=南（-Z=北を「前方」= WebXR/RH既定のヘッドセット
            // 正面に合わせる）。geographicTangentBasisToRef が特異点（極直下）で失敗した場合は
            // 直前の向きを維持する。
            if (geographicTangentBasisToRef(scratch.centerEcef, scratch.eastRef, scratch.northRef)) {
                const up = scratch.centerEcef.clone().normalize();
                Matrix.FromXYZAxesToRef(scratch.eastRef, up, scratch.northRef.scale(-1), scratch.rigMatrix);
                Quaternion.FromRotationMatrixToRef(scratch.rigMatrix, rig.rotationQuaternion!);
            }

            // 地形タイル LOD 追従（flight/roiorbit と同方式）。
            const nowMs = performance.now();
            if (!tileRefreshInFlight && nowMs - lastTileRefreshMs >= TILE_REFRESH_INTERVAL_MS) {
                lastTileRefreshMs = nowMs;
                const camera = xr!.baseExperience.camera;
                scratch.frustumViewOnly.copyFrom(camera.getViewMatrix());
                scratch.frustumViewOnly.setRowFromFloats(3, 0, 0, 0, 1);
                scratch.frustumViewOnly.multiplyToRef(camera.getProjectionMatrix(), scratch.frustumTransform);
                Frustum.GetPlanesToRef(scratch.frustumTransform, scratch.rawFrustumPlanes);
                for (let i = 0; i < 6; i++) {
                    const src = scratch.rawFrustumPlanes[i];
                    const dst = scratch.frustumPlanesResult[i];
                    dst.normal.x = src.normal.x;
                    dst.normal.y = src.normal.y;
                    dst.normal.z = src.normal.z;
                    dst.d = src.d;
                }
                const globalPos = camera.globalPosition;
                scratch.cameraPositionResult.x = globalPos.x;
                scratch.cameraPositionResult.y = globalPos.y;
                scratch.cameraPositionResult.z = globalPos.z;

                // lodBias: refreshTerrainWithExternalFrustum は内部で
                // camera.radius = FOLLOW_TILE_BASE_RADIUS_M * 2^-lodBias を設定する
                // （globeSceneController.ts 参照）。camera.radius はタイル LOD だけでなく
                // マーカー/ポリゴン/サークルの距離ベース自動スケール計算にも使われるため、
                // 既定の lodBias=0（固定 2000m 相当）のままだと VR中の実際の地表高度と
                // 乖離し、近距離のマーカーが異常な大きさで表示される
                // （実機検証で確認済みの不具合）。altitude と一致するよう逆算する。
                // ただし低高度では altitude をそのまま使うとタイル要求が過剰に高精細になり
                // 表示しきれない（欠ける）不具合も実機検証で確認したため、下限を設ける
                // （resolveVrLodEffectiveRadiusM）。
                const lodBias = computeLodBiasForAltitude(resolveVrLodEffectiveRadiusM(altitude));

                tileRefreshInFlight = true;
                void viewer
                    .refreshTerrainWithExternalFrustum(
                        lat,
                        lon,
                        scratch.frustumPlanesResult,
                        scratch.cameraPositionResult,
                        lodBias,
                    )
                    .finally(() => {
                        tileRefreshInFlight = false;
                    });
            }
        };

        const beforeRenderObserver = scene.onBeforeRenderObservable.add(updateRig);

        const restoreOnExit = (): void => {
            scene.onBeforeRenderObservable.remove(beforeRenderObserver);
            rig.dispose();
            viewer.attachTileCamera();
            restoreUi?.();
            // VR中に移動した lat/lon/altitude を通常表示へ引き継ぐ。
            viewer.lat = lat;
            viewer.lon = lon;
            viewer.altitude = altitude;
            // VR中に同期した fov を desktop 既定値へ戻す。
            if (desktopCamera && originalFov !== undefined) {
                desktopCamera.fov = originalFov;
            }
            // 背景の地球楕円体球を元の表示状態へ復元する。
            if (earthMeshWasEnabled !== null) {
                earthMesh?.setEnabled(earthMeshWasEnabled);
            }
            styleVrButton(button);
        };

        xr.baseExperience.onStateChangedObservable.add((state) => {
            if (state === WebXRState.NOT_IN_XR) {
                restoreOnExit();
            }
        });

        return xr;
    } catch (err) {
        console.error("[jpmap-terrain viewer demo] failed to start WebXR VR session:", err);
        // 部分的に確保したリソース（terrain camera detach / UI非表示等）を後始末する。
        restoreUi?.();
        viewer.attachTileCamera();
        if (earthMeshWasEnabled !== null) {
            earthMesh?.setEnabled(earthMeshWasEnabled);
        }
        xr?.dispose();
        styleVrButton(button);
        return null;
    }
};
