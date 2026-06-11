/**
 * グローブシーンを `DefaultSceneController` 互換にするアダプタ (Issue #349 / #275 Phase 4 P4-0)。
 *
 * `JpmapTerrain`（公開ライブラリ）は `DefaultSceneController` インターフェース越しに
 * シーンを操作する。本アダプタは `scenes/globe.ts`（GeospatialCamera + ECEF + floating origin）の
 * `GlobeSceneController` を同インターフェースへ橋渡しし、`JpmapTerrain` が `terrainEngine` で
 * planar↔globe を切替えるだけで globe 描画へ移行できるようにする。
 *
 * 本スライス（Slice 1）はカメラ get/set/flyTo・mapType（生成時固定）・dispose を実装する。
 * overlay マネージャ・UI コントロールパネル・2D(ortho)・太陽/影・external frustum・terrain click /
 * polygon point drag は globe 側の未整備機能を伴うため後続スライスで対応し、ここでは安全な
 * no-op もしくは明確な未対応エラーとする（design: files/p4-0_design.md）。
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";

import type { MapType } from "../terrain/gsiTile";
import { geodeticToEcef, ecefToGeodetic } from "../terrain/geo/ecef";
import { uiToYawPitch, yawPitchToUi } from "../terrain/geo/cameraMapping";
import { assertLatLonInBounds } from "../terrain/overlayCoords";
import { resolveIcon, resolveText } from "../terrain/marker";
import type { MarkerManager } from "../terrain/markerManager";
import type {
    MarkerHandle,
    MarkerOptions,
    MarkerUpdate,
    MarkerIconOptions,
    MarkerTextOptions,
    MarkerLineOptions,
} from "../lib/types";
import { MARKER_DEFAULTS } from "../lib/types";
import type { GlobeMarkerManager } from "../terrain/geo/globeMarkerManager";
import type {
    DefaultSceneController,
    DefaultSceneInitOptions,
    MarkerContext,
} from "./default";
import { GlobeScene, type GlobeSceneController } from "./globe";

/** lib の MapType（"standard"/"photo"）→ globe の MapType（"std"/"photo"）。 */
const toGlobeMapType = (mapType: "standard" | "photo" | undefined): MapType =>
    mapType === "photo" ? "photo" : "std";

/** globe の MapType（"std"/"photo"）→ lib の MapType（"standard"/"photo"）。 */
const fromGlobeMapType = (mapType: MapType): "standard" | "photo" =>
    mapType === "photo" ? "photo" : "standard";

const ERROR_PREFIX = "marker";

/** 公開 `MarkerLineOptions` を既定値で埋める（`marker.ts` の非公開 `resolveLine` 相当）。 */
const resolveLine = (
    line: MarkerLineOptions | undefined,
): Required<MarkerLineOptions> => ({
    color: line?.color ?? MARKER_DEFAULTS.line.color,
    width: line?.width ?? MARKER_DEFAULTS.line.width,
    height: line?.height ?? MARKER_DEFAULTS.line.height,
});

/** アダプタが保持する 1 マーカーの解決済み状態（公開ハンドル再構築用）。 */
interface AdapterEntry {
    /** `GlobeMarkerManager.add` が採番した内部 id。 */
    globeId: string;
    lat: number;
    lon: number;
    enabled: boolean;
    icon: Required<MarkerIconOptions> | null;
    text: Required<MarkerTextOptions> | null;
    line: Required<MarkerLineOptions>;
}

/**
 * `GlobeMarkerManager`（採番 id / handle・partial-update 非対応）を公開
 * `MarkerManager`（明示 id / `MarkerHandle` 返却 / partial-update）へアダプトする
 * （#275 Phase 4 / P4-0 Slice 2a）。
 *
 * - 公開 id ↔ globe 内部 id の対応と、ハンドル再構築に必要な解決済みオプションを保持する。
 * - `GlobeMarkerManager` は in-place のプロパティ更新を持たないため、`update` は内部ノードを
 *   作り直す（remove + add）。緯度経度・アイコン・テキスト・線・表示の各変更に対応する。
 * - `elevationResolved` は globe マネージャが露出しないため、その lat/lon で地形標高が
 *   取得できるか（`terrainElevAt !== null`）で best-effort に判定する（planar の初回解決と同趣旨）。
 *
 * @internal テスト用に export する。
 */
export const createGlobeMarkerManagerAdapter = (
    globeMgr: GlobeMarkerManager,
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null,
): MarkerManager => {
    const entries = new Map<string, AdapterEntry>();
    let disposed = false;

    const assertNotDisposed = (): void => {
        if (disposed) throw new Error("MarkerManager has been disposed");
    };

    const buildHandle = (id: string, e: AdapterEntry): MarkerHandle => ({
        id,
        lat: e.lat,
        lon: e.lon,
        enabled: e.enabled,
        icon: e.icon,
        text: e.text,
        line: e.line,
        elevationResolved: terrainElevAt(e.lat, e.lon) !== null,
    });

    const requireEntry = (id: string): AdapterEntry => {
        const e = entries.get(id);
        if (!e) throw new Error(`Marker id "${id}" not found`);
        return e;
    };

    return {
        add(id: string, options: MarkerOptions): MarkerHandle {
            assertNotDisposed();
            if (entries.has(id)) {
                throw new Error(
                    `JpmapTerrain.addMarker: id "${id}" already exists`,
                );
            }
            assertLatLonInBounds(options.lat, options.lon, ERROR_PREFIX);
            const icon = resolveIcon(options.icon);
            const text = resolveText(options.text);
            // planar(createMarkerNode) と同じ契約: icon/text の少なくとも一方が必須。
            if (!icon && !text) {
                throw new Error(
                    `addMarker: at least one of icon/text is required (id="${id}")`,
                );
            }
            const line = resolveLine(options.line);
            const enabled = options.enabled ?? MARKER_DEFAULTS.enabled;
            // 解決済みオプションを渡す（icon.url の危険スキームは globe 側で検証され throw する）。
            const globeId = globeMgr.add({
                lat: options.lat,
                lon: options.lon,
                icon: icon ?? undefined,
                text: text ?? undefined,
                line,
                enabled,
            });
            const entry: AdapterEntry = {
                globeId,
                lat: options.lat,
                lon: options.lon,
                enabled,
                icon,
                text,
                line,
            };
            entries.set(id, entry);
            return buildHandle(id, entry);
        },
        get(id: string): MarkerHandle | null {
            const e = entries.get(id);
            return e ? buildHandle(id, e) : null;
        },
        update(id: string, partial: MarkerUpdate): MarkerHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            const lat = partial.lat ?? prev.lat;
            const lon = partial.lon ?? prev.lon;
            if (partial.lat !== undefined || partial.lon !== undefined) {
                assertLatLonInBounds(lat, lon, ERROR_PREFIX);
            }
            const icon =
                partial.icon !== undefined ? resolveIcon(partial.icon) : prev.icon;
            const text =
                partial.text !== undefined ? resolveText(partial.text) : prev.text;
            const line =
                partial.line !== undefined ? resolveLine(partial.line) : prev.line;
            const enabled = partial.enabled ?? prev.enabled;
            // globe マネージャは in-place 更新を持たないため作り直す。再 add（icon.url 検証等で
            // throw しうる）を先に行い、成功後に旧ノードを remove して内部状態の不整合を防ぐ
            // （add-then-remove。planar は破壊操作前に検証するため parity を取る）。
            const globeId = globeMgr.add({
                lat,
                lon,
                icon: icon ?? undefined,
                text: text ?? undefined,
                line,
                enabled,
            });
            globeMgr.remove(prev.globeId);
            const entry: AdapterEntry = {
                globeId,
                lat,
                lon,
                enabled,
                icon,
                text,
                line,
            };
            entries.set(id, entry);
            return buildHandle(id, entry);
        },
        remove(id: string): void {
            const e = entries.get(id);
            if (!e) {
                console.warn(
                    `[jpmap-terrain] removeMarker: id "${id}" not found`,
                );
                return;
            }
            globeMgr.remove(e.globeId);
            entries.delete(id);
        },
        setEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const e = requireEntry(id);
            globeMgr.setEnabled(e.globeId, enabled);
            e.enabled = enabled;
        },
        list(): readonly string[] {
            return Array.from(entries.keys());
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            // globe マネージャの破棄はシーン破棄（gc.dispose）でも行われるが、公開 API の
            // dispose 契約に合わせてここでも明示的に破棄する（GlobeMarkerManager は冪等）。
            globeMgr.dispose();
            entries.clear();
        },
    };
};

/**
 * `DefaultScene` と同一シグネチャの `createScene` を提供する globe シーンファクトリ。
 * `JpmapTerrain.initAsync` は `terrainEngine` に応じて `DefaultScene` か本クラスを選ぶ。
 */
export class GlobeSceneAdapter {
    createScene = async (
        engine: AbstractEngine,
        canvas: HTMLCanvasElement,
        options?: DefaultSceneInitOptions,
    ): Promise<Scene> => {
        const mapType = toGlobeMapType(options?.mapType);
        const gc: GlobeSceneController = new GlobeScene().createSceneWithController(
            engine,
            canvas,
            {
                lat: options?.lat,
                lon: options?.lon,
                radius: options?.altitude,
                azimuth: options?.azimuth,
                tilt: options?.tilt,
                mapType,
            },
        );

        const controller = createGlobeSceneController(gc, mapType);
        options?.onReady?.(controller);
        return gc.scene;
    };
}

/**
 * `GlobeSceneController` を `DefaultSceneController` 互換へ橋渡しする。
 *
 * @internal テスト用に export する（カメラ get/set マッピングの単体検証）。
 */
export const createGlobeSceneController = (
    gc: GlobeSceneController,
    initialMapType: MapType,
): DefaultSceneController => {
    const { camera } = gc;
    let currentMapType: MapType = initialMapType;
    let mapTypeWarned = false;
    let viewModeWarned = false;

    // 公開 MarkerManager 互換アダプタ（P4-0 Slice 2a）。polygon/circle/model は globe
    // マネージャの機能不足（ラベル/垂線/altitudeMode 等）で parity 未達のため後続スライス。
    const markerManager = createGlobeMarkerManagerAdapter(
        gc.markerManager,
        (latDeg, lonDeg) => gc.tileManager.terrainElevAt(latDeg, lonDeg),
    );

    /** 現在の注視点（地表 lat/lon）。 */
    const currentGeodetic = (): { latDeg: number; lonDeg: number } => {
        const g = ecefToGeodetic(camera.center);
        return { latDeg: g.latDeg, lonDeg: g.lonDeg };
    };

    /** lat/lon を中心へ反映する（高度は seat-on-terrain が地表へ再吸着）。 */
    const setCenterLatLon = (latDeg: number, lonDeg: number): void => {
        camera.center = geodeticToEcef(latDeg, lonDeg, 0);
    };

    return {
        getLat: () => currentGeodetic().latDeg,
        getLon: () => currentGeodetic().lonDeg,
        getAltitude: () => camera.radius,
        getAzimuth: () => yawPitchToUi(camera.yaw, camera.pitch).azimuthDeg,
        getTilt: () => yawPitchToUi(camera.yaw, camera.pitch).tiltDeg,
        // globe は 2D(ズームレベル)概念を持たないため undefined。
        getZoomLevel: () => undefined,

        setLat: (value: number) => {
            const { lonDeg } = currentGeodetic();
            setCenterLatLon(value, lonDeg);
        },
        setLon: (value: number) => {
            const { latDeg } = currentGeodetic();
            setCenterLatLon(latDeg, value);
        },
        setAltitude: (value: number) => {
            camera.radius = value;
        },
        setAzimuth: (value: number) => {
            camera.yaw = uiToYawPitch(value, 0).yaw;
        },
        setTilt: (value: number) => {
            camera.pitch = uiToYawPitch(0, value).pitch;
        },

        setView: (values) => {
            const cur = currentGeodetic();
            const lat = values.lat ?? cur.latDeg;
            const lon = values.lon ?? cur.lonDeg;
            if (values.lat !== undefined || values.lon !== undefined) {
                setCenterLatLon(lat, lon);
            }
            if (values.altitude !== undefined) camera.radius = values.altitude;
            if (values.azimuth !== undefined) {
                camera.yaw = uiToYawPitch(values.azimuth, 0).yaw;
            }
            if (values.tilt !== undefined) {
                camera.pitch = uiToYawPitch(0, values.tilt).pitch;
            }
        },

        // ---- mapType ----
        getMapType: () => fromGlobeMapType(currentMapType),
        setMapType: (value: "standard" | "photo") => {
            const next = toGlobeMapType(value);
            if (next === currentMapType) return;
            // GlobeTileManager は生成時に mapType を固定しており実行時切替 API が無い（要シーン再構築）。
            // P4-0 後続スライスで対応する。ここでは状態のみ保持し描画は変更しない。
            currentMapType = next;
            if (!mapTypeWarned) {
                mapTypeWarned = true;
                console.warn(
                    "[globeSceneController] setMapType is not yet applied on the globe backend (runtime map switch pending; P4-0 follow-up).",
                );
            }
        },

        // ---- viewMode ----
        // globe は GeospatialCamera ベースで 2D(ortho) を持たない。常に "3d" として扱う。
        getViewMode: () => "3d",
        setViewMode: (value) => {
            if (value === "2d" && !viewModeWarned) {
                viewModeWarned = true;
                console.warn(
                    "[globeSceneController] viewMode \"2d\" is not supported on the globe backend; staying in 3d.",
                );
            }
        },

        // ---- external frustum / tile camera（flight 用, P4-0 後続スライス） ----
        refreshTerrainWithExternalFrustum: () => Promise.resolve(),
        detachTileCamera: () => {},
        attachTileCamera: () => {},
        setExternalCompassDegrees: () => {},

        // ---- UI コントロールパネル（globe 未実装, P4-0 後続スライス） ----
        setUiVisibility: () => {},

        // ---- 太陽 / 影（globe ライティング統合は P4-0 後続スライス） ----
        setSunState: () => {},
        setSunShadows: () => {},

        // テスト用の idle 判定。globe は同期統計を本 API に露出していないため暫定 true。
        isTerrainIdle: () => true,

        dispose: () => gc.dispose(),

        getMarkerContext: (): MarkerContext => {
            // 平面版 MarkerContext（world XZ 前提）は globe（ECEF + 地心 up）に適合しない。
            // marker は getMarkerManager（専用アダプタ）で対応する。polygon/circle/model の
            // 公開 parity は globe マネージャ拡張を伴うため P4-0 後続スライスで対応する。
            throw new Error(
                "[globeSceneController] getMarkerContext is not supported on the globe backend; use getMarkerManager for markers (polygon/circle/model: P4-0 follow-up).",
            );
        },

        // marker のみ globe 専用アダプタ経由で公開 MarkerManager 互換を提供する（P4-0 Slice 2a）。
        getMarkerManager: () => markerManager,

        // ---- イベント購読（floating-origin 対応の pick 非依存実装は P4-0 後続スライス） ----
        subscribeTerrainClick: () => () => {},
        subscribePolygonPointHover: () => () => {},
        subscribePolygonPointClick: () => () => {},
        subscribePolygonPointDragStart: () => () => {},
        subscribePolygonPointDrag: () => () => {},
        subscribePolygonPointDragEnd: () => () => {},
    };
};
