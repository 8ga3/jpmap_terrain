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
    stdTextureUrl,
} from "./gsiTile";

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
}

export interface TileManager {
    setCenter(lat: number, lon: number, altitudeOffset?: number): Promise<void>;
    attachCamera(): void;
    detachCamera(): void;
    dispose(): void;
    readonly activeTileCount: number;
    readonly loadingCount: number;
    onStatusChange: ((status: string) => void) | null;
}

interface ActiveTile {
    key: TileKey;
    coord: TileCoord;
    mesh: Mesh;
    tileSize: number;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_TILES = 60;
const DEFAULT_CACHE_CAPACITY = 96;
const DEFAULT_DEBOUNCE_MS = 200;
/** Frustum 判定用の基準最大標高 (m) — 富士山 3776m + マージン */
const MAX_BASE_ELEVATION = 4000;

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
 * 親タイルの標高データから子タイルに対応する領域を切り出す。
 * 最近傍補間で TILE_SIZE × TILE_SIZE に拡大。
 */
const extractSubTileElevation = (
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
                Math.round(originX + (x / tileSize) * subSize)
            );
            const srcY = Math.min(
                tileSize - 1,
                Math.round(originY + (y / tileSize) * subSize)
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
    } = opts;

    const minZoom = minZoomOpt ?? Math.max(0, zoom - 2);
    const maxElevationZoom = maxElevationZoomOpt ?? zoom;

    const cache: TileCache = createTileCache(cacheCapacity);
    const meshPool: MeshPool = createMeshPool({
        scene,
        subdivisions,
        tileSize: 1, // スケーリングで実サイズに合わせる
    });

    const activeTiles = new Map<TileKey, ActiveTile>();
    let requestId = 0;
    let loadingCount = 0;
    let statusCallback: ((status: string) => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cameraObserver: ReturnType<
        typeof camera.onViewMatrixChangedObservable.add
    > | null = null;

    // 現在の中心情報
    let currentCenter: TileCoord | null = null;
    let currentAltitudeOffset = 0;
    let currentLat = 0;

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

                for (let tryZoom = elevZoom; tryZoom >= minZoom; tryZoom--) {
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

            // 標高適用
            const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
            const idx = mesh.getIndices();
            if (pos && idx) {
                const typed =
                    pos instanceof Float32Array
                        ? pos
                        : new Float32Array(pos);
                applyElevation(
                    typed,
                    entry.elevation,
                    currentAltitudeOffset,
                    heightScale,
                    subdivisions
                );
                mesh.updateVerticesData(VertexBuffer.PositionKind, typed);
                const normals = new Float32Array(typed.length);
                VertexData.ComputeNormals(typed, idx, normals);
                mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
            }

            // テクスチャ
            const mat = mesh.material as StandardMaterial;
            if (mat.diffuseTexture) {
                mat.diffuseTexture.dispose();
            }
            mat.diffuseTexture = new Texture(
                stdTextureUrl(coord.zoom, coord.x, coord.y),
                scene,
                true,
                true,
                Texture.TRILINEAR_SAMPLINGMODE
            );

            activeTiles.set(key, { key, coord, mesh, tileSize });
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
            const { mesh, coord, tileSize } = tile;

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

            // キャッシュから標高データを取得し再適用
            const entry = cache.get(key);
            if (entry) {
                const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
                const idx = mesh.getIndices();
                if (pos && idx) {
                    const typed =
                        pos instanceof Float32Array
                            ? pos
                            : new Float32Array(pos);
                    applyElevation(
                        typed,
                        entry.elevation,
                        currentAltitudeOffset,
                        heightScale,
                        subdivisions
                    );
                    mesh.updateVerticesData(VertexBuffer.PositionKind, typed);
                    const normals = new Float32Array(typed.length);
                    VertexData.ComputeNormals(typed, idx, normals);
                    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
                }
            }
        }
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

    /** 可視タイルを算出する共通ヘルパー */
    const computeVisible = (
        frustumPlanes: FrustumPlane[],
        maxElevation: number
    ): LodTileEntry[] => {
        if (!currentCenter) return [];

        // カメラ→ターゲット距離（チルトに依存せず安定）
        const cameraDistance = Math.sqrt(
            camera.position.x ** 2 +
            camera.position.y ** 2 +
            camera.position.z ** 2
        );

        const baseZoom = computeBaseZoom(
            cameraDistance,
            tileSizeForZoom,
            zoom,
            minZoom
        );

        return computeMultiLodTiles({
            baseCenter: currentCenter,
            tileSizeForZoom,
            frustumPlanes,
            cameraDistance,
            baseZoom,
            minZoom,
            maxTiles,
            maxElevation,
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
            for (const [, tile] of activeTiles) {
                meshPool.release(tile.mesh);
            }
            activeTiles.clear();
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
    };
};
