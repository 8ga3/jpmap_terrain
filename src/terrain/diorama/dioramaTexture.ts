/**
 * 箱庭ジオラマのテクスチャモザイク合成。
 *
 * `dioramaGrid` の格子点群が跨る少数の GSI ラスタタイル（標準地図/写真）を
 * 1 枚のオフスクリーン `<canvas>` へ合成し、各点の UV を計算する。
 * レイアウト計算（`computeDioramaTextureLayout`）は純粋関数として分離し、
 * 実際のフェッチ/描画（`buildDioramaMosaicTexture`）から独立してテストできるようにする。
 *
 * @remarks
 * テクスチャ生成の経路は以下の変遷を経ている（Meta Quest 3実機検証に基づく）。
 * 1. 当初 Babylon の `DynamicTexture` を使用 → WebXR (`immersive-ar`) の
 *    パススルー合成中に地形面だけが透けて見える不具合を確認し、`canvas.toBlob()` →
 *    `URL.createObjectURL()` → 通常の `Texture`（`<img>`要素経由でデコード）という
 *    経路へ切り替えて回避した。
 * 2. その後、Quest 3実機でのプロファイリングにより、`canvas.toBlob()`
 *    （PNGエンコード）が地図移動（`setView`）再構築のたびに約4秒かかる支配的な
 *    ボトルネックであることが判明した。JPEGへのエンコード形式変更を試したが、
 *    実機では改善しなかった（immersive-arセッション中は `canvas.toBlob()`
 *    自体が約4秒かかることが判明。エンコード形式ではなくAPI自体の問題）。
 * 3. 最終的に `canvas.toBlob()`（非同期エンコード）と `<img>` 要素デコードの
 *    両方を回避するため、`ctx.getImageData()` で同期的に生ピクセルを取得し、
 *    Babylonの `RawTexture.CreateRGBATexture` へ直接アップロードする方式へ
 *    変更した。エンコード・デコードの往復が一切ないため、実機で最速。
 *    なお `DynamicTexture` の透過不具合の根本原因は完全には特定できていない
 *    ため、本方式でも同様の不具合が再発しないか実機での確認が必須
 *    （合成用canvasは `{ alpha: false }` で生成し、アルファ起因の透過リスクを
 *    設計上排除している）。
 */

import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { latLonToPixel, totalPixelsForZoom } from "../geo/mapping";
import { type MapType, TILE_SIZE, textureUrl, toTileXY } from "../gsiTile";
import { measureAsync } from "./dioramaPerfLog";

/** テクスチャ取得対象の1点（lat/lon のみを要求。他フィールドは無視）。 */
export interface DioramaTexturePoint {
    lat: number;
    lon: number;
}

/** モザイク内の1タイル配置。 */
interface DioramaMosaicTile {
    x: number;
    y: number;
    /** モザイク内オフセット（左上、px）。 */
    offsetX: number;
    offsetY: number;
}

/** UV座標（Babylon既定の invertY=true 前提: v=1 が北端）。 */
interface DioramaUv {
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
 * 箱庭のフットプリントは正方形のため、バウンディングボックスは常に格子点群の
 * 外形とほぼ一致する（無駄な合成領域が生じない）。
 */
/** ズームレベルが0以上の整数であることを検証する（非整数/負数はtoTileXY/totalPixelsForZoomを不正な計算に導くため）。 */
const assertValidZoom = (zoom: number): void => {
    if (!(Number.isInteger(zoom) && zoom >= 0)) {
        throw new RangeError(
            `zoom must be a non-negative integer (got ${zoom})`,
        );
    }
};

/**
 * 点群の lat/lon がすべて有限値であることを検証する。
 * NaN/Infinity を toTileXY/latLonToPixel にそのまま渡すと、min/max が更新されず
 * mosaicWidthPx が Infinity/NaN になる、UV が NaN になるなどサイレントに壊れるため、
 * 公開APIとして早期に検証する。
 */
const assertFinitePoints = (points: readonly DioramaTexturePoint[]): void => {
    for (const p of points) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
            throw new RangeError(
                `point.lat/lon must be finite (got lat=${p.lat}, lon=${p.lon})`,
            );
        }
    }
};

/**
 * モザイク1辺あたりの許容タイル数上限。
 *
 * `toTileXY` は経度を [-180, 180) に正規化してタイルX座標を [0, 2^zoom-1] へ
 * 写像するため、点群が反子午線（±180°）を跨ぐと（ローカル平面近似で単純に
 * lon±180°を超えた値をそのまま正規化する `dioramaGrid.offsetToLatLon` の
 * 性質上、実際に起こり得る）、一部の点が lon≈+180 側、別の点が lon≈-180 側に
 * ラップし、minTileX≈0・maxTileX≈2^zoom-1 という「ほぼ全世界幅」のバウンディング
 * ボックスになり得る。箱庭のfootprintは手元サイズ相当（実世界で高々数km）を
 * 想定しており、この規模のタイル数は明らかに異常（反子午線を跨いだ、または
 * footprintHalfSizeM/zoomの指定が極端）なため、早期にRangeErrorで検出する。
 */
const MAX_MOSAIC_TILES_PER_AXIS = 64;

export const computeDioramaTextureLayout = (
    points: readonly DioramaTexturePoint[],
    zoom: number,
): DioramaTextureLayout => {
    if (points.length === 0) {
        throw new RangeError("points must not be empty");
    }
    assertValidZoom(zoom);
    assertFinitePoints(points);
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

    const tilesX = maxTileX - minTileX + 1;
    const tilesY = maxTileY - minTileY + 1;
    if (
        tilesX > MAX_MOSAIC_TILES_PER_AXIS ||
        tilesY > MAX_MOSAIC_TILES_PER_AXIS
    ) {
        throw new RangeError(
            `mosaic tile span too large (${tilesX}x${tilesY} tiles, max ${MAX_MOSAIC_TILES_PER_AXIS} per axis); ` +
                "points may span the antimeridian (±180°) or footprintHalfSizeM/zoom is too large for this zoom level",
        );
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
        const { px: globalPx, py: globalPy } = latLonToPixel(
            p.lat,
            p.lon,
            totalPixels,
        );
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
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
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
 * 1枚のオフスクリーン `<canvas>` へ合成し、`RawTexture` として読み込む。取得に
 * 失敗したタイルは該当領域を {@link FALLBACK_TILE_COLOR} で塗りつぶし
 * （描画継続を優先）、コンソールにエラーを出す。
 */
export const buildDioramaMosaicTexture = async (
    scene: Scene,
    layout: DioramaTextureLayout,
    mapType: MapType,
    name = "diorama-terrain-texture",
): Promise<Texture> => {
    const canvas = document.createElement("canvas");
    canvas.width = layout.mosaicWidthPx;
    canvas.height = layout.mosaicHeightPx;
    // `{ alpha: false }`: 合成用canvasを不透明として扱わせる。GSIタイル画像に
    // アルファチャンネルが含まれる場合でも、`getImageData` で読み戻した際の
    // アルファ値は常に255（不透明）になる（ブラウザ仕様）。これにより、地形面の
    // アルファが意図せず下がってWebXR (`immersive-ar`) のパススルー合成中に
    // 地形が透けて見える不具合（本ファイル冒頭の経緯コメント参照）を、
    // アルファ値の混入という観点からは設計上排除できる。
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
        throw new Error(
            "[jpmap-terrain diorama] failed to acquire 2D context for texture mosaic canvas",
        );
    }

    // 実機（Meta Quest 3）でのみ顕在化する遅延調査用の計測: タイル取得（ネットワーク）+
    // canvas合成の合計時間。タイルは並列フェッチのため、この時間はほぼネットワーク往復
    // （最も遅いタイル）が支配的。
    await measureAsync(
        `tiles-fetch-compose (${layout.tiles.length} tiles)`,
        () =>
            Promise.all(
                layout.tiles.map(async (tile) => {
                    const url = textureUrl(
                        mapType,
                        layout.zoom,
                        tile.x,
                        tile.y,
                    );
                    // `drawImage` が失敗した場合でも `bitmap.close()` を確実に実行するため、
                    // `bitmap` を try スコープ外の変数で保持し、`finally` でクローズする
                    // （`try`ブロック内で完結させると、`loadTileBitmap`成功後に`drawImage`が
                    // 失敗したケースで`close()`が呼ばれずImageBitmapがリークする）。
                    let bitmap: ImageBitmap | undefined;
                    try {
                        bitmap = await loadTileBitmap(url);
                        ctx.drawImage(
                            bitmap,
                            tile.offsetX,
                            tile.offsetY,
                            TILE_SIZE,
                            TILE_SIZE,
                        );
                    } catch (err) {
                        console.error(
                            `[jpmap-terrain diorama] failed to load texture tile z${layout.zoom}/${tile.x}/${tile.y}, filling with fallback color:`,
                            err,
                        );
                        ctx.fillStyle = FALLBACK_TILE_COLOR;
                        ctx.fillRect(
                            tile.offsetX,
                            tile.offsetY,
                            TILE_SIZE,
                            TILE_SIZE,
                        );
                    } finally {
                        bitmap?.close();
                    }
                }),
            ),
    );

    // 遅延調査用の計測: canvasから生ピクセルデータを読み戻し（同期処理）、
    // Babylonの `RawTexture` へ直接アップロードする所要時間。`canvas.toBlob()`
    // によるPNG/JPEGエンコードや `<img>` 要素でのデコードを一切経由しないため、
    // 本ファイル冒頭の経緯コメントにある通り、Quest 3実機でWebXRセッション中に
    // `canvas.toBlob()` 自体が約4秒かかっていた問題を回避できる。
    return measureAsync("pixels-readback-and-upload", async () => {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const texture = RawTexture.CreateRGBATexture(
            imageData.data,
            canvas.width,
            canvas.height,
            scene,
            true, // generateMipMaps: ミップマップを生成する（従来のTexture(noMipmap=false)と同等）
            true, // invertY: v=1 が画像上端（=北）になるUV計算（本ファイル冒頭のUV計算参照）に合わせる
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        // UVが境界付近で僅かに0..1をはみ出す場合に反対側の端からサンプリングされる
        // （WRAP、既定値）のを防ぐため、タイル系テクスチャと同様にCLAMPを明示する
        // （`geo/globeTileManager.ts` の `tex.wrapU/wrapV = Texture.CLAMP_ADDRESSMODE` と同じ意図）。
        texture.wrapU = Texture.CLAMP_ADDRESSMODE;
        texture.wrapV = Texture.CLAMP_ADDRESSMODE;
        texture.name = name;
        return texture;
    });
};
