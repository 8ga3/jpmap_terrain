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
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";

import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, TerrainClickEvent } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import { circularOrbitPosition, circularOrbitHeading } from "../avatar/orbit";
import { createRouteLine, type RouteLine } from "./routeLine";
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

    const opts: JpmapTerrainOptions = {
        engine: resolveEngine(location.search),
        lat: camera?.lat ?? TOKYO_STATION.lat,
        lon: camera?.lon ?? TOKYO_STATION.lon,
        altitude: camera?.altitude ?? INITIAL_CAMERA_ALTITUDE,
        azimuth: camera?.azimuth,
        tilt: camera?.tilt ?? 45,
        mapType: mapType ?? "standard",
        showViewModeButton: false,
    };

    const viewer = await JpmapTerrain.create(mount, opts);

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
    // Follow カメラの可変パラメータ
    let followCamRadius = FOLLOW_CAMERA_RADIUS;
    let followCamHeightOffset = FOLLOW_CAMERA_HEIGHT_OFFSET;
    let followCamRotationOffset = FOLLOW_CAMERA_ROTATION_OFFSET;
    // Follow モードでのタイル中心更新スロットル
    let lastTileUpdateTime = 0;
    let tileRefreshInFlight = false;
    let lastRefreshLat = TOKYO_STATION.lat;
    let lastRefreshLon = TOKYO_STATION.lon;
    let lastRefreshRotationOffset = FOLLOW_CAMERA_ROTATION_OFFSET;
    let lastRefreshHeightOffset = FOLLOW_CAMERA_HEIGHT_OFFSET;
    let lastRefreshRadius = FOLLOW_CAMERA_RADIUS;
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
            lat: initPos.lat,
            lon: initPos.lon,
            altitude: altitudeM,
            azimuth: -circularOrbitHeading(angleDeg),
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
        }
    };

    const deactivateFollowCamera = (): void => {
        const scene = viewer.__debugScene;
        if (!scene || !followCamera) return;

        detachFollowPointerHandlers();
        const arcCam = scene.getCameraByName("terrain-camera");
        if (arcCam) {
            scene.activeCamera = arcCam;
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

    const switchCameraMode = (mode: CameraMode): void => {
        if (mode === currentCameraMode) return;

        // Follow モードから離脱する場合は、先に viewMode を確定させてから
        // deactivateFollowCamera を呼ぶ。attachTileCamera 内の
        // refreshFromCamera が正しいフラスタム（2D orthographic /
        // 3D perspective）で可視タイルを計算できるようにする。
        if (currentCameraMode === "follow") {
            viewer.viewMode = mode === "follow" ? "3d" : mode;
            deactivateFollowCamera();
        }

        currentCameraMode = mode;

        switch (mode) {
            case "3d":
                viewer.viewMode = "3d";
                viewer.updateModel(MODEL_ID, { scaling: { x: MODEL_SCALE_NORMAL, y: MODEL_SCALE_NORMAL, z: MODEL_SCALE_NORMAL } });
                break;
            case "2d":
                viewer.viewMode = "2d";
                viewer.updateModel(MODEL_ID, { scaling: { x: MODEL_SCALE_NORMAL, y: MODEL_SCALE_NORMAL, z: MODEL_SCALE_NORMAL } });
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
    const tunePlaneRenderSettings = (): void => {
        if (planeRenderTuned) return;
        const scene = viewer.__debugScene;
        if (!scene) return;
        const root = scene.getTransformNodeByName(`model-${MODEL_ID}`);
        if (!root) return;
        const meshes = root.getChildMeshes(false);
        if (meshes.length === 0) return;
        for (const mesh of meshes) {
            mesh.renderingGroupId = 1;
            mesh.alwaysSelectAsActiveMesh = true;
        }
        planeRenderTuned = true;
    };

    const tick = (timestamp: number): void => {
        const handle = viewer.getModel(MODEL_ID);
        if (!handle) return;
        tunePlaneRenderSettings();

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
            }
        }
        if (routeLine) {
            routeLine.update(
                {
                    scene: viewer.__debugScene!,
                    angleDeg,
                    centerLat,
                    centerLon,
                    radiusM,
                    modelNodeName: `model-${MODEL_ID}`,
                    modelScale: MODEL_SCALE_FOLLOW,
                },
                timestamp,
            );
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
            pipViewer.azimuth = -heading;
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
        pipCleanups.forEach((fn) => fn());
        if (pipViewer) {
            pipViewer.dispose();
        }
    });
};

start().catch((err) => {
    console.error("[flight-demo] Failed to start:", err);
});
