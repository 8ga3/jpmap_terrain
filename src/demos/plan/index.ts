/**
 * Plan Viewer デモ
 *
 * QGroundControl の `.plan` ファイルをドラッグ&ドロップで読み込み、
 * ウェイポイント・ジオフェンス・ラリーポイントをマップ上に表示する。
 *
 * - ビューア専用（編集なし）
 * - 再ドロップで前回表示をクリアし、新しい Plan のみ表示
 * - 描画は distance デモと同じ addPolygon / addCircle API を使用
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type {
    JpmapTerrainOptions,
    PolygonOptions,
    CircleOptions,
} from "../../lib/types";
import { CIRCLE_RADIUS_MAX_M } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
    resolveTerrainEngine,
} from "../../terrain/urlState";
import { parsePlan } from "./parsePlan";
import type { ParsedPlan } from "./parsePlan";
import {
    formatWaypointLabel,
    formatWaypointEdgeLabel,
    formatRallyPointLabel,
    formatHomePositionLabel,
} from "./utils";

const DEMO_MOUNT_ID = "root";
const STATUS_ID = "plan-status";
const DROP_ZONE_ID = "plan-drop-zone";
const BTN_WAYPOINTS_ID = "btn-waypoints";
const BTN_GEOFENCE_ID = "btn-geofence";
const BTN_RALLY_ID = "btn-rally";
const BTN_VIEW_MODE_ID = "btn-view-mode";

// 描画 ID プレフィックス
const ID_WAYPOINTS = "plan-waypoints";
const ID_HOME = "plan-home";
const ID_GEOFENCE_POLYGON_PREFIX = "plan-geofence-poly-";
const ID_GEOFENCE_CIRCLE_PREFIX = "plan-geofence-circle-";
const ID_RALLY_PREFIX = "plan-rally-";

/** 種別ごとの描画 ID セット */
interface PlanIds {
    homeId: string | null;
    waypointIds: string[];
    geofencePolyIds: string[];
    geofenceCircleIds: string[];
    rallyIds: string[];
}

const EMPTY_PLAN_IDS: PlanIds = {
    homeId: null,
    waypointIds: [],
    geofencePolyIds: [],
    geofenceCircleIds: [],
    rallyIds: [],
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

/** 既存の Plan 描画をすべて削除する */
const clearPlanDisplay = (viewer: JpmapTerrain, ids: PlanIds): void => {
    const allPolyIds = [
        ...(ids.homeId ? [ids.homeId] : []),
        ...ids.waypointIds,
        ...ids.geofencePolyIds,
        ...ids.rallyIds,
    ];
    for (const id of allPolyIds) {
        if (viewer.getPolygon(id)) viewer.removePolygon(id);
    }
    for (const id of ids.geofenceCircleIds) {
        if (viewer.getCircle(id)) viewer.removeCircle(id);
    }
};

/** Plan をマップに描画し、種別ごとの ID を返す */
const renderPlan = (viewer: JpmapTerrain, plan: ParsedPlan): PlanIds => {
    const result: PlanIds = {
        homeId: null,
        waypointIds: [],
        geofencePolyIds: [],
        geofenceCircleIds: [],
        rallyIds: [],
    };

    try {
        // ホームポジション
        if (plan.homePosition) {
            const hp = plan.homePosition;
            const opts: PolygonOptions = {
                points: [{ lat: hp.lat, lon: hp.lon, altitude: hp.altitude }],
                altitudeMode: "absolute",
                closed: false,
                labels: [formatHomePositionLabel(hp.altitude)],
                style: {
                    pointColor: "#4caf50",
                    lineColor: "#4caf50",
                    pointDiameter: 16,
                    lineWidth: 2,
                    labelFontSize: 12,
                    wallColor: "#4caf50",
                    wallOpacity: 0.15,
                },
            };
            viewer.addPolygon(ID_HOME, opts);
            result.homeId = ID_HOME;
        }

        // ウェイポイント（パスライン）
        if (plan.waypoints.length > 0) {
            const points = plan.waypoints.map((wp) => ({
                lat: wp.lat,
                lon: wp.lon,
                altitude: wp.altitude,
            }));
            const labels = plan.waypoints.map((wp) => formatWaypointLabel(wp));
            const edgeLabels: (string | undefined)[] = [];
            for (let i = 0; i < plan.waypoints.length - 1; i++) {
                edgeLabels.push(
                    formatWaypointEdgeLabel(
                        plan.waypoints[i],
                        plan.waypoints[i + 1],
                    ),
                );
            }

            const opts: PolygonOptions = {
                points,
                altitudeMode: "absolute",
                closed: false,
                labels,
                edgeLabels,
                style: {
                    pointColor: "#2196f3",
                    lineColor: "#2196f3",
                    pointDiameter: 12,
                    lineWidth: 2,
                    labelFontSize: 12,
                    wallColor: "#2196f3",
                    wallOpacity: 0.15,
                },
            };
            viewer.addPolygon(ID_WAYPOINTS, opts);
            result.waypointIds.push(ID_WAYPOINTS);
        }

        // ジオフェンスポリゴン
        // absolute モードで描画する。terrain モードだと遠方頂点のタイル未ロード時に
        // 描画されないため、ホーム高度を基準にした絶対高度で即時表示する。
        const geofenceAlt = (plan.homePosition?.altitude ?? 0) + 10;
        plan.geoFencePolygons.forEach((poly, i) => {
            const id = `${ID_GEOFENCE_POLYGON_PREFIX}${i}`;
            const color = poly.inclusion ? "#4caf50" : "#f44336";
            const opts: PolygonOptions = {
                points: poly.points.map((p) => ({
                    lat: p.lat,
                    lon: p.lon,
                    altitude: geofenceAlt,
                })),
                altitudeMode: "absolute",
                closed: true,
                style: {
                    pointColor: color,
                    lineColor: color,
                    pointDiameter: 0,
                    lineWidth: 2,
                    wallColor: color,
                    wallOpacity: 0.2,
                },
            };
            viewer.addPolygon(id, opts);
            result.geofencePolyIds.push(id);
        });

        // ジオフェンス円
        plan.geoFenceCircles.forEach((circ, i) => {
            const id = `${ID_GEOFENCE_CIRCLE_PREFIX}${i}`;
            const color = circ.inclusion ? "#4caf50" : "#f44336";
            const radius = Math.min(circ.radius, CIRCLE_RADIUS_MAX_M);
            const opts: CircleOptions = {
                center: {
                    lat: circ.center.lat,
                    lon: circ.center.lon,
                    altitude: geofenceAlt,
                },
                radius,
                altitudeMode: "absolute",
                label: null,
                pointEnabled: false,
                style: {
                    lineColor: color,
                    lineWidth: 2,
                    wallColor: color,
                    wallOpacity: 0.2,
                },
            };
            viewer.addCircle(id, opts);
            result.geofenceCircleIds.push(id);
        });

        // ラリーポイント
        plan.rallyPoints.forEach((rp) => {
            const id = `${ID_RALLY_PREFIX}${rp.number}`;
            const opts: PolygonOptions = {
                points: [{ lat: rp.lat, lon: rp.lon, altitude: rp.altitude }],
                altitudeMode: "absolute",
                closed: false,
                labels: [formatRallyPointLabel(rp.number)],
                style: {
                    pointColor: "#ff9800",
                    lineColor: "#ff9800",
                    pointDiameter: 16,
                    lineWidth: 2,
                    labelFontSize: 12,
                    wallColor: "#ff9800",
                    wallOpacity: 0.15,
                },
            };
            viewer.addPolygon(id, opts);
            result.rallyIds.push(id);
        });
    } catch (err) {
        // 描画途中で例外が発生した場合、追加済みオブジェクトをロールバック削除して再スロー
        clearPlanDisplay(viewer, result);
        throw err;
    }

    return result;
};

const updateStatus = (
    statusEl: HTMLElement | null,
    plan: ParsedPlan | null,
    error?: string,
): void => {
    if (!statusEl) return;
    if (error) {
        statusEl.textContent = `エラー: ${error}`;
        return;
    }
    if (!plan) {
        statusEl.textContent = ".plan ファイルをドラッグ&ドロップしてください";
        return;
    }
    const lines: string[] = [];
    lines.push(`ウェイポイント: ${plan.waypoints.length} 点`);
    if (plan.geoFencePolygons.length > 0) {
        lines.push(`ジオフェンス(ポリゴン): ${plan.geoFencePolygons.length}`);
    }
    if (plan.geoFenceCircles.length > 0) {
        lines.push(`ジオフェンス(円): ${plan.geoFenceCircles.length}`);
    }
    if (plan.rallyPoints.length > 0) {
        lines.push(`ラリーポイント: ${plan.rallyPoints.length}`);
    }
    statusEl.textContent = lines.join("\n");
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }

    const engine = resolveEngine(location.search);
    const terrainEngine = resolveTerrainEngine(location.search);
    const cameraState = parseCameraStateFromUrl(location.href) ?? undefined;
    const mapType = parseMapTypeFromUrl(location.href);
    const defaultCamera = {
        lat: 35.6242625,
        lon: 139.5148162,
        altitude: 1500,
        azimuth: 0,
        tilt: 55,
    };

    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        ...(terrainEngine ? { terrainEngine } : {}),
        ...(cameraState ?? defaultCamera),
        ...(mapType !== null ? { mapType } : {}),
        showViewModeButton: false,
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    const statusEl = document.getElementById(STATUS_ID);
    const dropZone = document.getElementById(DROP_ZONE_ID);

    let currentIds: PlanIds = { ...EMPTY_PLAN_IDS };

    // レイヤー表示状態
    const layerVisible = { waypoints: true, geofence: true, rally: true };

    // ボタン要素
    const btnViewMode = document.getElementById(BTN_VIEW_MODE_ID) as HTMLButtonElement | null;
    const btnWaypoints = document.getElementById(BTN_WAYPOINTS_ID) as HTMLButtonElement | null;
    const btnGeofence = document.getElementById(BTN_GEOFENCE_ID) as HTMLButtonElement | null;
    const btnRally = document.getElementById(BTN_RALLY_ID) as HTMLButtonElement | null;

    // 2D/3D 視点モード切替
    const refreshViewModeBtn = (): void => {
        if (btnViewMode) {
            const label = viewer.viewMode === "3d" ? "2D 表示" : "3D 表示";
            btnViewMode.textContent = label;
            btnViewMode.setAttribute("aria-label", label);
        }
    };
    if (btnViewMode) {
        btnViewMode.addEventListener("click", () => {
            viewer.viewMode = viewer.viewMode === "3d" ? "2d" : "3d";
        });
        btnViewMode.disabled = false;
    }
    viewer.onViewModeChange(() => refreshViewModeBtn());
    refreshViewModeBtn();

    const refreshButtons = (hasPlan: boolean): void => {
        if (btnWaypoints) {
            btnWaypoints.disabled = !hasPlan;
            btnWaypoints.dataset.active = String(layerVisible.waypoints);
        }
        if (btnGeofence) {
            btnGeofence.disabled = !hasPlan;
            btnGeofence.dataset.active = String(layerVisible.geofence);
        }
        if (btnRally) {
            btnRally.disabled = !hasPlan;
            btnRally.dataset.active = String(layerVisible.rally);
        }
    };

    const applyLayerVisibility = (): void => {
        if (currentIds.homeId) {
            if (viewer.getPolygon(currentIds.homeId)) viewer.setPolygonEnabled(currentIds.homeId, layerVisible.waypoints);
        }
        for (const id of currentIds.waypointIds) {
            if (viewer.getPolygon(id)) viewer.setPolygonEnabled(id, layerVisible.waypoints);
        }
        for (const id of [...currentIds.geofencePolyIds]) {
            if (viewer.getPolygon(id)) viewer.setPolygonEnabled(id, layerVisible.geofence);
        }
        for (const id of currentIds.geofenceCircleIds) {
            if (viewer.getCircle(id)) viewer.setCircleEnabled(id, layerVisible.geofence);
        }
        for (const id of currentIds.rallyIds) {
            if (viewer.getPolygon(id)) viewer.setPolygonEnabled(id, layerVisible.rally);
        }
    };

    if (btnWaypoints) {
        btnWaypoints.addEventListener("click", () => {
            layerVisible.waypoints = !layerVisible.waypoints;
            applyLayerVisibility();
            refreshButtons(true);
        });
    }
    if (btnGeofence) {
        btnGeofence.addEventListener("click", () => {
            layerVisible.geofence = !layerVisible.geofence;
            applyLayerVisibility();
            refreshButtons(true);
        });
    }
    if (btnRally) {
        btnRally.addEventListener("click", () => {
            layerVisible.rally = !layerVisible.rally;
            applyLayerVisibility();
            refreshButtons(true);
        });
    }

    const loadPlan = (fileContent: string): void => {
        // 前回表示をクリア
        clearPlanDisplay(viewer, currentIds);
        currentIds = { ...EMPTY_PLAN_IDS };
        // 表示状態をリセット
        layerVisible.waypoints = true;
        layerVisible.geofence = true;
        layerVisible.rally = true;

        try {
            const json = JSON.parse(fileContent) as unknown;
            const plan = parsePlan(json);
            currentIds = renderPlan(viewer, plan);
            updateStatus(statusEl, plan);
            refreshButtons(true);

            // ウェイポイントがある場合、最初のウェイポイント位置にカメラを移動
            if (plan.waypoints.length > 0) {
                const first = plan.waypoints[0];
                void viewer.flyTo({ lat: first.lat, lon: first.lon });
            } else if (plan.rallyPoints.length > 0) {
                const first = plan.rallyPoints[0];
                void viewer.flyTo({ lat: first.lat, lon: first.lon });
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : "不明なエラー";
            updateStatus(statusEl, null, msg);
            refreshButtons(false);
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
                loadPlan(reader.result);
            }
        };
        reader.onerror = () => {
            updateStatus(statusEl, null, "ファイルの読み込みに失敗しました");
        };
        reader.readAsText(file);
    });

    updateStatus(statusEl, null);

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
    }
};

if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain plan demo] failed to start:", err);
    });
}
