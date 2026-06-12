/**
 * アバターアニメーション #01 (Issue #250)
 *
 * `JpmapTerrain` の Model 公開 API と `playModelAnimation` を使って
 * 3D モデルが地形に沿って円軌道を移動するデモ。
 *
 * 仕様:
 * - 東京駅に `assets/human_walk.glb` を初期配置
 * - 地面クリックでクリック地点を中心とする円軌道の中心を移動
 * - 歩行アニメーションを再生しながら毎フレーム円周上を移動
 * - 進行方向に向きを自動回転
 * - 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
 * - 半径・速度のスライダー操作
 * - アニメーション開始/停止トグル
 * - 地形バックエンド: `?terrainEngine=globe|planar`（既定 planar, #275 Phase 4 / P4-2）
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, TerrainClickEvent } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
    resolveTerrainEngine,
} from "../../terrain/urlState";
import { circularOrbitPosition, circularOrbitHeading } from "./orbit";
import humanWalkGlbUrl from "../../../assets/human_walk.glb";

const DEMO_MOUNT_ID = "root";
const MODEL_ID = "avatar";

/** 東京駅 */
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };

/** モデルの表示スケール */
const MODEL_SCALE = 50;
/** 円軌道の初期半径 (m) */
const DEFAULT_RADIUS_M = 200;
/** 角速度 (度/秒)。初期値 */
const DEFAULT_SPEED_DEG_PER_SEC = 20;
/** クリック可能距離 (m) */
const MAX_CLICK_DISTANCE_M = 5000;

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
    const terrainEngine = resolveTerrainEngine(location.search);

    const opts: JpmapTerrainOptions = {
        engine: resolveEngine(location.search),
        ...(terrainEngine ? { terrainEngine } : {}),
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

    // --- 状態 ---
    let centerLat = TOKYO_STATION.lat;
    let centerLon = TOKYO_STATION.lon;
    let radiusM = DEFAULT_RADIUS_M;
    let speedDegPerSec = DEFAULT_SPEED_DEG_PER_SEC;
    let angleDeg = 0;
    let animating = true;
    let lastTimestamp: number | null = null;

    // 初期配置: 円周上 0° の位置
    const initPos = circularOrbitPosition(
        centerLat,
        centerLon,
        radiusM,
        angleDeg,
    );
    viewer.addModel(MODEL_ID, {
        url: humanWalkGlbUrl,
        lat: initPos.lat,
        lon: initPos.lon,
        altitudeMode: "terrain",
        altitude: 0,
        rotation: { y: circularOrbitHeading(angleDeg) },
        scaling: { x: MODEL_SCALE, y: MODEL_SCALE, z: MODEL_SCALE },
        gravity: true,
    });

    // human_walk.glb に含まれる唯一の歩行アニメーション名
    const WALK_ANIM = "rig-action";

    // モデルロード完了フラグ（tick ループ内でアニメーション開始を制御）
    let animationStarted = false;

    // --- UI 要素の取得 ---
    const centerLatDisplay = document.getElementById("center-lat") as HTMLSpanElement | null;
    const centerLonDisplay = document.getElementById("center-lon") as HTMLSpanElement | null;
    const radiusDisplay = document.getElementById("radius-value") as HTMLSpanElement | null;
    const radiusSlider = document.getElementById("radius-slider") as HTMLInputElement | null;
    const speedDisplay = document.getElementById("speed-value") as HTMLSpanElement | null;
    const speedSlider = document.getElementById("speed-slider") as HTMLInputElement | null;
    const toggleBtn = document.getElementById("toggle-animation") as HTMLButtonElement | null;
    const flyToBtn = document.getElementById("fly-to-center") as HTMLButtonElement | null;

    const updateDisplay = (): void => {
        if (centerLatDisplay) centerLatDisplay.textContent = centerLat.toFixed(6);
        if (centerLonDisplay) centerLonDisplay.textContent = centerLon.toFixed(6);
        if (radiusDisplay) radiusDisplay.textContent = `${radiusM}`;
        if (speedDisplay) speedDisplay.textContent = `${speedDegPerSec}`;
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
        speedSlider.value = String(speedDegPerSec);
        speedSlider.addEventListener("input", () => {
            speedDegPerSec = Number(speedSlider.value);
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
                // animationStarted が true なら即時再生。まだ未ロードならtickで開始される。
                if (animationStarted) {
                    viewer.playModelAnimation(MODEL_ID, WALK_ANIM);
                }
            } else {
                viewer.stopModelAnimation(MODEL_ID, WALK_ANIM);
            }
            updateToggleLabel();
        });
    }

    // 中心位置へカメラ移動
    if (flyToBtn) {
        flyToBtn.addEventListener("click", () => {
            viewer.lat = centerLat;
            viewer.lon = centerLon;
        });
    }

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
        // viewer 破棄後はループを停止
        if (!handle) return;

        // モデルロード完了後、最初のフレームでアニメーション開始
        if (handle.loaded && !animationStarted) {
            animationStarted = true;
            if (animating) {
                viewer.playModelAnimation(MODEL_ID, WALK_ANIM);
            }
        }

        if (animating) {
            if (lastTimestamp !== null) {
                const dtSec = (timestamp - lastTimestamp) / 1000;
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
                altitudeMode: "terrain",
                altitude: 0,
                rotation: { y: heading },
                gravity: true,
            });
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
    console.error("[avatar-demo] Failed to start:", err);
});
