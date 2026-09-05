/**
 * GPX Viewer デモ
 *
 * GPX (GPS eXchange Format) の `.gpx` ファイルをドラッグ&ドロップで読み込み、
 * トラック（軌跡）とウェイポイントをマップ上に表示する。
 *
 * - ビューア専用（編集なし）
 * - 再ドロップで前回表示をクリアし、新しい GPX のみ表示
 * - トラックは大量の点（数千点規模）を含み得るため、頂点球体マーカー/垂線/壁/点ラベルは
 *   無効化し、線のみのポリラインとして描画する。描画点数も `MAX_RENDER_POINTS_PER_SEGMENT`
 *   まで間引いて軽量化する（統計値の計算には間引き前の全点データを使う）。
 *   トラック始点・終点のみ Plan Viewer のホームポジション相当の単点マーカーで強調する。
 * - 描画は distance / plan デモと同じ addPolygon API を使用する。
 * - 画面右上の操作パネルに水平移動距離・標高差等の統計を表示する。
 * - 画面下部に標高-時間グラフ（Canvas 2D、外部ライブラリ非依存、折れ線＋下側塗りつぶし）
 *   を表示する。`<trkpt><time>` を持つ GPX のみ対象（無ければパネルごと非表示）。時刻は
 *   GPX 上は UTC で記録されているため、表示時のみ JST (UTC+9固定) に変換する
 *   （GPX ファイル自体は変更しない）。タイトル文言は表示せず（軸ラベルで自明なため）、
 *   パネルの `bottom` オフセットは左下（写真ボタン）・右下（ズーム/スケールバー）の
 *   操作 UI と重ならないよう実測して動的に調整する。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, PolygonOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import { clearElevationChart, renderElevationChart } from "./elevationChart";
import type { ParsedGpx } from "./parseGpx";
import { parseGpx } from "./parseGpx";
import type { ElevationProfileSeries } from "./utils";
import {
    buildElevationProfiles,
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
const ELEVATION_PANEL_ID = "gpx-elevation-panel";
const ELEVATION_CANVAS_ID = "gpx-elevation-canvas";

// 描画 ID プレフィックス
const ID_TRACK_LINE_PREFIX = "gpx-track-line-";
const ID_TRACK_START_PREFIX = "gpx-track-start-";
const ID_TRACK_END_PREFIX = "gpx-track-end-";
const ID_WAYPOINT_PREFIX = "gpx-waypoint-";

/** トラックごとの識別色（インデックスを周期的に割り当てる）。 */
const TRACK_COLORS = [
    "#2196f3",
    "#e91e63",
    "#4caf50",
    "#ff9800",
    "#9c27b0",
    "#00bcd4",
];
const colorForTrack = (index: number): string =>
    TRACK_COLORS[index % TRACK_COLORS.length];

/**
 * トラックポリラインの基準太さ（Tube半径, m, world, `lineWidthMode: "screen"` 用）。
 * `"screen"` モードでは頂点ごとにカメラ距離比例のスケールを掛けるため、垂線・点マーカーと
 * 同様にズームに依らず画面上の太さがほぼ一定になる（マーカーの垂線と同じ仕組み）。
 */
const TRACK_LINE_WIDTH = 3;

/** トラックポリライン用の style を組み立てる。 */
const buildTrackLineStyle = (
    color: string,
): NonNullable<PolygonOptions["style"]> => ({
    lineColor: color,
    lineWidth: TRACK_LINE_WIDTH,
    lineWidthMode: "screen",
});

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
    const allPolyIds = [
        ...ids.trackLineIds,
        ...ids.trackStartIds,
        ...ids.trackEndIds,
        ...ids.waypointIds,
    ];
    for (const id of allPolyIds) {
        if (viewer.getPolygon(id)) viewer.removePolygon(id);
    }
};

/**
 * マーカーを地表/トラックより持ち上げる高さ (m)。
 * ズームアップしてトラックのポリラインが太く見える状態でも、
 * マーカーが埋もれず垂線（drop line）で地表位置と結び付けて見えるようにする。
 */
const MARKER_ALTITUDE_OFFSET_M = 20;

/**
 * 単点マーカー（開始/終了/ウェイポイント）用の PolygonOptions を組み立てる。
 * トラックのポリライン（細い線・小さい点）に埋もれて見えなくならないよう、
 * ポイント径・垂線を大きめにし、地表より少し高い位置に浮かせ、
 * ラベルには背景色を付けて視認性を確保する。
 */
const buildMarkerOptions = (
    lat: number,
    lon: number,
    ele: number | null,
    label: string,
    color: string,
): PolygonOptions => ({
    points: [{ lat, lon, altitude: (ele ?? 0) + MARKER_ALTITUDE_OFFSET_M }],
    altitudeMode: ele !== null ? "absolute" : "terrain",
    closed: false,
    labels: [label],
    style: {
        pointColor: color,
        lineColor: color,
        pointDiameter: 28,
        lineWidth: 2,
        dropLineColor: color,
        dropLineWidth: 3,
        labelFontSize: 13,
        labelColor: "#000000",
        labelBackgroundColor: "rgba(255, 255, 255, 0.85)",
        wallColor: color,
        wallOpacity: 0.15,
    },
});

/** GPX をマップに描画し、種別ごとの ID を返す */
const renderGpx = (viewer: JpmapTerrain, gpx: ParsedGpx): GpxIds => {
    const result: GpxIds = {
        trackLineIds: [],
        trackStartIds: [],
        trackEndIds: [],
        waypointIds: [],
    };

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
                const renderPoints = decimatePoints(
                    segment.points,
                    MAX_RENDER_POINTS_PER_SEGMENT,
                );
                const opts: PolygonOptions = {
                    points: renderPoints.map((p) => ({
                        lat: p.lat,
                        lon: p.lon,
                        altitude: hasEle ? (p.ele ?? 0) : 0,
                    })),
                    altitudeMode: hasEle ? "absolute" : "terrain",
                    closed: false,
                    // 点マーカー/垂線/壁/点ラベルは軌跡表示では不要なため無効化する（線のみ表示）。
                    pointsEnabled: false,
                    verticalsEnabled: false,
                    wallsEnabled: false,
                    labelsEnabled: false,
                    style: buildTrackLineStyle(color),
                };
                const id = `${ID_TRACK_LINE_PREFIX}${trackIndex}-${segIndex}`;
                viewer.addPolygon(id, opts);
                result.trackLineIds.push(id);
            });

            // トラック始点・終点のみ強調表示する。
            const firstSeg = track.segments.find((s) => s.points.length > 0);
            const lastSeg = [...track.segments]
                .reverse()
                .find((s) => s.points.length > 0);
            if (firstSeg) {
                const p = firstSeg.points[0];
                const id = `${ID_TRACK_START_PREFIX}${trackIndex}`;
                viewer.addPolygon(
                    id,
                    buildMarkerOptions(
                        p.lat,
                        p.lon,
                        p.ele,
                        `${label}\n開始`,
                        "#4caf50",
                    ),
                );
                result.trackStartIds.push(id);
            }
            if (lastSeg) {
                const p = lastSeg.points[lastSeg.points.length - 1];
                const id = `${ID_TRACK_END_PREFIX}${trackIndex}`;
                viewer.addPolygon(
                    id,
                    buildMarkerOptions(
                        p.lat,
                        p.lon,
                        p.ele,
                        `${label}\n終了`,
                        "#f44336",
                    ),
                );
                result.trackEndIds.push(id);
            }
        });

        gpx.waypoints.forEach((wpt, i) => {
            const id = `${ID_WAYPOINT_PREFIX}${i}`;
            const label = formatWaypointLabel(wpt.name, i);
            viewer.addPolygon(
                id,
                buildMarkerOptions(wpt.lat, wpt.lon, wpt.ele, label, "#ffc107"),
            );
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
        lines.push(formatTrackLabel(track, i));
        lines.push(
            `  水平移動距離: ${formatHorizontalDistance(stats.distanceMeters)}`,
        );
        lines.push(
            `  ↑${formatElevationMeters(stats.elevationGainMeters)} ↓${formatElevationMeters(stats.elevationLossMeters)}` +
                ` (${formatElevationMeters(stats.minElevationMeters)}〜${formatElevationMeters(stats.maxElevationMeters)})`,
        );
        lines.push(`  トラックポイント: ${stats.pointCount} 点`);
    });
    if (gpx.tracks.length > 1) {
        const total = computeGpxStats(gpx.tracks);
        lines.push(
            `合計水平移動距離: ${formatHorizontalDistance(total.distanceMeters)}`,
        );
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
    const elevationPanel = document.getElementById(ELEVATION_PANEL_ID);
    const elevationCanvas = document.getElementById(
        ELEVATION_CANVAS_ID,
    ) as HTMLCanvasElement | null;

    let currentIds: GpxIds = { ...EMPTY_GPX_IDS };
    let currentProfiles: ElevationProfileSeries[] = [];

    /**
     * 標高-時間グラフパネルの位置・幅を、画面左下（写真ボタン）・右下（ズームボタン列・
     * スケールバー）の操作 UI と重ならないよう実測して調整する。
     *
     * これらの操作 UI はタッチ端末/画面幅に応じてサイズが変わる（`controlPanel.ts` の
     * `@media (pointer: coarse)`）ため、固定 px の CSS だけでは重なりを避けきれない。
     * - 左端: 写真ボタン（`.cp-maptoggle`）の右端より右に。
     * - 右端: ズームボタン列（`.cp-zoombtn`、右揃え）の左端より左に。
     * - 下端: スケールバー行（`.cp-scale-text` の親要素。ズームボタン列の下、
     *   右揃えで最も横幅が出るため水平方向は避けず、垂直方向にその上へ浮かせる）
     *   より上に。
     */
    const adjustElevationPanelBounds = (): void => {
        if (!elevationPanel) return;
        const GAP_PX = 12;

        const mapToggleRect =
            document.querySelector(".cp-maptoggle")?.getBoundingClientRect() ??
            null;
        const zoomBtnRects = Array.from(
            document.querySelectorAll(".cp-zoombtn"),
        ).map((el) => el.getBoundingClientRect());
        const scaleRowRect =
            document
                .querySelector(".cp-scale-text")
                ?.parentElement?.getBoundingClientRect() ?? null;

        const leftOffset = mapToggleRect
            ? Math.round(mapToggleRect.right + GAP_PX)
            : GAP_PX;
        const rightOffset =
            zoomBtnRects.length > 0
                ? Math.round(
                      window.innerWidth -
                          Math.min(...zoomBtnRects.map((r) => r.left)) +
                          GAP_PX,
                  )
                : GAP_PX;
        const bottomEdgeTop = scaleRowRect
            ? scaleRowRect.top
            : Math.min(
                  mapToggleRect?.top ?? Infinity,
                  zoomBtnRects.length > 0
                      ? Math.min(...zoomBtnRects.map((r) => r.top))
                      : Infinity,
              );
        const bottomOffset = Math.max(
            GAP_PX,
            Number.isFinite(bottomEdgeTop)
                ? Math.round(window.innerHeight - bottomEdgeTop + GAP_PX)
                : GAP_PX,
        );

        elevationPanel.style.left = `${leftOffset}px`;
        elevationPanel.style.right = `${rightOffset}px`;
        elevationPanel.style.bottom = `${bottomOffset}px`;
    };

    /**
     * 標高-時間グラフを再描画する。時刻情報を持つ点が無い GPX（あるいは未読み込み時）は
     * パネルごと非表示にする（opacity 切替。高さは常に確保しているため canvas サイズは
     * 表示/非表示に関わらず安定している）。
     */
    const redrawElevationChart = (): void => {
        const hasProfiles = currentProfiles.length > 0;
        elevationPanel?.classList.toggle("visible", hasProfiles);
        if (!elevationCanvas) return;
        if (hasProfiles) {
            renderElevationChart(
                elevationCanvas,
                currentProfiles,
                colorForTrack,
            );
        } else {
            clearElevationChart(elevationCanvas);
        }
    };

    adjustElevationPanelBounds();
    window.addEventListener("resize", () => {
        adjustElevationPanelBounds();
        redrawElevationChart();
    });

    // レイヤー表示状態
    const layerVisible = { track: true, waypoints: true };

    const btnTrack = document.getElementById(
        BTN_TRACK_ID,
    ) as HTMLButtonElement | null;
    const btnWaypoints = document.getElementById(
        BTN_WAYPOINTS_ID,
    ) as HTMLButtonElement | null;

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
        for (const id of [
            ...currentIds.trackLineIds,
            ...currentIds.trackStartIds,
            ...currentIds.trackEndIds,
        ]) {
            if (viewer.getPolygon(id))
                viewer.setPolygonEnabled(id, layerVisible.track);
        }
        for (const id of currentIds.waypointIds) {
            if (viewer.getPolygon(id))
                viewer.setPolygonEnabled(id, layerVisible.waypoints);
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
    const firstFlyToTarget = (
        gpx: ParsedGpx,
    ): { lat: number; lon: number } | null => {
        const firstTrack = gpx.tracks.find((t) =>
            t.segments.some((s) => s.points.length > 0),
        );
        if (firstTrack) {
            const firstSeg = firstTrack.segments.find(
                (s) => s.points.length > 0,
            );
            if (firstSeg)
                return {
                    lat: firstSeg.points[0].lat,
                    lon: firstSeg.points[0].lon,
                };
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

            currentProfiles = buildElevationProfiles(gpx.tracks);
            redrawElevationChart();

            const target = firstFlyToTarget(gpx);
            if (target) void viewer.flyTo(target);
        } catch (e) {
            const msg = e instanceof Error ? e.message : "不明なエラー";
            updateStatus(statusEl, null, msg);
            refreshButtons();
            currentProfiles = [];
            redrawElevationChart();
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
