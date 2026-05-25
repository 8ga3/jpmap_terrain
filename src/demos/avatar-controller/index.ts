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
import { VirtualJoystick } from "@babylonjs/core/Misc/virtualJoystick";
import {
    combineInputs,
    keyboardVector,
    moveVectorMagnitude,
    movementHeading,
    stepPosition,
    type MoveVector,
} from "./movement";
import humanWalkGlbUrl from "../../../assets/human_walk.glb";

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
        pressedKeys.add(e.key);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        pressedKeys.delete(e.code);
        pressedKeys.delete(e.key);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

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

    // --- 入力: Virtual Joystick（タッチデバイスのみ表示） ---
    const hasTouch =
        typeof window !== "undefined" &&
        ("ontouchstart" in window ||
            (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0));
    let joystick: VirtualJoystick | null = null;
    if (hasTouch) {
        joystick = new VirtualJoystick(true, {
            color: "#4af",
            limitToContainer: true,
            alwaysVisible: true,
        });
    }

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
        const js: MoveVector = joystick
            ? {
                  vx: joystick.deltaPosition.x,
                  vy: joystick.deltaPosition.y,
              }
            : { vx: 0, vy: 0 };
        return combineInputs([kb, gp, js]);
    };

    let rafId = 0;
    const tick = (timestamp: number): void => {
        const handle = viewer.getModel(MODEL_ID);
        if (!handle) return;

        if (handle.loaded && !animationStarted) {
            animationStarted = true;
        }

        if (lastTimestamp === null) lastTimestamp = timestamp;
        const dtSec = (timestamp - lastTimestamp) / 1000;
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
        gamepadManager.dispose();
        joystick?.releaseCanvas();
    });
};

start().catch((err) => {
    console.error("[avatar-controller-demo] Failed to start:", err);
});
