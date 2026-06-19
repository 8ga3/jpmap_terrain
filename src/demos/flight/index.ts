/**
 * フライトデモ (Issue #245)
 *
 * `JpmapTerrain` の Model 公開 API を使って飛行機が上空を大きな円軌道で
 * 高速旋回し、Babylon.js FollowCamera で追跡するデモ。
 *
 * 仕様:
 * - 東京駅上空に `assets/plane.glb` を初期配置（absolute altitude）
 * - 大きな半径（デフォルト 2000m）の円軌道を高速（デフォルト 60°/s）で飛行
 * - カメラ初期位置はズームアウト（altitude 5000m）
 * - カメラモード: 3D / 2D / Follow の3モード切替
 * - Follow モードでは FollowCamera で飛行機を追跡
 * - 地面クリックで円軌道の中心を変更
 * - 半径・速度・高度のスライダー操作
 * - アニメーション開始/停止トグル
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";

import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, TerrainClickEvent } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
    resolveTerrainEngine,
} from "../../terrain/urlState";
import { circularOrbitPosition, circularOrbitHeading } from "../avatar/orbit";
import { geodeticToEcefToRef } from "../../terrain/geo/ecef";
import { geographicTangentBasisToRef } from "../../terrain/geo/cameraMapping";
import { createRouteLine, type RouteLine } from "./routeLine";
import { createWaypointManager, type WaypointManager } from "./waypoints";
import { createFlightAudio, type FlightAudio } from "./flightAudio";
import { createAfterburner, type Afterburner } from "./afterburner";
import { createGlobeAfterburner } from "./globeAfterburner";
import { toTileXY, TILE_MAX_ZOOM } from "../../terrain/gsiTile";
import planeGlbUrl from "../../../assets/plane.glb";

/** PIP 用セカンダリ Viewer 設定 (Issue #264 Option C: 別 Canvas + 別 Engine) */
const PIP_WIDTH_FRACTION_DEFAULT = 0.2;
const PIP_WIDTH_FRACTION_MIN = 0.1;
const PIP_WIDTH_FRACTION_MAX = 0.4;
/** PIP belly カメラの俯角（度）— 天頂角（垂直からの角度）。45 = 水平から 45° 下 */
const PIP_BELLY_TILT_DEG = 45;
/**
 * PIP Viewer 状態 (lat/lon/altitude/azimuth) を更新する間隔 (ms)。
 * 毎フレーム setter を呼ぶと attachTileCamera の debounce が
 * 永続的に再延長され refreshTerrain が走らずタイルが消えるため、
 * 内部 debounce を上回る間隔でスロットルする。
 */
const PIP_UPDATE_INTERVAL_MS = 50;

const DEMO_MOUNT_ID = "root";
const MODEL_ID = "plane";

/** 東京駅 */
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };

/** モデルの表示スケール (3D/2D モード) */
const MODEL_SCALE_NORMAL = 50;
/** モデルの表示スケール (Follow モード) */
const MODEL_SCALE_FOLLOW = 1;
/** 円軌道の初期半径 (m) */
const DEFAULT_RADIUS_M = 2000;
/** 飛行速度 (m/s)。初期値 */
const DEFAULT_SPEED_MPS = 100;
/** 飛行高度 (m) */
const DEFAULT_ALTITUDE_M = 2000;
/** カメラ初期高度 (m) — ズームアウトで飛行機を見渡す */
const INITIAL_CAMERA_ALTITUDE = 6000;
/**
 * 3D/2D モードで飛行機を見つけやすくするための発光（emissive）色。
 * tick 内で点滅させて目立たせる。Follow モードでは元の emissive に戻す。
 */
const BEACON_EMISSIVE_COLOR = new Color3(1.0, 0.25, 0.05);
/**
 * globe バックエンドのカメラ初期高度 (m)。
 * globe(GeospatialCamera) は planar(ArcRotateCamera) と画角・投影が異なり、6000m では
 * 円軌道（半径 2000m / 高度 2000m）の飛行機がフレーム外に出る。全周を見渡せるよう高めに設定。
 */
const GLOBE_INITIAL_CAMERA_ALTITUDE = 14000;
/** クリック可能距離 (m) */
const MAX_CLICK_DISTANCE_M = 20000;

/** FollowCamera パラメータ — 飛行機の真後ろを追跡 */
const FOLLOW_CAMERA_RADIUS = 20;
const FOLLOW_CAMERA_HEIGHT_OFFSET = 15;
const FOLLOW_CAMERA_ROTATION_OFFSET = 180;
/** heightOffset の最大値 = radius × この倍率 */
const FOLLOW_CAMERA_HEIGHT_OFFSET_MAX_MAG = 3;

/** マウス操作感度 */
const DRAG_ROT_DEG_PER_PX = 0.5;
const DRAG_HEIGHT_M_PER_PX = 0.5;
const WHEEL_RADIUS_M_PER_DELTA = 0.5;

type CameraMode = "3d" | "2d" | "follow";

const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) return;

    const camera = parseCameraStateFromUrl(location.href);
    const mapType = parseMapTypeFromUrl(location.href);
    // `?terrainEngine=globe|planar`（未指定/不正は undefined → lib 既定 planar）。
    const terrainEngine = resolveTerrainEngine(location.search);

    const opts: JpmapTerrainOptions = {
        engine: resolveEngine(location.search),
        terrainEngine,
        lat: camera?.lat ?? TOKYO_STATION.lat,
        lon: camera?.lon ?? TOKYO_STATION.lon,
        altitude:
            camera?.altitude ??
            (terrainEngine === "globe"
                ? GLOBE_INITIAL_CAMERA_ALTITUDE
                : INITIAL_CAMERA_ALTITUDE),
        azimuth: camera?.azimuth,
        tilt: camera?.tilt ?? 45,
        mapType: mapType ?? "standard",
        showViewModeButton: false,
    };

    const viewer = await JpmapTerrain.create(mount, opts);
    // globe バックエンドでは floating origin の offset = アクティブカメラ位置のため、
    // Follow カメラ（FreeCamera）は真の ECEF 座標で配置する必要がある（後述）。
    const isGlobe = viewer.terrainEngine === "globe";

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
    }

    // --- 状態 ---
    let centerLat = TOKYO_STATION.lat;
    let centerLon = TOKYO_STATION.lon;
    let radiusM = DEFAULT_RADIUS_M;
    let speedMps = DEFAULT_SPEED_MPS;
    let altitudeM = DEFAULT_ALTITUDE_M;
    let angleDeg = 0;
    let animating = true;
    let lastTimestamp: number | null = null;
    let currentCameraMode: CameraMode = "3d";
    let followCamera: FreeCamera | null = null;
    /**
     * Follow モード進入直前の 3D/2D カメラ状態。Follow から 3D/2D へ戻る際に復元し、
     * 元のカメラ位置（注視点・高度・方位・俯角）を保つ（Follow 追従位置で上書きされるのを防ぐ）。
     */
    let saved3dCamera:
        | { lat: number; lon: number; altitude: number; azimuth: number; tilt: number }
        | null = null;
    // globe Follow カメラ配置用の再利用スクラッチ（毎フレーム allocation を避ける）。
    const followTargetEcef = new Vector3();
    const followEastEcef = new Vector3();
    const followNorthEcef = new Vector3();
    const followUpEcef = new Vector3();
    // Follow カメラの可変パラメータ
    let followCamRadius = FOLLOW_CAMERA_RADIUS;
    let followCamHeightOffset = FOLLOW_CAMERA_HEIGHT_OFFSET;
    let followCamRotationOffset = FOLLOW_CAMERA_ROTATION_OFFSET;
    // Follow モードでのタイル中心更新スロットル
    let lastTileUpdateTime = 0;
    let tileRefreshInFlight = false;
    /** グリッド原点ジャンプが発生したフレームで1回だけ afterburner.reset() を呼ぶためのフラグ */
    let afterburnerResetNeeded = false;
    let lastRefreshLat = TOKYO_STATION.lat;
    let lastRefreshLon = TOKYO_STATION.lon;
    let lastRefreshRotationOffset = FOLLOW_CAMERA_ROTATION_OFFSET;
    let lastRefreshHeightOffset = FOLLOW_CAMERA_HEIGHT_OFFSET;
    let lastRefreshRadius = FOLLOW_CAMERA_RADIUS;
    /** 前回 refresh 時の centerTile (タイルジャンプ検出用) */
    let lastCenterTile = toTileXY(TOKYO_STATION.lat, TOKYO_STATION.lon, TILE_MAX_ZOOM);
    /** Follow モードでタイル中心を飛行機位置に追従させる最小間隔 (ms) */
    const TILE_UPDATE_INTERVAL_MS = 300;
    /** 緯度/経度差がこの距離 (m) を超えたら更新を発火 */
    const TILE_UPDATE_DISTANCE_M = 80;
    /** カメラ方位がこれ以上変わったら更新を発火 (度) */
    const TILE_UPDATE_ROTATION_DEG = 8;
    /** 高度オフセット/半径がこれ以上変わったら更新を発火 (m) */
    const TILE_UPDATE_OFFSET_M = 5;

    // 初期配置: 円周上 0° の位置
    const initPos = circularOrbitPosition(
        centerLat,
        centerLon,
        radiusM,
        angleDeg,
    );
    viewer.addModel(MODEL_ID, {
        url: planeGlbUrl,
        lat: initPos.lat,
        lon: initPos.lon,
        altitudeMode: "absolute",
        altitude: altitudeM,
        rotation: { y: circularOrbitHeading(angleDeg) },
        scaling: { x: MODEL_SCALE_NORMAL, y: MODEL_SCALE_NORMAL, z: MODEL_SCALE_NORMAL },
        gravity: false,
    });

    // --- ルートライン (Issue #265) ---
    let routeLine: RouteLine | null = null;

    // --- ウェイポイント (Issue #274) ---
    let waypointManager: WaypointManager | null = null;
    /** ウェイポイント表示フラグ */
    let showWaypoints = true;
    /** リボン表示フラグ */
    let showRibbon = true;

    // --- SE (Issue #269) ---
    let flightAudio: FlightAudio | null = null;
    let audioInitializing = false;

    // --- アフターバーナー (Issue #276) ---
    let afterburner: Afterburner | null = null;
    let showAfterburner = true;
    /** Follow モードに入ったがモデル未ロードのため start() を保留中のフラグ */
    let afterburnerStartPending = false;

    /** ウェイポイント再計算ヘルパー — パラメータ変更時に共通で呼ぶ */
    const resetWaypointsIfNeeded = (): void => {
        if (waypointManager && viewer.__debugScene) {
            waypointManager.reset({
                centerLat,
                centerLon,
                radiusM,
                altitudeM,
                angleDeg,
                modelNodeName: `model-${MODEL_ID}`,
                isGlobe,
            });
        }
    };

    // --- PIP (Picture-in-Picture) セカンダリ Viewer セットアップ ---
    // Issue #264 Option C: 別 Canvas + 別 Engine + 別 Scene による完全独立構成。
    // - メイン Viewer の入力系・タイル管理・カメラに一切手を入れない（バグ非導入）
    // - PIP は独立タイルマネージャーで動作し、メインのズーム/ドラッグの影響を受けない
    // - 将来の N 分割ビューも `JpmapTerrain` を複数並べるだけで実現可能
    const pipMount = document.getElementById("pip-mount");
    const pipFrame = document.getElementById("pip-frame");
    const pipResizeHandle = document.getElementById("pip-resize-handle");

    let pipViewer: JpmapTerrain | null = null;
    let pipWidthFraction = PIP_WIDTH_FRACTION_DEFAULT;
    let lastPipUpdateMs = 0;
    const pipCleanups: (() => void)[] = [];

    const updatePipFrameSize = (): void => {
        if (!pipFrame) return;
        const canvas = viewer.__debugScene?.getEngine().getRenderingCanvas();
        if (!canvas) return;
        const pixelWidth = pipWidthFraction * canvas.clientWidth;
        pipFrame.style.width = `${pixelWidth}px`;
        // 高さは CSS の aspect-ratio: 4/3 に任せる
        // 地図切替ボタン (lib 製) は既定で `bottom:12px; left:12px` に配置されるため
        // PIP と重なる。PIP の右隣 (= 12 + PIP 幅 + 8px) に移動させる。
        const mapToggleBtn = document.querySelector<HTMLButtonElement>(
            'button[aria-label^="地図切替"]',
        );
        if (mapToggleBtn) {
            mapToggleBtn.style.left = `${12 + pixelWidth + 8}px`;
        }
    };

    if (pipMount) {
        const pipOpts: JpmapTerrainOptions = {
            engine: opts.engine,
            terrainEngine,
            lat: initPos.lat,
            lon: initPos.lon,
            altitude: altitudeM,
            // PIP belly カメラは機体の heading 方向（前方）を見る。方位の符号は backend で異なる:
            // globe(GeospatialCamera) はカメラ視線方位 = azimuth（0=北,+=東回り、ComputeLookAtFromYawPitch
            // 由来）なので azimuth=heading。planar(ArcRotateCamera) は従来規約に合わせ -heading。
            azimuth: isGlobe
                ? circularOrbitHeading(angleDeg)
                : -circularOrbitHeading(angleDeg),
            tilt: PIP_BELLY_TILT_DEG,
            // PIP は写真タイルを表示 (Issue #264)
            mapType: "photo",
            showViewModeButton: false,
        };
        pipViewer = await JpmapTerrain.create(pipMount, pipOpts);
        // セカンダリ Viewer の UI を全て非表示にする
        // （compass/zoom/mapToggle/scaleBar/attribution は document.body へ append されるため）
        pipViewer.showCompass = false;
        pipViewer.showZoomButtons = false;
        pipViewer.showScaleBar = false;
        pipViewer.showMapToggle = false;
        pipViewer.showAttribution = false;
        // PIP はリサイズ以外のマウス操作を一切受け付けない (Issue #264)。
        // - secondary canvas に attach されている Babylon カメラ入力を解除
        // - canvas 自体の pointer-events を切ってクリック/ドラッグを無視する
        const pipScene = pipViewer.__debugScene;
        const pipCanvas = pipScene?.getEngine().getRenderingCanvas();
        const pipCam = pipScene?.activeCamera;
        if (pipCam) {
            pipCam.detachControl();
            pipCam.inputs.clear();
        }
        if (pipCanvas) {
            pipCanvas.style.pointerEvents = "none";
        }
        updatePipFrameSize();
    }

    if (pipResizeHandle && pipFrame) {
        let resizing = false;
        let resizeStartX = 0;
        let resizeStartWidth = 0;
        let capturedElement: HTMLElement | null = null;
        let capturedPointerId = -1;

        const onPipPointerDown = (e: PointerEvent): void => {
            resizing = true;
            resizeStartX = e.clientX;
            resizeStartWidth = pipFrame.clientWidth;
            capturedElement = e.target as HTMLElement;
            capturedPointerId = e.pointerId;
            capturedElement.setPointerCapture(e.pointerId);
            e.stopPropagation();
            e.preventDefault();
        };

        const onPipPointerMove = (e: PointerEvent): void => {
            if (!resizing) return;
            const canvas = viewer.__debugScene?.getEngine().getRenderingCanvas();
            if (!canvas) return;
            const dx = e.clientX - resizeStartX;
            const newPixelWidth = Math.max(50, resizeStartWidth + dx);
            const canvasWidth = canvas.clientWidth;
            const fraction = newPixelWidth / canvasWidth;
            pipWidthFraction = Math.max(
                PIP_WIDTH_FRACTION_MIN,
                Math.min(PIP_WIDTH_FRACTION_MAX, fraction),
            );
            updatePipFrameSize();
        };

        const onPipPointerUp = (): void => {
            if (resizing && capturedElement && capturedPointerId >= 0) {
                capturedElement.releasePointerCapture(capturedPointerId);
                capturedElement = null;
                capturedPointerId = -1;
            }
            resizing = false;
        };

        pipResizeHandle.addEventListener("pointerdown", onPipPointerDown);
        document.addEventListener("pointermove", onPipPointerMove);
        document.addEventListener("pointerup", onPipPointerUp);

        // クリーンアップ用に保存
        pipCleanups.push(() => {
            pipResizeHandle.removeEventListener("pointerdown", onPipPointerDown);
            document.removeEventListener("pointermove", onPipPointerMove);
            document.removeEventListener("pointerup", onPipPointerUp);
        });
    }

    window.addEventListener("resize", updatePipFrameSize);
    pipCleanups.push(() => {
        window.removeEventListener("resize", updatePipFrameSize);
    });

    // --- Follow カメラセットアップ（FreeCamera + 毎フレーム手動位置計算） ---
    // FollowCamera の内部補間を使わず、tick() で直接位置を設定する。
    const setupFollowCamera = (): FreeCamera | null => {
        const scene = viewer.__debugScene;
        if (!scene) return null;

        const fc = new FreeCamera(
            "follow-camera",
            Vector3.Zero(),
            scene,
        );
        fc.minZ = 1;
        fc.maxZ = 400000;
        // 組み込み入力を無効化（カスタム操作で制御）
        fc.inputs.clear();

        return fc;
    };

    /** Follow カメラの位置を飛行機の現在位置に基づいて計算・設定する */
    const updateFollowCameraPosition = (): void => {
        if (!followCamera) return;
        const scene = viewer.__debugScene;
        if (!scene) return;

        if (isGlobe) {
            // globe: floating origin の offset はアクティブカメラ（= この FreeCamera）の
            // globalPosition。よって FreeCamera を「真の ECEF」で配置すれば、
            // 機体・地形（真の ECEF メッシュ）がカメラ相対に正しくリベースされ描画される。
            // 機体まわりの ENU 基底（east/north/up）でオフセットを組み、planar と同じ
            // 「後方へ followCamRadius・上方へ followCamHeightOffset」を地心 up 基準で再現する。
            const planePos = circularOrbitPosition(
                centerLat,
                centerLon,
                radiusM,
                angleDeg,
            );
            geodeticToEcefToRef(planePos.lat, planePos.lon, altitudeM, followTargetEcef);
            if (
                !geographicTangentBasisToRef(
                    followTargetEcef,
                    followEastEcef,
                    followNorthEcef,
                )
            ) {
                return;
            }
            followUpEcef.copyFrom(followTargetEcef).normalize();

            const camRotRad =
                ((circularOrbitHeading(angleDeg) + followCamRotationOffset) *
                    Math.PI) /
                180;
            const s = Math.sin(camRotRad);
            const c = Math.cos(camRotRad);

            followCamera.position.copyFrom(followTargetEcef);
            followEastEcef.scaleAndAddToRef(followCamRadius * s, followCamera.position);
            followNorthEcef.scaleAndAddToRef(followCamRadius * c, followCamera.position);
            followUpEcef.scaleAndAddToRef(followCamHeightOffset, followCamera.position);
            // 地心 up を上方向にして水平線のロールを防ぐ。
            followCamera.upVector.copyFrom(followUpEcef);
            followCamera.setTarget(followTargetEcef);
            return;
        }

        const targetNode = scene.getTransformNodeByName(`model-${MODEL_ID}`);
        if (!targetNode) return;
        const targetMesh = targetNode.getChildMeshes(false)[0] ?? null;
        if (!targetMesh) return;

        targetMesh.computeWorldMatrix(true);
        const targetPos = targetMesh.absolutePosition;

        // heading（飛行機の進行方向）+ rotationOffset でカメラの水平角度を決める
        const headingRad = (circularOrbitHeading(angleDeg) * Math.PI) / 180;
        const camRotRad = headingRad + (followCamRotationOffset * Math.PI) / 180;

        // 飛行機の後方にカメラを配置
        followCamera.position.set(
            targetPos.x + followCamRadius * Math.sin(camRotRad),
            targetPos.y + followCamHeightOffset,
            targetPos.z + followCamRadius * Math.cos(camRotRad),
        );
        // カメラは飛行機を向く
        followCamera.setTarget(targetPos);
    };

    /** Follow モード用カスタムポインター操作 */
    let followDragging = false;
    let followLastX = 0;
    let followLastY = 0;

    const onFollowPointerDown = (e: PointerEvent): void => {
        followDragging = true;
        followLastX = e.clientX;
        followLastY = e.clientY;
        e.stopImmediatePropagation();
    };
    const onFollowPointerMove = (e: PointerEvent): void => {
        if (!followDragging || !followCamera) return;
        const dx = e.clientX - followLastX;
        const dy = e.clientY - followLastY;
        followLastX = e.clientX;
        followLastY = e.clientY;

        // 左右ドラッグ → 水平回転
        followCamRotationOffset = ((followCamRotationOffset + dx * DRAG_ROT_DEG_PER_PX) % 360 + 360) % 360;

        // 上下ドラッグ → 高度オフセット（上ドラッグで高く）
        const maxOffset = followCamRadius * FOLLOW_CAMERA_HEIGHT_OFFSET_MAX_MAG;
        followCamHeightOffset = Math.max(1, Math.min(maxOffset, followCamHeightOffset + dy * DRAG_HEIGHT_M_PER_PX));

        updateFollowCamDisplay();
        e.stopImmediatePropagation();
    };
    const onFollowPointerUp = (e: PointerEvent): void => {
        followDragging = false;
        e.stopImmediatePropagation();
    };
    const onFollowWheel = (e: WheelEvent): void => {
        if (!followCamera) return;
        followCamRadius = Math.max(1, followCamRadius + e.deltaY * WHEEL_RADIUS_M_PER_DELTA);
        // radius 変更時に heightOffset が上限を超えないようクランプ
        const maxOffset = followCamRadius * FOLLOW_CAMERA_HEIGHT_OFFSET_MAX_MAG;
        followCamHeightOffset = Math.min(followCamHeightOffset, maxOffset);
        updateFollowCamDisplay();
        e.stopImmediatePropagation();
        e.preventDefault();
    };

    const attachFollowPointerHandlers = (): void => {
        const scene = viewer.__debugScene;
        const canvas = scene?.getEngine().getRenderingCanvas();
        if (!canvas) return;
        canvas.addEventListener("pointerdown", onFollowPointerDown, { capture: true });
        canvas.addEventListener("pointermove", onFollowPointerMove, { capture: true });
        canvas.addEventListener("pointerup", onFollowPointerUp, { capture: true });
        canvas.addEventListener("wheel", onFollowWheel, { capture: true, passive: false });
    };
    const detachFollowPointerHandlers = (): void => {
        const scene = viewer.__debugScene;
        const canvas = scene?.getEngine().getRenderingCanvas();
        if (!canvas) return;
        canvas.removeEventListener("pointerdown", onFollowPointerDown, { capture: true });
        canvas.removeEventListener("pointermove", onFollowPointerMove, { capture: true });
        canvas.removeEventListener("pointerup", onFollowPointerUp, { capture: true });
        canvas.removeEventListener("wheel", onFollowWheel, { capture: true });
    };

    const activateFollowCamera = (): void => {
        const scene = viewer.__debugScene;
        if (!scene) return;

        if (!followCamera) {
            followCamera = setupFollowCamera();
        }
        if (followCamera) {
            // terrain camera の自動タイル更新を停止（C案: 外部 frustum で更新する）
            viewer.detachTileCamera();
            // 即座にカメラ位置を飛行機の後方に設定
            updateFollowCameraPosition();
            scene.activeCamera = followCamera;
            attachFollowPointerHandlers();
            showFollowCamInfo(true);
            updateFollowCamDisplay();

            // SE 開始 (Issue #269)
            if (!flightAudio && !audioInitializing) {
                audioInitializing = true;
                createFlightAudio()
                    .then((audio) => {
                        flightAudio = audio;
                        audioInitializing = false;
                        if (currentCameraMode === "follow") {
                            flightAudio.startEngineSound();
                        }
                    })
                    .catch((err) => {
                        audioInitializing = false;
                        console.warn("[flight-demo] Audio init failed:", err);
                    });
            } else if (flightAudio) {
                flightAudio.startEngineSound();
            }

            // アフターバーナー開始 (Issue #276 / globe: Issue #349)
            // モデルロード完了後に start() する。未ロードなら pending フラグを立て
            // tick() 内でリトライすることで「原点→機体位置」の折れ線トレイルを防ぐ。
            // planar は TrailMesh（機体 TransformNode を generator）で自動更新する。
            // globe は機体ノード名が `globe-model-*-root` で公開 API から取得できず、かつ
            // TrailMesh が真 ECEF を float32 頂点へ焼くと精度落ち + floating origin 非対応の
            // ため、軌道パラメータから真 ECEF を都度算出してリビルドするカスタムトレイル
            // （createGlobeAfterburner）を使う。globe は generator 不要なので即 start 可能。
            if (!afterburner && scene) {
                afterburner = isGlobe
                    ? createGlobeAfterburner(scene)
                    : createAfterburner(scene);
            }
            if (afterburner) {
                if (isGlobe) {
                    // globe は軌道パラメータから算出するためモデルロード待ち不要。
                    afterburner.start({ modelNodeName: `model-${MODEL_ID}` });
                    afterburner.setVisible(showAfterburner);
                } else {
                    const handle = viewer.getModel(MODEL_ID);
                    if (handle?.loaded) {
                        afterburner.start({
                            modelNodeName: `model-${MODEL_ID}`,
                        });
                        afterburner.setVisible(showAfterburner);
                    } else {
                        // 未ロード: tick() 内でモデルロード完了を検知してから start する
                        afterburnerStartPending = true;
                    }
                }
            }
        }
    };

    const deactivateFollowCamera = (): void => {
        const scene = viewer.__debugScene;
        if (!scene || !followCamera) return;

        detachFollowPointerHandlers();
        // 地形カメラへ復帰する。planar は "terrain-camera"、globe は "globe-camera"。
        const terrainCam =
            scene.getCameraByName("terrain-camera") ??
            scene.getCameraByName("globe-camera");
        if (terrainCam) {
            scene.activeCamera = terrainCam;
        }
        // Follow 中の最新タイル中心座標で ArcRotateCamera を再配置してから
        // attachTileCamera を呼ぶ。そうしないと旧座標のタイルがロードされる。
        viewer.lat = lastRefreshLat;
        viewer.lon = lastRefreshLon;
        // terrain camera の自動タイル更新を再開
        viewer.attachTileCamera();
        // コンパスを通常モードに戻す
        viewer.setExternalCompassDegrees(null);
        showFollowCamInfo(false);

        // SE 停止 (Issue #269)
        flightAudio?.stopEngineSound();

        // アフターバーナー停止 (Issue #276)
        afterburnerStartPending = false;
        afterburner?.stop();
    };

    // --- UI 要素の取得 ---
    const centerLatDisplay = document.getElementById("center-lat") as HTMLSpanElement | null;
    const centerLonDisplay = document.getElementById("center-lon") as HTMLSpanElement | null;
    const radiusDisplay = document.getElementById("radius-value") as HTMLSpanElement | null;
    const radiusSlider = document.getElementById("radius-slider") as HTMLInputElement | null;
    const speedDisplay = document.getElementById("speed-value") as HTMLSpanElement | null;
    const speedSlider = document.getElementById("speed-slider") as HTMLInputElement | null;
    const altitudeDisplay = document.getElementById("altitude-value") as HTMLSpanElement | null;
    const altitudeSlider = document.getElementById("altitude-slider") as HTMLInputElement | null;
    const toggleBtn = document.getElementById("toggle-animation") as HTMLButtonElement | null;
    const flyToBtn = document.getElementById("fly-to-center") as HTMLButtonElement | null;
    const camera3dBtn = document.getElementById("camera-3d") as HTMLButtonElement | null;
    const camera2dBtn = document.getElementById("camera-2d") as HTMLButtonElement | null;
    const cameraFollowBtn = document.getElementById("camera-follow") as HTMLButtonElement | null;
    const followCamInfo = document.getElementById("follow-cam-info") as HTMLDivElement | null;
    const followRadiusDisplay = document.getElementById("follow-radius-value") as HTMLSpanElement | null;
    const followHeightDisplay = document.getElementById("follow-height-value") as HTMLSpanElement | null;
    const followLodBiasInput = document.getElementById("follow-lod-bias") as HTMLInputElement | null;
    const followLodBiasDisplay = document.getElementById("follow-lod-bias-value") as HTMLSpanElement | null;
    // Follow モード時のタイル粒度調整 (0 = 通常, 大きいほど粗い)
    let followLodBias = followLodBiasInput ? Number(followLodBiasInput.value) || 0 : 0;
    followLodBiasInput?.addEventListener("input", () => {
        followLodBias = Number(followLodBiasInput.value) || 0;
        if (followLodBiasDisplay) followLodBiasDisplay.textContent = String(followLodBias);
        // 即時反映: 次フレームの tile update で新しい bias が使われるが、
        // ユーザー体感を早めるため lastTileUpdateTime をリセットして即更新を促す
        lastTileUpdateTime = 0;
    });

    const showFollowCamInfo = (visible: boolean): void => {
        if (followCamInfo) followCamInfo.style.display = visible ? "block" : "none";
    };
    const updateFollowCamDisplay = (): void => {
        if (followRadiusDisplay) followRadiusDisplay.textContent = followCamRadius.toFixed(1);
        if (followHeightDisplay) followHeightDisplay.textContent = followCamHeightOffset.toFixed(1);
        if (followLodBiasDisplay) followLodBiasDisplay.textContent = String(followLodBias);
    };

    const updateDisplay = (): void => {
        if (centerLatDisplay) centerLatDisplay.textContent = centerLat.toFixed(6);
        if (centerLonDisplay) centerLonDisplay.textContent = centerLon.toFixed(6);
        if (radiusDisplay) radiusDisplay.textContent = `${radiusM}`;
        if (speedDisplay) speedDisplay.textContent = `${speedMps}`;
        if (altitudeDisplay) altitudeDisplay.textContent = `${altitudeM}`;
    };

    updateDisplay();

    // 半径スライダー
    if (radiusSlider) {
        radiusSlider.value = String(radiusM);
        radiusSlider.addEventListener("input", () => {
            radiusM = Number(radiusSlider.value);
            updateDisplay();
            resetWaypointsIfNeeded();
        });
    }

    // 速度スライダー
    if (speedSlider) {
        speedSlider.value = String(speedMps);
        speedSlider.addEventListener("input", () => {
            speedMps = Number(speedSlider.value);
            updateDisplay();
        });
    }

    // 高度スライダー
    if (altitudeSlider) {
        altitudeSlider.value = String(altitudeM);
        altitudeSlider.addEventListener("input", () => {
            altitudeM = Number(altitudeSlider.value);
            updateDisplay();
            resetWaypointsIfNeeded();
        });
    }

    // アニメーション開始/停止
    const updateToggleLabel = (): void => {
        if (toggleBtn) {
            toggleBtn.textContent = animating ? "⏸ 停止" : "▶ 開始";
        }
    };
    updateToggleLabel();

    if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
            animating = !animating;
            if (animating) {
                lastTimestamp = null;
            }
            updateToggleLabel();
        });
    }

    // ウェイポイント / リボン 表示切替チェックボックス (Issue #274)
    const waypointToggle = document.getElementById("waypoint-toggle") as HTMLInputElement | null;
    const ribbonToggle = document.getElementById("ribbon-toggle") as HTMLInputElement | null;
    if (waypointToggle) {
        waypointToggle.checked = showWaypoints;
        waypointToggle.addEventListener("change", () => {
            showWaypoints = waypointToggle.checked;
            if (!showWaypoints && waypointManager) {
                waypointManager.dispose();
                waypointManager = null;
            }
        });
    }
    if (ribbonToggle) {
        ribbonToggle.checked = showRibbon;
        ribbonToggle.addEventListener("change", () => {
            showRibbon = ribbonToggle.checked;
            if (routeLine) {
                routeLine.setVisible(showRibbon);
            }
        });
    }

    // アフターバーナー表示切替チェックボックス (Issue #276)
    const afterburnerToggle = document.getElementById("afterburner-toggle") as HTMLInputElement | null;
    if (afterburnerToggle) {
        afterburnerToggle.checked = showAfterburner;
        afterburnerToggle.addEventListener("change", () => {
            showAfterburner = afterburnerToggle.checked;
            if (afterburner) {
                afterburner.setVisible(showAfterburner);
            }
        });
    }

    // 中心位置へカメラ移動
    if (flyToBtn) {
        flyToBtn.addEventListener("click", () => {
            if (currentCameraMode !== "follow") {
                viewer.lat = centerLat;
                viewer.lon = centerLon;
            }
        });
    }

    // --- カメラモード切替 ---
    const updateCameraModeButtons = (): void => {
        camera3dBtn?.classList.toggle("active", currentCameraMode === "3d");
        camera2dBtn?.classList.toggle("active", currentCameraMode === "2d");
        cameraFollowBtn?.classList.toggle("active", currentCameraMode === "follow");
    };

    const restore3dCamera = (): void => {
        if (!saved3dCamera) return;
        viewer.lat = saved3dCamera.lat;
        viewer.lon = saved3dCamera.lon;
        viewer.altitude = saved3dCamera.altitude;
        viewer.azimuth = saved3dCamera.azimuth;
        viewer.tilt = saved3dCamera.tilt;
    };

    const switchCameraMode = (mode: CameraMode): void => {
        if (mode === currentCameraMode) return;

        const leavingFollow = currentCameraMode === "follow";

        // Follow へ入る直前に現在の 3D/2D カメラ状態を保存し、Follow→3D/2D 復帰時に復元する。
        if (mode === "follow" && !leavingFollow) {
            saved3dCamera = {
                lat: viewer.lat,
                lon: viewer.lon,
                altitude: viewer.altitude,
                azimuth: viewer.azimuth,
                tilt: viewer.tilt,
            };
        }

        // Follow モードから離脱する場合は、先に viewMode を確定させてから
        // deactivateFollowCamera を呼ぶ。attachTileCamera 内の
        // refreshFromCamera が正しいフラスタム（2D orthographic /
        // 3D perspective）で可視タイルを計算できるようにする。
        if (leavingFollow) {
            viewer.viewMode = mode === "follow" ? "3d" : mode;
            deactivateFollowCamera();
        }

        currentCameraMode = mode;

        switch (mode) {
            case "3d":
                viewer.viewMode = "3d";
                viewer.updateModel(MODEL_ID, { scaling: { x: MODEL_SCALE_NORMAL, y: MODEL_SCALE_NORMAL, z: MODEL_SCALE_NORMAL } });
                // Follow から戻ったときは保存しておいた 3D カメラ位置を復元する
                // （deactivateFollowCamera が Follow 追従位置で上書きするため、その後に再設定）。
                if (leavingFollow) restore3dCamera();
                break;
            case "2d":
                viewer.viewMode = "2d";
                viewer.updateModel(MODEL_ID, { scaling: { x: MODEL_SCALE_NORMAL, y: MODEL_SCALE_NORMAL, z: MODEL_SCALE_NORMAL } });
                if (leavingFollow) restore3dCamera();
                break;
            case "follow":
                // Follow モードでは先に 3D に戻してから FollowCamera を起動
                viewer.viewMode = "3d";
                viewer.updateModel(MODEL_ID, { scaling: { x: MODEL_SCALE_FOLLOW, y: MODEL_SCALE_FOLLOW, z: MODEL_SCALE_FOLLOW } });
                activateFollowCamera();
                break;
        }

        updateCameraModeButtons();
    };

    if (camera3dBtn) {
        camera3dBtn.addEventListener("click", () => switchCameraMode("3d"));
    }
    if (camera2dBtn) {
        camera2dBtn.addEventListener("click", () => switchCameraMode("2d"));
    }
    if (cameraFollowBtn) {
        cameraFollowBtn.addEventListener("click", () => switchCameraMode("follow"));
    }

    updateCameraModeButtons();

    // 地面クリックで円軌道の中心を変更
    viewer.onTerrainClick((event: TerrainClickEvent) => {
        const cameraLat = viewer.lat;
        const cameraLon = viewer.lon;
        const dLat = (event.lat - cameraLat) * 111320;
        const dLon =
            (event.lon - cameraLon) *
            111320 *
            Math.cos((cameraLat * Math.PI) / 180);
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);
        if (dist > MAX_CLICK_DISTANCE_M) return;

        centerLat = event.lat;
        centerLon = event.lon;
        angleDeg = 0;
        lastTimestamp = null;
        updateDisplay();
        resetWaypointsIfNeeded();
    });

    // 毎フレーム更新: 円軌道上の位置を計算してモデルを移動
    let rafId = 0;
    // plane mesh の描画設定（renderingGroupId / alwaysSelectAsActiveMesh）を
    // ロード後に一度だけ適用するためのフラグ。
    // - renderingGroupId=1: 地形タイル (group 0) より後に描画して、Follow モードで
    //   タイル reposition のタイミングと描画順が乱れて「飛行機の場所に奥側地図が
    //   一瞬見える」現象を防ぐ。
    // - alwaysSelectAsActiveMesh=true: 飛行機の frustum culling 判定が
    //   ワールド行列更新と非同期に走るフレームでも active mesh から外れないように。
    let planeRenderTuned = false;
    /**
     * 機体ルート TransformNode を backend 非依存で解決する。
     * - planar: `model-${MODEL_ID}`
     * - globe: `globe-model-N-root`
     *
     * 前提: このデモはメイン Viewer に機体を1体のみ追加する（`globe-model-*-root` は機体だけ）。
     * globe 側は配列順で最初に一致したノードを返すため、将来 scene に複数 globe モデルを
     * 追加する場合は addModel 時の model id を保持して `getTransformNodeByName(`${id}-root`)`
     * で厳密参照すること。
     */
    const getPlaneRoot = (): TransformNode | null => {
        const scene = viewer.__debugScene;
        if (!scene) return null;
        return (
            scene.getTransformNodeByName(`model-${MODEL_ID}`) ??
            scene.transformNodes.find((n) => /^globe-model-\d+-root$/.test(n.name)) ??
            null
        );
    };
    const tunePlaneRenderSettings = (): void => {
        if (planeRenderTuned) return;
        const root = getPlaneRoot();
        if (!root) return;
        const meshes = root.getChildMeshes(false);
        if (meshes.length === 0) return;
        for (const mesh of meshes) {
            mesh.renderingGroupId = 1;
            mesh.alwaysSelectAsActiveMesh = true;
        }
        planeRenderTuned = true;
    };

    // --- 機体の発光ビーコン (3D/2D モードで見つけやすくする) ---
    // 機体マテリアルの emissiveColor を点滅させる。元の値を保持し、Follow では復元する。
    type EmissiveTarget = { material: { emissiveColor: Color3 }; original: Color3 };
    let planeEmissiveTargets: EmissiveTarget[] | null = null;
    const collectPlaneEmissive = (): void => {
        if (planeEmissiveTargets) return;
        const root = getPlaneRoot();
        if (!root) return;
        const meshes = root.getChildMeshes(false);
        if (meshes.length === 0) return;
        const targets: EmissiveTarget[] = [];
        const seen = new Set<unknown>();
        for (const mesh of meshes) {
            const material = mesh.material as unknown as { emissiveColor?: Color3 } | null;
            if (!material || !material.emissiveColor || seen.has(material)) continue;
            seen.add(material);
            targets.push({
                material: material as { emissiveColor: Color3 },
                original: material.emissiveColor.clone(),
            });
        }
        if (targets.length > 0) planeEmissiveTargets = targets;
    };
    const updatePlaneBeacon = (timestamp: number): void => {
        collectPlaneEmissive();
        if (!planeEmissiveTargets) return;
        if (currentCameraMode === "follow") {
            // Follow では機体を間近で見るため発光を解除し、元の見た目に戻す。
            for (const t of planeEmissiveTargets) t.material.emissiveColor.copyFrom(t.original);
            return;
        }
        // 約 1.5Hz で 0..1 を往復する点滅係数。
        const blink = 0.5 + 0.5 * Math.sin(timestamp * 0.01);
        for (const t of planeEmissiveTargets) {
            t.material.emissiveColor.set(
                BEACON_EMISSIVE_COLOR.r * blink,
                BEACON_EMISSIVE_COLOR.g * blink,
                BEACON_EMISSIVE_COLOR.b * blink,
            );
        }
    };

    const tick = (timestamp: number): void => {
        const handle = viewer.getModel(MODEL_ID);
        if (!handle) return;
        tunePlaneRenderSettings();
        updatePlaneBeacon(timestamp);

        if (animating && lastTimestamp !== null) {
            const dtSec = (timestamp - lastTimestamp) / 1000;
            // 線速度 (m/s) → 角速度 (°/s) に変換: ω = v / r * (180/π)
            const speedDegPerSec = (speedMps / radiusM) * (180 / Math.PI);
            angleDeg = (angleDeg + speedDegPerSec * dtSec) % 360;
        }
        if (animating) lastTimestamp = timestamp;

        // この tick で使う最終位置・方位を先に決定する。
        // 順序: (1) refreshTerrain で gridResidual を更新 → (2) updateModel で
        // 新 gridResidual を使って plane.position を更新 → (3) updateFollowCameraPosition
        // でカメラを新 plane 絶対位置に追従させる。
        // 旧順序 (model→camera→refresh) では中心タイル境界を跨いだフレームで
        // gridResidual だけ tileSize ジャンプし、followCamera が旧 plane 位置を見続け、
        // tile/plane が一斉にスライドして「飛行機の場所に奥側地図」のように見えていた。
        const pos = circularOrbitPosition(
            centerLat,
            centerLon,
            radiusM,
            angleDeg,
        );
        const heading = circularOrbitHeading(angleDeg);

        // Follow モード: Follow カメラの frustum を直接 tileManager に注入し、
        // 画面に映っている範囲のタイルを正しく LOD 更新する (C案)。
        // - 前回 refresh が in-flight ならスキップ（オーバーラップを防ぎ過剰負荷を回避）
        // - 一定時間経過 + 意味のある変化（位置/方位/オフセット）があった場合のみ発火
        // - refreshTerrainWithExternalFrustum の同期部分で gridResidualX/Z が
        //   tileSize 単位でジャンプし得るため、必ず updateModel/Follow カメラ更新より
        //   前に呼ぶ。これにより後段の updateModel が新 origin を使って plane.position
        //   を再計算し、followCamera も新 plane 絶対位置に追従できる。
        if (
            currentCameraMode === "follow" &&
            followCamera &&
            !tileRefreshInFlight &&
            timestamp - lastTileUpdateTime >= TILE_UPDATE_INTERVAL_MS
        ) {
            // 前回 refresh からの差分を判定
            const dLat = (pos.lat - lastRefreshLat) * 111320;
            const dLon =
                (pos.lon - lastRefreshLon) *
                111320 *
                Math.cos((pos.lat * Math.PI) / 180);
            const moved = Math.sqrt(dLat * dLat + dLon * dLon);
            const rotDelta = Math.abs(
                ((followCamRotationOffset - lastRefreshRotationOffset + 540) % 360) - 180,
            );
            const heightDelta = Math.abs(followCamHeightOffset - lastRefreshHeightOffset);
            const radiusDelta = Math.abs(followCamRadius - lastRefreshRadius);
            const meaningful =
                moved >= TILE_UPDATE_DISTANCE_M ||
                rotDelta >= TILE_UPDATE_ROTATION_DEG ||
                heightDelta >= TILE_UPDATE_OFFSET_M ||
                radiusDelta >= TILE_UPDATE_OFFSET_M;

            if (meaningful) {
                // Follow カメラの view/projection → frustum planes
                const viewMat = followCamera.getViewMatrix();
                const projMat = followCamera.getProjectionMatrix();
                const transform = Matrix.Identity();
                viewMat.multiplyToRef(projMat, transform);
                const rawPlanes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
                Frustum.GetPlanesToRef(transform, rawPlanes);
                const frustumPlanes = rawPlanes.map((p) => ({
                    normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
                    d: p.d,
                }));

                // カメラ位置を terrain camera target 基準のローカル座標系に変換
                const scene = viewer.__debugScene;
                const terrainCam = scene?.getCameraByName("terrain-camera");
                const target = terrainCam && "target" in terrainCam
                    ? (terrainCam as { target: Vector3 }).target
                    : Vector3.Zero();
                const cameraPosition = {
                    x: followCamera.position.x - target.x,
                    y: followCamera.position.y - target.y,
                    z: followCamera.position.z - target.z,
                };

                lastRefreshLat = pos.lat;
                lastRefreshLon = pos.lon;
                lastRefreshRotationOffset = followCamRotationOffset;
                lastRefreshHeightOffset = followCamHeightOffset;
                lastRefreshRadius = followCamRadius;
                lastTileUpdateTime = timestamp;
                tileRefreshInFlight = true;
                // centerTile が変わるとき gridResidual がタイルサイズ単位でジャンプする。
                // 事前に centerTile を比較して検出し、reset フラグを立てる。
                const currentTile = toTileXY(pos.lat, pos.lon, TILE_MAX_ZOOM);
                if (currentTile.x !== lastCenterTile.x || currentTile.y !== lastCenterTile.y) {
                    afterburnerResetNeeded = true;
                }
                lastCenterTile = currentTile;
                // この呼び出しの同期部分で gridResidualX/Z が更新される。
                void viewer
                    .refreshTerrainWithExternalFrustum(
                        pos.lat,
                        pos.lon,
                        frustumPlanes,
                        cameraPosition,
                        followLodBias,
                    )
                    .finally(() => {
                        tileRefreshInFlight = false;
                    });
            } else {
                // 意味のある変化なし: 次回の判定を遅延させすぎないよう最終チェック時刻だけ進める
                lastTileUpdateTime = timestamp;
            }
        }

        // 上記 refresh により gridResidual がジャンプし得るため、ここで必ず
        // updateModel を呼んで plane.root.position を新 origin で再計算する。
        // animating でなくても、refresh による origin シフトを反映するため呼ぶ。
        viewer.updateModel(MODEL_ID, {
            lat: pos.lat,
            lon: pos.lon,
            altitudeMode: "absolute",
            altitude: altitudeM,
            rotation: { y: heading },
            gravity: false,
        });

        // updateModel で root.position が確定した後にトレイルをリセットする。
        // refreshTerrainWithExternalFrustum が走ったフレームでのみ1回だけ実行。
        // gridResidual ジャンプで旧座標の頂点が残り折れ線になるのを防止する。
        // globe トレイルは絶対 ECEF 履歴で構築され origin ジャンプの影響を受けないため、
        // reset するとタイル境界ごとに炎が一瞬畳まれて見えてしまう。planar のみ reset する。
        if (afterburnerResetNeeded && afterburner) {
            afterburnerResetNeeded = false;
            if (!isGlobe) {
                const scene = viewer.__debugScene;
                const root = scene?.getTransformNodeByName(`model-${MODEL_ID}`);
                root?.computeWorldMatrix(true);
                afterburner.reset();
            }
        }

        // モデルロード完了後に afterburner を start するリトライ処理。
        // activateFollowCamera() 時点で handle.loaded=false だった場合、ここで開始する。
        // updateModel() 後に実行することで root.position が正しい座標に確定している。
        if (afterburnerStartPending && afterburner && handle.loaded && currentCameraMode === "follow") {
            afterburnerStartPending = false;
            afterburner.start({
                modelNodeName: `model-${MODEL_ID}`,
            });
            afterburner.setVisible(showAfterburner);
        }

        // globe アフターバーナーの毎フレーム更新（軌道パラメータから真 ECEF を算出して
        // トレイルをリビルド）。planar は TrailMesh が自動更新するため update は no-op。
        if (afterburner && currentCameraMode === "follow" && showAfterburner) {
            afterburner.update({
                centerLat,
                centerLon,
                radiusM,
                altitudeM,
                angleDeg,
            });
        }

        // Follow モード: 毎フレームカメラ位置を飛行機の後方に直接設定 + コンパス同期
        // plane.root.position 更新後に呼ぶことで、followCamera の注視点が
        // 新 origin の plane 絶対位置と一致する。
        if (currentCameraMode === "follow") {
            updateFollowCameraPosition();
            // コンパスを Follow カメラの水平方位に同期
            if (followCamera) {
                // followCamRotationOffset: 飛行機の進行方向に対するカメラのオフセット角度
                // heading + rotationOffset がカメラの向いている方位
                const headingDeg = circularOrbitHeading(angleDeg);
                const camAzimuth = (headingDeg + followCamRotationOffset + 180) % 360;
                viewer.setExternalCompassDegrees(camAzimuth);
            }
        }

        // ルートライン更新 (Issue #265) — 遅延初期化
        if (!routeLine) {
            const scene = viewer.__debugScene;
            if (scene) {
                routeLine = createRouteLine(scene);
                routeLine.setVisible(showRibbon);
            }
        }
        if (routeLine) {
            if (showRibbon) {
                routeLine.update(
                    {
                        scene: viewer.__debugScene!,
                        angleDeg,
                        centerLat,
                        centerLon,
                        radiusM,
                        modelNodeName: `model-${MODEL_ID}`,
                        isGlobe,
                        altitudeM,
                    },
                    timestamp,
                );
            }
        }

        // ウェイポイント更新 (Issue #274) — Followモードのみ
        if (currentCameraMode === "follow" && showWaypoints) {
            if (!waypointManager) {
                const scene = viewer.__debugScene;
                if (scene) {
                    waypointManager = createWaypointManager(scene, {
                        onPass: () => flightAudio?.playWaypointPassSound(),
                    });
                    resetWaypointsIfNeeded();
                }
            }
            if (waypointManager) {
                waypointManager.update(
                    {
                        centerLat,
                        centerLon,
                        radiusM,
                        altitudeM,
                        angleDeg,
                        modelNodeName: `model-${MODEL_ID}`,
                        isGlobe,
                    },
                    timestamp,
                );
            }
        } else if (waypointManager && currentCameraMode !== "follow") {
            // Followモードを離れたらウェイポイントを破棄
            waypointManager.dispose();
            waypointManager = null;
        }


        // PIP セカンダリ Viewer 更新: 飛行機の腹部カメラを再現。
        // lib の lat/lon = ArcRotateCamera のターゲット (地面の注視点)。
        // belly カメラは飛行機位置にあり、heading 方向 + 俯角 tilt で地面を見るので、
        // ターゲットは飛行機から heading 方向に altitude*tan(tilt) メートル前方の地表。
        const now = performance.now();
        if (pipViewer && now - lastPipUpdateMs >= PIP_UPDATE_INTERVAL_MS) {
            lastPipUpdateMs = now;
            const tiltRad = (PIP_BELLY_TILT_DEG * Math.PI) / 180;
            const forwardDistM = altitudeM * Math.tan(tiltRad);
            const headingRad = (heading * Math.PI) / 180;
            const dLatDeg = (forwardDistM * Math.cos(headingRad)) / 111320;
            const dLonDeg =
                (forwardDistM * Math.sin(headingRad)) /
                (111320 * Math.cos((pos.lat * Math.PI) / 180));
            pipViewer.lat = pos.lat + dLatDeg;
            pipViewer.lon = pos.lon + dLonDeg;
            pipViewer.altitude = altitudeM;
            // 方位の符号は backend 依存（globe: 視線方位=azimuth=heading / planar: -heading）。
            pipViewer.azimuth = isGlobe ? heading : -heading;
            pipViewer.tilt = PIP_BELLY_TILT_DEG;
        }

        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // ページ離脱時にアニメーションフレームをキャンセル + PIP クリーンアップ
    window.addEventListener("beforeunload", () => {
        cancelAnimationFrame(rafId);
        if (routeLine) {
            routeLine.dispose();
        }
        if (waypointManager) {
            waypointManager.dispose();
        }
        if (flightAudio) {
            flightAudio.dispose();
        }
        if (afterburner) {
            afterburner.dispose();
        }
        pipCleanups.forEach((fn) => fn());
        if (pipViewer) {
            pipViewer.dispose();
        }
    });
};

start().catch((err) => {
    console.error("[flight-demo] Failed to start:", err);
});
