/**
 * 3Dモデルデモ (Issue #244)
 *
 * `JpmapTerrain` の Model 公開 API（`addModel` / `updateModel` /
 * `removeModel` / `getModel` / `setModelEnabled`）を目視確認するためのデモ。
 *
 * 仕様:
 * - 東京駅に `assets/human.glb` を初期配置
 * - 地面クリックで3Dモデルを移動
 * - 方位スライダーで向き変更
 * - 緯度・経度・方位の表示
 * - モデル位置へカメラ移動ボタン
 * - クリック可能範囲はカメラから一定距離以内
 * - 地面以外は無視
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, TerrainClickEvent } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";

const DEMO_MOUNT_ID = "root";
const MODEL_ID = "human";
const MODEL_URL = "assets/human.glb";

/** 東京駅 */
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };

/** モデルの表示スケール。human.glb は約1m なので地形上で視認できるサイズに拡大 */
const MODEL_SCALE = 50;
/** クリック可能距離 (m)。カメラからこの距離以内のみクリックを受け付ける */
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

    // 開発/テスト用グローバル公開
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
    }

    // 初期配置: 東京駅に human.glb を配置
    let currentRotationY = 0;
    viewer.addModel(MODEL_ID, {
        url: MODEL_URL,
        lat: TOKYO_STATION.lat,
        lon: TOKYO_STATION.lon,
        altitudeMode: "terrain",
        altitude: 0,
        rotation: { y: currentRotationY },
        scaling: { x: MODEL_SCALE, y: MODEL_SCALE, z: MODEL_SCALE },
        gravity: true,
    });

    // --- UI 要素の取得 ---
    const latDisplay = document.getElementById("model-lat") as HTMLSpanElement;
    const lonDisplay = document.getElementById("model-lon") as HTMLSpanElement;
    const azimuthDisplay = document.getElementById("model-azimuth") as HTMLSpanElement;
    const azimuthSlider = document.getElementById("azimuth-slider") as HTMLInputElement;
    const scaleDisplay = document.getElementById("model-scale") as HTMLSpanElement;
    const scaleSlider = document.getElementById("scale-slider") as HTMLInputElement;
    const flyToBtn = document.getElementById("fly-to-model") as HTMLButtonElement;

    let modelLat = TOKYO_STATION.lat;
    let modelLon = TOKYO_STATION.lon;
    let currentScale = MODEL_SCALE;

    const updateDisplay = (): void => {
        if (latDisplay) latDisplay.textContent = modelLat.toFixed(6);
        if (lonDisplay) lonDisplay.textContent = modelLon.toFixed(6);
        if (azimuthDisplay) azimuthDisplay.textContent = `${currentRotationY}°`;
        if (scaleDisplay) scaleDisplay.textContent = String(currentScale);
    };

    updateDisplay();

    // 方位スライダー
    if (azimuthSlider) {
        azimuthSlider.value = String(currentRotationY);
        azimuthSlider.addEventListener("input", () => {
            currentRotationY = Number(azimuthSlider.value);
            viewer.updateModel(MODEL_ID, { rotation: { y: currentRotationY } });
            updateDisplay();
        });
    }

    // 拡大率スライダー
    if (scaleSlider) {
        scaleSlider.value = String(currentScale);
        scaleSlider.addEventListener("input", () => {
            currentScale = Number(scaleSlider.value);
            const s = currentScale;
            viewer.updateModel(MODEL_ID, { scaling: { x: s, y: s, z: s } });
            updateDisplay();
        });
    }

    // モデル位置へ移動ボタン
    if (flyToBtn) {
        flyToBtn.addEventListener("click", () => {
            viewer.flyTo({ lat: modelLat, lon: modelLon, duration: 1500 });
        });
    }

    // 地面クリックでモデル移動
    viewer.onTerrainClick((event: TerrainClickEvent) => {
        // カメラからの距離チェック
        const cameraLat = viewer.lat;
        const cameraLon = viewer.lon;
        const dLat = (event.lat - cameraLat) * 111320;
        const dLon = (event.lon - cameraLon) * 111320 * Math.cos((cameraLat * Math.PI) / 180);
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);
        if (dist > MAX_CLICK_DISTANCE_M) return;

        modelLat = event.lat;
        modelLon = event.lon;
        // event.altitude はメッシュ表面の実際のY座標。
        // queryElevationAtWorld は最近傍ピクセルで補間するため、
        // 急な坂では terrain モードとズレが生じる。
        // absolute + event.altitude でクリック位置に正確に配置する。
        viewer.updateModel(MODEL_ID, {
            lat: modelLat,
            lon: modelLon,
            altitudeMode: "absolute",
            altitude: event.altitude,
        });
        updateDisplay();
    });
};

start().catch((err) => {
    console.error("[model-demo] Failed to start:", err);
});
