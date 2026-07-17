/**
 * GPX Viewer デモ
 *
 * GPX (GPS eXchange Format) の `.gpx` ファイルをドラッグ&ドロップで読み込み、
 * トラック（軌跡）とウェイポイントをマップ上に表示する。
 *
 * - ビューア専用（編集なし）
 * - 再ドロップで前回表示をクリアし、新しい GPX のみ表示
 * - トラックは大量の点（数千点規模）を含み得るため、垂線/壁/点ラベルは無効化し、
 *   描画点数も `MAX_RENDER_POINTS_PER_SEGMENT` まで間引いて軽量なポリラインとして描画する
 *   （統計値の計算には間引き前の全点データを使う）。
 *   トラック始点・終点のみ Plan Viewer のホームポジション相当の単点マーカーで強調する。
 * - 描画は distance / plan デモと同じ addPolygon API を使用する。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, PolygonOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import { parseGpx } from "./parseGpx";
import type { ParsedGpx } from "./parseGpx";
import {
    computeGpxStats,
    computeTrackStats,
    decimatePoints,
    formatElevationMeters,
    formatHorizontalDistance,
    formatTrackLabel,
    formatWaypointLabel,
    MAX_RENDER_POINTS_PER_SEGMENT,
} from "./utils";

const DEMO_MOUNT_ID = "root";
const STATUS_ID = "gpx-status";
const DROP_ZONE_ID = "gpx-drop-zone";
const BTN_TRACK_ID = "btn-track";
const BTN_WAYPOINTS_ID = "btn-waypoints";

// 描画 ID プレフィックス
const ID_TRACK_LINE_PREFIX = "gpx-track-line-";
const ID_TRACK_START_PREFIX = "gpx-track-start-";
const ID_TRACK_END_PREFIX = "gpx-track-end-";
const ID_WAYPOINT_PREFIX = "gpx-waypoint-";

/** トラックごとの識別色（インデックスを周期的に割り当てる）。 */
const TRACK_COLORS = ["#2196f3", "#e91e63", "#4caf50", "#ff9800", "#9c27b0", "#00bcd4"];
const colorForTrack = (index: number): string => TRACK_COLORS[index % TRACK_COLORS.length];

/** 種別ごとの描画 ID セット */
interface GpxIds {
    trackLineIds: string[];
    trackStartIds: string[];
    trackEndIds: string[];
    waypointIds: string[];
}

const EMPTY_GPX_IDS: GpxIds = {
    trackLineIds: [],
    trackStartIds: [],
    trackEndIds: [],
    waypointIds: [],
};

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する。
 */
const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/** 既存の GPX 描画をすべて削除する */
const clearGpxDisplay = (viewer: JpmapTerrain, ids: GpxIds): void => {
    const allPolyIds = [...ids.trackLineIds, ...ids.trackStartIds, ...ids.trackEndIds, ...ids.waypointIds];
    for (const id of allPolyIds) {
        if (viewer.getPolygon(id)) viewer.removePolygon(id);
    }
};

/** 単点マーカー（開始/終了/ウェイポイント）用の PolygonOptions を組み立てる。 */
const buildMarkerOptions = (
    lat: number,
    lon: number,
    ele: number | null,
    label: string,
    color: string,
): PolygonOptions => ({
    points: [{ lat, lon, altitude: ele ?? 0 }],
    altitudeMode: ele !== null ? "absolute" : "terrain",
    closed: false,
    labels: [label],
    style: {
        pointColor: color,
        lineColor: color,
        pointDiameter: 14,
        lineWidth: 2,
        labelFontSize: 12,
        wallColor: color,
        wallOpacity: 0.15,
    },
});

/** GPX をマップに描画し、種別ごとの ID を返す */
const renderGpx = (viewer: JpmapTerrain, gpx: ParsedGpx): GpxIds => {
    const result: GpxIds = { trackLineIds: [], trackStartIds: [], trackEndIds: [], waypointIds: [] };

    try {
        gpx.tracks.forEach((track, trackIndex) => {
            const color = colorForTrack(trackIndex);
            const label = formatTrackLabel(track, trackIndex);

            track.segments.forEach((segment, segIndex) => {
                if (segment.points.length === 0) return;
                // セグメント内の全点が ele を持つ場合のみ絶対高度で描画する。
                // 一部でも欠損する場合は地形に接地させる（terrain, offset 0）。
                const hasEle = segment.points.every((p) => p.ele !== null);
                // 数千点規模になり得るため間引く（addPolygon は頂点ごとに球体メッシュを
                // 生成するため、間引かないとメッシュ数が膨大になり描画性能を損なう）。
                // 統計（距離/標高）は元の全点データを使うため、この間引きは表示のみに影響する。
                const renderPoints = decimatePoints(segment.points, MAX_RENDER_POINTS_PER_SEGMENT);
                const opts: PolygonOptions = {
                    points: renderPoints.map((p) => ({
                        lat: p.lat,
                        lon: p.lon,
                        altitude: hasEle ? (p.ele ?? 0) : 0,
                    })),
                    altitudeMode: hasEle ? "absolute" : "terrain",
                    closed: false,
                    // 垂線/壁/点ラベルは軌跡表示では不要なため無効化する（線のみ表示）。
                    verticalsEnabled: false,
                    wallsEnabled: false,
                    labelsEnabled: false,
                    style: {
                        lineColor: color,
                        lineWidth: 3,
                        // 頂点ごとに球体は生成されるため、密な軌跡上で目立たないよう小さくする。
                        pointDiameter: 4,
                        pointColor: color,
                    },
                };
                const id = `${ID_TRACK_LINE_PREFIX}${trackIndex}-${segIndex}`;
                viewer.addPolygon(id, opts);
                result.trackLineIds.push(id);
            });

            // トラック始点・終点のみ強調表示する。
            const firstSeg = track.segments.find((s) => s.points.length > 0);
            const lastSeg = [...track.segments].reverse().find((s) => s.points.length > 0);
            if (firstSeg) {
                const p = firstSeg.points[0];
                const id = `${ID_TRACK_START_PREFIX}${trackIndex}`;
                viewer.addPolygon(id, buildMarkerOptions(p.lat, p.lon, p.ele, `${label}\n開始`, "#4caf50"));
                result.trackStartIds.push(id);
            }
            if (lastSeg) {
                const p = lastSeg.points[lastSeg.points.length - 1];
                const id = `${ID_TRACK_END_PREFIX}${trackIndex}`;
                viewer.addPolygon(id, buildMarkerOptions(p.lat, p.lon, p.ele, `${label}\n終了`, "#f44336"));
                result.trackEndIds.push(id);
            }
        });

        gpx.waypoints.forEach((wpt, i) => {
            const id = `${ID_WAYPOINT_PREFIX}${i}`;
            const label = formatWaypointLabel(wpt.name, i);
            viewer.addPolygon(id, buildMarkerOptions(wpt.lat, wpt.lon, wpt.ele, label, "#ffc107"));
            result.waypointIds.push(id);
        });
    } catch (err) {
        // 描画途中で例外が発生した場合、追加済みオブジェクトをロールバック削除して再スロー
        clearGpxDisplay(viewer, result);
        throw err;
    }

    return result;
};

const updateStatus = (
    statusEl: HTMLElement | null,
    gpx: ParsedGpx | null,
    error?: string,
): void => {
    if (!statusEl) return;
    if (error) {
        statusEl.textContent = `エラー: ${error}`;
        return;
    }
    if (!gpx) {
        statusEl.textContent = ".gpx ファイルをドラッグ&ドロップしてください";
        return;
    }

    const lines: string[] = [];
    gpx.tracks.forEach((track, i) => {
        const stats = computeTrackStats(track);
        lines.push(`${formatTrackLabel(track, i)}: ${formatHorizontalDistance(stats.distanceMeters)}`);
        lines.push(
            `  ↑${formatElevationMeters(stats.elevationGainMeters)} ↓${formatElevationMeters(stats.elevationLossMeters)}` +
                ` (${formatElevationMeters(stats.minElevationMeters)}〜${formatElevationMeters(stats.maxElevationMeters)})`,
        );
        lines.push(`  トラックポイント: ${stats.pointCount} 点`);
    });
    if (gpx.tracks.length > 1) {
        const total = computeGpxStats(gpx.tracks);
        lines.push(`合計距離: ${formatHorizontalDistance(total.distanceMeters)}`);
    }
    if (gpx.waypoints.length > 0) {
        lines.push(`ウェイポイント: ${gpx.waypoints.length} 点`);
    }
    statusEl.textContent = lines.join("\n");
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }

    const engine = resolveEngine(location.search);
    const cameraState = parseCameraStateFromUrl(location.href) ?? undefined;
    const mapType = parseMapTypeFromUrl(location.href);
    const defaultCamera = {
        lat: 36.60287,
        lon: 137.61614,
        altitude: 3000,
        azimuth: 0,
        tilt: 55,
    };

    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        ...(cameraState ?? defaultCamera),
        ...(mapType !== null ? { mapType } : {}),
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    const statusEl = document.getElementById(STATUS_ID);
    const dropZone = document.getElementById(DROP_ZONE_ID);

    let currentIds: GpxIds = { ...EMPTY_GPX_IDS };

    // レイヤー表示状態
    const layerVisible = { track: true, waypoints: true };

    const btnTrack = document.getElementById(BTN_TRACK_ID) as HTMLButtonElement | null;
    const btnWaypoints = document.getElementById(BTN_WAYPOINTS_ID) as HTMLButtonElement | null;

    const refreshButtons = (): void => {
        const hasTrack = currentIds.trackLineIds.length > 0;
        const hasWaypoints = currentIds.waypointIds.length > 0;
        if (btnTrack) {
            btnTrack.disabled = !hasTrack;
            btnTrack.dataset.active = String(layerVisible.track);
        }
        if (btnWaypoints) {
            btnWaypoints.disabled = !hasWaypoints;
            btnWaypoints.dataset.active = String(layerVisible.waypoints);
        }
    };

    const applyLayerVisibility = (): void => {
        for (const id of [...currentIds.trackLineIds, ...currentIds.trackStartIds, ...currentIds.trackEndIds]) {
            if (viewer.getPolygon(id)) viewer.setPolygonEnabled(id, layerVisible.track);
        }
        for (const id of currentIds.waypointIds) {
            if (viewer.getPolygon(id)) viewer.setPolygonEnabled(id, layerVisible.waypoints);
        }
    };

    if (btnTrack) {
        btnTrack.addEventListener("click", () => {
            layerVisible.track = !layerVisible.track;
            applyLayerVisibility();
            refreshButtons();
        });
    }
    if (btnWaypoints) {
        btnWaypoints.addEventListener("click", () => {
            layerVisible.waypoints = !layerVisible.waypoints;
            applyLayerVisibility();
            refreshButtons();
        });
    }

    /** カメラを移動する対象点を決める（最初のトラックの始点、無ければ最初のウェイポイント）。 */
    const firstFlyToTarget = (gpx: ParsedGpx): { lat: number; lon: number } | null => {
        const firstTrack = gpx.tracks.find((t) => t.segments.some((s) => s.points.length > 0));
        if (firstTrack) {
            const firstSeg = firstTrack.segments.find((s) => s.points.length > 0);
            if (firstSeg) return { lat: firstSeg.points[0].lat, lon: firstSeg.points[0].lon };
        }
        if (gpx.waypoints.length > 0) {
            return { lat: gpx.waypoints[0].lat, lon: gpx.waypoints[0].lon };
        }
        return null;
    };

    const loadGpx = (fileContent: string): void => {
        // 前回表示をクリア
        clearGpxDisplay(viewer, currentIds);
        currentIds = { ...EMPTY_GPX_IDS };
        // 表示状態をリセット
        layerVisible.track = true;
        layerVisible.waypoints = true;

        try {
            const gpx = parseGpx(fileContent);
            currentIds = renderGpx(viewer, gpx);
            updateStatus(statusEl, gpx);
            refreshButtons();

            const target = firstFlyToTarget(gpx);
            if (target) void viewer.flyTo(target);
        } catch (e) {
            const msg = e instanceof Error ? e.message : "不明なエラー";
            updateStatus(statusEl, null, msg);
            refreshButtons();
        }
    };

    // ドラッグ&ドロップ
    let dragCounter = 0;

    document.addEventListener("dragenter", (e: DragEvent) => {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) {
            dropZone?.classList.add("active");
        }
    });

    document.addEventListener("dragleave", (e: DragEvent) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropZone?.classList.remove("active");
        }
    });

    document.addEventListener("dragover", (e: DragEvent) => {
        e.preventDefault();
    });

    document.addEventListener("drop", (e: DragEvent) => {
        e.preventDefault();
        dragCounter = 0;
        dropZone?.classList.remove("active");

        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        const file = files[0];
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === "string") {
                loadGpx(reader.result);
            }
        };
        reader.onerror = () => {
            updateStatus(statusEl, null, "ファイルの読み込みに失敗しました");
        };
        reader.readAsText(file);
    });

    updateStatus(statusEl, null);
    refreshButtons();

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
    }
};

if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain gpx demo] failed to start:", err);
    });
}
