/**
 * アバターアニメーション #02 — Game Controller 対応
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
 *   自動スクロール追従はカメラ中心（viewer.lat/lon）駆動で行う
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, TerrainClickEvent } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import { GamepadManager } from "@babylonjs/core/Gamepads/gamepadManager";
import type { GenericPad } from "@babylonjs/core/Gamepads/gamepad";
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
import { computeCameraControl } from "./cameraControl";
import {
    DEFAULT_GRAVITY,
    DEFAULT_JUMP_HEIGHT,
    isJumping,
    JUMP_IDLE,
    startJump,
    tickJump,
    type JumpState,
} from "./jump";
import humanWalkGlbUrl from "../../../assets/human_walk.glb";

const METERS_PER_DEGREE_LAT = 111320;

const DEMO_MOUNT_ID = "root";
const MODEL_ID = "avatar";

/** 東京駅 */
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };

/** モデルの表示スケール */
const MODEL_SCALE = 50;
/** デフォルト歩行速度 (m/s) */
const DEFAULT_SPEED_MPS = 30;
/** クリック可能距離 (m) */
const MAX_CLICK_DISTANCE_M = 5000;
/** 移動を「歩行中」とみなす入力強度の閾値 */
const MOVING_THRESHOLD = 0.05;

/**
 * 自動スクロールの実スクリーン射影に用いる垂直 FOV (rad)。
 * globe の GeospatialCamera は fov を明示設定せず Babylon 既定値 0.8 rad を使うためこれに合わせる。
 */
const CAMERA_FOV_Y_RAD = 0.8;

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
        // globe は組み込みの WASD キーボードパンを持つ。本デモは WASD をアバター操作に
        // 使い、カメラは自動スクロールでアバターを追従させるため、WASD パンのみ
        // 無効化して二重スクロール（カメラ競合）を防ぐ。ドラッグパンは手動での視点移動用に
        // 有効のまま残す。
        enableKeyboardPan: false,
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
    let cameraReverseX = false;
    let jumpState: JumpState = JUMP_IDLE;
    let jumpHeight = DEFAULT_JUMP_HEIGHT;
    let jumpGravity = DEFAULT_GRAVITY;
    /** ジャンプボタンが押された（次フレームで発動） */
    let jumpRequested = false;

    /**
     * 自動スクロール — カメラ中心（viewer.lat/lon）を直接動かす方式。
     * globe ではタイルは camera.center 駆動で自動ストリーミングされる。
     */

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
        // Space はエッジトリガー（押した瞬間のみ）：着地後の即再ジャンプを防ぐ
        if (e.code === "Space" && !e.repeat) jumpRequested = true;
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
    const gamepadRightStick = { x: 0, y: 0 };
    let gamepadJumpPressed = false;
    gamepadManager.onGamepadConnectedObservable.add((gp) => {
        gp.onleftstickchanged((values) => {
            gamepadStick.x = values.x;
            gamepadStick.y = values.y;
        });
        gp.onrightstickchanged((values) => {
            gamepadRightStick.x = values.x;
            gamepadRightStick.y = values.y;
        });
        (gp as GenericPad).onbuttondown((index: number) => {
            // A ボタン (Xbox: index 0) でジャンプ
            if (index === 0) gamepadJumpPressed = true;
        });
    });
    gamepadManager.onGamepadDisconnectedObservable.add(() => {
        gamepadStick.x = 0;
        gamepadStick.y = 0;
        gamepadRightStick.x = 0;
        gamepadRightStick.y = 0;
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
    const jumpBtn = document.getElementById(
        "jump-btn",
    ) as HTMLButtonElement | null;
    const jumpHeightSlider = document.getElementById(
        "jump-height-slider",
    ) as HTMLInputElement | null;
    const jumpHeightDisplay = document.getElementById(
        "jump-height-value",
    ) as HTMLSpanElement | null;
    const jumpGravitySlider = document.getElementById(
        "jump-gravity-slider",
    ) as HTMLInputElement | null;
    const jumpGravityDisplay = document.getElementById(
        "jump-gravity-value",
    ) as HTMLSpanElement | null;

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
        });
    }

    const cameraReverseCheckbox = document.getElementById(
        "camera-reverse-toggle",
    ) as HTMLInputElement | null;
    if (cameraReverseCheckbox) {
        cameraReverseCheckbox.checked = cameraReverseX;
        cameraReverseCheckbox.addEventListener("change", () => {
            cameraReverseX = cameraReverseCheckbox.checked;
        });
    }

    if (jumpBtn) {
        jumpBtn.addEventListener("pointerdown", () => {
            jumpRequested = true;
        });
    }

    if (jumpHeightSlider) {
        jumpHeightSlider.value = String(jumpHeight);
        if (jumpHeightDisplay) jumpHeightDisplay.textContent = `${jumpHeight}`;
        jumpHeightSlider.addEventListener("input", () => {
            jumpHeight = Number(jumpHeightSlider.value);
            if (jumpHeightDisplay) jumpHeightDisplay.textContent = `${jumpHeight}`;
        });
    }

    if (jumpGravitySlider) {
        jumpGravitySlider.value = String(jumpGravity);
        if (jumpGravityDisplay) jumpGravityDisplay.textContent = `${jumpGravity.toFixed(1)}`;
        jumpGravitySlider.addEventListener("input", () => {
            jumpGravity = Number(jumpGravitySlider.value);
            if (jumpGravityDisplay) jumpGravityDisplay.textContent = `${jumpGravity.toFixed(1)}`;
        });
    }

    // パネル操作後にキーボードフォーカスを canvas に戻す
    const controlsPanel = document.getElementById("avatar-controls");
    const canvas = mount.querySelector("canvas");
    if (controlsPanel && canvas) {
        canvas.tabIndex = 0;
        const refocus = (): void => { canvas.focus(); };
        controlsPanel.addEventListener("pointerup", refocus);
        controlsPanel.addEventListener("change", refocus);
    }

    viewer.onTerrainClick((event: TerrainClickEvent) => {
        const cameraLat = viewer.lat;
        const cameraLon = viewer.lon;
        const dLat = (event.lat - cameraLat) * METERS_PER_DEGREE_LAT;
        const dLon =
            (event.lon - cameraLon) *
            METERS_PER_DEGREE_LAT *
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
        // 画面（カメラ）方位に合わせて回転: 入力の "up" = カメラ前方。
        // `rotateByAzimuth` は planar（ArcRotateCamera alpha 由来, 北=0°・反時計回り正）の
        // 方位規約に合わせてある。globe の azimuth は標準（北=0°・時計回り正）で handedness が
        // 逆のため、符号を反転して入力をカメラ前方へ正しく揃える。
        const screen = combineInputs([kb, gp, js]);
        const headingAzimuth = -viewer.azimuth;
        return rotateByAzimuth(screen, headingAzimuth);
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

        // --- ジャンプ開始判定 ---
        const jumpTrigger = jumpRequested || gamepadJumpPressed;
        jumpRequested = false;
        gamepadJumpPressed = false;
        if (jumpTrigger && !isJumping(jumpState)) {
            jumpState = startJump(jumpHeight, jumpGravity, input);
            // ジャンプ中は歩行アニメを停止
            if (walking) {
                viewer.stopModelAnimation(MODEL_ID, WALK_ANIM);
                walking = false;
            }
        }

        // --- ジャンプ中のフレーム更新 ---
        if (isJumping(jumpState)) {
            jumpState = tickJump(jumpState, jumpGravity, dtSec);
            // ジャンプ中はロックされた方向で水平移動
            const jumpDir = jumpState.active ? jumpState.lockedDirection : JUMP_IDLE.lockedDirection;
            const jumpMag = moveVectorMagnitude(jumpDir);
            if (jumpMag > MOVING_THRESHOLD) {
                const next = stepPosition(avatarLat, avatarLon, jumpDir, speedMps, dtSec);
                avatarLat = next.lat;
                avatarLon = next.lon;
                const heading = movementHeading(jumpDir);
                if (heading !== null) lastHeadingDeg = heading;
            }
            viewer.updateModel(MODEL_ID, {
                lat: avatarLat,
                lon: avatarLon,
                altitudeMode: "terrain",
                altitude: jumpState.altitude,
                rotation: { y: lastHeadingDeg },
                gravity: true,
            });
            updateDisplay();
        } else {
            // --- 通常移動 ---
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
        }

        // --- 右スティックによるカメラ制御 ---
        const rightStickInput = {
            vx: cameraReverseX ? -gamepadRightStick.x : gamepadRightStick.x,
            // Babylon のスティック Y は下方向正なので反転して前=+1 に揃える
            vy: -gamepadRightStick.y,
        };
        const camDelta = computeCameraControl(
            rightStickInput,
            dtSec,
            viewer.viewMode === "2d",
            viewer.tilt,
        );
        if (camDelta.deltaAzimuth !== 0 || camDelta.deltaTilt !== 0) {
            // detach/通常 共通で viewer setter を使い内部状態を一貫させる
            if (camDelta.deltaAzimuth !== 0) {
                viewer.azimuth = viewer.azimuth + camDelta.deltaAzimuth;
            }
            if (camDelta.deltaTilt !== 0) {
                viewer.tilt = viewer.tilt + camDelta.deltaTilt;
            }
        }

        // --- 自動スクロール ---
        // ジャンプ中・通常移動どちらでも水平位置が変わるのでスクロール判定する
        const isMovingForScroll = isJumping(jumpState)
            ? moveVectorMagnitude(jumpState.lockedDirection) > MOVING_THRESHOLD
            : mag > MOVING_THRESHOLD;
        if (isMovingForScroll && autoScrollEnabled) {
            const cameraLatNow = viewer.lat;
            const cameraLonNow = viewer.lon;
            // 実スクリーン射影で判定するため、カメラ中心とアバター直下の地形標高・アスペクト比を渡す。
            // 勾配地形でアバターが画面外に出るのを防ぐ。標高が未解決(null)なら 0 とみなす。
            const camGroundElevation =
                viewer.terrainElevAt(cameraLatNow, cameraLonNow) ?? 0;
            const avatarGroundElevation =
                viewer.terrainElevAt(avatarLat, avatarLon) ?? 0;
            const viewW = mount.clientWidth;
            const viewH = mount.clientHeight;
            const aspect = viewH > 0 ? viewW / viewH : 1;
            const scroll = computeAutoScroll({
                avatarLat,
                avatarLon,
                cameraLat: cameraLatNow,
                cameraLon: cameraLonNow,
                cameraAltitude: viewer.altitude,
                cameraTilt: viewer.tilt,
                deadzoneRatio: DEFAULT_DEADZONE_RATIO,
                scrollLerp: DEFAULT_SCROLL_LERP,
                projection: {
                    cameraAzimuth: viewer.azimuth,
                    fovYRad: CAMERA_FOV_Y_RAD,
                    aspect,
                    avatarGroundElevation,
                    cameraGroundElevation: camGroundElevation,
                },
            });
            if (scroll.scrolled) {
                // globe: カメラ中心を直接動かす。タイルは camera.center 駆動で
                // 自動ストリーミングされるため external frustum refresh は不要。
                viewer.lat = scroll.lat;
                viewer.lon = scroll.lon;
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
