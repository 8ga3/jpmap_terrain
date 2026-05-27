/**
 * アバターアニメーション #02 — Game Controller 対応 (Issue #270)
 *
 * `JpmapTerrain` の Model 公開 API と `playModelAnimation` を使い、
 * キーボード / Game Controller / Virtual Joystick でユーザーがアバターを
 * 操作できるデモ。
 *
 * 入力デバイス:
 * - キーボード: 矢印キー / WASD
 * - Game Controller: Babylon.js `GamepadManager` の左スティック
 * - タッチ: Babylon.js `VirtualJoystick`（左スティック）
 *
 * 仕様:
 * - 東京駅に初期配置、移動中のみ歩行アニメーションを再生
 * - 地面クリックでスポーン地点を変更
 * - 進行方向に自動回転
 * - 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, TerrainClickEvent } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import { GamepadManager } from "@babylonjs/core/Gamepads/gamepadManager";
import { createDomJoystick } from "./domJoystick";
import {
    combineInputs,
    keyboardVector,
    moveVectorMagnitude,
    movementHeading,
    rotateByAzimuth,
    stepPosition,
    type MoveVector,
} from "./movement";
import {
    computeAutoScroll,
    DEFAULT_DEADZONE_RATIO,
    DEFAULT_SCROLL_LERP,
} from "./autoScroll";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { extractOrthoStableFrustumPlanes } from "../../terrain/tileManager";
import humanWalkGlbUrl from "../../../assets/human_walk.glb";

const METERS_PER_DEGREE_LAT = 111320;

const DEMO_MOUNT_ID = "root";
const MODEL_ID = "avatar";

/** 東京駅 */
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };

/** モデルの表示スケール */
const MODEL_SCALE = 50;
/** デフォルト歩行速度 (m/s) */
const DEFAULT_SPEED_MPS = 10;
/** クリック可能距離 (m) */
const MAX_CLICK_DISTANCE_M = 5000;
/** 移動を「歩行中」とみなす入力強度の閾値 */
const MOVING_THRESHOLD = 0.05;

const WALK_ANIM = "rig-action";

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
        altitude: camera?.altitude ?? 500,
        azimuth: camera?.azimuth,
        tilt: camera?.tilt ?? 45,
        mapType: mapType ?? "standard",
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
    }

    let avatarLat = TOKYO_STATION.lat;
    let avatarLon = TOKYO_STATION.lon;
    let speedMps = DEFAULT_SPEED_MPS;
    let lastHeadingDeg = 0;
    let walking = false;
    let lastTimestamp: number | null = null;
    let animationStarted = false;
    let autoScrollEnabled = true;

    /**
     * 自動スクロール — Flight demo Follow モードと同じ手法 (Issue #287):
     * - `detachTileCamera()` で内部の自動タイル更新監視を停止
     * - 毎フレーム `arcCamera.target.x/z` を直接動かして滑らかに追従
     *   (setter 経由だと毎回 `refreshTerrain → requestId++` で in-flight が
     *    キャンセルされ、スクロール中に新規タイルがロードされない)
     * - 距離スロットル + in-flight ガード付きで
     *   `refreshTerrainWithExternalFrustum` を発火し新規タイルをロード
     */
    const SCROLL_REFRESH_DISTANCE_M = 5;
    const SCROLL_REFRESH_INTERVAL_MS = 100;
    /** カメラ方位の変化がこれ以上で refresh 発火（度） */
    const CAMERA_ROT_REFRESH_DEG = 3;
    /** カメラ tilt の変化がこれ以上で refresh 発火（度） */
    const CAMERA_TILT_REFRESH_DEG = 2;
    let lastRefreshLat = viewer.lat;
    let lastRefreshLon = viewer.lon;
    let lastRefreshTime = 0;
    let lastRefreshAzimuth = viewer.azimuth;
    let lastRefreshTilt = viewer.tilt;
    let lastRefreshAltitude = viewer.altitude;
    /** 高度変化率がこれ以上で refresh 発火 */
    const CAMERA_ALT_REFRESH_RATIO = 0.1;
    let scrollRefreshInFlight = false;
    /** detach は初回移動時に遅延実行する（初期表示の境界タイル欠けを防ぐ） */
    let tileCameraDetached = false;

    // ArcRotateCamera への直接アクセス (Flight Follow モードと同じパターン)
    const scene = viewer.__debugScene;
    const arcCamera = scene?.getCameraByName("terrain-camera") as
        | ArcRotateCamera
        | undefined;

    /** in-flight ガード付きでタイル refresh を発火する共通ヘルパー */
    const triggerTileRefresh = (timestamp: number): void => {
        if (!arcCamera || scrollRefreshInFlight) return;
        if (timestamp - lastRefreshTime < SCROLL_REFRESH_INTERVAL_MS) return;
        const refLatNow = viewer.lat;
        const refLonNow = viewer.lon;

        // 2D (ortho) モードでは回転に依存しない安定 frustum planes を使う (#286)。
        // 通常の view*proj から抽出すると alpha 回転でタイル選択が膨らみ
        // maxTiles/maxVisited 到達や LOD 乱れが発生するため。
        let frustumPlanes: { normal: { x: number; y: number; z: number }; d: number }[];
        if (arcCamera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
            frustumPlanes = extractOrthoStableFrustumPlanes(arcCamera);
        } else {
            const viewMat = arcCamera.getViewMatrix();
            const projMat = arcCamera.getProjectionMatrix();
            const transform = Matrix.Identity();
            viewMat.multiplyToRef(projMat, transform);
            const rawPlanes: Plane[] = Array.from(
                { length: 6 },
                () => new Plane(0, 0, 0, 0),
            );
            Frustum.GetPlanesToRef(transform, rawPlanes);
            frustumPlanes = rawPlanes.map((p) => ({
                normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
                d: p.d,
            }));
        }

        const cameraPosition = {
            x: arcCamera.position.x - arcCamera.target.x,
            y: arcCamera.position.y - arcCamera.target.y,
            z: arcCamera.position.z - arcCamera.target.z,
        };
        lastRefreshLat = refLatNow;
        lastRefreshLon = refLonNow;
        lastRefreshAzimuth = viewer.azimuth;
        lastRefreshTilt = viewer.tilt;
        lastRefreshAltitude = viewer.altitude;
        lastRefreshTime = timestamp;
        scrollRefreshInFlight = true;
        void viewer
            .refreshTerrainWithExternalFrustum(
                refLatNow,
                refLonNow,
                frustumPlanes,
                cameraPosition,
            )
            .finally(() => {
                scrollRefreshInFlight = false;
            });
    };

    viewer.addModel(MODEL_ID, {
        url: humanWalkGlbUrl,
        lat: avatarLat,
        lon: avatarLon,
        altitudeMode: "terrain",
        altitude: 0,
        rotation: { y: lastHeadingDeg },
        scaling: { x: MODEL_SCALE, y: MODEL_SCALE, z: MODEL_SCALE },
        gravity: true,
    });

    // --- 入力: キーボード ---
    const pressedKeys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent): void => {
        pressedKeys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        pressedKeys.delete(e.code);
    };
    // ウィンドウフォーカスを失った際に keyup を取りこぼしてキーが押しっぱなしになるのを防ぐ
    const onBlur = (): void => {
        pressedKeys.clear();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    // --- 入力: Gamepad ---
    const gamepadManager = new GamepadManager();
    const gamepadStick = { x: 0, y: 0 };
    gamepadManager.onGamepadConnectedObservable.add((gp) => {
        gp.onleftstickchanged((values) => {
            gamepadStick.x = values.x;
            gamepadStick.y = values.y;
        });
    });
    gamepadManager.onGamepadDisconnectedObservable.add(() => {
        gamepadStick.x = 0;
        gamepadStick.y = 0;
    });

    // --- 入力: Virtual Joystick（左下に常時表示） ---
    // Babylon.js の VirtualJoystick は canvas が画面全体を覆ってしまうため、
    // 操作領域を左下の円形 DOM 要素に限定した独自実装を使う。
    const overlay = document.getElementById("avatar-overlay") as HTMLElement | null;
    const joystick = createDomJoystick({
        parent: overlay ?? document.body,
        containerSize: 120,
        puckSize: 50,
        // Babylon.js の写真ボタン（左下 ~50px）の右隣に配置
        leftOffset: 70,
        bottomOffset: 10,
        color: "#4af",
    });

    // --- UI ---
    const latDisplay = document.getElementById(
        "avatar-lat",
    ) as HTMLSpanElement | null;
    const lonDisplay = document.getElementById(
        "avatar-lon",
    ) as HTMLSpanElement | null;
    const speedDisplay = document.getElementById(
        "speed-value",
    ) as HTMLSpanElement | null;
    const speedSlider = document.getElementById(
        "speed-slider",
    ) as HTMLInputElement | null;
    const flyToBtn = document.getElementById(
        "fly-to-avatar",
    ) as HTMLButtonElement | null;
    const autoScrollCheckbox = document.getElementById(
        "auto-scroll-toggle",
    ) as HTMLInputElement | null;

    const updateDisplay = (): void => {
        if (latDisplay) latDisplay.textContent = avatarLat.toFixed(6);
        if (lonDisplay) lonDisplay.textContent = avatarLon.toFixed(6);
        if (speedDisplay) speedDisplay.textContent = `${speedMps}`;
    };
    updateDisplay();

    if (speedSlider) {
        speedSlider.value = String(speedMps);
        speedSlider.addEventListener("input", () => {
            speedMps = Number(speedSlider.value);
            updateDisplay();
        });
    }

    if (flyToBtn) {
        flyToBtn.addEventListener("click", () => {
            viewer.lat = avatarLat;
            viewer.lon = avatarLon;
        });
    }

    if (autoScrollCheckbox) {
        autoScrollCheckbox.checked = autoScrollEnabled;
        autoScrollCheckbox.addEventListener("change", () => {
            autoScrollEnabled = autoScrollCheckbox.checked;
            // OFF にしたとき detach 済みなら通常のタイル監視を再開する
            if (!autoScrollEnabled && tileCameraDetached) {
                viewer.attachTileCamera();
                tileCameraDetached = false;
            }
        });
    }

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

        avatarLat = event.lat;
        avatarLon = event.lon;
        lastTimestamp = null;
        updateDisplay();
        viewer.updateModel(MODEL_ID, {
            lat: avatarLat,
            lon: avatarLon,
            altitudeMode: "terrain",
            altitude: 0,
            gravity: true,
        });
    });

    const readInputs = (): MoveVector => {
        const kb = keyboardVector(pressedKeys);
        // Babylon の左スティック Y は下方向で正なので反転して北=+1 に揃える
        const gp: MoveVector = { vx: gamepadStick.x, vy: -gamepadStick.y };
        const js: MoveVector = joystick.pressed
            ? { vx: joystick.value.vx, vy: joystick.value.vy }
            : { vx: 0, vy: 0 };
        // 画面（カメラ）方位に合わせて回転: 入力の "up" = カメラ前方
        const screen = combineInputs([kb, gp, js]);
        return rotateByAzimuth(screen, viewer.azimuth);
    };

    let rafId = 0;
    const tick = (timestamp: number): void => {
        const handle = viewer.getModel(MODEL_ID);
        // モデルが既に破棄されている（ページ遷移途中など）場合は RAF を再スケジュール
        // しないことで自然にループを終了させる。`addModel` の直後から `tick` を起動
        // しているため、通常運用ではここに入るのは破棄後のフレームのみ。
        if (!handle) return;

        if (handle.loaded && !animationStarted) {
            animationStarted = true;
        }

        if (lastTimestamp === null) lastTimestamp = timestamp;
        // タブが非アクティブから復帰した直後など dtSec が大きくなった場合に、
        // 一気に巨大な距離を進めて地形外まで飛び出すのを防ぐため上限クランプ。
        // boids デモ (src/demos/boids/index.ts) と同じ 0.1s を採用。
        const dtSec = Math.min((timestamp - lastTimestamp) / 1000, 0.1);
        lastTimestamp = timestamp;

        const input = readInputs();
        const mag = moveVectorMagnitude(input);
        const isMoving = mag > MOVING_THRESHOLD;

        if (isMoving) {
            const next = stepPosition(avatarLat, avatarLon, input, speedMps, dtSec);
            avatarLat = next.lat;
            avatarLon = next.lon;
            const heading = movementHeading(input);
            if (heading !== null) lastHeadingDeg = heading;
            viewer.updateModel(MODEL_ID, {
                lat: avatarLat,
                lon: avatarLon,
                altitudeMode: "terrain",
                altitude: 0,
                rotation: { y: lastHeadingDeg },
                gravity: true,
            });
            updateDisplay();

            // 自動スクロール: アバターが画面端に近づいたらカメラを追従
            // (Flight Follow モードと同じ二段構成: 滑らかな target 移動 + 距離スロットルされたタイル refresh)
            if (autoScrollEnabled && arcCamera) {
                const cameraLatNow = viewer.lat;
                const cameraLonNow = viewer.lon;
                // 2D (ortho) モードでは altitude/tilt から可視範囲を推定できないため、
                // ortho サイズを extent として渡す。
                // 短辺側を使うことでアスペクト比に関わらず画面外に出ないことを保証する。
                const is2D = viewer.viewMode === "2d";
                const viewExtentOverride = is2D
                    ? Math.min(
                          arcCamera.orthoTop ?? 0,
                          arcCamera.orthoRight ?? 0,
                      ) || undefined
                    : undefined;
                const scroll = computeAutoScroll({
                    avatarLat,
                    avatarLon,
                    cameraLat: cameraLatNow,
                    cameraLon: cameraLonNow,
                    cameraAltitude: viewer.altitude,
                    cameraTilt: viewer.tilt,
                    deadzoneRatio: DEFAULT_DEADZONE_RATIO,
                    scrollLerp: DEFAULT_SCROLL_LERP,
                    viewExtentOverride,
                });
                if (scroll.scrolled) {
                    // 初回スクロール時に detach する（初期表示の境界タイル欠けを防ぐ）
                    if (!tileCameraDetached) {
                        viewer.detachTileCamera();
                        tileCameraDetached = true;
                    }
                    // (1) camera.target を直接動かして滑らかに追従 (setter は呼ばない)
                    const dLat = scroll.lat - cameraLatNow;
                    const dLon = scroll.lon - cameraLonNow;
                    const metersPerDegLon =
                        METERS_PER_DEGREE_LAT *
                        Math.cos((cameraLatNow * Math.PI) / 180);
                    arcCamera.target.x += dLon * metersPerDegLon;
                    arcCamera.target.z += dLat * METERS_PER_DEGREE_LAT;

                    // (2) 距離スロットル + in-flight ガード付きでタイル refresh
                    const refLatNow = viewer.lat;
                    const refLonNow = viewer.lon;
                    const movedLat =
                        (refLatNow - lastRefreshLat) * METERS_PER_DEGREE_LAT;
                    const movedLon =
                        (refLonNow - lastRefreshLon) *
                        METERS_PER_DEGREE_LAT *
                        Math.cos((refLatNow * Math.PI) / 180);
                    const movedM = Math.hypot(movedLat, movedLon);
                    if (movedM >= SCROLL_REFRESH_DISTANCE_M) {
                        triggerTileRefresh(timestamp);
                    }
                }
            }
        }

        // カメラのチルト・パン（横回転）・ズーム・ユーザー操作に追従するタイル refresh。
        // detach 後は内部 observer が無効なので、自前で変化を監視して発火する。
        if (tileCameraDetached && arcCamera) {
            const rotDelta = Math.abs(
                ((viewer.azimuth - lastRefreshAzimuth + 540) % 360) - 180,
            );
            const tiltDelta = Math.abs(viewer.tilt - lastRefreshTilt);
            const altRatio =
                lastRefreshAltitude > 0
                    ? Math.abs(viewer.altitude - lastRefreshAltitude) /
                      lastRefreshAltitude
                    : 0;
            // パン操作（lat/lon 変化）の検出
            const refLatNow2 = viewer.lat;
            const refLonNow2 = viewer.lon;
            const panM = Math.sqrt(
                ((refLatNow2 - lastRefreshLat) * METERS_PER_DEGREE_LAT) ** 2 +
                    ((refLonNow2 - lastRefreshLon) *
                        METERS_PER_DEGREE_LAT *
                        Math.cos((refLatNow2 * Math.PI) / 180)) **
                        2,
            );
            if (
                rotDelta >= CAMERA_ROT_REFRESH_DEG ||
                tiltDelta >= CAMERA_TILT_REFRESH_DEG ||
                altRatio >= CAMERA_ALT_REFRESH_RATIO ||
                panM >= SCROLL_REFRESH_DISTANCE_M
            ) {
                triggerTileRefresh(timestamp);
            }
        }

        if (animationStarted) {
            if (isMoving && !walking) {
                viewer.playModelAnimation(MODEL_ID, WALK_ANIM);
                walking = true;
            } else if (!isMoving && walking) {
                viewer.stopModelAnimation(MODEL_ID, WALK_ANIM);
                walking = false;
            }
        }

        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    window.addEventListener("beforeunload", () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
        gamepadManager.dispose();
        joystick.dispose();
    });
};

start().catch((err) => {
    console.error("[avatar-controller-demo] Failed to start:", err);
});
