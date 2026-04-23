/** カメラFrustum内の可視タイルを算出する */

import { TileCoord, TileKey, toTileKey, tileOffsetToWorld, convertTileZoom, computeSubTileOffset } from "./tileTypes";

export interface FrustumPlane {
    normal: { x: number; y: number; z: number };
    d: number;
}

export interface VisibleTilesOptions {
    center: TileCoord;
    tileSize: number;
    frustumPlanes: readonly FrustumPlane[];
    maxTiles?: number;
    searchRadius?: number;
    /** AABB の maxY に使う値。省略時は DEFAULT_MAX_ELEVATION (4000) */
    maxElevation?: number;
}

const DEFAULT_MAX_TILES = 50;
/** coveredBaseZoomCells / findUncoveredChildren で許容するzoom差の上限 */
const MAX_COVERAGE_DIFF = 7;
const DEFAULT_SEARCH_RADIUS = 4;
/** 日本の標高上限概算（富士山 3776m + マージン） */
const DEFAULT_MAX_ELEVATION = 4000;

/** AABB が Frustum の全平面の内側または交差にあるか判定 */
const isAABBInFrustum = (
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    planes: readonly FrustumPlane[]
): boolean => {
    for (const plane of planes) {
        const { normal, d } = plane;
        // AABB の「平面に最も近い頂点」（P-vertex）を選択
        const px = normal.x >= 0 ? maxX : minX;
        const py = normal.y >= 0 ? maxY : minY;
        const pz = normal.z >= 0 ? maxZ : minZ;
        // P-vertex が平面の外側なら完全に外
        if (normal.x * px + normal.y * py + normal.z * pz + d < 0) {
            return false;
        }
    }
    return true;
};

/**
 * カメラ Frustum 内の可視タイル座標を返す。
 * 距離が近い順にソート済み、maxTiles で打ち切り。
 */
export const computeVisibleTiles = (opts: VisibleTilesOptions): TileCoord[] => {
    const {
        center,
        tileSize,
        frustumPlanes,
        maxTiles = DEFAULT_MAX_TILES,
        searchRadius = DEFAULT_SEARCH_RADIUS,
        maxElevation = DEFAULT_MAX_ELEVATION,
    } = opts;

    const half = tileSize / 2;
    const candidates: { coord: TileCoord; dist: number }[] = [];

    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
            const { wx, wz } = tileOffsetToWorld(dx, dy, tileSize);
            const minX = wx - half;
            const maxX = wx + half;
            const minZ = wz - half;
            const maxZ = wz + half;

            if (
                isAABBInFrustum(
                    minX, 0, minZ,
                    maxX, maxElevation, maxZ,
                    frustumPlanes
                )
            ) {
                const dist = Math.abs(dx) + Math.abs(dy); // マンハッタン距離
                candidates.push({
                    coord: {
                        zoom: center.zoom,
                        x: center.x + dx,
                        y: center.y + dy,
                    },
                    dist,
                });
            }
        }
    }

    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, maxTiles).map((c) => c.coord);
};

/** マルチLOD可視タイルの結果 */
export interface LodTileEntry {
    coord: TileCoord;
    tileSize: number;
}

export interface MultiLodTilesOptions {
    /** 基本zoom（最高解像度）の中心タイル座標 */
    baseCenter: TileCoord;
    /** 各zoomでのタイル実サイズ（メートル）を返す関数 */
    tileSizeForZoom: (zoom: number) => number;
    frustumPlanes: readonly FrustumPlane[];
    /** カメラからターゲットまでの距離（ArcRotateCamera.radius相当） */
    cameraDistance: number;
    /** カメラ高度から算出した基本ズームレベル */
    baseZoom: number;
    /** 使用する最小ズームレベル */
    minZoom: number;
    /** タイル総数の上限 */
    maxTiles?: number;
    maxElevation?: number;
    /** baseZoom 格子の探索半径（省略時 14）。Far-field sweep 側の半径には影響しない。 */
    searchRadius?: number;
    /**
     * カメラの地上投影点（ターゲット基準のワールド座標）。
     * 指定時は「ターゲットまたはカメラ地上投影点の近い方」の距離で zoom を決定する。
     * チルトで見えてくる手前側タイルをカメラ直下と同じ zoom に揃える目的。
     */
    cameraGroundOffset?: { x: number; z: number };
}

const DEFAULT_SEARCH_RADIUS_LOD = 14;

/**
 * カメラ距離から基本ズームレベルを算出する。
 * カメラ→ターゲット距離を基準にするため、チルト角に依存せず安定する。
 */
export const computeBaseZoom = (
    cameraDistance: number,
    tileSizeForZoom: (z: number) => number,
    maxZoom: number,
    minZoom: number,
): number => {
    // 画面中央にタイル約3枚幅が収まるレベルを選択
    // 可視幅 ≈ cameraDistance * 1.5（典型的な FOV・アスペクト比）
    const targetTileSize = cameraDistance * 0.8;
    for (let z = minZoom; z < maxZoom; z++) {
        if (tileSizeForZoom(z) <= targetTileSize) {
            return z;
        }
    }
    return maxZoom;
};

/**
 * カメラ距離ベースのマルチLOD可視タイルを算出する。
 * baseZoom格子を基準に探索し、距離に応じて低zoomの親タイルに集約。
 * LOD境界では昇格方式で重なりを防止：親タイル内に高zoomセルが混在する場合、
 * 低zoomセルを z+1 に昇格して同一親タイルのメッシュ重複を排除する。
 */
export const computeMultiLodTiles = (
    opts: MultiLodTilesOptions
): LodTileEntry[] => {
    const {
        baseCenter,
        tileSizeForZoom,
        frustumPlanes,
        cameraDistance: rawCameraDistance,
        baseZoom,
        minZoom,
        maxTiles = DEFAULT_MAX_TILES,
        maxElevation = DEFAULT_MAX_ELEVATION,
        searchRadius = DEFAULT_SEARCH_RADIUS_LOD,
        cameraGroundOffset,
    } = opts;

    if (baseZoom < minZoom) return [];

    const cameraDistance = Math.max(1, rawCameraDistance);

    /**
     * ターゲットからの水平距離でzoomレベルを決定。
     * cameraDistance×1.3以遠で段階的にzoomを下げる。
     */
    const zoomForDist = (dist: number): number => {
        let z = baseZoom;
        let threshold = cameraDistance * 1.3;
        while (z > minZoom && dist >= threshold) {
            z--;
            threshold *= 2;
        }
        return z;
    };

    // baseZoom格子で探索（baseZoomのタイルサイズに合わせた座標系）
    const gridTileSize = tileSizeForZoom(baseZoom);
    const gridHalf = gridTileSize / 2;
    const gridCenter = convertTileZoom(baseCenter, baseZoom);

    // 探索半径: 画面をカバーできる最小半径と設定値の大きい方。
    // cameraGroundOffset 指定時は、ターゲット〜カメラ地上投影点の距離も含めて広げる。
    const offsetReach = cameraGroundOffset
        ? Math.sqrt(cameraGroundOffset.x ** 2 + cameraGroundOffset.z ** 2)
        : 0;
    const minRadiusForCoverage = Math.ceil((cameraDistance * 1.5 + offsetReach) / gridTileSize);
    const effectiveRadius = Math.max(searchRadius, Math.min(minRadiusForCoverage, 60));

    // baseCenter→gridCenter 変換で生じるサブタイルオフセット
    const { fracX, fracY } = computeSubTileOffset(baseCenter, baseZoom);

    // Step 1: baseZoom格子で可視セルを列挙、距離からzoomを決定
    interface GridCell {
        dx: number;
        dy: number;
        targetZoom: number;
        dist: number;
    }
    const gridCells: GridCell[] = [];

    for (let dy = -effectiveRadius; dy <= effectiveRadius; dy++) {
        for (let dx = -effectiveRadius; dx <= effectiveRadius; dx++) {
            const { wx, wz } = tileOffsetToWorld(dx - fracX, dy - fracY, gridTileSize);

            if (
                !isAABBInFrustum(
                    wx - gridHalf, 0, wz - gridHalf,
                    wx + gridHalf, maxElevation, wz + gridHalf,
                    frustumPlanes
                )
            ) continue;

            const distFromTarget = Math.sqrt(wx ** 2 + wz ** 2);
            let dist = distFromTarget;
            if (cameraGroundOffset) {
                // 線分 [target(0,0) → cameraGround] からの距離。
                // チルト時にカメラとターゲットの間に並ぶ手前側タイル群を
                // 全て「近い」と判定し、カメラ直下と同じ zoom に揃える。
                const cx = cameraGroundOffset.x;
                const cz = cameraGroundOffset.z;
                const segLenSq = cx * cx + cz * cz;
                if (segLenSq > 1e-6) {
                    // t = clamp((P - target) · (cameraGround - target) / |segment|², 0, 1)
                    const tParam = Math.max(0, Math.min(1, (wx * cx + wz * cz) / segLenSq));
                    const closestX = tParam * cx;
                    const closestZ = tParam * cz;
                    const distFromSegment = Math.sqrt(
                        (wx - closestX) ** 2 + (wz - closestZ) ** 2,
                    );
                    dist = Math.min(dist, distFromSegment);
                } else {
                    dist = Math.min(
                        dist,
                        Math.sqrt((wx - cx) ** 2 + (wz - cz) ** 2),
                    );
                }
            }
            const targetZoom = zoomForDist(dist);
            gridCells.push({ dx, dy, targetZoom, dist });
        }
    }

    // Step 1.5: 近傍タイルのzoom平準化
    // 近傍セル（cameraDistance×2.6以内）のzoomを最大値に揃える。
    // 標高差のある地形でLOD段差が目立つのを防止する。
    const nearbyThreshold = cameraDistance * 2.6;
    let nearbyMaxZoom = minZoom;
    for (const cell of gridCells) {
        if (cell.dist < nearbyThreshold && cell.targetZoom > nearbyMaxZoom) {
            nearbyMaxZoom = cell.targetZoom;
        }
    }
    for (const cell of gridCells) {
        if (cell.dist < nearbyThreshold) {
            cell.targetZoom = nearbyMaxZoom;
        }
    }

    // Step 2: ズーム境界の重なり防止（昇格方式）
    // 親タイル内に高zoomセルが混在する場合、低zoomセルを z+1 に昇格。
    // 全セルが同一低zoomの親タイルはそのまま維持（遠方LODを保持）。
    // 降順パスで昇格 → カスケード昇格が発生しうるため収束まで反復。
    const cellZoomMap = new Map<string, number>();
    for (const cell of gridCells) {
        cellZoomMap.set(`${cell.dx},${cell.dy}`, cell.targetZoom);
    }

    let promotionsOccurred = true;
    while (promotionsOccurred) {
        promotionsOccurred = false;
        for (let z = baseZoom - 1; z >= minZoom; z--) {
            const diff = baseZoom - z;
            const parentHasHigher = new Set<string>();

            // 親タイル内に z より高いzoomのセルがあるか確認
            for (const cell of gridCells) {
                const cellZoom = cellZoomMap.get(`${cell.dx},${cell.dy}`)!;
                if (cellZoom > z) {
                    const gx = gridCenter.x + cell.dx;
                    const gy = gridCenter.y + cell.dy;
                    parentHasHigher.add(`${gx >> diff},${gy >> diff}`);
                }
            }

        // 高zoomセルと混在する親タイル内の低zoomセルを z+1 に昇格
        if (parentHasHigher.size > 0) {
            for (const cell of gridCells) {
                if (cellZoomMap.get(`${cell.dx},${cell.dy}`) !== z) continue;
                const gx = gridCenter.x + cell.dx;
                const gy = gridCenter.y + cell.dy;
                if (parentHasHigher.has(`${gx >> diff},${gy >> diff}`)) {
                    cellZoomMap.set(`${cell.dx},${cell.dy}`, z + 1);
                    promotionsOccurred = true;
                }
            }
        }
        }
    }

    // Step 3: セルを対象zoomのタイルに集約
    const tilesByZoom = new Map<number, Map<TileKey, { coord: TileCoord; dist: number }>>();
    for (let z = minZoom; z <= baseZoom; z++) {
        tilesByZoom.set(z, new Map());
    }

    for (const cell of gridCells) {
        const assignedZoom = cellZoomMap.get(`${cell.dx},${cell.dy}`)!;
        const gridTile: TileCoord = {
            zoom: baseZoom,
            x: gridCenter.x + cell.dx,
            y: gridCenter.y + cell.dy,
        };
        const parentCoord = convertTileZoom(gridTile, assignedZoom);
        const key = toTileKey(parentCoord);

        const zoomMap = tilesByZoom.get(assignedZoom)!;
        const existing = zoomMap.get(key);
        if (!existing || cell.dist < existing.dist) {
            zoomMap.set(key, { coord: parentCoord, dist: cell.dist });
        }
    }

    // Step 4: 低zoom → 高zoom の順に結果を収集（距離順ソート）
    const results: LodTileEntry[] = [];
    for (let z = minZoom; z <= baseZoom; z++) {
        if (results.length >= maxTiles) break;

        const tileSize = tileSizeForZoom(z);
        const zoomTiles = [...tilesByZoom.get(z)!.values()];
        zoomTiles.sort((a, b) => a.dist - b.dist);

        const remaining = maxTiles - results.length;
        for (const { coord } of zoomTiles.slice(0, remaining)) {
            results.push({ coord, tileSize });
        }
    }

    // Step 5: Far-field sweep — baseZoom格子のカバー範囲外を低zoom格子で補完
    // 水平に近いチルト時、frustumはbaseZoom格子の探索範囲を大きく超える。
    // 各低zoom層のタイルサイズで独自に探索し、遠方の欠けを埋める。
    // 部分カバー時は親タイルではなく未カバーの子セルのみを追加（重なり防止）。
    const allKeys = new Set(results.map(r => toTileKey(r.coord)));

    // Step 1-4 の全結果タイルが覆う baseZoom セルを記録（重複判定用）
    const coveredBaseZoomCells = new Set<string>();
    for (const r of results) {
        const rDiff = baseZoom - r.coord.zoom;
        if (rDiff > 0 && rDiff <= MAX_COVERAGE_DIFF) {
            const rCount = 1 << rDiff;
            const rBaseX = r.coord.x << rDiff;
            const rBaseY = r.coord.y << rDiff;
            for (let ry = 0; ry < rCount; ry++) {
                for (let rx = 0; rx < rCount; rx++) {
                    coveredBaseZoomCells.add(`${rBaseX + rx},${rBaseY + ry}`);
                }
            }
        } else {
            coveredBaseZoomCells.add(`${r.coord.x},${r.coord.y}`);
        }
    }

    /**
     * 低zoomタイルのうち、baseZoom格子で未カバーの子セルを
     * 再帰的に zoom+1 へ分割し、重なりのないタイル群を返す。
     * 完全カバー → 空配列、カバーなし → null（親タイルをそのまま使う）
     */
    const findUncoveredChildren = (
        parentCoord: TileCoord,
        parentDist: number,
    ): { coord: TileCoord; dist: number; tileSize: number }[] | null => {
        const diff = baseZoom - parentCoord.zoom;
        if (diff <= 0) return null;
        // diff が大きすぎて部分カバー判定を諦める場合は、
        // 親タイルを追加すると高zoom側と重なり得るため、このzoomの親タイル追加をスキップする
        if (diff > MAX_COVERAGE_DIFF) return [];

        const childCount = 1 << diff;
        const childBaseX = parentCoord.x << diff;
        const childBaseY = parentCoord.y << diff;

        let coveredCount = 0;
        for (let cy = 0; cy < childCount; cy++) {
            for (let cx = 0; cx < childCount; cx++) {
                if (coveredBaseZoomCells.has(`${childBaseX + cx},${childBaseY + cy}`)) {
                    coveredCount++;
                }
            }
        }

        // カバーなし → 親タイルをそのまま追加
        if (coveredCount === 0) return null;
        // 完全カバー → スキップ
        if (coveredCount === childCount * childCount) return [];

        // 部分カバー → zoom+1 の子タイルに分割し再帰判定
        const nextZoom = parentCoord.zoom + 1;
        const nextTileSize = tileSizeForZoom(nextZoom);
        const uncovered: { coord: TileCoord; dist: number; tileSize: number }[] = [];

        for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
                const childCoord: TileCoord = {
                    zoom: nextZoom,
                    x: parentCoord.x * 2 + sx,
                    y: parentCoord.y * 2 + sy,
                };
                const childKey = toTileKey(childCoord);
                if (allKeys.has(childKey)) continue;

                // 再帰: この子タイルも部分カバーなら更に分割
                const childResult = findUncoveredChildren(childCoord, parentDist);
                if (childResult === null) {
                    // カバーなし → この子タイルをそのまま追加
                    uncovered.push({ coord: childCoord, dist: parentDist, tileSize: nextTileSize });
                } else {
                    // 部分/完全カバー → 再帰結果をそのまま追加
                    uncovered.push(...childResult);
                }
            }
        }
        return uncovered;
    };

    for (let z = baseZoom - 1; z >= minZoom && results.length < maxTiles; z--) {
        const farTileSize = tileSizeForZoom(z);
        const farHalf = farTileSize / 2;
        const farCenter = convertTileZoom(baseCenter, z);
        const { fracX: farFracX, fracY: farFracY } = computeSubTileOffset(baseCenter, z);

        // zoom z の距離上限: cameraDistance × 1.3 × 2^(baseZoom − z)
        const zoomSteps = baseZoom - z;
        const maxDistForZoom = cameraDistance * 1.3 * Math.pow(2, zoomSteps);
        const farSearchRadius = Math.min(
            Math.ceil(maxDistForZoom / farTileSize) + 1,
            30
        );

        const candidates: { coord: TileCoord; dist: number; tileSize: number }[] = [];

        for (let dy = -farSearchRadius; dy <= farSearchRadius; dy++) {
            for (let dx = -farSearchRadius; dx <= farSearchRadius; dx++) {
                const { wx, wz } = tileOffsetToWorld(
                    dx - farFracX, dy - farFracY, farTileSize
                );
                const dist = Math.sqrt(wx ** 2 + wz ** 2);

                // このzoom以下の距離帯のセルを追加（境界ギャップ防止）
                if (zoomForDist(dist) > z) continue;

                if (
                    !isAABBInFrustum(
                        wx - farHalf, 0, wz - farHalf,
                        wx + farHalf, maxElevation, wz + farHalf,
                        frustumPlanes
                    )
                ) continue;

                const coord: TileCoord = {
                    zoom: z,
                    x: farCenter.x + dx,
                    y: farCenter.y + dy,
                };
                const key = toTileKey(coord);
                if (allKeys.has(key)) continue;

                // 部分カバー判定
                const uncovered = findUncoveredChildren(coord, dist);
                if (uncovered === null) {
                    // カバーなし → 親タイルをそのまま候補に追加
                    candidates.push({ coord, dist, tileSize: farTileSize });
                } else if (uncovered.length > 0) {
                    // 部分カバー → 未カバーの子タイルのみ追加
                    for (const child of uncovered) {
                        if (!allKeys.has(toTileKey(child.coord))) {
                            candidates.push(child);
                        }
                    }
                }
                // uncovered.length === 0 → 完全カバー → スキップ
            }
        }

        candidates.sort((a, b) => a.dist - b.dist);
        for (const entry of candidates) {
            if (results.length >= maxTiles) break;
            const key = toTileKey(entry.coord);
            if (allKeys.has(key)) continue;
            results.push({ coord: entry.coord, tileSize: entry.tileSize });
            allKeys.add(key);

            // coveredBaseZoomCells を更新（後続zoom反復での重複防止）
            const addedDiff = baseZoom - entry.coord.zoom;
            if (addedDiff > 0 && addedDiff <= MAX_COVERAGE_DIFF) {
                const addedCount = 1 << addedDiff;
                const addedBaseX = entry.coord.x << addedDiff;
                const addedBaseY = entry.coord.y << addedDiff;
                for (let ay = 0; ay < addedCount; ay++) {
                    for (let ax = 0; ax < addedCount; ax++) {
                        coveredBaseZoomCells.add(`${addedBaseX + ax},${addedBaseY + ay}`);
                    }
                }
            } else if (addedDiff === 0) {
                coveredBaseZoomCells.add(`${entry.coord.x},${entry.coord.y}`);
            }
        }
    }

    return results;
};
