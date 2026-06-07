/**
 * グローブ地形デモエントリ (Issue #275 Phase 1)。
 *
 * 平面ワールドの各デモと併存する **並行スタック**。`scenes/globe.ts`（`GeospatialCamera` +
 * ECEF 楕円体 + floating origin）の地形エンジンを `/geospatial` で起動し、旧（平面）と
 * 新（グローブ）を一時併存させて実機比較できるようにする。
 *
 * URL クエリ:
 * - `?engine=webgpu|webgl|webgl2`（既定: 自動。webgl/webgl2 は webgl2 に正規化）
 * - `?lat=&lon=&zoom=&radius=&azimuth=&tilt=`（既定: 富士山周辺）
 * - `?map=photo`（航空写真。既定: 標準地図）
 * - `?snap=off`（クロスレベル標高スナップを無効化。比較用）
 */
import type { Scene } from "@babylonjs/core/scene";
import type { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import { clamp, type MapType } from "../../terrain/gsiTile";
import { RAD2DEG } from "../../terrain/geo/ecef";
import {
    GlobeScene,
    GLOBE_SCENE_DEFAULTS,
    type GlobeSceneSyncInfo,
} from "../../scenes/globe";

const DEMO_MOUNT_ID = "root";

/** `?engine=` を解決する（viewer デモと同じ正規化）。 */
const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/** `?key=` を数値として解決する（未指定 / NaN は fallback）。 */
const resolveNumber = (search: string, key: string, fallback: number): number => {
    const raw = new URLSearchParams(search).get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
};

const updateInfo = (text: string): void => {
    const el = document.getElementById("globe-info");
    if (el) el.textContent = text;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);

    const search = location.search;
    const params = new URLSearchParams(search);
    const lat = resolveNumber(search, "lat", GLOBE_SCENE_DEFAULTS.lat);
    const lon = resolveNumber(search, "lon", GLOBE_SCENE_DEFAULTS.lon);
    // URL 由来の minZoom は安全な範囲 [0, maxZoom] にクランプする
    // （負値・極端値だと toTileXY / 1<<zoom が壊れ、タイル選択が空になる）。
    const minZoom = clamp(
        Math.round(resolveNumber(search, "zoom", GLOBE_SCENE_DEFAULTS.minZoom)),
        0,
        GLOBE_SCENE_DEFAULTS.maxZoom,
    );
    const radius = resolveNumber(search, "radius", GLOBE_SCENE_DEFAULTS.radius);
    const azimuth = resolveNumber(search, "azimuth", GLOBE_SCENE_DEFAULTS.azimuth);
    const tilt = resolveNumber(search, "tilt", GLOBE_SCENE_DEFAULTS.tilt);
    const mapType: MapType = params.get("map") === "photo" ? "photo" : "std";
    const snapEnabled = params.get("snap") !== "off";

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.tabIndex = 0;
    canvas.style.outline = "none";
    canvas.addEventListener("pointerdown", () => canvas.focus());
    mount.appendChild(canvas);
    canvas.focus();

    const engine = await createBabylonEngine(canvas, resolveEngine(search) ?? "webgpu");

    const sceneFactory = new GlobeScene();
    // onSyncStats はレンダーループ（createSceneWithController return 後）でのみ呼ばれるが、
    // controller への依存を避け floatingOriginMode は確定後の scene 参照から読む。
    let infoScene: Scene | undefined;
    const controller = sceneFactory.createSceneWithController(engine, canvas, {
        lat,
        lon,
        minZoom,
        radius,
        azimuth,
        tilt,
        mapType,
        snapEnabled,
        onSyncStats: (s: GlobeSceneSyncInfo) => {
            const zoomLabel =
                s.minZoom !== null && s.maxZoom !== null ? `${s.minZoom}–${s.maxZoom}` : "-";
            const floatingOrigin = infoScene?.floatingOriginMode ?? "-";
            // azimuth は 0–360 に正規化（JS の % は負値を返すため）。radius は注視点(center)
            // からのカメラ距離で、鉛直高度(altitude)とは一致しないためラベルは radius とする。
            const azimuthDeg = (((s.yaw * RAD2DEG) % 360) + 360) % 360;
            updateInfo(
                `Geospatial Globe (#275 Phase 1)\n` +
                    `右ドラッグ=回転 / ホイール=ズーム\n` +
                    `engine: ${engine.constructor.name} / floatingOrigin: ${floatingOrigin}\n` +
                    `fps: ${engine.getFps().toFixed(0)}\n` +
                    `lat,lon: ${s.latDeg.toFixed(4)}, ${s.lonDeg.toFixed(4)}\n` +
                    `azimuth: ${azimuthDeg.toFixed(1)}° / ` +
                    `tilt: ${(s.pitch * RAD2DEG).toFixed(1)}° / radius: ${Math.round(s.radius)}m\n` +
                    `LOD zoom: ${zoomLabel} / selected: ${s.selected.length} / ` +
                    `loaded: ${s.loadedCount} / loading: ${s.loadingCount}`,
            );
        },
    });
    infoScene = controller.scene;

    window.addEventListener("resize", () => engine.resize());

    // デバッグ用に内部状態を露出（公開 API ではない）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { scene: Scene }).scene = controller.scene;
        (window as unknown as { camera: GeospatialCamera }).camera = controller.camera;
    }
};

if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[geospatial] failed to start:", err);
        updateInfo(`Geospatial Globe (#275 Phase 1)\n起動に失敗しました: ${String(err)}`);
    });
}
