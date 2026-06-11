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
import { JAPAN_BOUNDS } from "../terrain/gsiTile";
import { geodeticToEcef, ecefToGeodetic } from "../terrain/geo/ecef";
import { uiToYawPitch, yawPitchToUi } from "../terrain/geo/cameraMapping";
import { assertLatLonInBounds } from "../terrain/overlayCoords";
import { resolveIcon, resolveText } from "../terrain/marker";
import {
    createControlPanel,
    snapScale,
    formatScale,
    showToast,
} from "../terrain/controlPanel";
import { createUiVisibilityController } from "../terrain/uiVisibility";
import type { MarkerManager } from "../terrain/markerManager";
import type { PolygonManager } from "../terrain/polygonManager";
import type { CircleManager } from "../terrain/circleManager";
import type {
    MarkerHandle,
    MarkerOptions,
    MarkerUpdate,
    MarkerIconOptions,
    MarkerTextOptions,
    MarkerLineOptions,
    PolygonHandle,
    PolygonOptions,
    PolygonPointOptions,
    PolygonPointPartial,
    PolygonStyleOptions,
    PolygonUpdate,
    CircleHandle,
    CircleOptions,
    CircleUpdate,
    CircleCenterOptions,
    CircleStyleOptions,
    AltitudeMode,
} from "../lib/types";
import {
    MARKER_DEFAULTS,
    POLYGON_DEFAULTS,
    CIRCLE_DEFAULTS,
    CIRCLE_RADIUS_MAX_M,
    CIRCLE_SEGMENTS_MIN,
    CIRCLE_SEGMENTS_MAX,
} from "../lib/types";
import type { GlobeMarkerManager } from "../terrain/geo/globeMarkerManager";
import type {
    GlobePolygonManager,
    GlobePolygonOptions,
} from "../terrain/geo/globePolygonManager";
import type {
    GlobeCircleManager,
    GlobeCircleOptions,
} from "../terrain/geo/globeCircleManager";
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
const POLYGON_ERROR_PREFIX = "JpmapTerrain.addPolygon";

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

    const buildHandle = (
        id: string,
        e: AdapterEntry,
        elevationResolvedOverride?: boolean,
    ): MarkerHandle => ({
        id,
        lat: e.lat,
        lon: e.lon,
        enabled: e.enabled,
        icon: e.icon,
        text: e.text,
        line: e.line,
        // planar(markerManager) は lat/lon を変更する update 直後、次フレームの再解決まで
        // elevationResolved=false とする契約。呼び出し側がそれに合わせて override を渡せるようにし、
        // 通常は terrainElevAt!==null で best-effort 判定する（override は false 明示にも対応）。
        elevationResolved:
            elevationResolvedOverride ?? (terrainElevAt(e.lat, e.lon) !== null),
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
            const latLonChanged =
                partial.lat !== undefined || partial.lon !== undefined;
            if (latLonChanged) {
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
            // planar parity: lat/lon を変更した直後は次フレーム再解決まで未解決として返す。
            return buildHandle(id, entry, latLonChanged ? false : undefined);
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
            // 内部 GlobeMarkerManager はシーンが毎フレーム参照し GlobeScene.dispose() が破棄する
            // 所有者であるため、ここでは破棄しない（破棄すると render ループが called-after-dispose で
            // 壊れる）。公開 API dispose の契約として、このアダプタが追加したマーカーのみ削除し、
            // 以降の API 呼び出しを禁止する。
            for (const e of entries.values()) {
                globeMgr.remove(e.globeId);
            }
            entries.clear();
        },
    };
};

interface PolygonAdapterEntry {
    globeId: string;
    points: PolygonPointOptions[];
    closed: boolean;
    altitudeMode: AltitudeMode;
    labels: (string | undefined)[];
    hasLabels: boolean;
    edgeLabels: (string | undefined)[];
    hasEdgeLabels: boolean;
    style: Required<PolygonStyleOptions>;
    enabled: boolean;
    verticalsEnabled: boolean;
    labelsEnabled: boolean;
    wallsEnabled: boolean;
}

const resolvePolygonStyle = (
    style: PolygonStyleOptions | undefined,
): Required<PolygonStyleOptions> => ({
    lineColor: style?.lineColor ?? POLYGON_DEFAULTS.style.lineColor,
    lineWidth: style?.lineWidth ?? POLYGON_DEFAULTS.style.lineWidth,
    lineOpacity: style?.lineOpacity ?? POLYGON_DEFAULTS.style.lineOpacity,
    pointDiameter: style?.pointDiameter ?? POLYGON_DEFAULTS.style.pointDiameter,
    pointColor: style?.pointColor ?? POLYGON_DEFAULTS.style.pointColor,
    pointOpacity: style?.pointOpacity ?? POLYGON_DEFAULTS.style.pointOpacity,
    dropLineColor: style?.dropLineColor ?? POLYGON_DEFAULTS.style.dropLineColor,
    dropLineWidth: style?.dropLineWidth ?? POLYGON_DEFAULTS.style.dropLineWidth,
    dropLineOpacity: style?.dropLineOpacity ?? POLYGON_DEFAULTS.style.dropLineOpacity,
    labelColor: style?.labelColor ?? POLYGON_DEFAULTS.style.labelColor,
    labelBackgroundColor:
        style?.labelBackgroundColor ?? POLYGON_DEFAULTS.style.labelBackgroundColor,
    labelFontSize: style?.labelFontSize ?? POLYGON_DEFAULTS.style.labelFontSize,
    wallColor: style?.wallColor ?? POLYGON_DEFAULTS.style.wallColor,
    wallOpacity: style?.wallOpacity ?? POLYGON_DEFAULTS.style.wallOpacity,
});

const polygonEdgeCount = (pointCount: number, closed: boolean): number =>
    closed && pointCount >= 2 ? pointCount : Math.max(0, pointCount - 1);

const validatePolygonPoints = (
    points: readonly PolygonPointOptions[],
    altitudeMode: AltitudeMode,
    prefix: string,
): void => {
    if (!points || points.length < 1) {
        throw new Error(
            `${prefix}: points must contain at least 1 entry (got ${points?.length ?? 0})`,
        );
    }
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        assertLatLonInBounds(p.lat, p.lon, `${prefix}[${i}]`);
        if (altitudeMode === "absolute" && p.altitude === undefined) {
            throw new Error(
                `${prefix}: altitudeMode="absolute" requires altitude on every point (missing at index ${i})`,
            );
        }
    }
};

const toGlobePolygonOptions = (entry: PolygonAdapterEntry): GlobePolygonOptions => ({
    points: entry.points.map((p) => ({ lat: p.lat, lon: p.lon, altitude: p.altitude })),
    closed: entry.closed,
    altitudeMode: entry.altitudeMode,
    labels: entry.hasLabels ? entry.labels : undefined,
    edgeLabels: entry.hasEdgeLabels ? entry.edgeLabels : undefined,
    style: entry.style,
    enabled: entry.enabled,
    verticalsEnabled: entry.verticalsEnabled,
    labelsEnabled: entry.labelsEnabled,
    wallsEnabled: entry.wallsEnabled,
});

export const createGlobePolygonManagerAdapter = (
    globeMgr: GlobePolygonManager,
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null,
): PolygonManager => {
    const entries = new Map<string, PolygonAdapterEntry>();
    let disposed = false;

    const assertNotDisposed = (): void => {
        if (disposed) throw new Error("PolygonManager has been disposed");
    };

    const buildHandle = (id: string, e: PolygonAdapterEntry): PolygonHandle => ({
        id,
        points: e.points.map((p) => ({ ...p })),
        closed: e.closed,
        altitudeMode: e.altitudeMode,
        labels: e.hasLabels ? Object.freeze([...e.labels]) : undefined,
        edgeLabels: e.hasEdgeLabels ? Object.freeze([...e.edgeLabels]) : undefined,
        style: { ...e.style },
        enabled: e.enabled,
        verticalsEnabled: e.verticalsEnabled,
        labelsEnabled: e.labelsEnabled,
        wallsEnabled: e.wallsEnabled,
        elevationResolved:
            e.altitudeMode === "absolute" ||
            e.points.every((p) => terrainElevAt(p.lat, p.lon) !== null),
    });

    const requireEntry = (id: string): PolygonAdapterEntry => {
        const e = entries.get(id);
        if (!e) throw new Error(`Polygon id "${id}" not found`);
        return e;
    };

    const cloneEntry = (e: PolygonAdapterEntry): PolygonAdapterEntry => ({
        ...e,
        points: e.points.map((p) => ({ ...p })),
        labels: [...e.labels],
        edgeLabels: [...e.edgeLabels],
        style: { ...e.style },
    });

    // 先に新ノードを add し、成功した場合にのみ旧ノードを remove して entries を差し替える。
    // add が throw した場合は「表示は旧ノード・状態は旧 entry」のまま不整合を残さない
    // （Marker アダプタの add-then-remove と同じトランザクション契約）。
    const commitRebuild = (
        id: string,
        prev: PolygonAdapterEntry,
        next: PolygonAdapterEntry,
    ): PolygonAdapterEntry => {
        const globeId = globeMgr.add(toGlobePolygonOptions(next));
        globeMgr.remove(prev.globeId);
        next.globeId = globeId;
        entries.set(id, next);
        return next;
    };

    const createEntry = (options: PolygonOptions, globeId: string): PolygonAdapterEntry => {
        const closed = options.closed ?? POLYGON_DEFAULTS.closed;
        const altitudeMode = options.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode;
        validatePolygonPoints(options.points, altitudeMode, POLYGON_ERROR_PREFIX);
        const points = options.points.map((p) => ({
            lat: p.lat,
            lon: p.lon,
            altitude: p.altitude,
        }));
        const labels = points.map((_p, i) => options.labels?.[i]);
        const eCount = polygonEdgeCount(points.length, closed);
        const edgeLabels = Array.from(
            { length: eCount },
            (_v, i) => options.edgeLabels?.[i],
        );
        return {
            globeId,
            points,
            closed,
            altitudeMode,
            labels,
            hasLabels: options.labels !== undefined,
            edgeLabels,
            hasEdgeLabels: options.edgeLabels !== undefined,
            style: resolvePolygonStyle(options.style),
            enabled: options.enabled ?? POLYGON_DEFAULTS.enabled,
            verticalsEnabled:
                options.verticalsEnabled ?? POLYGON_DEFAULTS.verticalsEnabled,
            labelsEnabled: options.labelsEnabled ?? POLYGON_DEFAULTS.labelsEnabled,
            wallsEnabled: options.wallsEnabled ?? POLYGON_DEFAULTS.wallsEnabled,
        };
    };

    return {
        add(id: string, options: PolygonOptions): PolygonHandle {
            assertNotDisposed();
            if (entries.has(id)) {
                throw new Error(
                    `JpmapTerrain.addPolygon: id "${id}" already exists`,
                );
            }
            const tmp = createEntry(options, "");
            const globeId = globeMgr.add(toGlobePolygonOptions(tmp));
            tmp.globeId = globeId;
            entries.set(id, tmp);
            return buildHandle(id, tmp);
        },
        get(id: string): PolygonHandle | null {
            const e = entries.get(id);
            return e ? buildHandle(id, e) : null;
        },
        update(id: string, partial: PolygonUpdate): PolygonHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            const closed = partial.closed ?? prev.closed;
            const altitudeMode = partial.altitudeMode ?? prev.altitudeMode;
            const points = (partial.points ?? prev.points).map((p) => ({ ...p }));
            validatePolygonPoints(
                points,
                altitudeMode,
                `JpmapTerrain.updatePolygon[${id}]`,
            );
            const eCount = polygonEdgeCount(points.length, closed);
            const labels =
                partial.labels !== undefined
                    ? points.map((_p, i) => partial.labels?.[i])
                    : points.map((_p, i) => prev.labels[i]);
            const edgeLabels =
                partial.edgeLabels !== undefined
                    ? Array.from({ length: eCount }, (_v, i) => partial.edgeLabels?.[i])
                    : Array.from({ length: eCount }, (_v, i) => prev.edgeLabels[i]);
            const next: PolygonAdapterEntry = {
                ...prev,
                points,
                closed,
                altitudeMode,
                labels,
                hasLabels: partial.labels !== undefined ? true : prev.hasLabels,
                edgeLabels,
                hasEdgeLabels:
                    partial.edgeLabels !== undefined ? true : prev.hasEdgeLabels,
                style:
                    partial.style !== undefined
                        ? resolvePolygonStyle(partial.style)
                        : prev.style,
                enabled: partial.enabled ?? prev.enabled,
                verticalsEnabled:
                    partial.verticalsEnabled ?? prev.verticalsEnabled,
                labelsEnabled: partial.labelsEnabled ?? prev.labelsEnabled,
                wallsEnabled: partial.wallsEnabled ?? prev.wallsEnabled,
            };
            return buildHandle(id, commitRebuild(id, prev, next));
        },
        remove(id: string): void {
            const e = entries.get(id);
            if (!e) {
                console.warn(
                    `[jpmap-terrain] removePolygon: id "${id}" not found`,
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
        setVerticalsEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.verticalsEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        setLabelsEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.labelsEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        setWallsEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.wallsEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        insertPoint(id: string, index: number, point: PolygonPointOptions): PolygonHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            if (!Number.isInteger(index) || index < 0 || index > prev.points.length) {
                throw new RangeError(
                    `JpmapTerrain.insertPolygonPoint[${id}]: index out of range (got ${index}, length=${prev.points.length})`,
                );
            }
            validatePolygonPoints(
                [point],
                prev.altitudeMode,
                `JpmapTerrain.insertPolygonPoint[${id}]`,
            );
            const next = cloneEntry(prev);
            next.points.splice(index, 0, { ...point });
            next.labels.splice(index, 0, undefined);
            next.edgeLabels.splice(index, 0, undefined);
            next.edgeLabels.length = polygonEdgeCount(next.points.length, next.closed);
            return buildHandle(id, commitRebuild(id, prev, next));
        },
        removePoint(id: string, index: number): PolygonHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            if (!Number.isInteger(index) || index < 0 || index >= prev.points.length) {
                throw new RangeError(
                    `JpmapTerrain.removePolygonPoint[${id}]: index out of range (got ${index}, length=${prev.points.length})`,
                );
            }
            if (prev.points.length <= 1) {
                throw new Error(
                    `JpmapTerrain.removePolygonPoint[${id}]: cannot remove (must keep at least 1 point)`,
                );
            }
            const next = cloneEntry(prev);
            next.points.splice(index, 1);
            next.labels.splice(index, 1);
            if (next.edgeLabels.length > 0) {
                next.edgeLabels.splice(Math.min(index, next.edgeLabels.length - 1), 1);
            }
            next.edgeLabels.length = polygonEdgeCount(next.points.length, next.closed);
            return buildHandle(id, commitRebuild(id, prev, next));
        },
        updatePoint(
            id: string,
            index: number,
            partial: PolygonPointPartial,
        ): PolygonHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            if (!Number.isInteger(index) || index < 0 || index >= prev.points.length) {
                throw new RangeError(
                    `JpmapTerrain.updatePolygonPoint[${id}]: index out of range (got ${index}, length=${prev.points.length})`,
                );
            }
            const current = prev.points[index];
            const nextPoint = {
                lat: partial.lat ?? current.lat,
                lon: partial.lon ?? current.lon,
                altitude:
                    partial.altitude !== undefined
                        ? partial.altitude
                        : current.altitude,
            };
            validatePolygonPoints(
                [nextPoint],
                prev.altitudeMode,
                `JpmapTerrain.updatePolygonPoint[${id}][${index}]`,
            );
            const next = cloneEntry(prev);
            next.points[index] = nextPoint;
            if (partial.label !== undefined) {
                next.labels[index] =
                    partial.label === null ? undefined : partial.label;
                if (partial.label !== null) next.hasLabels = true;
            }
            return buildHandle(id, commitRebuild(id, prev, next));
        },
        replacePoints(id: string, points: readonly PolygonPointOptions[]): PolygonHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            validatePolygonPoints(
                points,
                prev.altitudeMode,
                `JpmapTerrain.replacePolygonPoints[${id}]`,
            );
            const next = cloneEntry(prev);
            next.points = points.map((p) => ({ ...p }));
            next.labels = next.points.map(() => undefined);
            next.hasLabels = false;
            next.edgeLabels = Array.from(
                { length: polygonEdgeCount(next.points.length, next.closed) },
                () => undefined,
            );
            next.hasEdgeLabels = false;
            return buildHandle(id, commitRebuild(id, prev, next));
        },
        list(): readonly string[] {
            return Array.from(entries.keys());
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            // 内部 GlobePolygonManager はシーンが毎フレーム update(camEcef) で参照し
            // GlobeScene.dispose() が破棄する所有者であるため、ここでは破棄しない（破棄すると
            // render ループが GlobePolygonManager.update: called after dispose で壊れる）。
            // 公開 API dispose の契約として、このアダプタが追加したポリゴンのみ削除し、
            // 以降の API 呼び出しを禁止する。
            for (const e of entries.values()) {
                globeMgr.remove(e.globeId);
            }
            entries.clear();
        },
    };
};

const CIRCLE_ERROR_PREFIX = "JpmapTerrain.addCircle";

/** 公開 `CircleStyleOptions` を `CIRCLE_DEFAULTS.style` で埋める。 */
const resolveCircleStyle = (
    style: CircleStyleOptions | undefined,
): Required<CircleStyleOptions> => ({
    pointColor: style?.pointColor ?? CIRCLE_DEFAULTS.style.pointColor,
    pointDiameter: style?.pointDiameter ?? CIRCLE_DEFAULTS.style.pointDiameter,
    pointOpacity: style?.pointOpacity ?? CIRCLE_DEFAULTS.style.pointOpacity,
    lineColor: style?.lineColor ?? CIRCLE_DEFAULTS.style.lineColor,
    lineWidth: style?.lineWidth ?? CIRCLE_DEFAULTS.style.lineWidth,
    lineOpacity: style?.lineOpacity ?? CIRCLE_DEFAULTS.style.lineOpacity,
    wallColor: style?.wallColor ?? CIRCLE_DEFAULTS.style.wallColor,
    wallOpacity: style?.wallOpacity ?? CIRCLE_DEFAULTS.style.wallOpacity,
    labelColor: style?.labelColor ?? CIRCLE_DEFAULTS.style.labelColor,
    labelBackgroundColor:
        style?.labelBackgroundColor ?? CIRCLE_DEFAULTS.style.labelBackgroundColor,
    labelFontSize: style?.labelFontSize ?? CIRCLE_DEFAULTS.style.labelFontSize,
});

/**
 * 中心ラベルの自動生成テキスト（lat / lon / alt / radius を 4 行）。planar `circle.ts` と一致させる。
 */
const formatCircleAutoLabel = (
    center: CircleCenterOptions,
    radius: number,
): string => {
    const altText = center.altitude !== undefined ? center.altitude.toFixed(1) : "0.0";
    return [
        `lat: ${center.lat.toFixed(6)}`,
        `lon: ${center.lon.toFixed(6)}`,
        `alt: ${altText} m`,
        `radius: ${radius.toFixed(1)} m`,
    ].join("\n");
};

/** アダプタが保持する 1 サークルの解決済み状態（公開ハンドル再構築用）。 */
interface CircleAdapterEntry {
    /** `GlobeCircleManager.add` が採番した内部 id。 */
    globeId: string;
    center: CircleCenterOptions;
    radius: number;
    segments: number;
    altitudeMode: AltitudeMode;
    /** label が undefined（自動生成）指定だったか。center/radius 変化時に再生成する。 */
    labelAuto: boolean;
    /** 現在のラベル文字列（null は非表示指定）。 */
    labelText: string | null;
    style: Required<CircleStyleOptions>;
    enabled: boolean;
    pointEnabled: boolean;
    lineEnabled: boolean;
    wallEnabled: boolean;
    labelEnabled: boolean;
}

/**
 * `GlobeCircleManager`（採番 id・閉ポリゴン委譲）を公開 `CircleManager`（明示 id・`CircleHandle`
 * 返却・partial-update・各種トグル）へアダプトする（#275 Phase 4 / Slice 2b-2）。
 *
 * - `GlobeCircleManager` は in-place 更新を持たないため、`update` および各トグルは内部ノードを
 *   作り直す（add-then-remove のトランザクション。Marker / Polygon アダプタと同契約）。
 * - `elevationResolved` は planar 同様、中心の地形標高が取得できるか（`terrainElevAt !== null`）で
 *   best-effort 判定する（`absolute` は常に true）。
 *
 * @internal テスト用に export する。
 */
export const createGlobeCircleManagerAdapter = (
    globeMgr: GlobeCircleManager,
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null,
): CircleManager => {
    const entries = new Map<string, CircleAdapterEntry>();
    let disposed = false;

    const assertNotDisposed = (): void => {
        if (disposed) throw new Error("CircleManager has been disposed");
    };

    const requireEntry = (id: string): CircleAdapterEntry => {
        const e = entries.get(id);
        if (!e) throw new Error(`Circle id "${id}" not found`);
        return e;
    };

    const validateOptions = (
        center: CircleCenterOptions,
        radius: number,
        segments: number | undefined,
        altitudeMode: AltitudeMode,
        prefix: string,
    ): void => {
        if (!center) throw new Error(`${prefix}: center is required`);
        assertLatLonInBounds(center.lat, center.lon, prefix);
        if (!Number.isFinite(radius) || radius <= 0 || radius > CIRCLE_RADIUS_MAX_M) {
            throw new Error(
                `${prefix}: radius must be in (0, ${CIRCLE_RADIUS_MAX_M}] m (got ${radius})`,
            );
        }
        if (
            segments !== undefined &&
            (!Number.isInteger(segments) ||
                segments < CIRCLE_SEGMENTS_MIN ||
                segments > CIRCLE_SEGMENTS_MAX)
        ) {
            throw new Error(
                `${prefix}: segments must be an integer in [${CIRCLE_SEGMENTS_MIN}, ${CIRCLE_SEGMENTS_MAX}] (got ${segments})`,
            );
        }
        if (altitudeMode === "absolute" && center.altitude === undefined) {
            throw new Error(`${prefix}: altitudeMode="absolute" requires center.altitude`);
        }
    };

    const toGlobeOptions = (e: CircleAdapterEntry): GlobeCircleOptions => ({
        centerLat: e.center.lat,
        centerLon: e.center.lon,
        radiusMeters: e.radius,
        segments: e.segments,
        altitudeMode: e.altitudeMode,
        centerAltitudeMeters: e.center.altitude,
        label: e.labelText,
        style: e.style as PolygonStyleOptions,
        enabled: e.enabled,
        pointEnabled: e.pointEnabled,
        lineEnabled: e.lineEnabled,
        wallEnabled: e.wallEnabled,
        labelEnabled: e.labelEnabled,
    });

    const buildHandle = (id: string, e: CircleAdapterEntry): CircleHandle => ({
        id,
        center: { ...e.center },
        radius: e.radius,
        segments: e.segments,
        altitudeMode: e.altitudeMode,
        label: e.labelText,
        style: { ...e.style },
        enabled: e.enabled,
        pointEnabled: e.pointEnabled,
        lineEnabled: e.lineEnabled,
        wallEnabled: e.wallEnabled,
        labelEnabled: e.labelEnabled,
        elevationResolved:
            e.altitudeMode === "absolute" ||
            terrainElevAt(e.center.lat, e.center.lon) !== null,
    });

    // 先に新ノードを add し、成功時のみ旧ノードを remove する（Polygon アダプタと同契約）。
    const commitRebuild = (
        id: string,
        prev: CircleAdapterEntry,
        next: CircleAdapterEntry,
    ): CircleAdapterEntry => {
        const globeId = globeMgr.add(toGlobeOptions(next));
        globeMgr.remove(prev.globeId);
        next.globeId = globeId;
        entries.set(id, next);
        return next;
    };

    const cloneEntry = (e: CircleAdapterEntry): CircleAdapterEntry => ({
        ...e,
        center: { ...e.center },
        style: { ...e.style },
    });

    return {
        add(id: string, options: CircleOptions): CircleHandle {
            assertNotDisposed();
            if (entries.has(id)) {
                throw new Error(`${CIRCLE_ERROR_PREFIX}: id "${id}" already exists`);
            }
            const altitudeMode = options.altitudeMode ?? CIRCLE_DEFAULTS.altitudeMode;
            validateOptions(
                options.center,
                options.radius,
                options.segments,
                altitudeMode,
                CIRCLE_ERROR_PREFIX,
            );
            const center = { ...options.center };
            const radius = options.radius;
            // label: undefined=自動生成 / null=非表示 / string=カスタム。
            const labelAuto = options.label === undefined;
            const labelText: string | null =
                options.label === null
                    ? null
                    : labelAuto
                      ? formatCircleAutoLabel(center, radius)
                      : (options.label as string);
            const entry: CircleAdapterEntry = {
                globeId: "",
                center,
                radius,
                segments: options.segments ?? CIRCLE_DEFAULTS.segments,
                altitudeMode,
                labelAuto,
                labelText,
                style: resolveCircleStyle(options.style),
                enabled: options.enabled ?? CIRCLE_DEFAULTS.enabled,
                pointEnabled: options.pointEnabled ?? CIRCLE_DEFAULTS.pointEnabled,
                lineEnabled: options.lineEnabled ?? CIRCLE_DEFAULTS.lineEnabled,
                wallEnabled: options.wallEnabled ?? CIRCLE_DEFAULTS.wallEnabled,
                labelEnabled: options.labelEnabled ?? CIRCLE_DEFAULTS.labelEnabled,
            };
            entry.globeId = globeMgr.add(toGlobeOptions(entry));
            entries.set(id, entry);
            return buildHandle(id, entry);
        },
        update(id: string, partial: CircleUpdate): CircleHandle {
            assertNotDisposed();
            const prev = requireEntry(id);
            const center =
                partial.center !== undefined ? { ...partial.center } : { ...prev.center };
            const radius = partial.radius ?? prev.radius;
            const segments = partial.segments ?? prev.segments;
            const altitudeMode = partial.altitudeMode ?? prev.altitudeMode;
            validateOptions(
                center,
                radius,
                segments,
                altitudeMode,
                `JpmapTerrain.updateCircle[${id}]`,
            );
            // label の再解決（CircleUpdate.label は string | null）:
            // - partial.label === null: 非表示（auto 解除）
            // - partial.label === string: カスタム文字列（auto 解除）
            // - partial.label 未指定(undefined): 変更なし。元が自動生成なら center/radius の
            //   変化に追従してテキストを再生成、それ以外は現状維持。
            //   ※ undefined を渡して「自動生成へ戻す」操作は型上表現できない（= 維持扱い）。
            let labelAuto = prev.labelAuto;
            let labelText = prev.labelText;
            if (partial.label !== undefined) {
                if (partial.label === null) {
                    labelAuto = false;
                    labelText = null;
                } else {
                    labelAuto = false;
                    labelText = partial.label;
                }
            } else if (prev.labelAuto) {
                labelText = formatCircleAutoLabel(center, radius);
            }
            const next: CircleAdapterEntry = {
                ...prev,
                center,
                radius,
                segments,
                altitudeMode,
                labelAuto,
                labelText,
                style:
                    partial.style !== undefined
                        ? resolveCircleStyle(partial.style)
                        : { ...prev.style },
                enabled: partial.enabled ?? prev.enabled,
                pointEnabled: partial.pointEnabled ?? prev.pointEnabled,
                lineEnabled: partial.lineEnabled ?? prev.lineEnabled,
                wallEnabled: partial.wallEnabled ?? prev.wallEnabled,
                labelEnabled: partial.labelEnabled ?? prev.labelEnabled,
            };
            return buildHandle(id, commitRebuild(id, prev, next));
        },
        get(id: string): CircleHandle | null {
            const e = entries.get(id);
            return e ? buildHandle(id, e) : null;
        },
        remove(id: string): void {
            const e = entries.get(id);
            if (!e) {
                console.warn(`[jpmap-terrain] removeCircle: id "${id}" not found`);
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
        setPointEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.pointEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        setLineEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.lineEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        setWallEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.wallEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        setLabelEnabled(id: string, enabled: boolean): void {
            assertNotDisposed();
            const prev = requireEntry(id);
            const next = cloneEntry(prev);
            next.labelEnabled = enabled;
            commitRebuild(id, prev, next);
        },
        list(): readonly string[] {
            return Array.from(entries.keys());
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            // 内部 GlobeCircleManager はシーンが毎フレーム update(camEcef) で参照し
            // GlobeScene.dispose() が破棄する所有者であるため、ここでは破棄しない。
            // このアダプタが追加したサークルのみ削除し、以降の API 呼び出しを禁止する。
            for (const e of entries.values()) {
                globeMgr.remove(e.globeId);
            }
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

        const controller = createGlobeSceneController(gc, mapType, options, canvas);
        options?.onReady?.(controller);

        // JpmapTerrain.initAsync は初期フラッシュ防止のため canvas を visibility:hidden で
        // マウントし、planar(DefaultScene)は初回レンダ後に復帰させる(#225)。globe バックエンドでも
        // 同様に初回レンダ後へ可視化を復帰しないと canvas が hidden のままで真っ白になる。
        gc.scene.onAfterRenderObservable.addOnce(() => {
            canvas.style.visibility = "";
        });
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
    options?: DefaultSceneInitOptions,
    canvas?: HTMLCanvasElement,
): DefaultSceneController => {
    const { camera } = gc;
    let currentMapType: MapType = initialMapType;
    let viewModeWarned = false;

    // 公開 overlay manager 互換アダプタ（P4-0 Slice 2a / 2b-1）。
    const markerManager = createGlobeMarkerManagerAdapter(
        gc.markerManager,
        (latDeg, lonDeg) => gc.tileManager.terrainElevAt(latDeg, lonDeg),
    );
    const polygonManager = createGlobePolygonManagerAdapter(
        gc.polygonManager,
        (latDeg, lonDeg) => gc.tileManager.terrainElevAt(latDeg, lonDeg),
    );
    const circleManager = createGlobeCircleManagerAdapter(
        gc.circleManager,
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

    // ---- UI コントロールパネル配線（#275 Phase 4 / P4-1） ----
    // canvas が渡された実行時のみ DOM コントロールパネルを生成・配線する（単体テストの
    // 軽量スタブ呼び出しでは canvas 未指定で no-op）。
    let uiSetVisibility: (
        target: Parameters<DefaultSceneController["setUiVisibility"]>[0],
        visible: boolean,
    ) => void = () => {};
    let uiDispose: () => void = () => {};
    let updateMapToggleLabel: ((m: MapType) => void) | undefined;

    /**
     * 地図種別を切り替える共通処理（UI ボタン / `controller.setMapType` の双方から呼ぶ）。
     * 同値なら no-op。タイルマネージャを実行時切替し、ラベル更新と onMapTypeChange 通知を行う。
     */
    const applyMapType = (next: MapType, fireChange: boolean): void => {
        if (next === currentMapType) return;
        currentMapType = next;
        gc.tileManager.setMapType(next);
        updateMapToggleLabel?.(next);
        if (fireChange) options?.onMapTypeChange?.(fromGlobeMapType(next));
    };

    if (canvas && typeof document !== "undefined") {
        const ui = createControlPanel();
        // UI 破棄後にアニメーション（requestAnimationFrame）が camera を更新し続けないための
        // ガードフラグ。uiDispose で true にし、各 rAF ループは次フレームをスケジュールしない。
        let uiDisposed = false;
        // globe は 2D(ortho) を持たないため視点切替ボタンは常時非表示にする（#275 P4-1）。
        // createUiVisibilityController は生成時の display を初期値として捕捉するため、
        // 先に "none" にしておけば setUiVisibility("viewModeButton", true) でも再表示されない。
        ui.viewModeButton.style.display = "none";

        // 地図切替ボタンのラベル/aria を現在の mapType に合わせて更新する。
        updateMapToggleLabel = (m: MapType): void => {
            ui.mapToggle.textContent = m === "std" ? "写真" : "標準";
            ui.mapToggle.setAttribute(
                "aria-label",
                m === "std" ? "地図切替: 写真地図に変更" : "地図切替: 標準地図に変更",
            );
        };
        updateMapToggleLabel(currentMapType);

        // コンパス回転 + スケールバーをフレーム毎に更新する（変化時のみ DOM を書く）。
        const SCALE_BAR_BASE_PX = 100;
        let prevCompassDeg = Number.NaN;
        let prevScaleText = "";
        let prevBarPx = Number.NaN;
        const updateOverlayUi = (): void => {
            // コンパス: 北矢印が実際の北を指すよう azimuth の逆回転を適用する。
            // azimuthDeg は浮動小数のためほぼ毎フレーム変化しうる。0.1 度に丸めて比較し、
            // 視覚的に意味のある変化があるときだけ DOM(style.transform) を書く。
            const az = yawPitchToUi(camera.yaw, camera.pitch).azimuthDeg;
            const deg = Math.round(-az * 10) / 10;
            if (deg !== prevCompassDeg) {
                ui.compass.style.transform = `rotate(${deg}deg)`;
                prevCompassDeg = deg;
            }
            // スケールバー: 視野中心の地表サンプリング（fov 高 / ビュー高さ[px]）から m/px を概算する。
            const h = canvas.clientHeight || canvas.height;
            if (h > 0) {
                const metersPerPx =
                    (2 * camera.radius * Math.tan(camera.fov / 2)) / h;
                const rawMeters = metersPerPx * SCALE_BAR_BASE_PX;
                if (Number.isFinite(rawMeters) && rawMeters > 0) {
                    const snapped = snapScale(rawMeters);
                    const barPx = Math.round(snapped / metersPerPx);
                    const text = formatScale(snapped);
                    if (text !== prevScaleText) {
                        ui.scaleBar.label.textContent = text;
                        prevScaleText = text;
                    }
                    // ラベル同様、幅も変化時のみ更新して不要なレイアウトを避ける。
                    if (barPx !== prevBarPx) {
                        ui.scaleBar.bar.style.width = `${barPx}px`;
                        prevBarPx = barPx;
                    }
                }
            }
        };
        const overlayObserver =
            gc.scene.onBeforeRenderObservable.add(updateOverlayUi);
        updateOverlayUi();

        // コンパスクリック: 北向き・真下（azimuth=0 / tilt=0）へスムーズに戻す。
        ui.compass.style.cursor = "pointer";
        const resetCompassView = (): void => {
            const startYaw = camera.yaw;
            const startPitch = camera.pitch;
            const targetYaw = uiToYawPitch(0, 0).yaw;
            const targetPitch = uiToYawPitch(0, 0).pitch;
            // yaw は最短経路（±π に正規化）で回す。
            let dYaw = targetYaw - startYaw;
            dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
            const duration = 400;
            const startTime = performance.now();
            const animate = (now: number): void => {
                // UI 破棄後はカメラを更新せず再スケジュールも止める。
                if (uiDisposed) return;
                const t = Math.min((now - startTime) / duration, 1);
                const ease = 1 - Math.pow(1 - t, 3);
                camera.yaw = startYaw + dYaw * ease;
                camera.pitch = startPitch + (targetPitch - startPitch) * ease;
                if (t < 1) requestAnimationFrame(animate);
            };
            requestAnimationFrame(animate);
        };
        ui.compass.addEventListener("click", resetCompassView);
        ui.compass.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                resetCompassView();
            }
        });

        // ズームボタン: camera.radius（高度相当）を係数で滑らかに増減する。
        const zoomByFactor = (factor: number): void => {
            const startR = camera.radius;
            const targetR = startR * factor;
            const duration = 250;
            const startTime = performance.now();
            const animate = (now: number): void => {
                // UI 破棄後は camera.radius を更新せず再スケジュールも止める。
                if (uiDisposed) return;
                const t = Math.min((now - startTime) / duration, 1);
                const ease = 1 - Math.pow(1 - t, 3);
                camera.radius = startR + (targetR - startR) * ease;
                if (t < 1) requestAnimationFrame(animate);
            };
            requestAnimationFrame(animate);
        };
        ui.zoomIn.addEventListener("click", () => zoomByFactor(0.7));
        ui.zoomOut.addEventListener("click", () => zoomByFactor(1 / 0.7));

        // 現在地ボタン: Geolocation で取得した地点へ注視点を移す。
        ui.locateMe.addEventListener("click", () => {
            if (!navigator.geolocation) {
                console.warn(
                    "[globeSceneController] Geolocation API is not supported by this browser.",
                );
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    if (uiDisposed) return;
                    const lat = position.coords.latitude;
                    const lon = position.coords.longitude;
                    // GSI 地形タイルは日本域のみ。域外は背景球のみ表示になる旨を通知する。
                    if (
                        lat < JAPAN_BOUNDS.minLat ||
                        lat > JAPAN_BOUNDS.maxLat ||
                        lon < JAPAN_BOUNDS.minLon ||
                        lon > JAPAN_BOUNDS.maxLon
                    ) {
                        showToast(
                            "現在地は対応エリア外のため、地形が表示されない場合があります",
                        );
                    }
                    setCenterLatLon(lat, lon);
                },
                (error) => {
                    if (uiDisposed) return;
                    console.warn(
                        `[globeSceneController] Geolocation error: ${error.message}`,
                    );
                },
            );
        });

        // 地図切替ボタン: std ↔ photo を実行時に切り替える（#275 P4-1）。
        ui.mapToggle.addEventListener("click", () => {
            applyMapType(currentMapType === "std" ? "photo" : "std", true);
        });

        uiSetVisibility = createUiVisibilityController({
            compass: ui.compass,
            locateMe: ui.locateMe,
            zoomIn: ui.zoomIn,
            zoomOut: ui.zoomOut,
            scaleBarBar: ui.scaleBar.bar,
            scaleBarLabel: ui.scaleBar.label,
            mapToggle: ui.mapToggle,
            viewModeButton: ui.viewModeButton,
            attribution: ui.scaleBar.attribution,
        });

        // dispose: フレーム購読を解除し、controlPanel が body に追加した UI 要素を除去する。
        const removeFromParent = (el: HTMLElement | null): void => {
            el?.parentElement?.removeChild(el);
        };
        uiDispose = (): void => {
            uiDisposed = true;
            gc.scene.onBeforeRenderObservable.remove(overlayObserver);
            removeFromParent(ui.compass);
            removeFromParent(ui.mapToggle);
            removeFromParent(ui.viewModeButton);
            // locateMe / zoomIn / zoomOut / scaleBar.* は共通の親コンテナ配下。
            const zoomContainer = ui.zoomIn.parentElement;
            if (zoomContainer) {
                removeFromParent(zoomContainer);
            } else {
                removeFromParent(ui.locateMe);
                removeFromParent(ui.zoomIn);
                removeFromParent(ui.zoomOut);
                removeFromParent(ui.scaleBar.container);
            }
        };
    }

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
            // UI ボタンと同じ共通処理で実行時切替する（#275 P4-1）。onMapTypeChange も発火する。
            applyMapType(toGlobeMapType(value), true);
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

        // ---- UI コントロールパネル（#275 P4-1 で配線。canvas 未指定時は no-op） ----
        setUiVisibility: (target, visible) => uiSetVisibility(target, visible),

        // ---- 太陽 / 影（globe ライティング統合は P4-0 後続スライス） ----
        setSunState: () => {},
        setSunShadows: () => {},

        // テスト用の idle 判定。globe タイルマネージャの実 idle 状態
        // （初回 sync 済み / 標高ロード中タイル無し / LOD 遷移の pendingRelease 無し に加え、
        //  希望タイル desiredKeys がすべて loaded かつテクスチャ適用済み readyMeshes）を返す。
        isTerrainIdle: () => gc.tileManager.isIdle(),

        dispose: () => {
            uiDispose();
            gc.dispose();
        },

        getMarkerContext: (): MarkerContext => {
            // 平面版 MarkerContext（world XZ 前提）は globe（ECEF + 地心 up）に適合しない。
            // marker/polygon は専用アダプタで対応する。
            throw new Error(
                "[globeSceneController] getMarkerContext is not supported on the globe backend; use dedicated overlay managers.",
            );
        },

        getMarkerManager: () => markerManager,
        getPolygonManager: () => polygonManager,
        getCircleManager: () => circleManager,

        // ---- 地形クリック購読（pick 非依存・floating origin 対応, #275 P4・実装済み） ----
        // globe シーン（globe.ts）が真の ECEF レイ × 地形楕円体で求めたクリック地点を、公開
        // TerrainClickEvent へ橋渡しする。GlobeTerrainClickEvent は構造互換だが、型を明示するため
        // ここで明示的にイベントを組み直す。
        subscribeTerrainClick: (listener) =>
            gc.subscribeTerrainClick((e) =>
                listener({
                    lat: e.lat,
                    lon: e.lon,
                    altitude: e.altitude,
                    world: e.world,
                    pointerEvent: e.pointerEvent,
                }),
            ),
        subscribePolygonPointHover: () => () => {},
        subscribePolygonPointClick: () => () => {},
        subscribePolygonPointDragStart: () => () => {},
        subscribePolygonPointDrag: () => () => {},
        subscribePolygonPointDragEnd: () => () => {},
    };
};
