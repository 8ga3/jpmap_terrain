/** タイルのライフサイクルを統合管理する TileManager */

import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";

import { TileCoord, TileKey, toTileKey, tileOffsetToWorld, convertTileZoom, computeSubTileOffset } from "./tileTypes";
import { computeQuadtreeTiles, FrustumPlane, LodTileEntry } from "./visibleTiles";
import { createTileCache, TileCache } from "./tileCache";
import { createMeshPool, MeshPool, ShadowHooks } from "./meshPool";
import {
    TILE_SIZE,
    toTileXY,
    tileEdgeMeters,
    loadElevationTile,
    textureUrl,
    MapType,
    fillInvalidPixels,
    isAllNaN,
    isInvalidElev,
    NO_DATA_SENTINEL,
} from "./gsiTile";
import { stitchTileEdges, stitchTileEdgesCrossLevel } from "./tileStitching";
import type { CoarseEdgeNeighbor } from "./tileStitching";
import { createElevationWorkerPool, type ElevationWorkerPool } from "./elevationWorkerPool";

export interface TileManagerOptions {
    scene: Scene;
    camera: ArcRotateCamera;
    zoom: number;
    subdivisions: number;
    heightScale: number;
    maxConcurrent?: number;
    maxTiles?: number;
    cacheCapacity?: number;
    debounceMs?: number;
    /** 遠景LODの最小ズームレベル（省略時は zoom - 2） */
    minZoom?: number;
    /** 標高タイルの最大ズームレベル（省略時は zoom） */
    maxElevationZoom?: number;
    /** 標高フォールバックの最小ズームレベル（省略時は max(minZoom, maxElevationZoom - 4)） */
    minElevationZoom?: number;
    /** Quadtree root 探索半径（minZoom タイル単位、±N 格子）。省略時は visibleTiles の既定値 */
    rootSearchRadius?: number;
}

export interface TileManager {
    setCenter(lat: number, lon: number, altitudeOffset?: number): Promise<void>;
    /**
     * 外部カメラの frustum を使って可視タイルを再計算する。
     *
     * Follow カメラなど、terrain 用 ArcRotateCamera とは異なるカメラで
     * 地形を表示するケースで使う。terrain camera のフラスタムではなく、
     * 呼び出し側が計算した frustumPlanes と cameraPosition を直接渡す。
     * `setCenter` と異なり reposition は行わない（タイル位置は変更済みの前提）。
     */
    refreshWithExternalFrustum(
        lat: number,
        lon: number,
        frustumPlanes: FrustumPlane[],
        cameraPosition: { x: number; y: number; z: number },
    ): Promise<void>;
    setMapType(mapType: MapType): void;
    readonly mapType: MapType;
    attachCamera(): void;
    detachCamera(): void;
    dispose(): void;
    readonly activeTileCount: number;
    readonly loadingCount: number;
    onStatusChange: ((status: string) => void) | null;
    /**
     * キャッシュ済み標高データからワールド座標のY値を返す（ヒットしなければ null）。
     *
     * 表示中の可視タイル（activeTiles）のデータのみ参照する。
     * カメラ外に出たタイルのキャッシュは使用しないため、
     * LOD 切替時に表示メッシュと異なる zoom の標高を返すことを防ぐ。
     * null が返った場合、呼び出し側は前回の標高を維持すること
     * （ModelManager の gravity では非表示にせず前回値を保持する）。
     */
    queryElevationAtWorld(wx: number, wz: number): number | null;
    /** メッシュ頂点の標高が更新されたときに呼ばれるコールバック */
    onTerrainUpdated: (() => void) | null;
    /** 太陽影 (Issue #39) caster/receiver フックを設定する。`null` で解除 */
    setShadowHooks(hooks: ShadowHooks | null): void;
    /** 現在アクティブな全タイルメッシュを列挙する（Issue #39 ON/OFF 切替用） */
    forEachActiveMesh(cb: (mesh: Mesh) => void): void;
}

interface ActiveTile {
    key: TileKey;
    coord: TileCoord;
    mesh: Mesh;
    tileSize: number;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_TILES = 120;
const DEFAULT_CACHE_CAPACITY = 192;
const DEFAULT_DEBOUNCE_MS = 200;
/** Frustum 判定用の基準最大標高 (m) — 富士山 3776m + マージン */
const MAX_BASE_ELEVATION = 4000;
/**
 * クロスレベル縫い合わせを適用する「カメラ近傍」判定の距離係数。
 * タイル中心とカメラの 3D 距離が `tileSize × NEAR_DISTANCE_TILES_FACTOR` 以下なら近傍とみなす。
 * 値が大きいほど縫い合わせ対象が広がる。遠方タイルは隙間が視認しにくいため、近傍のみに限定する。
 */
const NEAR_DISTANCE_TILES_FACTOR = 3;

// 旧 applyElevation はインラインで使われていたが、Web Worker への移行に伴い
// `elevationCompute.ts` の `applyElevationToPositions` に集約された。

/**
 * 低zoomテクスチャ使用時のUVパラメータを算出する。
 * tileZoom のタイルに対し textureZoom のテクスチャを適用する際の
 * uScale/vScale/uOffset/vOffset を返す。
 */
export const computeTextureUvParams = (
    tileZoom: number,
    tileX: number,
    tileY: number,
    textureZoom: number,
): { uScale: number; vScale: number; uOffset: number; vOffset: number } => {
    const diff = tileZoom - textureZoom;
    if (diff <= 0) return { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 };
    const scale = 1 << diff;
    const subX = tileX & (scale - 1);
    const subY = tileY & (scale - 1);
    return {
        uScale: 1 / scale,
        vScale: 1 / scale,
        uOffset: subX / scale,
        vOffset: subY / scale,
    };
};

/**
 * 親タイルの標高データから子タイルに対応する領域を切り出す。
 * 最近傍補間で TILE_SIZE × TILE_SIZE に拡大。
 */
export const extractSubTileElevation = (
    parentElev: Float32Array,
    childCoord: TileCoord,
    parentZoom: number,
    tileSize: number,
): Float32Array => {
    const diff = childCoord.zoom - parentZoom;
    const scale = 1 << diff; // 子タイル数（片辺）
    // 親タイル内での子タイルオフセット (0..scale-1)
    const subX = childCoord.x - ((childCoord.x >> diff) << diff);
    const subY = childCoord.y - ((childCoord.y >> diff) << diff);

    const result = new Float32Array(tileSize * tileSize);
    const subSize = tileSize / scale; // 親タイル内の子タイルピクセルサイズ
    const originX = subX * subSize;
    const originY = subY * subSize;

    for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
            // 子タイルの (x,y) → 親タイルのピクセル座標
            const srcX = Math.min(
                tileSize - 1,
                tileSize > 1
                    ? Math.round(originX + (x / (tileSize - 1)) * (subSize - 1))
                    : Math.round(originX)
            );
            const srcY = Math.min(
                tileSize - 1,
                tileSize > 1
                    ? Math.round(originY + (y / (tileSize - 1)) * (subSize - 1))
                    : Math.round(originY)
            );
            result[y * tileSize + x] = parentElev[srcY * tileSize + srcX];
        }
    }
    return result;
};

/** Babylon.js Frustum planes を FrustumPlane[] に変換 */
const extractFrustumPlanes = (camera: ArcRotateCamera): FrustumPlane[] => {
    const transform = Matrix.Identity();
    camera
        .getViewMatrix()
        .multiplyToRef(camera.getProjectionMatrix(), transform);
    const planes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
    Frustum.GetPlanesToRef(transform, planes);

    return planes.map((p) => ({
        normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
        d: p.d,
    }));
};

export const createTileManager = (opts: TileManagerOptions): TileManager => {
    const {
        scene,
        camera,
        zoom,
        subdivisions,
        heightScale,
        maxConcurrent = DEFAULT_MAX_CONCURRENT,
        maxTiles = DEFAULT_MAX_TILES,
        cacheCapacity = DEFAULT_CACHE_CAPACITY,
        debounceMs = DEFAULT_DEBOUNCE_MS,
        minZoom: minZoomOpt,
        maxElevationZoom: maxElevationZoomOpt,
        minElevationZoom: minElevationZoomOpt,
        rootSearchRadius,
    } = opts;

    const minZoom = minZoomOpt ?? Math.max(0, zoom - 2);
    const maxElevationZoom = maxElevationZoomOpt ?? zoom;
    const minElevationZoom = minElevationZoomOpt ?? Math.max(minZoom, maxElevationZoom - 4);

    const cache: TileCache = createTileCache(cacheCapacity);
    const meshPool: MeshPool = createMeshPool({
        scene,
        subdivisions,
        tileSize: 1, // スケーリングで実サイズに合わせる
    });

    const activeTiles = new Map<TileKey, ActiveTile>();
    /** テクスチャ適用の競合を防ぐためのリクエストID（mesh単位） */
    const textureRequestIds = new Map<Mesh, number>();
    let requestId = 0;
    let loadingCount = 0;
    let statusCallback: ((status: string) => void) | null = null;
    let terrainUpdatedCallback: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cameraObserver: ReturnType<
        typeof camera.onViewMatrixChangedObservable.add
    > | null = null;

    /** 再ステッチ待ちの隣接タイルキーを蓄積し、同一フレームで一括処理する */
    const pendingRestitch = new Set<TileKey>();
    let restitchRafId: number | null = null;

    // 現在の中心情報
    let currentCenter: TileCoord | null = null;
    let currentAltitudeOffset = 0;
    let currentLat = 0;
    let currentMapType: MapType = "std";

    const emitStatus = (): void => {
        if (!statusCallback) return;
        const active = activeTiles.size;
        const loading = loadingCount;
        if (loading > 0) {
            statusCallback(
                `表示中 ${active}/${maxTiles} タイル (読込中: ${loading})`
            );
        } else {
            statusCallback(`表示中 ${active}/${maxTiles} タイル`);
        }
    };

    /** 単一タイルをロードしてメッシュに適用 */
    const loadTile = async (
        coord: TileCoord,
        tileSize: number,
        rid: number
    ): Promise<void> => {
        const key = toTileKey(coord);
        if (activeTiles.has(key) || !currentCenter) return;

        loadingCount++;
        emitStatus();

        try {
            // キャッシュ or fetch（標高zoomは maxElevationZoom で制限）
            const elevZoom = Math.min(coord.zoom, maxElevationZoom);

            let entry = cache.get(key);
            if (!entry) {
                // 標高データを取得（maxElevationZoomから段階的にフォールバック）
                let elevData: Float32Array | null = null;
                let actualElevZoom = elevZoom;

                for (let tryZoom = elevZoom; tryZoom >= minElevationZoom; tryZoom--) {
                    const tryCoord = convertTileZoom(coord, tryZoom);
                    const tryKey = toTileKey(tryCoord);

                    // キャッシュにあればそれを使う
                    const cached = cache.get(tryKey);
                    if (cached) {
                        elevData = cached.elevation;
                        actualElevZoom = tryZoom;
                        break;
                    }

                    try {
                        elevData = await loadElevationTile(
                            tryCoord.zoom,
                            tryCoord.x,
                            tryCoord.y
                        );
                        if (rid !== requestId) return;
                        // 成功した標高データをキャッシュ
                        cache.set(tryKey, {
                            coord: tryCoord,
                            elevation: elevData,
                            wasAllNaN: isAllNaN(elevData),
                        });
                        actualElevZoom = tryZoom;
                        break;
                    } catch {
                        // このzoomでは利用不可 → 1段下げて再試行
                        if (rid !== requestId) return;
                    }
                }

                if (!elevData) {
                    // 全zoomで失敗 → フラット標高で表示（all NaN とし、後続の反復補間で埋める）
                    elevData = new Float32Array(TILE_SIZE * TILE_SIZE);
                    elevData.fill(NaN);
                    actualElevZoom = coord.zoom;
                }

                // zoom差がある場合、親タイルの該当領域を切り出し
                let elevation: Float32Array;
                if (actualElevZoom < coord.zoom) {
                    elevation = extractSubTileElevation(
                        elevData, coord, actualElevZoom, TILE_SIZE
                    );
                } else {
                    elevation = elevData;
                }

                entry = { coord, elevation, wasAllNaN: isAllNaN(elevation) };
                cache.set(key, entry);
            }

            if (rid !== requestId) return;
            if (activeTiles.has(key)) return;

            // 重い mesh sync 処理（elevation 適用 + GPU upload + 隣接ステッチ）を
            // フレーム単位でシリアライズする。並列ワーカーが同フレームに集中して
            // sync 処理を積み上げて Babylon の rAF レンダーを抜かさないようにし、
            // 飛行機アニメーションがちらつくのを防ぐ (Issue #245)。
            const releaseSlot = await acquireApplySlot();
            try {
                if (rid !== requestId) return;
                if (activeTiles.has(key)) return;

                // メッシュ取得・配置
                const mesh = meshPool.acquire();

                // スケーリング
                mesh.scaling.x = tileSize;
                mesh.scaling.z = tileSize;
                mesh.scaling.y = 1;

                // 中心タイルからのオフセット（サブタイルオフセット補正込み）
                const center = convertTileZoom(currentCenter, coord.zoom);
                const { fracX, fracY } = computeSubTileOffset(currentCenter, coord.zoom);
                const dx = coord.x - center.x;
                const dy = coord.y - center.y;
                const { wx, wz } = tileOffsetToWorld(dx - fracX, dy - fracY, tileSize);
                mesh.position.x = wx;
                mesh.position.z = wz;

                // 標高適用（ステッチ＋NaN埋め）
                await applyStitchedElevation(mesh, entry.elevation, coord);

                // テクスチャ
                applyTexture(mesh, coord);

                activeTiles.set(key, { key, coord, mesh, tileSize });

                // 隣接タイルのメッシュも再ステッチ
                restitchNeighbors(coord);

                terrainUpdatedCallback?.();
            } finally {
                releaseSlot();
            }
        } catch (e) {
            if (rid !== requestId) return;
            statusCallback?.(
                `タイル読込失敗 ${key}: ${e instanceof Error ? e.message : String(e)}`
            );
        } finally {
            loadingCount--;
            emitStatus();
        }
    };

    /** 既存 activeTiles の position/scaling/標高を現在の中心・高度オフセットに合わせて再配置 */
    const repositionActiveTiles = async (): Promise<void> => {
        if (!currentCenter) return;
        const promises: Promise<void>[] = [];
        for (const [key, tile] of activeTiles) {
            const { mesh, coord } = tile;

            // tileSize を現在の緯度で再計算
            const tileSize = tileSizeForZoom(coord.zoom);
            tile.tileSize = tileSize;

            // スケーリング
            mesh.scaling.x = tileSize;
            mesh.scaling.z = tileSize;
            mesh.scaling.y = 1;

            // 位置（サブタイルオフセット補正込み）
            const center = convertTileZoom(currentCenter, coord.zoom);
            const { fracX, fracY } = computeSubTileOffset(currentCenter, coord.zoom);
            const dx = coord.x - center.x;
            const dy = coord.y - center.y;
            const { wx, wz } = tileOffsetToWorld(dx - fracX, dy - fracY, tileSize);
            mesh.position.x = wx;
            mesh.position.z = wz;

            // キャッシュから標高データを取得し再適用（ステッチ＋NaN埋め）
            const entry = cache.get(key);
            if (entry) {
                promises.push(applyStitchedElevation(mesh, entry.elevation, coord));
            }
        }
        if (promises.length > 0) await Promise.all(promises);
        terrainUpdatedCallback?.();
    };

    /**
     * 1 フレーム待機する yield ユーティリティ。
     *
     * `setTimeout(0)` は macrotask 譲渡だけで描画フレームを挟む保証がなく、
     * 連続するタイル sync 処理（elevation + ComputeNormals + GPU upload）が
     * Babylon の rAF レンダーを抜かしてアニメーションをガク落ちさせる原因になる。
     * rAF を await することで「1 フレーム = 1 タイル sync」を保証し、
     * Babylon のレンダーループ（VSync 同期）が必ず間に走るようにする。
     * テスト環境など rAF が無い場合は setTimeout(0) にフォールバック。
     */
    // テスト環境（Jest）では rAF が setTimeout(16) に近い挙動になり、
    // タイル数が多いと sync 完了までに 5s 以上かかってタイムアウトするため
    // 即時 resolve にして直列化のみ維持する。
    const isTestEnv =
        typeof process !== "undefined" &&
        typeof (process as { env?: Record<string, string | undefined> }).env !== "undefined" &&
        (process as { env: Record<string, string | undefined> }).env.JEST_WORKER_ID !== undefined;
    // Babylon の onAfterRenderObservable に同期して、現在フレームの
     // 描画完了後にタイル sync を再開する。これにより
     // 「飛行機の位置反映 → render → タイル sync」の順番が保証され、
     // sync 処理が描画途中に割り込んでフレームを乱すことが無くなる。
     // sync 自体が 1 フレーム超過する場合でも、直前の render は
     // 正しい飛行機位置で完了しているため、ちらつきとして見えない。
    const yieldToFrame = (): Promise<void> => {
        if (isTestEnv) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const obs = scene.onAfterRenderObservable.addOnce(() => {
                resolve();
            });
            // scene が render されない期間でも進行できるよう保険のタイムアウト
            setTimeout(() => {
                if (obs) scene.onAfterRenderObservable.remove(obs);
                resolve();
            }, 100);
        });
    };

    /**
     * タイル sync 適用のフレーム単位排他ロック。
     *
     * 並列フェッチ後の重い同期処理（applyStitchedElevation /
     * ComputeNormals / GPU upload / restitchNeighbors）を
     * 1 フレームに 1 タイルだけ走らせるための Promise チェーン排他制御。
     * 取得時に release 関数を返し、呼び出し側は finally で release する。
     */
    let applyChain: Promise<void> = Promise.resolve();
    const acquireApplySlot = async (): Promise<() => void> => {
        const prev = applyChain;
        let release!: () => void;
        const slot = new Promise<void>((r) => { release = r; });
        applyChain = prev.then(() => slot);
        await prev;
        // 直前の sync が完了したら、レンダーフレームを 1 つ挟んで自分の番に入る。
        await yieldToFrame();
        return release;
    };

    /** 並列数制限付きのロードキュー */
    const loadTilesInQueue = async (
        entries: readonly LodTileEntry[],
        rid: number
    ): Promise<void> => {
        let idx = 0;
        const next = async (): Promise<void> => {
            while (idx < entries.length && rid === requestId) {
                const { coord, tileSize } = entries[idx++];
                await loadTile(coord, tileSize, rid);
            }
        };

        const workers = Array.from(
            { length: Math.min(maxConcurrent, entries.length) },
            () => next()
        );
        await Promise.all(workers);
    };

    /** tileSizeForZoom: 指定zoomでのタイル実サイズを返す */
    const tileSizeForZoom = (z: number): number => tileEdgeMeters(currentLat, z);

    /** メッシュにテクスチャを適用する（取得失敗時は低zoomへフォールバック） */
    const applyTexture = (mesh: Mesh, coord: TileCoord, fallbackZoom?: number): void => {
        const targetZoom = fallbackZoom ?? coord.zoom;
        const targetCoord = convertTileZoom(coord, targetZoom);

        // このリクエストのIDを発行し、meshに紐付ける
        const texReqId = (textureRequestIds.get(mesh) ?? 0) + 1;
        textureRequestIds.set(mesh, texReqId);

        const mat = mesh.material as StandardMaterial;
        if (mat.diffuseTexture) {
            mat.diffuseTexture.dispose();
        }

        const tex = new Texture(
            textureUrl(currentMapType, targetCoord.zoom, targetCoord.x, targetCoord.y),
            scene,
            true,
            true,
            Texture.TRILINEAR_SAMPLINGMODE,
            undefined,
            () => {
                // meshが既に別タイルへ再利用されていたらフォールバックしない
                if (textureRequestIds.get(mesh) !== texReqId) return;
                // テクスチャ取得失敗 → 低zoomへフォールバック
                if (targetZoom > minZoom) {
                    applyTexture(mesh, coord, targetZoom - 1);
                }
            }
        );

        // UV補正（低zoomテクスチャ使用時）
        const uv = computeTextureUvParams(coord.zoom, coord.x, coord.y, targetZoom);
        tex.uScale = uv.uScale;
        tex.vScale = uv.vScale;
        tex.uOffset = uv.uOffset;
        tex.vOffset = uv.vOffset;

        mat.diffuseTexture = tex;
    };

    /** 全アクティブタイルのテクスチャを現在の mapType で差し替え */
    const retextureAll = (): void => {
        for (const [, tile] of activeTiles) {
            applyTexture(tile.mesh, tile.coord);
        }
    };

    /**
     * 同じzoomの隣接タイル標高をキャッシュから取得。
     * @param useFilled true なら filled（ステッチ＋NaN埋め済み）を優先して返す。
     *                  false なら raw elevation を返し、辺平均の対称性を保証する。
     */
    const getNeighborElevations = (coord: TileCoord, useFilled = false): {
        top?: Float32Array; bottom?: Float32Array;
        left?: Float32Array; right?: Float32Array;
        topLeft?: Float32Array; topRight?: Float32Array;
        bottomLeft?: Float32Array; bottomRight?: Float32Array;
    } => {
        const { zoom: z, x, y } = coord;
        const get = (nx: number, ny: number): Float32Array | undefined => {
            const e = cache.get(toTileKey({ zoom: z, x: nx, y: ny }));
            if (!e) return undefined;
            // 元データが all-NaN かつ未補間なら参照しない（誤った 0 を伝搬させない）
            if (e.wasAllNaN && !e.unblocked) return undefined;
            return useFilled ? (e.filled ?? e.elevation) : e.elevation;
        };
        return {
            top: get(x, y - 1),
            bottom: get(x, y + 1),
            left: get(x - 1, y),
            right: get(x + 1, y),
            topLeft: get(x - 1, y - 1),
            topRight: get(x + 1, y - 1),
            bottomLeft: get(x - 1, y + 1),
            bottomRight: get(x + 1, y + 1),
        };
    };

    /**
     * カメラがタイル中心に近いか判定する。
     * タイル中心（XZ 平面上）とカメラ（target 原点ローカル）との 3D 距離が
     * `tileSize × NEAR_DISTANCE_TILES_FACTOR` 以下なら true。
     * クロスレベル縫い合わせを近傍に限定するために用いる。
     */
    const isTileNearCamera = (coord: TileCoord, tileSize: number): boolean => {
        if (!currentCenter) return false;
        const center = convertTileZoom(currentCenter, coord.zoom);
        const { fracX, fracY } = computeSubTileOffset(currentCenter, coord.zoom);
        const dx = coord.x - center.x;
        const dy = coord.y - center.y;
        const { wx, wz } = tileOffsetToWorld(dx - fracX, dy - fracY, tileSize);
        // camera position は target 原点ローカル。タイル中心は y=0 平面。
        const cx = camera.position.x - camera.target.x;
        const cy = camera.position.y - camera.target.y;
        const cz = camera.position.z - camera.target.z;
        const ex = wx - cx;
        const ez = wz - cz;
        const dist = Math.sqrt(ex * ex + cy * cy + ez * ez);
        return dist <= tileSize * NEAR_DISTANCE_TILES_FACTOR;
    };

    /**
     * target タイルの 4 辺それぞれについて、辺を共有する粗 zoom のアクティブタイルを
     * 1 つだけ選んで返す（同じ辺で複数候補があれば最も細かい粗 zoom を採用）。
     * 同 zoom の隣接タイルが存在する場合はその辺は対象外（同 zoom の縫い合わせに任せる）。
     */
    const getCoarseEdgeNeighbors = (coord: TileCoord): CoarseEdgeNeighbor[] => {
        const result: CoarseEdgeNeighbor[] = [];
        const { zoom: z, x, y } = coord;
        const dirs = [
            { dir: "top" as const, ndx: 0, ndy: -1 },
            { dir: "bottom" as const, ndx: 0, ndy: 1 },
            { dir: "left" as const, ndx: -1, ndy: 0 },
            { dir: "right" as const, ndx: 1, ndy: 0 },
        ];
        for (const d of dirs) {
            // 同 zoom 隣接が存在すればクロスレベル不要
            const sameZoomKey = toTileKey({ zoom: z, x: x + d.ndx, y: y + d.ndy });
            if (activeTiles.has(sameZoomKey)) continue;

            // 粗 zoom を z-1 から minZoom まで降順で探索（細かい粗 zoom を優先）
            for (let zp = z - 1; zp >= minZoom; zp--) {
                const diff = z - zp;
                const scale = 1 << diff;
                const subX = x & (scale - 1);
                const subY = y & (scale - 1);
                // target の辺が親タイルの境界辺と一致する条件
                let onParentEdge: boolean;
                switch (d.dir) {
                    case "top": onParentEdge = subY === 0; break;
                    case "bottom": onParentEdge = subY === scale - 1; break;
                    case "left": onParentEdge = subX === 0; break;
                    case "right": onParentEdge = subX === scale - 1; break;
                }
                if (!onParentEdge) continue;

                const px = x >> diff;
                const py = y >> diff;
                const ncx = px + d.ndx;
                const ncy = py + d.ndy;
                const nKey = toTileKey({ zoom: zp, x: ncx, y: ncy });
                if (!activeTiles.has(nKey)) continue;
                const entry = cache.get(nKey);
                if (!entry) continue;
                if (entry.wasAllNaN && !entry.unblocked) continue;
                result.push({
                    elevation: entry.filled ?? entry.elevation,
                    direction: d.dir,
                    subX,
                    subY,
                    scale,
                });
                break;
            }
        }
        return result;
    };

    /** Web Worker による標高 → 頂点 / 法線変換のオフロード用プール */
    const elevationWorkerPool: ElevationWorkerPool = createElevationWorkerPool(2);

    /** 補間済み標高データをメッシュ頂点・法線に反映する（Web Worker オフロード版） */
    const applyElevationDataToMesh = async (mesh: Mesh, filled: Float32Array): Promise<void> => {
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
        const idx = mesh.getIndices();
        if (!pos || !idx) return;

        // worker に transfer するため必ずコピーを作る（mesh 内部バッファを detach しない）
        const typed = new Float32Array(pos);
        // indices を TypedArray にコピー（number[] / TypedArray いずれにも対応）
        let indices: Int32Array | Uint32Array | Uint16Array;
        if (idx instanceof Int32Array || idx instanceof Uint32Array || idx instanceof Uint16Array) {
            indices = new (idx.constructor as Int32ArrayConstructor)(idx);
        } else {
            indices = new Int32Array(idx as ArrayLike<number>);
        }
        // elevations もコピー（filled は cache 内データで破壊禁止）
        const elevations = new Float32Array(filled);

        const res = await elevationWorkerPool.run({
            id: 0,
            positions: typed,
            indices,
            elevations,
            altitudeOffset: currentAltitudeOffset,
            heightScale,
            subdivisions,
            tileSize: TILE_SIZE,
        });

        if (res.positions.length === 0) return;
        try {
            // mesh が disposed 済みの場合は何もしない（worker 待ち中に dispose されうる）
            if (typeof mesh.isDisposed === "function" && mesh.isDisposed()) return;
            mesh.updateVerticesData(VertexBuffer.PositionKind, res.positions);
            mesh.updateVerticesData(VertexBuffer.NormalKind, res.normals);
            mesh.refreshBoundingInfo();
        } catch {
            // disposed 等で更新に失敗しても致命的ではないので無視
        }
    };

    /**
     * elevation をコピーしてステッチ（同zoom + cross-level）を適用し、
     * 辺に有効値（シード）があるかを判定する共通ヘルパー。
     * @param useFilled true なら同 zoom ステッチで filled データを参照する
     *                  （refineAllNaNTiles 用）。false なら raw 同士で対称平均。
     */
    const stitchAndCheckSeed = (
        elevation: Float32Array,
        coord: TileCoord,
        crossLevel: boolean,
        useFilled = false,
    ): { stitched: Float32Array; hasSeed: boolean } => {
        const stitched = new Float32Array(elevation);
        stitchTileEdges(stitched, getNeighborElevations(coord, useFilled), TILE_SIZE);
        if (crossLevel) {
            const coarse = getCoarseEdgeNeighbors(coord);
            if (coarse.length > 0) stitchTileEdgesCrossLevel(stitched, coarse, TILE_SIZE);
        }

        const last = TILE_SIZE - 1;
        let hasSeed = false;
        for (let i = 0; i < TILE_SIZE && !hasSeed; i++) {
            if (!isInvalidElev(stitched[i])) { hasSeed = true; break; }
            if (!isInvalidElev(stitched[last * TILE_SIZE + i])) { hasSeed = true; break; }
            if (!isInvalidElev(stitched[i * TILE_SIZE])) { hasSeed = true; break; }
            if (!isInvalidElev(stitched[i * TILE_SIZE + last])) { hasSeed = true; break; }
        }

        return { stitched, hasSeed };
    };

    /** タイルの標高データをステッチ＋NaN埋めしてメッシュに適用 */
    const applyStitchedElevation = async (
        mesh: Mesh,
        elevation: Float32Array,
        coord: TileCoord,
    ): Promise<void> => {
        const cacheEntryPre = cache.get(toTileKey(coord));

        // 異 zoom 隣接（粗タイル）と縫い合わせ。
        // - 通常タイルはカメラ近傍のみ対象（再適用時の計算コスト抑制）
        // - all-NaN タイルは同 zoom 近傍からシードが得られない場合があるため
        //   カメラ距離に関わらず常に試行する
        const tileSize = tileSizeForZoom(coord.zoom);
        const crossLevel = !!cacheEntryPre?.wasAllNaN || isTileNearCamera(coord, tileSize);
        const { stitched, hasSeed } = stitchAndCheckSeed(elevation, coord, crossLevel);

        // NaN を埋める（BFS）
        // wasAllNaN でシードなしの場合、フロンティアが空で BFS は進まず
        // 全ピクセル走査だけが発生する（256×256 で無駄）。
        // この場合は fillInvalidPixels をスキップし sentinel で直接埋める。
        const isAllNanNoSeed = !!cacheEntryPre?.wasAllNaN && !hasSeed;
        if (!isAllNanNoSeed) {
            fillInvalidPixels(stitched, TILE_SIZE, TILE_SIZE);
        } else {
            for (let i = 0; i < stitched.length; i++) {
                if (isInvalidElev(stitched[i])) stitched[i] = NO_DATA_SENTINEL;
            }
        }

        // メッシュに適用:
        // - シードあり: 今回のステッチ結果を使用
        // - シードなし（wasAllNaN）: 旧 filled があれば維持（Y=0 凹み防止）
        const meshData = (cacheEntryPre?.wasAllNaN && !hasSeed && cacheEntryPre.filled)
            ? cacheEntryPre.filled
            : stitched;
        await applyElevationDataToMesh(mesh, meshData);

        // キャッシュ更新:
        // - wasAllNaN + シードあり: filled/unblocked を更新
        // - 通常タイル: filled を常に更新。
        //   NaN 埋め済みデータ（entry.filled）を保存しておくことで、
        //   後から refineAllNaNTiles（useFilled=true）が隣接参照する際に
        //   岸タイルの lake 側エッジ NaN が補間済みの値を返せるようになる。
        //   通常のステッチ（useFilled=false）では raw elevation を参照するため
        //   filled を保存しても辺平均の対称性には影響しない。
        if (cacheEntryPre) {
            if (cacheEntryPre.wasAllNaN) {
                if (hasSeed) {
                    cacheEntryPre.filled = stitched;
                    cacheEntryPre.unblocked = true;
                }
            } else {
                cacheEntryPre.filled = stitched;
            }
        }
    };

    /** 蓄積された再ステッチ対象タイルを一括処理する */
    const flushRestitch = (): void => {
        restitchRafId = null;
        const promises: Promise<void>[] = [];
        for (const key of pendingRestitch) {
            const neighborTile = activeTiles.get(key);
            if (!neighborTile) continue;
            const entry = cache.get(key);
            if (!entry) continue;
            promises.push(
                applyStitchedElevation(neighborTile.mesh, entry.elevation, neighborTile.coord),
            );
        }
        pendingRestitch.clear();
        if (promises.length === 0) {
            terrainUpdatedCallback?.();
            return;
        }
        void Promise.all(promises).then(() => {
            terrainUpdatedCallback?.();
        });
    };

    /** 新タイルの隣接タイル（同zoom、アクティブなもの）を再ステッチキューに追加 */
    const restitchNeighbors = (coord: TileCoord): void => {
        const { zoom: z, x, y } = coord;
        const deltas = [
            [0, -1], [0, 1], [-1, 0], [1, 0],
            [-1, -1], [1, -1], [-1, 1], [1, 1],
        ];
        for (const [ddx, ddy] of deltas) {
            const neighborKey = toTileKey({ zoom: z, x: x + ddx, y: y + ddy });
            if (!activeTiles.has(neighborKey)) continue;
            pendingRestitch.add(neighborKey);
        }

        // クロスレベル: coord（粗タイル/同 zoom 問わず）の辺を共有する細タイルを再ステッチ。
        // coord が粗タイルなら、隣接する細タイルがそのスナップ先として coord を参照しうる。
        // coord が細タイルなら、隣接する更に細い別 zoom タイルへの影響は限定的だが、
        // 自身の cross-level スナップは applyStitchedElevation で初回適用済み。
        for (const [k, t] of activeTiles) {
            if (t.coord.zoom <= z) continue;
            const diff = t.coord.zoom - z;
            const scale = 1 << diff;
            const tpx = t.coord.x >> diff;
            const tpy = t.coord.y >> diff;
            const tsubX = t.coord.x & (scale - 1);
            const tsubY = t.coord.y & (scale - 1);
            // 細タイル t が coord と辺を共有する条件
            const adjTop = tpx === x && tpy === y - 1 && tsubY === scale - 1; // t の上に coord
            const adjBottom = tpx === x && tpy === y + 1 && tsubY === 0; // t の下に coord
            const adjLeft = tpx === x - 1 && tpy === y && tsubX === scale - 1;
            const adjRight = tpx === x + 1 && tpy === y && tsubX === 0;
            if (adjTop || adjBottom || adjLeft || adjRight) {
                pendingRestitch.add(k);
            }
        }

        if (restitchRafId === null) {
            restitchRafId = requestAnimationFrame(flushRestitch);
        }
    };

    /**
     * 元データが all-NaN だったタイルを反復的に補間する。
     *
     * アルゴリズム:
     * 1. wasAllNaN タイルをリセット（filled/unblocked をクリア）
     *    ※非 wasAllNaN タイルは loadTile/flushRestitch で filled 設定済み（NaN 埋め済み）
     * 2. 反復: elevation ベース（all-NaN）でステッチ → 辺シード有りなら NaN 埋め
     *    隣接に解決済みタイルが増えるたびに波状に補間が進む
     * 3. 解決済みタイルのみメッシュ適用（反復中は適用しない）
     * 4. 到達不能タイルはレスキューパス（代表標高で平坦化）
     */
    const ALL_NAN_REFINE_MAX_ITER = 32;
    const refineAllNaNTiles = async (): Promise<void> => {
        // wasAllNaN タイルを収集
        const allNanTiles: Array<[TileKey, ActiveTile]> = [];
        for (const [key, tile] of activeTiles) {
            const entry = cache.get(key);
            if (entry?.wasAllNaN) allNanTiles.push([key, tile]);
        }
        if (allNanTiles.length === 0) return;

        // Step 1: まだ解決していないタイル（未解決 or レスキュー経由）のみリセット。
        // BFS 補間で解決済みのタイルはスキップし、再計算コストを抑える。
        for (const [key] of allNanTiles) {
            const entry = cache.get(key);
            if (entry && (!entry.unblocked || entry.isRescue)) {
                entry.filled = undefined;
                entry.unblocked = false;
                entry.isRescue = false;
            }
        }

        // Step 2: 反復ステッチ + NaN 埋め
        const resolvedInThisCall = new Set<TileKey>();
        for (let iter = 0; iter < ALL_NAN_REFINE_MAX_ITER; iter++) {
            let resolvedThisIter = 0;
            let remainingCount = 0;

            for (const [key, tile] of allNanTiles) {
                const entry = cache.get(key);
                if (!entry || entry.unblocked) continue; // 解決済みはスキップ

                remainingCount++;

                // wasAllNaN → 常に cross-level stitch を実行
                // useFilled=true: 隣接 filled データからシードを取得しNaN領域を補間する
                const { stitched, hasSeed } = stitchAndCheckSeed(entry.elevation, tile.coord, true, true);

                if (hasSeed) {
                    fillInvalidPixels(stitched, TILE_SIZE, TILE_SIZE);
                    entry.filled = stitched;
                    entry.unblocked = true;
                    resolvedThisIter++;
                    remainingCount--;
                    resolvedInThisCall.add(key);
                }
            }

            if (remainingCount === 0 || resolvedThisIter === 0) break;
        }

        // Step 3: メッシュ適用（今回新たに解決したタイルのみ）
        let progressed = false;
        const meshPromises: Promise<void>[] = [];
        for (const [key, tile] of allNanTiles) {
            if (!resolvedInThisCall.has(key)) continue;
            const entry = cache.get(key);
            if (!entry?.filled) continue;
            meshPromises.push(applyElevationDataToMesh(tile.mesh, entry.filled));
            progressed = true;
        }

        // Step 4: レスキューパス（反復で到達できなかったタイルを代表標高で平坦化）
        const stillBlocked: Array<[TileKey, ActiveTile]> = [];
        for (const [key, tile] of allNanTiles) {
            const entry = cache.get(key);
            if (entry?.wasAllNaN && !entry.unblocked) stillBlocked.push([key, tile]);
        }
        if (stillBlocked.length > 0) {
            // 解決済みタイルの代表標高（中央値近似: 平均）
            let sum = 0;
            let count = 0;
            for (const [, tile] of activeTiles) {
                const entry = cache.get(toTileKey(tile.coord));
                if (!entry || (entry.wasAllNaN && !entry.unblocked)) continue;
                const data = entry.filled ?? entry.elevation;
                const v = data[(TILE_SIZE >> 1) * TILE_SIZE + (TILE_SIZE >> 1)];
                if (!isInvalidElev(v)) { sum += v; count++; }
            }
            if (count > 0) {
                const fallbackElev = sum / count;
                for (const [, tile] of stillBlocked) {
                    const entry = cache.get(toTileKey(tile.coord));
                    if (!entry) continue;
                    const filled = new Float32Array(TILE_SIZE * TILE_SIZE).fill(fallbackElev);
                    entry.filled = filled;
                    entry.unblocked = true;
                    entry.isRescue = true;
                    meshPromises.push(applyElevationDataToMesh(tile.mesh, filled));
                }
                progressed = true;
            }
        }

        if (meshPromises.length > 0) await Promise.all(meshPromises);

        if (progressed) {
            terrainUpdatedCallback?.();
        }
    };

    /**
     * キャッシュ済み標高データからワールド座標のY値を返す（ヒットしなければ null）。
     *
     * 可視タイル（activeTiles）のデータのみ参照し、表示メッシュとの標高整合を保つ。
     * 4 頂点バイリニア補間で標高を算出する。NaN（無効）頂点は重みから除外し、
     * 有効頂点だけで加重平均を取る。4 頂点全て無効なら低 zoom へフォールバックし、
     * 全 zoom で見つからなければ null。
     */
    const queryLocalElevation = (wx: number, wz: number): number | null => {
        if (!currentCenter) return null;
        // activeTiles には可視タイル（minZoom〜zoom）が登録される。
        // zoom > maxElevationZoom のタイルも activeTiles に含まれるため、
        // maxElevationZoom ではなく zoom から探索を開始する（#260）。
        for (let z = zoom; z >= minElevationZoom; z--) {
            const ts = tileSizeForZoom(z);
            const center = convertTileZoom(currentCenter, z);
            const { fracX, fracY } = computeSubTileOffset(currentCenter, z);
            // タイルメッシュの中心が world(0,0) に配置されるため、
            // ワールド座標 wx=0 はタイルの中央ピクセル（0.5 タイル）に対応する。
            // + 0.5 は left-edge 基準(0) → center 基準(0.5) への補正。
            const tileXFloat = center.x + 0.5 + fracX + wx / ts;
            const tileYFloat = center.y + 0.5 + fracY - wz / ts;
            const tileXInt = Math.floor(tileXFloat);
            const tileYInt = Math.floor(tileYFloat);
            const key = toTileKey({ zoom: z, x: tileXInt, y: tileYInt });
            // 現在 activeTiles に存在するタイルのデータのみ使用する。
            // キャッシュには古い zoom レベルのデータが残留していることがあり、
            // 表示メッシュと異なる標高データを返すとアバターが地面に潜る原因になる。
            if (!activeTiles.has(key)) continue;
            const entry = cache.get(key);
            if (!entry) continue;
            // まだ解決できていない all-NaN タイルはスキップ
            if (entry.wasAllNaN && !entry.unblocked) continue;
            const data = entry.filled ?? entry.elevation;
            const fx = tileXFloat - tileXInt;
            const fy = tileYFloat - tileYInt;

            // バイリニア補間: 地形メッシュのレンダリングと一致させるため
            // 最近傍ではなく 4 頂点の加重平均を使う
            const fpx = fx * (TILE_SIZE - 1);
            const fpy = fy * (TILE_SIZE - 1);
            const px0 = Math.max(0, Math.floor(fpx));
            const py0 = Math.max(0, Math.floor(fpy));
            const px1 = Math.min(TILE_SIZE - 1, px0 + 1);
            const py1 = Math.min(TILE_SIZE - 1, py0 + 1);
            const tx = fpx - px0;
            const ty = fpy - py0;
            const v00 = data[py0 * TILE_SIZE + px0];
            const v10 = data[py0 * TILE_SIZE + px1];
            const v01 = data[py1 * TILE_SIZE + px0];
            const v11 = data[py1 * TILE_SIZE + px1];

            // 有効な頂点だけで加重補間（w * NaN = NaN を避けるため条件付き加算）。
            // 全て無効なら低 zoom へフォールバック
            let wSum = 0;
            let valSum = 0;
            const addCorner = (v: number, w: number): void => {
                if (!isInvalidElev(v)) {
                    wSum += w;
                    valSum += w * v;
                }
            };
            addCorner(v00, (1 - tx) * (1 - ty));
            addCorner(v10, tx * (1 - ty));
            addCorner(v01, (1 - tx) * ty);
            addCorner(v11, tx * ty);
            if (wSum > 0) {
                return (valSum / wSum + currentAltitudeOffset) * heightScale;
            }
            // 4 頂点全て無効 → 低 zoom へフォールバック
        }
        return null;
    };

    /** 可視タイルを算出する共通ヘルパー */
    const computeVisible = (
        frustumPlanes: FrustumPlane[],
        maxElevation: number
    ): LodTileEntry[] => {
        if (!currentCenter) return [];
        const engine = scene.getEngine();
        return computeQuadtreeTiles({
            maxZoom: zoom,
            minZoom,
            baseCenter: currentCenter,
            tileSizeForZoom,
            frustumPlanes,
            cameraPosition: {
                x: camera.position.x - camera.target.x,
                y: camera.position.y - camera.target.y,
                z: camera.position.z - camera.target.z,
            },
            verticalFov: camera.fov,
            viewportHeight: engine.getRenderHeight(),
            maxElevation,
            maxTiles,
            rootSearchRadius,
        });
    };

    /** 可視タイルリストから不要タイルを解放し、新規タイルをロード */
    const applyVisibleTiles = async (
        visibleEntries: readonly LodTileEntry[],
        rid: number,
        reposition: boolean
    ): Promise<void> => {
        const visibleKeys = new Set(visibleEntries.map((e) => toTileKey(e.coord)));

        // 不要タイルを解放
        for (const [key, tile] of activeTiles) {
            if (!visibleKeys.has(key)) {
                textureRequestIds.delete(tile.mesh);
                meshPool.release(tile.mesh);
                activeTiles.delete(key);
            }
        }

        if (reposition) {
            await repositionActiveTiles();
        }

        // 新規タイルのみロード
        const toLoad = visibleEntries.filter(
            (e) => !activeTiles.has(toTileKey(e.coord))
        );

        if (toLoad.length > 0) {
            await loadTilesInQueue(toLoad, rid);
        }

        if (rid === requestId) {
            // all-NaN だったタイルを反復補間で埋める（湖中央等）
            await refineAllNaNTiles();
        }

        emitStatus();
    };

    /** 可視タイルを再計算し、不要タイルを解放・新規タイルをロード */
    const refresh = async (
        lat: number,
        lon: number,
        altitudeOffset: number
    ): Promise<void> => {
        const rid = ++requestId;

        const center = toTileXY(lat, lon, zoom);
        currentCenter = { zoom, x: center.x, y: center.y };
        currentAltitudeOffset = altitudeOffset;
        currentLat = lat;

        const frustumPlanes = extractFrustumPlanes(camera);
        const maxElevation =
            (MAX_BASE_ELEVATION + Math.max(0, altitudeOffset)) * heightScale;

        const visibleEntries = computeVisible(frustumPlanes, maxElevation);
        await applyVisibleTiles(visibleEntries, rid, true);
    };

    // カメラ変更時のリフレッシュ（中心座標を保持して使用）
    const refreshFromCamera = async (): Promise<void> => {
        if (!currentCenter) return;
        const rid = ++requestId;

        const frustumPlanes = extractFrustumPlanes(camera);
        const maxElevation =
            (MAX_BASE_ELEVATION + Math.max(0, currentAltitudeOffset)) *
            heightScale;

        const visibleEntries = computeVisible(frustumPlanes, maxElevation);
        await applyVisibleTiles(visibleEntries, rid, false);
    };

    return {
        async setCenter(
            lat: number,
            lon: number,
            altitudeOffset = 0
        ): Promise<void> {
            await refresh(lat, lon, altitudeOffset);
        },

        async refreshWithExternalFrustum(
            lat: number,
            lon: number,
            frustumPlanes: FrustumPlane[],
            cameraPosition: { x: number; y: number; z: number },
        ): Promise<void> {
            const rid = ++requestId;

            const center = toTileXY(lat, lon, zoom);
            // 中心タイルが変わった場合のみ reposition する
            const needsReposition = !currentCenter ||
                currentCenter.x !== center.x ||
                currentCenter.y !== center.y;
            currentCenter = { zoom, x: center.x, y: center.y };
            currentLat = lat;

            const maxElevation =
                (MAX_BASE_ELEVATION + Math.max(0, currentAltitudeOffset)) *
                heightScale;

            const engine = scene.getEngine();
            const visibleEntries = computeQuadtreeTiles({
                maxZoom: zoom,
                minZoom,
                baseCenter: currentCenter,
                tileSizeForZoom,
                frustumPlanes,
                cameraPosition,
                verticalFov: camera.fov,
                viewportHeight: engine.getRenderHeight(),
                maxElevation,
                maxTiles,
                rootSearchRadius,
            });

            await applyVisibleTiles(visibleEntries, rid, needsReposition);
        },

        setMapType(mapType: MapType): void {
            if (mapType === currentMapType) return;
            currentMapType = mapType;
            retextureAll();
        },

        get mapType(): MapType {
            return currentMapType;
        },

        attachCamera(): void {
            if (cameraObserver) return;
            cameraObserver = camera.onViewMatrixChangedObservable.add(() => {
                if (debounceTimer !== null) {
                    clearTimeout(debounceTimer);
                }
                debounceTimer = setTimeout(() => {
                    void refreshFromCamera();
                }, debounceMs);
            });
        },

        detachCamera(): void {
            if (cameraObserver) {
                camera.onViewMatrixChangedObservable.remove(cameraObserver);
                cameraObserver = null;
            }
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
        },

        dispose(): void {
            this.detachCamera();
            if (restitchRafId !== null) {
                cancelAnimationFrame(restitchRafId);
                restitchRafId = null;
            }
            pendingRestitch.clear();
            for (const [, tile] of activeTiles) {
                meshPool.release(tile.mesh);
            }
            activeTiles.clear();
            textureRequestIds.clear();
            cache.clear();
            meshPool.dispose();
            elevationWorkerPool.dispose();
        },

        get activeTileCount(): number {
            return activeTiles.size;
        },

        get loadingCount(): number {
            return loadingCount;
        },

        set onStatusChange(cb: ((status: string) => void) | null) {
            statusCallback = cb;
        },
        get onStatusChange(): ((status: string) => void) | null {
            return statusCallback;
        },

        queryElevationAtWorld(wx: number, wz: number): number | null {
            return queryLocalElevation(wx, wz);
        },

        set onTerrainUpdated(cb: (() => void) | null) {
            terrainUpdatedCallback = cb;
        },
        get onTerrainUpdated(): (() => void) | null {
            return terrainUpdatedCallback;
        },

        setShadowHooks(hooks: ShadowHooks | null): void {
            meshPool.setShadowHooks(hooks);
        },

        forEachActiveMesh(cb: (mesh: Mesh) => void): void {
            meshPool.forEachActive(cb);
        },
    };
};
