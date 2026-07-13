/**
 * ROI（Region of Interest）周回デモ
 *
 * 3D 地形ビューアをベースに、富士山頂 ROI を中心に一定半径・時計回りで
 * カメラが周回し続けるプロモーション用デモ（zoomloop と同型）。
 * - マーカーなし
 * - 写真ボタン（地図切替）以外の画面操作（ドラッグ・ホイール・コンパス・
 *   ズームボタン・現在地・視点切替）はすべて無効化する。ボタン自体は非表示に
 *   せず、クリック/キー操作のみ無効化する（表示は維持）。
 * - 速度・半径・高度は開発中に調整する暫定値。
 *
 * カメラは `viewer.lat/lon/altitude/azimuth/tilt`（内蔵 ArcRotateCamera 系）を使わず、
 * flight デモの Follow モードと同じ方式で、専用の Babylon `FreeCamera` を真の ECEF
 * 絶対座標で毎フレーム直接配置する。`viewer.altitude` は実体がカメラ注視点からの
 * 距離（radius）であり、低高度では地形へ追従する「seat-on-terrain」機構の影響で
 * 起伏に沿って絶対高度が揺らいでしまう（地図ドラッグを起伏のある山岳地帯で行った
 * 場合と同じ現象）。ROI 周回は富士山頂付近の低高度・小半径で周回するため、この
 * 揺らぎが顕著に現れる。真の ECEF 座標で直接配置すればこの機構の影響を受けず、
 * 絶対高度を厳密に一定に保てる。
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { EngineType, JpmapTerrainOptions } from "../../lib/types";
import { geodeticToEcefToRef } from "../../terrain/geo/ecef";
import { lockCameraInput, lockControlPanelExceptPhoto } from "../shared/lockControls";
import {
    advanceRoiOrbit,
    cameraPositionForRoiOrbit,
    headingForRoiOrbit,
    type RoiOrbitConfig,
    type RoiOrbitState,
} from "./orbitLoop";

const DEMO_MOUNT_ID = "root";

/** 富士山頂（剣ヶ峰）付近。周回中心（ROI）。 */
const FUJI_SUMMIT = { lat: 35.360833, lon: 138.727361 };
/** 剣ヶ峰の標高（公開値）[m]。カメラの注視点（ROI 中心）の絶対高度に使う。 */
const FUJI_SUMMIT_ALTITUDE_M = 3776;

/** 周回半径 [m]（暫定値。開発中に調整。山頂全体を見渡せるよう離れた距離にする）。 */
const RADIUS_M = 3000;
/** 周回中のカメラの絶対高度 [m]（暫定値。開発中に調整。山頂よりやや高く、見下ろす画角にする）。 */
const CAMERA_ALTITUDE_M = 4660;
/** 角速度 [deg/s]（暫定値。1周 約120秒。開発中に調整）。 */
const ANGULAR_SPEED_DEG_PER_SEC = 3;

const ORBIT_CONFIG: RoiOrbitConfig = {
    center: FUJI_SUMMIT,
    radiusM: RADIUS_M,
    cameraAltitudeM: CAMERA_ALTITUDE_M,
    angularSpeedDegPerSec: ANGULAR_SPEED_DEG_PER_SEC,
};

/** 周回カメラの far clip [m]。近距離周回のため flight デモより小さく抑える。 */
const ORBIT_CAMERA_MAX_Z = 100000;
/** 地形タイル frustum 更新の最小間隔 [ms]（flight デモの Follow モードと同じ値）。 */
const TILE_REFRESH_INTERVAL_MS = 300;

/** `?engine=` クエリ文字列から描画エンジン種別を解決する（他デモと同じ規約）。 */
const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

// スクラッチ用（GC 回避のため使い回す）。ROI 中心は周回中不変のため一度だけ計算する。
const targetEcef = new Vector3();
const cameraEcef = new Vector3();
const rawFrustumPlanes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
const frustumTransform = new Matrix();

/**
 * 周回カメラ（FreeCamera）を ROI 周回位置に合わせて配置する。
 * 位置は真の ECEF 絶対座標で設定し、`setTarget` で常に ROI 中心を向かせる
 * （方位角・チルトは Babylon 側の自動計算に任せ、本デモでは算出しない）。
 */
const updateOrbitCameraPose = (orbitCamera: FreeCamera, lat: number, lon: number): void => {
    geodeticToEcefToRef(lat, lon, CAMERA_ALTITUDE_M, cameraEcef);
    orbitCamera.position.copyFrom(cameraEcef);
    // 地心 up を上方向にすることで水平線のロールを防ぐ（flight デモの Follow モードと同じ方針）。
    orbitCamera.upVector.copyFrom(cameraEcef).normalize();
    orbitCamera.setTarget(targetEcef);
};

/**
 * 周回カメラの frustum を `viewer.refreshTerrainWithExternalFrustum` へ渡し、
 * 内蔵 terrain camera の自動更新を使わずに周回カメラの視野内タイルを LOD 更新する。
 * 呼び出し間隔は `TILE_REFRESH_INTERVAL_MS` で間引き、前回呼び出しが未完了の間は
 * スキップして多重発火を防ぐ（flight デモの Follow モードと同方針。角速度が一定の
 * ため、flight のような「意味のある変化」判定は不要で固定間隔の間引きのみで足りる）。
 */
const createTileRefreshScheduler = (viewer: JpmapTerrain, orbitCamera: FreeCamera) => {
    let lastRefreshMs = 0;
    let inFlight = false;

    return (nowMs: number, lat: number, lon: number): void => {
        if (inFlight || nowMs - lastRefreshMs < TILE_REFRESH_INTERVAL_MS) return;
        lastRefreshMs = nowMs;

        // 外部カメラの実 view 行列（並進 ~6.4e6m の ECEF 絶対位置を含む）をそのまま
        // projection と合成すると Float32 演算の桁落ちが起きるため、並進行を 0 にした
        // 「camera 相対（回転のみ）」の行列で frustum 平面を作る（spec/package.md 3.3.14.2 参照）。
        const viewMat = orbitCamera.getViewMatrix().clone();
        viewMat.setRowFromFloats(3, 0, 0, 0, 1);
        const projMat = orbitCamera.getProjectionMatrix();
        viewMat.multiplyToRef(projMat, frustumTransform);
        Frustum.GetPlanesToRef(frustumTransform, rawFrustumPlanes);
        const frustumPlanes = rawFrustumPlanes.map((p) => ({
            normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
            d: p.d,
        }));
        const cameraPosition = {
            x: orbitCamera.position.x,
            y: orbitCamera.position.y,
            z: orbitCamera.position.z,
        };

        inFlight = true;
        void viewer
            .refreshTerrainWithExternalFrustum(lat, lon, frustumPlanes, cameraPosition, 0)
            .finally(() => {
                inFlight = false;
            });
    };
};

/** ROI 周回を無限に実行する（デモページが開いている間、停止しない）。 */
const runRoiOrbit = (viewer: JpmapTerrain, orbitCamera: FreeCamera): void => {
    const refreshTiles = createTileRefreshScheduler(viewer, orbitCamera);
    let state: RoiOrbitState = { elapsedMs: 0 };
    let lastTime: number | null = null;

    const step = (now: number): void => {
        const deltaMs = lastTime === null ? 0 : now - lastTime;
        lastTime = now;
        state = advanceRoiOrbit(state, deltaMs, ORBIT_CONFIG);

        const { lat, lon } = cameraPositionForRoiOrbit(state, ORBIT_CONFIG);
        updateOrbitCameraPose(orbitCamera, lat, lon);
        viewer.setExternalCompassDegrees(headingForRoiOrbit(state, ORBIT_CONFIG));
        refreshTiles(now, lat, lon);

        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }
    const engine = resolveEngine(location.search);
    const initialPosition = cameraPositionForRoiOrbit({ elapsedMs: 0 }, ORBIT_CONFIG);
    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        lat: initialPosition.lat,
        lon: initialPosition.lon,
        mapType: "photo",
        viewMode: "3d",
        // ドラッグパン・WASD パンは detachControl() では止まらない独自ハンドラのため、
        // 写真ボタン以外を完全に無効化する要件のためオプションで明示的に無効化する。
        enablePan: false,
        enableKeyboardPan: false,
    };
    const viewer = await JpmapTerrain.create(mount, opts);

    const scene = viewer.__debugScene;
    if (!scene) {
        throw new Error("[jpmap-terrain roiorbit demo] scene not available");
    }

    // ROI 中心（山頂）の ECEF 絶対位置は周回中不変のため、ここで一度だけ計算する。
    geodeticToEcefToRef(FUJI_SUMMIT.lat, FUJI_SUMMIT.lon, FUJI_SUMMIT_ALTITUDE_M, targetEcef);

    const orbitCamera = new FreeCamera("roiorbit-camera", Vector3.Zero(), scene);
    orbitCamera.minZ = 1;
    orbitCamera.maxZ = ORBIT_CAMERA_MAX_Z;
    // 組み込み入力を無効化（本デモは自動演出のみで、ユーザー操作を受け付けない）。
    orbitCamera.inputs.clear();
    updateOrbitCameraPose(orbitCamera, initialPosition.lat, initialPosition.lon);

    // 内蔵 terrain camera の自動タイル更新を停止し、周回カメラの frustum で明示的に更新する。
    viewer.detachTileCamera();
    scene.activeCamera = orbitCamera;

    lockControlPanelExceptPhoto();
    lockCameraInput(viewer);
    runRoiOrbit(viewer, orbitCamera);

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する（他デモと同じ規約）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        (window as unknown as { scene: unknown }).scene = viewer.__debugScene;
    }
};

// `#root` が無い環境（テスト環境等）では副作用としてのデモ起動をスキップする。
if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain roiorbit demo] failed to start:", err);
    });
}
