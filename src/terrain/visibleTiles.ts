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

    // 探索半径: 画面をカバーできる最小半径と設定値の大きい方
    const minRadiusForCoverage = Math.ceil(cameraDistance * 1.5 / gridTileSize);
    const effectiveRadius = Math.max(searchRadius, Math.min(minRadiusForCoverage, 30));

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

            const dist = Math.sqrt(wx ** 2 + wz ** 2);
            const targetZoom = zoomForDist(dist);
            gridCells.push({ dx, dy, targetZoom, dist });
        }
    }

    // Step 2: ズーム境界の重なり防止（昇格方式）
    // 親タイル内に高zoomセルが混在する場合、低zoomセルを z+1 に昇格。
    // 全セルが同一低zoomの親タイルはそのまま維持（遠方LODを保持）。
    // 処理は baseZoom-1 → minZoom の降順。
    const cellZoomMap = new Map<string, number>();
    for (const cell of gridCells) {
        cellZoomMap.set(`${cell.dx},${cell.dy}`, cell.targetZoom);
    }

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
    // baseZoom格子の既存タイルと重複する親タイルは子がカバー済みなのでスキップ。
    const allKeys = new Set(results.map(r => toTileKey(r.coord)));

    // 既存タイルのzoom別座標を記録（祖先/子孫の重複判定用）
    // 文字列キーを避け、数値エンコードでホットパスの文字列処理を排除
    const PACK_SHIFT = 0x1000000; // 2^24: zoom 23 まで安全
    const packXY = (x: number, y: number): number => x * PACK_SHIFT + y;
    const tilesByZoomForOverlap = new Map<number, Set<number>>();
    for (const r of results) {
        const { zoom, x, y } = r.coord;
        if (!tilesByZoomForOverlap.has(zoom)) tilesByZoomForOverlap.set(zoom, new Set());
        tilesByZoomForOverlap.get(zoom)!.add(packXY(x, y));
    }

    /** 指定タイルの領域が既存タイル（より高いzoom）によってカバーされているか判定 */
    const hasDescendantTile = (coord: TileCoord): boolean => {
        for (const [z, coords] of tilesByZoomForOverlap) {
            if (z <= coord.zoom) continue;
            const diff = z - coord.zoom;
            // 子孫タイルの座標範囲
            const childBaseX = coord.x << diff;
            const childBaseY = coord.y << diff;
            const childEndX = childBaseX + (1 << diff);
            const childEndY = childBaseY + (1 << diff);
            for (const packed of coords) {
                const cx = Math.floor(packed / PACK_SHIFT);
                const cy = packed % PACK_SHIFT;
                if (cx >= childBaseX && cx < childEndX &&
                    cy >= childBaseY && cy < childEndY) {
                    return true;
                }
            }
        }
        return false;
    };

    /** 指定タイルの祖先が既存タイル（より低いzoom）に含まれているか判定 */
    const hasAncestorTile = (coord: TileCoord): boolean => {
        for (const [z, coords] of tilesByZoomForOverlap) {
            if (z >= coord.zoom) continue;
            const diff = coord.zoom - z;
            const ancestorX = coord.x >> diff;
            const ancestorY = coord.y >> diff;
            if (coords.has(packXY(ancestorX, ancestorY))) return true;
        }
        return false;
    };

    // baseZoom格子でカバー済みのセル座標を記録（完全カバー判定用）
    const coveredBaseZoomCells = new Set<number>();
    for (const cell of gridCells) {
        coveredBaseZoomCells.add(packXY(gridCenter.x + cell.dx, gridCenter.y + cell.dy));
    }

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

        const candidates: { coord: TileCoord; dist: number }[] = [];

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

                // 既存タイルとの祖先/子孫関係による重複チェック
                if (hasDescendantTile(coord) || hasAncestorTile(coord)) continue;

                // この親タイルがbaseZoom格子で完全にカバー済みか確認
                // カバー済みならスキップ（重なり防止）
                const diff = baseZoom - z;
                // diff > 4 は子タイル 16×16=256 以上。完全カバーは事実上ないのでスキップ
                let fullyCovered = false;
                if (diff <= 4) {
                    const childCount = 1 << diff;
                    const childBaseX = coord.x << diff;
                    const childBaseY = coord.y << diff;
                    fullyCovered = true;
                    for (let cy = 0; cy < childCount && fullyCovered; cy++) {
                        for (let cx = 0; cx < childCount && fullyCovered; cx++) {
                            if (!coveredBaseZoomCells.has(packXY(childBaseX + cx, childBaseY + cy))) {
                                fullyCovered = false;
                            }
                        }
                    }
                }
                if (fullyCovered) continue;

                candidates.push({ coord, dist });
            }
        }

        candidates.sort((a, b) => a.dist - b.dist);
        for (const { coord } of candidates) {
            if (results.length >= maxTiles) break;
            results.push({ coord, tileSize: farTileSize });
            allKeys.add(toTileKey(coord));
            // 重複判定用のzoom別座標も更新
            if (!tilesByZoomForOverlap.has(z)) tilesByZoomForOverlap.set(z, new Set());
            tilesByZoomForOverlap.get(z)!.add(packXY(coord.x, coord.y));
        }
    }

    return results;
};
