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
import planeGlbUrl from "../../../assets/plane.glb";

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
    /** Follow モードでタイル中心を飛行機位置に追従させる最小間隔 (ms) */
    const TILE_UPDATE_INTERVAL_MS = 2000;

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
        e.stopPropagation();
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
        e.stopPropagation();
    };
    const onFollowPointerUp = (e: PointerEvent): void => {
        followDragging = false;
        e.stopPropagation();
    };
    const onFollowWheel = (e: WheelEvent): void => {
        if (!followCamera) return;
        followCamRadius = Math.max(1, followCamRadius + e.deltaY * WHEEL_RADIUS_M_PER_DELTA);
        // radius 変更時に heightOffset が上限を超えないようクランプ
        const maxOffset = followCamRadius * FOLLOW_CAMERA_HEIGHT_OFFSET_MAX_MAG;
        followCamHeightOffset = Math.min(followCamHeightOffset, maxOffset);
        updateFollowCamDisplay();
        e.stopPropagation();
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

    const showFollowCamInfo = (visible: boolean): void => {
        if (followCamInfo) followCamInfo.style.display = visible ? "block" : "none";
    };
    const updateFollowCamDisplay = (): void => {
        if (followRadiusDisplay) followRadiusDisplay.textContent = followCamRadius.toFixed(1);
        if (followHeightDisplay) followHeightDisplay.textContent = followCamHeightOffset.toFixed(1);
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

        // 前のモードの後処理
        if (currentCameraMode === "follow") {
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
    const tick = (timestamp: number): void => {
        const handle = viewer.getModel(MODEL_ID);
        if (!handle) return;

        if (animating) {
            if (lastTimestamp !== null) {
                const dtSec = (timestamp - lastTimestamp) / 1000;
                // 線速度 (m/s) → 角速度 (°/s) に変換: ω = v / r * (180/π)
                const speedDegPerSec = (speedMps / radiusM) * (180 / Math.PI);
                angleDeg = (angleDeg + speedDegPerSec * dtSec) % 360;
            }
            lastTimestamp = timestamp;

            const pos = circularOrbitPosition(
                centerLat,
                centerLon,
                radiusM,
                angleDeg,
            );
            const heading = circularOrbitHeading(angleDeg);

            viewer.updateModel(MODEL_ID, {
                lat: pos.lat,
                lon: pos.lon,
                altitudeMode: "absolute",
                altitude: altitudeM,
                rotation: { y: heading },
                gravity: false,
            });
        }

        // Follow モード: 毎フレームカメラ位置を飛行機の後方に直接設定 + コンパス同期
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

        // Follow モード: Follow カメラの frustum を直接 tileManager に注入し、
        // 画面に映っている範囲のタイルを正しく LOD 更新する (C案)。
        if (
            currentCameraMode === "follow" &&
            followCamera &&
            timestamp - lastTileUpdateTime >= TILE_UPDATE_INTERVAL_MS
        ) {
            const planePos = circularOrbitPosition(centerLat, centerLon, radiusM, angleDeg);
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

            viewer.refreshTerrainWithExternalFrustum(
                planePos.lat,
                planePos.lon,
                frustumPlanes,
                cameraPosition,
            );
            lastTileUpdateTime = timestamp;
        }

        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // ページ離脱時にアニメーションフレームをキャンセル
    window.addEventListener("beforeunload", () => {
        cancelAnimationFrame(rafId);
    });
};

start().catch((err) => {
    console.error("[flight-demo] Failed to start:", err);
});
