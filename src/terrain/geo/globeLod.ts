/**
 * グローブ（ECEF）向け LOD/SSE タイル選択 (Issue #275 Phase 1)。
 *
 * 平面ワールド前提の `src/terrain/visibleTiles.ts`（Quadtree+SSE）を、グローブ
 * （地心 ECEF）向けに再定義したもの。PoC (#321) を本体共有モジュールへ昇格し、
 * ECEF 変換を Phase 0 の `geo/ecef` に委譲する。
 *
 * 平面版との差分:
 * - タイル距離は AABB との XZ 最短距離＋カメラ高度の合成ではなく、タイル中心 ECEF と
 *   カメラ ECEF の **素直な地心 3D 距離** を使う（地心距離は常に正のため平面版の
 *   `distanceFootprintToPoint` ハックが不要）。
 * - 視錐台 6 平面カリングのかわりに、floating origin 下でも安定する **地平線カリング**
 *   （地心法線とカメラ方向の内積）で裏側タイルを除外する。
 * - SSE 式 `tileSizeMeters * viewportHeight / (distance * 2 tan(fov/2))` は座標系非依存で流用。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { tileCenterLatLon, tileEdgeMeters, toTileXY } from "../gsiTile";
import { ecefToGeodetic, geodeticToEcefToRef } from "./ecef";

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
    /**
     * root タイル（minZoom）の帯の横半幅（lateral）かつ nadir 手前の後方マージン（±N 格子）。
     * 直下視（nadir≒center）では nadir 中心の対称ボックス（一辺 2N+1）状に張る。ただし生成は
     * 常に `maxRootTiles` の予算内に収まり、`maxRootTiles < (2N+1)^2` のときは前景優先で
     * 打ち切られる（対称ボックスを満たし切らない）。
     */
    rootSearchRadius: number;
    /**
     * root 帯に張る minZoom タイル数の予算（上限）。前景（nadir 側）から地平線側へ
     * 帯を張り、予算を使い切ったら地平線側を捨てて前景を残す（水平チルト時の前景被覆を優先）。
     */
    maxRootTiles: number;
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

/** タイル中心の ECEF（基準標高 alt）を ref に書き込み、その緯度経度を返す。 */
const tileCenterEcefToRef = (
    zoom: number,
    x: number,
    y: number,
    alt: number,
    ref: Vector3,
): { lat: number; lon: number } => {
    const { lat, lon } = tileCenterLatLon(x, y, zoom);
    geodeticToEcefToRef(lat, lon, alt, ref);
    return { lat, lon };
};

/** `selectGlobeRootTiles` の入力（root 帯の選定に必要な最小集合）。 */
export interface GlobeRootSeedOptions {
    /** カメラの真の ECEF 位置。 */
    cameraEcef: Vector3;
    /** 注視点（look-at center）の緯度 [deg]。 */
    centerLat: number;
    /** 注視点の経度 [deg]。 */
    centerLon: number;
    /** root（最低）ズーム。 */
    minZoom: number;
    /** 帯の横半幅かつ nadir 手前の後方マージン（±N 格子）。 */
    rootSearchRadius: number;
    /** root タイル数の予算（上限）。 */
    maxRootTiles: number;
}
/**
 * 可視地表を覆う root（minZoom）タイル集合を選定する（Issue #329）。
 *
 * 旧実装は注視点（look-at center）中心の固定 ±N 格子のみを root にしていたため、水平
 * チルト時にカメラ直下（nadir）の前景がこの領域の外へ出てタイルが生成されなかった。
 * 本関数は **カメラ直下点（nadir）から注視点（center）を通り地平線方向へ伸びる帯**
 * （ground track に沿う swath）に root を張る:
 * - nadir と center の minZoom タイル座標を結ぶ方向を along-track、その直交を lateral とする。
 * - along-track は nadir 手前 `rootSearchRadius` から、center を越え地平線側へ `2*dirLen`
 *   ＋マージンまで（dirLen = nadir↔center のタイル距離）。lateral は ±`rootSearchRadius`。
 * - 前景（nadir 側）から順に張り、`maxRootTiles` を使い切ったら地平線側を捨てる（前景優先）。
 * - 直下視（nadir≒center で方向が定まらない）では nadir 中心の対称ボックスにフォールバックし、
 *   旧来の中心アンカー挙動を保つ。
 *
 * 地平線側の被覆過多や裏側は後段の地平線カリング・SSE・maxTiles 打ち切りで間引かれる。
 */
export const selectGlobeRootTiles = (
    opts: GlobeRootSeedOptions,
): { x: number; y: number }[] => {
    const { cameraEcef, centerLat, centerLon, minZoom, rootSearchRadius, maxRootTiles } =
        opts;
    const margin = Math.max(0, rootSearchRadius);
    const budget = Math.max(1, maxRootTiles);

    // カメラ直下点（nadir, 前景）と注視点（center）の minZoom タイル座標。
    const nadir = ecefToGeodetic(cameraEcef);
    const t0 = toTileXY(nadir.latDeg, nadir.lonDeg, minZoom);
    const t1 = toTileXY(centerLat, centerLon, minZoom);

    // x（経度方向）は日付変更線で巡回する（2^minZoom タイル周期）。単純差分だと境界を
    // またいだとき t0.x=2047/t1.x=0 のように巨大な dx になり帯の方向・長さが壊れるため、
    // 最短符号付き差分（[-n/2, n/2)）に正規化する。y（メルカトル緯度）は巡回しない。
    const n = 2 ** minZoom;
    let dx = ((((t1.x - t0.x) % n) + n) % n);
    if (dx > n / 2) dx -= n;
    const dy = t1.y - t0.y;
    const dirLen = Math.hypot(dx, dy);

    // along-track（帯の進行方向）と lateral（直交方向）の単位ベクトル。直下視で方向が
    // 定まらない（dirLen≒0）ときは nadir 中心の対称ボックスへフォールバックする。
    let ux = 1;
    let uy = 0;
    let px = 0;
    let py = 1;
    if (dirLen > 1e-6) {
        ux = dx / dirLen;
        uy = dy / dirLen;
        px = -uy;
        py = ux;
    }

    const seeds: { x: number; y: number }[] = [];
    const seen = new Set<string>();
    const add = (x: number, y: number): void => {
        if (seeds.length >= budget) return;
        // y（メルカトル緯度）は巡回しない。範囲外（極側のはみ出し）は無効タイルなので捨て、
        // 予算を浪費しない。x（経度）は巡回するため範囲内へ正規化する。
        if (y < 0 || y >= n) return;
        const wx = ((x % n) + n) % n;
        const key = `${wx},${y}`;
        if (seen.has(key)) return;
        seen.add(key);
        seeds.push({ x: wx, y });
    };
    /** along-track 位置 s の lateral 断面（±margin）を張る。 */
    const addCrossSection = (s: number): void => {
        const cx = t0.x + ux * s;
        const cy = t0.y + uy * s;
        for (let w = -margin; w <= margin; w++) {
            add(Math.round(cx + px * w), Math.round(cy + py * w));
        }
    };

    // nadir と center の root タイルは予算内で最優先に確保する（前景=nadir を最優先、
    // 次に視界中心=center）。これにより maxRootTiles が小さい／nadir↔center が遠いケースで
    // 帯が center に届く前に予算切れになっても、視界中心が root 領域外にならない。
    // budget=1 では nadir のみ確保される。
    add(t0.x, t0.y);
    add(t1.x, t1.y);

    // 残り予算で nadir(s=0) を起点に、center を越え地平線側へ 2*dirLen + margin まで前進。
    // 前景を優先して張り、予算を使い切ったら地平線側を捨てる。最後に nadir 手前のマージン
    // （s<0）を埋める。既出タイル（nadir/center 等）は seen でデデュプされる。
    const alongEnd = Math.round(2 * dirLen) + margin;
    for (let s = 0; s <= alongEnd && seeds.length < budget; s++) addCrossSection(s);
    for (let s = -1; s >= -margin && seeds.length < budget; s--) addCrossSection(s);
    return seeds;
};

/**
 * グローブ向け Quadtree+SSE でカメラ近傍の可視タイルを選択する。
 *
 * root は `selectGlobeRootTiles` が選ぶ「nadir→center→地平線」の帯（Issue #329）。
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
        maxRootTiles,
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
        // 裏側（地球の向こう側）のタイルを除外する。camDir は正規化済みなので
        // dot(normalize(tileEcef), camDir) = dot(tileEcef, camDir) / |tileEcef| として
        // 計算し、ホットパスでの Vector3 割り当て（clone/normalize）を避ける。
        const tileLen = tileEcef.length();
        const horizonDot =
            tileLen > 0 ? Vector3.Dot(tileEcef, camDir) / tileLen : 0;
        if (horizonDot < horizonDotThreshold) return;

        const distance = Vector3.Distance(cameraEcef, tileEcef);
        const tileSizeMeters = tileEdgeMeters(lat, zoom);

        const accept =
            zoom >= maxZoom ||
            (tileSizeMeters * viewportHeight) /
                (Math.max(1, distance) * sseDenomBase) <=
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

    const roots = selectGlobeRootTiles({
        cameraEcef,
        centerLat,
        centerLon,
        minZoom,
        rootSearchRadius,
        maxRootTiles,
    });
    for (const r of roots) traverse(minZoom, r.x, r.y);

    accepted.sort((a, b) => a.distance - b.distance);
    return accepted.slice(0, maxTiles);
};

/** タイル一意キー（"z/x/y"）。 */
export const tileKey = (zoom: number, x: number, y: number): string =>
    `${zoom}/${x}/${y}`;
