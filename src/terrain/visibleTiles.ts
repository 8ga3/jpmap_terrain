/** カメラFrustum内の可視タイルを算出する */

import { TileCoord, tileOffsetToWorld } from "./tileTypes";

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
}

const DEFAULT_MAX_TILES = 25;
const DEFAULT_SEARCH_RADIUS = 4;
/** 日本の標高上限概算（富士山 3776m + マージン） */
const MAX_ELEVATION = 4000;

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
                    maxX, MAX_ELEVATION, maxZ,
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
