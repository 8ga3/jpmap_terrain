/**
 * Geospatial PoC: グローブ向け LOD/SSE 選択 (Issue #321 / 親 #275)
 *
 * production の `src/terrain/visibleTiles.ts`（平面ワールド前提の Quadtree+SSE）を
 * **グローブ（ECEF）向けに再定義した PoC 実装**。production には依存・改修しない。
 *
 * 平面版との差分（= 移行で再定義が必要な箇所の検証）:
 * - タイル距離は AABB との XZ 最短距離＋カメラ高度の合成ではなく、
 *   タイル中心 ECEF とカメラ ECEF の **素直な地心 3D 距離** を使う。
 *   （平面版の `distanceFootprintToPoint` は「カメラが Y 拡張 AABB 内に入ると D=0」を
 *     避けるためのハックで、グローブでは地心距離が常に正のため不要。）
 * - 視錐台 6 平面カリングのかわりに、PoC では floating origin 下でも安定する
 *   **地平線カリング（地心法線とカメラ方向の内積）** で裏側タイルを除外する。
 * - SSE 式そのもの（`tileSizeMeters * viewportHeight / (distance * 2 tan(fov/2))`）は
 *   座標系非依存でそのまま流用できる。
 */
import {
    Wgs84Ellipsoid,
    EcefFromLatLonAltToRef,
} from "@babylonjs/core/Maths/math.geospatial.functions";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { tileCenterLatLon, tileEdgeMeters, toTileXY } from "../../terrain/gsiTile";

const DEG2RAD = Math.PI / 180;

/** LOD 選択されたタイル。 */
export interface GlobeTile {
    zoom: number;
    x: number;
    y: number;
    /** タイル 1 辺の実距離 [m]（メッシュ生成・距離評価に流用可）。 */
    tileSizeMeters: number;
    /** カメラ ECEF からタイル中心 ECEF までの距離 [m]（maxTiles 打ち切り用）。 */
    distance: number;
}

export interface GlobeLodOptions {
    /** カメラの真の ECEF 位置。 */
    cameraEcef: Vector3;
    /** 中心緯度 [deg]（root 探索の中心）。 */
    centerLat: number;
    /** 中心経度 [deg]。 */
    centerLon: number;
    /** 最低ズーム（root）。 */
    minZoom: number;
    /** 最高ズーム（分割上限）。 */
    maxZoom: number;
    /** ビューポート高さ [px]。 */
    viewportHeight: number;
    /** 垂直 FOV [rad]。 */
    verticalFov: number;
    /** SSE 採用しきい値 [px]。大きいほど粗いタイルを早期受容。 */
    sseThreshold: number;
    /** 結果タイル数の上限。 */
    maxTiles: number;
    /** root タイル（minZoom）の探索半径（±N 格子）。 */
    rootSearchRadius: number;
    /**
     * 地平線カリングの内積しきい値。
     * `dot(normalize(tileEcef), normalize(cameraEcef)) < threshold` のタイルを裏側として除外。
     * 0 で半球、負値で地平線の少し裏まで許容。
     */
    horizonDotThreshold: number;
    /**
     * SSE 距離評価に使うタイル中心の基準標高[m]。
     * 高標高地（富士山等）では実地表が海面より高く、タイル中心を alt=0 で評価すると
     * カメラ↔タイルの距離が過大になり LOD が上がらない。中心付近の地形標高を渡すことで
     * 距離が地表基準になり、近接時に高 zoom が選択される。省略時 0。
     */
    referenceAltitude?: number;
}

/** タイル中心の ECEF（基準標高 alt）を ref に書き込む。 */
const tileCenterEcefToRef = (
    zoom: number,
    x: number,
    y: number,
    alt: number,
    ref: Vector3,
): { lat: number; lon: number } => {
    const { lat, lon } = tileCenterLatLon(x, y, zoom);
    EcefFromLatLonAltToRef(
        { lat: lat * DEG2RAD, lon: lon * DEG2RAD, alt },
        Wgs84Ellipsoid,
        ref,
    );
    return { lat, lon };
};

/**
 * グローブ向け Quadtree+SSE でカメラ近傍の可視タイルを選択する。
 *
 * root は中心 lat/lon の minZoom タイルを中心に ±rootSearchRadius 格子。
 * 各ノードで「地平線カリング → SSE 判定」を行い、受容 or 4 子へ分割。
 * 最後にカメラ距離の昇順で maxTiles 件に打ち切る。
 */
export const selectGlobeTiles = (opts: GlobeLodOptions): GlobeTile[] => {
    const {
        cameraEcef,
        centerLat,
        centerLon,
        minZoom,
        maxZoom,
        viewportHeight,
        verticalFov,
        sseThreshold,
        maxTiles,
        rootSearchRadius,
        horizonDotThreshold,
        referenceAltitude = 0,
    } = opts;

    if (maxZoom < minZoom) return [];

    const tanHalfFov = Math.max(1e-6, Math.tan(verticalFov / 2));
    const sseDenomBase = 2 * tanHalfFov;
    const camDir = cameraEcef.clone().normalize();

    const accepted: GlobeTile[] = [];
    const tileEcef = new Vector3();
    // 暴発防止の訪問上限。
    const maxVisited = Math.max(maxTiles, 256) * 32;
    let visited = 0;

    const traverse = (zoom: number, x: number, y: number): void => {
        if (visited >= maxVisited) return;
        visited++;

        const limit = 1 << zoom;
        if (x < 0 || x >= limit || y < 0 || y >= limit) return;

        const { lat } = tileCenterEcefToRef(zoom, x, y, referenceAltitude, tileEcef);

        // 地平線カリング: タイルの地心法線（= normalize(tileEcef)）とカメラ方向の内積。
        // 裏側（地球の向こう側）のタイルを除外する。
        const tileDir = tileEcef.clone().normalize();
        if (Vector3.Dot(tileDir, camDir) < horizonDotThreshold) return;

        const distance = Vector3.Distance(cameraEcef, tileEcef);
        const tileSizeMeters = tileEdgeMeters(lat, zoom);

        const accept =
            zoom >= maxZoom ||
            (tileSizeMeters * viewportHeight) / (Math.max(1, distance) * sseDenomBase) <=
                sseThreshold;

        if (accept) {
            accepted.push({ zoom, x, y, tileSizeMeters, distance });
            return;
        }

        const nz = zoom + 1;
        for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
                traverse(nz, x * 2 + sx, y * 2 + sy);
            }
        }
    };

    const root = toTileXY(centerLat, centerLon, minZoom);
    for (let dy = -rootSearchRadius; dy <= rootSearchRadius; dy++) {
        for (let dx = -rootSearchRadius; dx <= rootSearchRadius; dx++) {
            traverse(minZoom, root.x + dx, root.y + dy);
        }
    }

    accepted.sort((a, b) => a.distance - b.distance);
    return accepted.slice(0, maxTiles);
};

/** タイル一意キー。 */
export const tileKey = (zoom: number, x: number, y: number): string =>
    `${zoom}/${x}/${y}`;
