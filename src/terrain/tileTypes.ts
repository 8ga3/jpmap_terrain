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
/** -0 を +0 に正規化する（NaN はそのまま伝播） */
const normalizeNegZero = (v: number): number => (Object.is(v, -0) ? 0 : v);

export const tileOffsetToWorld = (
    dx: number,
    dy: number,
    tileSize: number,
): { wx: number; wz: number } => ({
    wx: dx * tileSize,
    wz: normalizeNegZero(-(dy * tileSize)),
});

/** ワールド座標(x, z) → 中心タイルからの相対タイルオフセット */
export const worldToTileOffset = (
    wx: number,
    wz: number,
    tileSize: number,
): { dx: number; dy: number } => ({
    dx: Math.round(wx / tileSize),
    dy: normalizeNegZero(-Math.round(wz / tileSize)),
});

/** タイル座標を別の zoom レベルに変換 */
export const convertTileZoom = (
    coord: TileCoord,
    targetZoom: number,
): TileCoord => {
    const diff = coord.zoom - targetZoom;
    if (diff > 0) {
        // 高zoom → 低zoom: ビット右シフト相当
        return {
            zoom: targetZoom,
            x: coord.x >> diff,
            y: coord.y >> diff,
        };
    }
    if (diff < 0) {
        // 低zoom → 高zoom: 左シフト（左上隅）
        const shift = -diff;
        return {
            zoom: targetZoom,
            x: coord.x << shift,
            y: coord.y << shift,
        };
    }
    return coord;
};

/** 高zoom タイルが低zoom タイルに含まれるか判定 */
export const isChildOf = (child: TileCoord, parent: TileCoord): boolean => {
    if (child.zoom <= parent.zoom) return false;
    const parentOfChild = convertTileZoom(child, parent.zoom);
    return parentOfChild.x === parent.x && parentOfChild.y === parent.y;
};

/**
 * 基本zoom中心タイルの、対象zoom中心タイル内でのサブタイルオフセットを計算。
 * convertTileZoom のビットシフトで失われる端数を補正するための値。
 */
export const computeSubTileOffset = (
    baseCenter: TileCoord,
    targetZoom: number,
): { fracX: number; fracY: number } => {
    const diff = baseCenter.zoom - targetZoom;
    if (diff <= 0) return { fracX: 0, fracY: 0 };
    const scale = 1 << diff; // 2^diff
    const targetCenter = convertTileZoom(baseCenter, targetZoom);
    return {
        fracX: (baseCenter.x + 0.5) / scale - (targetCenter.x + 0.5),
        fracY: (baseCenter.y + 0.5) / scale - (targetCenter.y + 0.5),
    };
};
