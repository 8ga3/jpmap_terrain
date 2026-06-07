/**
 * グローブ地形デモエントリ (Issue #275 Phase 2)。
 *
 * 平面ワールドの各デモと併存する **並行スタック**。`scenes/globe.ts`（`GeospatialCamera` +
 * ECEF 楕円体 + floating origin）の地形エンジンを `/geospatial` で起動し、旧（平面）と
 * 新（グローブ）を一時併存させて実機比較できるようにする。
 *
 * URL（既存共有形式と後方互換, Issue #275 Phase 2 / #64 / #254）:
 * - パス/ハッシュ `@lat,lon,altitude,azimuth,tilt`（3D 共有形式。altitude ⇄ radius）
 * - パス/ハッシュ `@lat,lon,Xz`（2D 互換ズームレベル形式。zoomLevel → radius へ換算して受理）
 * - `?engine=webgpu|webgl|webgl2`（既定: 自動。webgl/webgl2 は webgl2 に正規化）
 * - `?lat=&lon=&zoom=&radius=&azimuth=&tilt=`（`@` パスが無い場合のフォールバック）
 * - `?map=photo`（航空写真。既定: 標準地図）
 * - `?snap=off`（クロスレベル標高スナップを無効化。比較用）
 */
import type { Scene } from "@babylonjs/core/scene";
import type { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import { clamp, type MapType } from "../../terrain/gsiTile";
import { yawPitchToUi } from "../../terrain/geo/cameraMapping";
import {
    parseCameraStateFromUrl,
    createUrlUpdater,
    zoomLevelToRadius,
} from "../../terrain/urlState";
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
    // 既存共有形式 `@lat,lon,...` がパス/ハッシュにあれば最優先で復元（後方互換）。
    // なければ `?lat=&lon=&radius=&azimuth=&tilt=` のクエリにフォールバックする。
    const hasAtPath = location.pathname.includes("/@") || location.hash.includes("@");
    const atState = hasAtPath ? parseCameraStateFromUrl(location.href) : null;
    const lat = atState?.lat ?? resolveNumber(search, "lat", GLOBE_SCENE_DEFAULTS.lat);
    const lon = atState?.lon ?? resolveNumber(search, "lon", GLOBE_SCENE_DEFAULTS.lon);
    // URL 由来の minZoom は安全な範囲 [0, maxZoom] にクランプする
    // （負値・極端値だと toTileXY / 1<<zoom が壊れ、タイル選択が空になる）。
    const minZoom = clamp(
        Math.round(resolveNumber(search, "zoom", GLOBE_SCENE_DEFAULTS.minZoom)),
        0,
        GLOBE_SCENE_DEFAULTS.maxZoom,
    );
    // altitude ⇄ radius は PoC で確認した等価関係。`@lat,lon,Xz`（zoomLevel）はカメラ生成後に
    // canvasHeight/fov を使って radius へ換算する（zoomLevelToRadius）。
    const radius =
        atState?.zoomLevel !== undefined
            ? GLOBE_SCENE_DEFAULTS.radius // zoomLevel はカメラ生成後に再設定（後段）
            : (atState?.altitude ?? resolveNumber(search, "radius", GLOBE_SCENE_DEFAULTS.radius));
    const azimuth = atState?.azimuth ?? resolveNumber(search, "azimuth", GLOBE_SCENE_DEFAULTS.azimuth);
    const tilt = atState?.tilt ?? resolveNumber(search, "tilt", GLOBE_SCENE_DEFAULTS.tilt);
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
    // カメラ状態を共有 URL（`@lat,lon,altitude,azimuth,tilt`）へ反映するデバウンス更新器。
    // 既存デモ（viewer/timelapse）と同じ createUrlUpdater を使い、`/geospatial/@...` 形式で
    // 出力する（vite.rewrites に geospatial 登録済みのためリロードでも復元できる）。
    const urlUpdater = createUrlUpdater(1000);
    // onSyncStats は毎 sync（数百 ms 間隔）で呼ばれるため、毎回 urlUpdater を呼ぶとデバウンスが
    // 確定しない（タイマーが常にリセットされる）。カメラ状態が変化した時のみ更新を投げる。
    let lastUrlState: { lat: number; lon: number; radius: number; yaw: number; pitch: number } | null = null;
    const urlStateChanged = (
        latDeg: number, lonDeg: number, radius: number, yaw: number, pitch: number,
    ): boolean => {
        const p = lastUrlState;
        if (
            p === null ||
            Math.abs(latDeg - p.lat) > 1e-5 ||
            Math.abs(lonDeg - p.lon) > 1e-5 ||
            Math.abs(radius - p.radius) > 1 ||
            Math.abs(yaw - p.yaw) > 1e-4 ||
            Math.abs(pitch - p.pitch) > 1e-4
        ) {
            lastUrlState = { lat: latDeg, lon: lonDeg, radius, yaw, pitch };
            return true;
        }
        return false;
    };
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
            // yaw/pitch[rad] → azimuth/tilt[deg]（azimuth は [0,360) 正規化）。
            const { azimuthDeg, tiltDeg } = yawPitchToUi(s.yaw, s.pitch);
            // 共有 URL を更新（altitude ⇄ radius 等価。3D 形式 `@lat,lon,altitude,azimuth,tilt`）。
            // 状態が動いた時のみ投げ、停止後にデバウンスが確定するようにする。
            if (urlStateChanged(s.latDeg, s.lonDeg, s.radius, s.yaw, s.pitch)) {
                urlUpdater({
                    lat: s.latDeg,
                    lon: s.lonDeg,
                    altitude: s.radius,
                    azimuth: azimuthDeg,
                    tilt: tiltDeg,
                });
            }
            updateInfo(
                `Geospatial Globe (#275 Phase 2)\n` +
                    `左ドラッグ=パン / 右ドラッグ=回転 / ホイール=ズーム / WASD=パン\n` +
                    `engine: ${engine.constructor.name} / floatingOrigin: ${floatingOrigin}\n` +
                    `fps: ${engine.getFps().toFixed(0)}\n` +
                    `lat,lon: ${s.latDeg.toFixed(4)}, ${s.lonDeg.toFixed(4)}\n` +
                    `azimuth: ${azimuthDeg.toFixed(1)}° / ` +
                    `tilt: ${tiltDeg.toFixed(1)}° / radius: ${Math.round(s.radius)}m\n` +
                    `LOD zoom: ${zoomLabel} / selected: ${s.selected.length} / ` +
                    `loaded: ${s.loadedCount} / loading: ${s.loadingCount}`,
            );
        },
    });
    infoScene = controller.scene;

    // `@lat,lon,Xz`（2D 互換ズームレベル）指定時は、実 canvas 高さとカメラ fov を使って
    // radius へ換算しカメラへ反映する（生成後でないと fov / clientHeight が確定しないため後段）。
    if (atState?.zoomLevel !== undefined) {
        controller.camera.radius = zoomLevelToRadius(
            atState.zoomLevel,
            Math.max(1, canvas.clientHeight),
            lat,
            controller.camera.fov,
        );
    }

    // render ループはシーン生成側ではなく呼び出し側（本デモ）で開始する
    // （GlobeScene は責務分離のためループを開始しない）。
    engine.runRenderLoop(() => controller.scene.render());

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
        updateInfo(`Geospatial Globe (#275 Phase 2)\n起動に失敗しました: ${String(err)}`);
    });
}
