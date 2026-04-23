/** タイルのライフサイクルを統合管理する TileManager */

import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";

import { TileCoord, TileKey, toTileKey, tileOffsetToWorld, convertTileZoom, computeSubTileOffset } from "./tileTypes";
import { computeMultiLodTiles, computeBaseZoom, FrustumPlane, LodTileEntry } from "./visibleTiles";
import { createTileCache, TileCache } from "./tileCache";
import { createMeshPool, MeshPool } from "./meshPool";
import {
    TILE_SIZE,
    toTileXY,
    tileEdgeMeters,
    loadElevationTile,
    textureUrl,
    MapType,
    fillInvalidPixels,
} from "./gsiTile";
import { stitchTileEdges } from "./tileStitching";

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
}

export interface TileManager {
    setCenter(lat: number, lon: number, altitudeOffset?: number): Promise<void>;
    setMapType(mapType: MapType): void;
    readonly mapType: MapType;
    attachCamera(): void;
    detachCamera(): void;
    dispose(): void;
    readonly activeTileCount: number;
    readonly loadingCount: number;
    onStatusChange: ((status: string) => void) | null;
    /** キャッシュ済み標高データからワールド座標のY値を返す（ヒットしなければ null） */
    queryElevationAtWorld(wx: number, wz: number): number | null;
    /** メッシュ頂点の標高が更新されたときに呼ばれるコールバック */
    onTerrainUpdated: (() => void) | null;
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
/** 有効カメラ距離の下限値（生の radius に対する比率） */
const EFFECTIVE_RADIUS_MIN_RATIO = 0.05;

/** 頂点Y座標を標高値で更新 */
const applyElevation = (
    positions: Float32Array,
    elevations: Float32Array,
    altitudeOffset: number,
    heightScale: number,
    subdivisions: number
): void => {
    const cols = subdivisions + 1;
    for (let row = 0; row <= subdivisions; row++) {
        for (let col = 0; col <= subdivisions; col++) {
            const u = col / subdivisions;
            const v = row / subdivisions;
            const sx = Math.min(
                TILE_SIZE - 1,
                Math.round(u * (TILE_SIZE - 1))
            );
            const sy = Math.min(
                TILE_SIZE - 1,
                Math.round(v * (TILE_SIZE - 1))
            );
            const elev = elevations[sy * TILE_SIZE + sx];
            positions[(row * cols + col) * 3 + 1] =
                (elev + altitudeOffset) * heightScale;
        }
    }
};

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
                        cache.set(tryKey, { coord: tryCoord, elevation: elevData });
                        actualElevZoom = tryZoom;
                        break;
                    } catch {
                        // このzoomでは利用不可 → 1段下げて再試行
                        if (rid !== requestId) return;
                    }
                }

                if (!elevData) {
                    // 全zoomで失敗 → フラット標高で表示
                    elevData = new Float32Array(TILE_SIZE * TILE_SIZE);
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

                entry = { coord, elevation };
                cache.set(key, entry);
            }

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
            applyStitchedElevation(mesh, entry.elevation, coord);

            // テクスチャ
            applyTexture(mesh, coord);

            activeTiles.set(key, { key, coord, mesh, tileSize });

            // 隣接タイルのメッシュも再ステッチ
            restitchNeighbors(coord);

            terrainUpdatedCallback?.();
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
    const repositionActiveTiles = (): void => {
        if (!currentCenter) return;
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
                applyStitchedElevation(mesh, entry.elevation, coord);
            }
        }
        terrainUpdatedCallback?.();
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

    /** 同じzoomの隣接タイル標高をキャッシュから取得 */
    const getNeighborElevations = (coord: TileCoord): {
        top?: Float32Array; bottom?: Float32Array;
        left?: Float32Array; right?: Float32Array;
        topLeft?: Float32Array; topRight?: Float32Array;
        bottomLeft?: Float32Array; bottomRight?: Float32Array;
    } => {
        const { zoom: z, x, y } = coord;
        const get = (nx: number, ny: number): Float32Array | undefined =>
            cache.get(toTileKey({ zoom: z, x: nx, y: ny }))?.elevation;
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

    /** タイルの標高データをステッチ＋NaN埋めしてメッシュに適用 */
    const applyStitchedElevation = (
        mesh: Mesh,
        elevation: Float32Array,
        coord: TileCoord,
    ): void => {
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
        const idx = mesh.getIndices();
        if (!pos || !idx) return;

        const typed = pos instanceof Float32Array ? pos : new Float32Array(pos);

        // 標高データのコピーを作成（キャッシュの元データを保持するため）
        const stitched = new Float32Array(elevation);

        // 隣接タイルと辺を縫い合わせ
        const neighbors = getNeighborElevations(coord);
        stitchTileEdges(stitched, neighbors, TILE_SIZE);

        // NaN を埋める
        fillInvalidPixels(stitched, TILE_SIZE, TILE_SIZE);

        // メッシュに適用
        applyElevation(typed, stitched, currentAltitudeOffset, heightScale, subdivisions);
        mesh.updateVerticesData(VertexBuffer.PositionKind, typed);
        const normals = new Float32Array(typed.length);
        VertexData.ComputeNormals(typed, idx, normals);
        mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
        mesh.refreshBoundingInfo();
    };

    /** 蓄積された再ステッチ対象タイルを一括処理する */
    const flushRestitch = (): void => {
        restitchRafId = null;
        for (const key of pendingRestitch) {
            const neighborTile = activeTiles.get(key);
            if (!neighborTile) continue;
            const entry = cache.get(key);
            if (!entry) continue;
            applyStitchedElevation(neighborTile.mesh, entry.elevation, neighborTile.coord);
        }
        pendingRestitch.clear();
        terrainUpdatedCallback?.();
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
        if (restitchRafId === null) {
            restitchRafId = requestAnimationFrame(flushRestitch);
        }
    };

    /** キャッシュ済み標高データからワールド座標のY値を返す（ヒットしなければ null） */
    const queryLocalElevation = (wx: number, wz: number): number | null => {
        if (!currentCenter) return null;
        for (let z = maxElevationZoom; z >= minElevationZoom; z--) {
            const ts = tileSizeForZoom(z);
            const center = convertTileZoom(currentCenter, z);
            const { fracX, fracY } = computeSubTileOffset(currentCenter, z);
            const tileXFloat = center.x + fracX + wx / ts;
            const tileYFloat = center.y + fracY - wz / ts;
            const tileXInt = Math.floor(tileXFloat);
            const tileYInt = Math.floor(tileYFloat);
            const key = toTileKey({ zoom: z, x: tileXInt, y: tileYInt });
            const entry = cache.get(key);
            if (!entry) continue;
            const fx = tileXFloat - tileXInt;
            const fy = tileYFloat - tileYInt;
            const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.round(fx * (TILE_SIZE - 1))));
            const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.round(fy * (TILE_SIZE - 1))));
            const val = entry.elevation[py * TILE_SIZE + px];
            if (Number.isNaN(val)) continue;
            return (val + currentAltitudeOffset) * heightScale;
        }
        return null;
    };

    /** 可視タイルを算出する共通ヘルパー */
    const computeVisible = (
        frustumPlanes: FrustumPlane[],
        maxElevation: number
    ): LodTileEntry[] => {
        if (!currentCenter) return [];

        const rawCameraDistance = camera.radius;

        // ターゲット直下の地形標高を差し引き、有効カメラ距離を算出する。
        // チルト角に依存しない式を用いることで、チルト操作で baseZoom が変動することを防ぐ。
        const terrainY = queryLocalElevation(camera.target.x, camera.target.z);
        const effectiveRadius = terrainY !== null
            ? Math.max(rawCameraDistance * EFFECTIVE_RADIUS_MIN_RATIO, rawCameraDistance - terrainY)
            : rawCameraDistance;

        const baseZoom = computeBaseZoom(
            effectiveRadius,
            tileSizeForZoom,
            zoom,
            minZoom
        );

        // カメラ地上投影点（ターゲット基準のワールド座標）。
        // チルトで見える手前側タイルをカメラ直下タイルと同じ zoom に揃えるために使用。
        const sinB = Math.sin(camera.beta);
        const cameraGroundOffset = {
            x: rawCameraDistance * sinB * Math.cos(camera.alpha),
            z: rawCameraDistance * sinB * Math.sin(camera.alpha),
        };

        return computeMultiLodTiles({
            baseCenter: currentCenter,
            tileSizeForZoom,
            frustumPlanes,
            cameraDistance: effectiveRadius,
            baseZoom,
            minZoom,
            maxTiles,
            maxElevation,
            cameraGroundOffset,
            // zoom 判定の基準は生のカメラ距離。
            // 高標高地で effectiveRadius が極小化しても、遠方タイルがすぐに低 zoom へ
            // 落ちないようにする（急斜面での LOD 段差防止）。
            zoomReferenceDistance: rawCameraDistance,
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
            repositionActiveTiles();
        }

        // 新規タイルのみロード
        const toLoad = visibleEntries.filter(
            (e) => !activeTiles.has(toTileKey(e.coord))
        );

        if (toLoad.length > 0) {
            await loadTilesInQueue(toLoad, rid);
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
    };
};
