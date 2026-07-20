/**
 * 箱庭ジオラマのテクスチャモザイク合成。
 *
 * `dioramaGrid` の格子点群が跨る少数の GSI ラスタタイル（標準地図/写真）を
 * 1 枚の `DynamicTexture` へ合成し、各点の UV を計算する。
 * レイアウト計算（`computeDioramaTextureLayout`）は純粋関数として分離し、
 * 実際のフェッチ/描画（`buildDioramaMosaicTexture`）から独立してテストできるようにする。
 */
import type { Scene } from "@babylonjs/core/scene";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";

import { TILE_SIZE, toTileXY, textureUrl, type MapType } from "../gsiTile";
import { totalPixelsForZoom, latLonToPixel } from "../geo/mapping";

/** テクスチャ取得対象の1点（lat/lon のみを要求。他フィールドは無視）。 */
export interface DioramaTexturePoint {
    lat: number;
    lon: number;
}

/** モザイク内の1タイル配置。 */
export interface DioramaMosaicTile {
    x: number;
    y: number;
    /** モザイク内オフセット（左上、px）。 */
    offsetX: number;
    offsetY: number;
}

/** UV座標（Babylon既定の invertY=true 前提: v=1 が北端）。 */
export interface DioramaUv {
    u: number;
    v: number;
}

export interface DioramaTextureLayout {
    zoom: number;
    /** モザイク画像の幅・高さ[px]。 */
    mosaicWidthPx: number;
    mosaicHeightPx: number;
    /** 合成に必要なタイル一覧（重複なし）。 */
    tiles: DioramaMosaicTile[];
    /** 入力点群と同順の UV 配列。 */
    uvs: DioramaUv[];
}

/**
 * 格子点群が跨るタイルの矩形バウンディングボックスを求め、モザイクレイアウトと
 * 各点の UV を計算する（フェッチ・描画は行わない純粋関数）。
 *
 * 円形フットプリントのバウンディングボックスに含まれる矩形領域を丸ごとモザイク化する
 * ため、円の外側にあたる四隅のタイルも合成対象に含まれる（単純さを優先した実装。
 * フットプリント半径に対してタイル数が少ない前提のため、無駄なフェッチの影響は小さい）。
 */
/** ズームレベルが0以上の整数であることを検証する（非整数/負数はtoTileXY/totalPixelsForZoomを不正な計算に導くため）。 */
const assertValidZoom = (zoom: number): void => {
    if (!(Number.isInteger(zoom) && zoom >= 0)) {
        throw new RangeError(`zoom must be a non-negative integer (got ${zoom})`);
    }
};

export const computeDioramaTextureLayout = (
    points: readonly DioramaTexturePoint[],
    zoom: number,
): DioramaTextureLayout => {
    if (points.length === 0) {
        throw new RangeError("points must not be empty");
    }
    assertValidZoom(zoom);
    const totalPixels = totalPixelsForZoom(zoom);

    let minTileX = Infinity;
    let maxTileX = -Infinity;
    let minTileY = Infinity;
    let maxTileY = -Infinity;
    for (const p of points) {
        const { x, y } = toTileXY(p.lat, p.lon, zoom);
        if (x < minTileX) minTileX = x;
        if (x > maxTileX) maxTileX = x;
        if (y < minTileY) minTileY = y;
        if (y > maxTileY) maxTileY = y;
    }

    const tiles: DioramaMosaicTile[] = [];
    const seen = new Set<string>();
    for (let ty = minTileY; ty <= maxTileY; ty++) {
        for (let tx = minTileX; tx <= maxTileX; tx++) {
            const key = `${tx}/${ty}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tiles.push({
                x: tx,
                y: ty,
                offsetX: (tx - minTileX) * TILE_SIZE,
                offsetY: (ty - minTileY) * TILE_SIZE,
            });
        }
    }

    const mosaicWidthPx = (maxTileX - minTileX + 1) * TILE_SIZE;
    const mosaicHeightPx = (maxTileY - minTileY + 1) * TILE_SIZE;

    const uvs: DioramaUv[] = points.map((p) => {
        const { px: globalPx, py: globalPy } = latLonToPixel(p.lat, p.lon, totalPixels);
        const localPx = globalPx - minTileX * TILE_SIZE;
        const localPy = globalPy - minTileY * TILE_SIZE;
        return {
            u: localPx / mosaicWidthPx,
            // Babylon既定の invertY=true（v=1が画像上端=北）に合わせる
            // （globe地形メッシュ・globeTileManagerと同じ規約、geo/globeMesh.ts参照）。
            v: 1 - localPy / mosaicHeightPx,
        };
    });

    return { zoom, mosaicWidthPx, mosaicHeightPx, tiles, uvs };
};

/** fetch タイムアウト [ms]（`gsiTile.ts` の DEM フェッチと同じ値）。 */
const FETCH_TIMEOUT_MS = 15000;

/** ラスタタイル画像を `ImageBitmap` として取得する（`gsiTile.loadImageData` と同じ fetch+blob 方式）。 */
const loadTileBitmap = async (url: string): Promise<ImageBitmap> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Tile fetch failed (${res.status}): ${url}`);
    const blob = await res.blob();
    return createImageBitmap(blob);
};

/**
 * 取得失敗タイルの代替塗りつぶし色（土色系の中間トーン）。
 *
 * 地形は不透明な地面のため、失敗領域を透明のままにすると背景が透けて
 * 「穴」に見えてしまう。無地の代替色で塗りつぶし、描画継続を優先する。
 */
const FALLBACK_TILE_COLOR = "#8a8270";

/**
 * `computeDioramaTextureLayout` の結果に基づき、実際にタイル画像を取得して
 * 1枚の `DynamicTexture` へ合成する。取得に失敗したタイルは該当領域を
 * {@link FALLBACK_TILE_COLOR} で塗りつぶし（描画継続を優先）、コンソールにエラーを出す。
 */
export const buildDioramaMosaicTexture = async (
    scene: Scene,
    layout: DioramaTextureLayout,
    mapType: MapType,
    name = "diorama-terrain-texture",
): Promise<DynamicTexture> => {
    const texture = new DynamicTexture(
        name,
        { width: layout.mosaicWidthPx, height: layout.mosaicHeightPx },
        scene,
        true,
    );
    const ctx = texture.getContext();

    await Promise.all(
        layout.tiles.map(async (tile) => {
            const url = textureUrl(mapType, layout.zoom, tile.x, tile.y);
            try {
                const bitmap = await loadTileBitmap(url);
                ctx.drawImage(bitmap, tile.offsetX, tile.offsetY, TILE_SIZE, TILE_SIZE);
                bitmap.close();
            } catch (err) {
                console.error(
                    `[jpmap-terrain diorama] failed to load texture tile z${layout.zoom}/${tile.x}/${tile.y}, filling with fallback color:`,
                    err,
                );
                ctx.fillStyle = FALLBACK_TILE_COLOR;
                ctx.fillRect(tile.offsetX, tile.offsetY, TILE_SIZE, TILE_SIZE);
            }
        }),
    );

    texture.update(false);
    return texture;
};
