/**
 * QGroundControl Plan ファイルパーサ (#38)
 *
 * `.plan` JSON を受け取り、描画に必要な Mission / GeoFence / RallyPoint 情報を抽出する。
 * MAV_CMD のうち NAV_WAYPOINT(16) / NAV_LAND(21) / NAV_TAKEOFF(22) のみをウェイポイントとして扱い、
 * それ以外はスキップする。高度は MAV_FRAME に基づきホームポジションからの相対高度として解決する。
 */

// ---- QGC Plan JSON スキーマ型定義 ----

/** Plan ファイルトップレベル */
export interface QgcPlanFile {
    /** QGC v4.x 形式ではトップレベルに存在。v3.x 以前は version がトップレベルに直接ある場合も。 */
    fileHeader?: { version: number };
    /** QGC v3.x の一部バージョンではトップレベルに version が直接ある */
    version?: number;
    mission: QgcMission;
    geoFence?: QgcGeoFence;
    rallyPoints?: QgcRallyPoints;
}

/** Mission セクション */
export interface QgcMission {
    plannedHomePosition?: [number, number, number]; // [lat, lon, alt]
    items: QgcMissionItem[];
}

/** Mission アイテム（個々のコマンド） */
export interface QgcMissionItem {
    command: number;
    frame: number;
    params: (number | null)[];
    /** autoContinue */
    autoContinue?: boolean;
    /** MAV_CMD type label (informational) */
    type?: string;
    /**
     * QGC 固有の座標フィールド。
     * items[].coordinate = [lat, lon, alt] (QGC v4.x+)
     * items[].params[4..6] = [lat, lon, alt] (QGC v3.x fallback)
     */
    coordinate?: [number, number, number];
}

/** GeoFence セクション */
export interface QgcGeoFence {
    polygons?: QgcGeoFencePolygon[];
    circles?: QgcGeoFenceCircle[];
}

export interface QgcGeoFencePolygon {
    inclusion: boolean;
    polygon: [number, number][]; // [[lat, lon], ...]
    version?: number;
}

export interface QgcGeoFenceCircle {
    inclusion: boolean;
    circle: { center: [number, number]; radius: number };
    version?: number;
}

/** Rally Points セクション */
export interface QgcRallyPoints {
    points: [number, number, number][]; // [[lat, lon, alt], ...]
    version?: number;
}

// ---- パース結果型 ----

export interface ParsedWaypoint {
    /** 1-based 表示番号（スキップ分を除く） */
    number: number;
    lat: number;
    lon: number;
    /** ホームポジション相対の絶対高度 (m) */
    altitude: number;
    command: number;
}

export interface ParsedGeoFencePolygon {
    inclusion: boolean;
    points: { lat: number; lon: number }[];
}

export interface ParsedGeoFenceCircle {
    inclusion: boolean;
    center: { lat: number; lon: number };
    radius: number;
}

export interface ParsedRallyPoint {
    /** 1-based 表示番号 */
    number: number;
    lat: number;
    lon: number;
    altitude: number;
}

export interface ParsedPlan {
    homePosition: { lat: number; lon: number; altitude: number } | null;
    waypoints: ParsedWaypoint[];
    geoFencePolygons: ParsedGeoFencePolygon[];
    geoFenceCircles: ParsedGeoFenceCircle[];
    rallyPoints: ParsedRallyPoint[];
}

// ---- 定数 ----

/** ウェイポイントとして描画する MAV_CMD */
export const WAYPOINT_COMMANDS = new Set([
    16, // MAV_CMD_NAV_WAYPOINT
    21, // MAV_CMD_NAV_LAND
    22, // MAV_CMD_NAV_TAKEOFF
]);

// ---- パースロジック ----

/**
 * Mission item から座標 (lat, lon, alt) を抽出する。
 * QGC v4+ は `coordinate` フィールド、v3 以前は `params[4..6]` にフォールバック。
 *
 * lat=0 かつ lon=0 はQGCにおける「ホームポジションで実行」を意味する。
 * homePosition が指定されていればホーム座標・相対高度 0（地表）に置換して返す。
 * homePosition が null の場合は従来通り null を返しスキップする。
 */
const extractCoordinate = (
    item: QgcMissionItem,
    homePosition: ParsedPlan["homePosition"],
): { lat: number; lon: number; alt: number } | null => {
    let lat: number | null = null;
    let lon: number | null = null;
    let alt: number | null = null;

    if (item.coordinate && item.coordinate.length >= 3) {
        lat = item.coordinate[0];
        lon = item.coordinate[1];
        alt = item.coordinate[2];
    } else if (item.params && item.params.length >= 7) {
        // params fallback: [p1, p2, p3, p4, lat(x), lon(y), alt(z)]
        lat = item.params[4];
        lon = item.params[5];
        alt = item.params[6];
    }

    if (lat === null || lon === null || alt === null) return null;
    // lat=0 かつ lon=0 はホームポジション指定（QGC 仕様）
    if (lat === 0 && lon === 0) {
        if (!homePosition) return null;
        return { lat: homePosition.lat, lon: homePosition.lon, alt: 0 };
    }
    return { lat, lon, alt };
};

/**
 * QGC Plan JSON をパースし、描画用データを返す。
 *
 * @throws JSON 構造が不正な場合 Error
 */
export const parsePlan = (json: unknown): ParsedPlan => {
    if (typeof json !== "object" || json === null) {
        throw new Error("Invalid plan file: not an object");
    }
    const plan = json as QgcPlanFile;

    if (!plan.mission) {
        throw new Error("Invalid plan file: missing mission section");
    }
    if (!Array.isArray(plan.mission.items)) {
        throw new Error("Invalid plan file: mission.items is missing or not an array");
    }

    // ホームポジション
    let homePosition: ParsedPlan["homePosition"] = null;
    const hp = plan.mission.plannedHomePosition;
    if (hp && hp.length >= 3) {
        homePosition = { lat: hp[0], lon: hp[1], altitude: hp[2] };
    }

    // ウェイポイント
    const waypoints: ParsedWaypoint[] = [];
    let waypointNumber = 0;
    for (const item of plan.mission.items) {
        if (!WAYPOINT_COMMANDS.has(item.command)) continue;
        const coord = extractCoordinate(item, homePosition);
        if (!coord) continue;

        waypointNumber++;
        // MAV_FRAME: ホームポジション相対 → 絶対高度
        const homeAlt = homePosition?.altitude ?? 0;
        const altitude = coord.alt + homeAlt;

        waypoints.push({
            number: waypointNumber,
            lat: coord.lat,
            lon: coord.lon,
            altitude,
            command: item.command,
        });
    }

    // ジオフェンス
    const geoFencePolygons: ParsedGeoFencePolygon[] = [];
    const geoFenceCircles: ParsedGeoFenceCircle[] = [];
    if (plan.geoFence) {
        if (plan.geoFence.polygons) {
            for (const poly of plan.geoFence.polygons) {
                if (!poly.polygon || poly.polygon.length < 3) continue;
                geoFencePolygons.push({
                    inclusion: poly.inclusion,
                    points: poly.polygon.map(([lat, lon]) => ({ lat, lon })),
                });
            }
        }
        if (plan.geoFence.circles) {
            for (const circ of plan.geoFence.circles) {
                if (!circ.circle) continue;
                const center = circ.circle.center;
                if (!center || center.length < 2) continue;
                geoFenceCircles.push({
                    inclusion: circ.inclusion,
                    center: { lat: center[0], lon: center[1] },
                    radius: circ.circle.radius,
                });
            }
        }
    }

    // ラリーポイント
    const rallyPoints: ParsedRallyPoint[] = [];
    if (plan.rallyPoints?.points) {
        let rallyNumber = 0;
        for (const pt of plan.rallyPoints.points) {
            if (!pt || pt.length < 3) continue;
            rallyNumber++;
            const homeAlt = homePosition?.altitude ?? 0;
            rallyPoints.push({
                number: rallyNumber,
                lat: pt[0],
                lon: pt[1],
                altitude: pt[2] + homeAlt,
            });
        }
    }

    return {
        homePosition,
        waypoints,
        geoFencePolygons,
        geoFenceCircles,
        rallyPoints,
    };
};
