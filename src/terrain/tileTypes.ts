/** タイル座標の型定義と座標変換ユーティリティ */

/** タイル座標の一意キー（"z/x/y" 形式文字列） */
export type TileKey = `${number}/${number}/${number}`;

export interface TileCoord {
    readonly zoom: number;
    readonly x: number;
    readonly y: number;
}

/** TileCoord → TileKey */
export const toTileKey = (coord: TileCoord): TileKey =>
    `${coord.zoom}/${coord.x}/${coord.y}`;

/**
 * 中心タイルからの相対オフセットをワールド座標(x, z)に変換。
 * タイルY軸は南向き、Babylon.js Z軸は北向きのため符号を反転。
 */
export const tileOffsetToWorld = (
    dx: number,
    dy: number,
    tileSize: number
): { wx: number; wz: number } => ({
    wx: dx * tileSize,
    wz: -(dy * tileSize) || 0,
});

/** ワールド座標(x, z) → 中心タイルからの相対タイルオフセット */
export const worldToTileOffset = (
    wx: number,
    wz: number,
    tileSize: number
): { dx: number; dy: number } => ({
    dx: Math.round(wx / tileSize),
    dy: -(Math.round(wz / tileSize)) || 0,
});
