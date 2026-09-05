/**
 * ズームループ デモ
 *
 * 3D 地形ビューアをベースに、ズームイン地点とズームアウト地点の間をカメラが
 * クォータニオンで滑らかに往復し続けるプロモーション用デモ。
 * - マーカーなし
 * - 写真ボタン（地図切替）以外の画面操作（ドラッグ・ホイール・コンパス・
 *   ズームボタン・現在地・視点切替）はすべて無効化する。ボタン自体は非表示に
 *   せず、クリック/キー操作のみ無効化する（表示は維持）。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { EngineType, JpmapTerrainOptions } from "../../lib/types";
import {
    lockCameraInput,
    lockControlPanelExceptPhoto,
} from "../shared/lockControls";
import {
    advanceZoomLoop,
    type CameraEndpoint,
    type CameraFrame,
    cameraFrameForState,
    type ZoomLoopConfig,
    type ZoomLoopState,
} from "./cameraPath";

const DEMO_MOUNT_ID = "root";

/** ズームイン側 */
const ZOOM_IN: CameraEndpoint = {
    lat: 35.358152,
    lon: 138.732405,
    altitude: 2000,
    azimuth: 0,
    tilt: 35,
};

/** ズームアウト側 */
const ZOOM_OUT: CameraEndpoint = {
    lat: 35.075275,
    lon: -96.293408,
    altitude: 3_177_000,
    azimuth: 0,
    tilt: 45,
};

/** 片道の移動時間 [ms]（Issue指定: およそ120秒）。 */
const MOVE_DURATION_MS = 120_000;
/** 両端点での静止時間 [ms]（Issue指定: 2秒）。 */
const HOLD_DURATION_MS = 2_000;

const LOOP_CONFIG: ZoomLoopConfig = {
    zoomIn: ZOOM_IN,
    zoomOut: ZOOM_OUT,
    moveDurationMs: MOVE_DURATION_MS,
    holdDurationMs: HOLD_DURATION_MS,
};

/** `?engine=` クエリ文字列から描画エンジン種別を解決する（他デモと同じ規約）。 */
const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

const applyCameraFrame = (viewer: JpmapTerrain, frame: CameraFrame): void => {
    viewer.lat = frame.lat;
    viewer.lon = frame.lon;
    viewer.altitude = frame.altitude;
    viewer.azimuth = frame.azimuth;
    viewer.tilt = frame.tilt;
};

/** ズームループを無限に実行する（デモページが開いている間、停止しない）。 */
const runZoomLoop = (viewer: JpmapTerrain): void => {
    let state: ZoomLoopState = { phase: "holdZoomIn", elapsedInPhaseMs: 0 };
    let lastTime: number | null = null;

    const step = (now: number): void => {
        const deltaMs = lastTime === null ? 0 : now - lastTime;
        lastTime = now;
        state = advanceZoomLoop(state, deltaMs, LOOP_CONFIG);
        applyCameraFrame(viewer, cameraFrameForState(state, LOOP_CONFIG));
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
    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        lat: ZOOM_IN.lat,
        lon: ZOOM_IN.lon,
        altitude: ZOOM_IN.altitude,
        azimuth: ZOOM_IN.azimuth,
        tilt: ZOOM_IN.tilt,
        mapType: "standard",
        viewMode: "3d",
        // ドラッグパン・WASD パンは detachControl() では止まらない独自ハンドラのため、
        // 写真ボタン以外を完全に無効化する要件のためオプションで明示的に無効化する。
        enablePan: false,
        enableKeyboardPan: false,
    };
    const viewer = await JpmapTerrain.create(mount, opts);

    lockControlPanelExceptPhoto();
    lockCameraInput(viewer);
    runZoomLoop(viewer);

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
        console.error("[jpmap-terrain zoomloop demo] failed to start:", err);
    });
}
