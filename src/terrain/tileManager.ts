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

import { TileCoord, TileKey, toTileKey, tileOffsetToWorld } from "./tileTypes";
import { computeVisibleTiles, FrustumPlane } from "./visibleTiles";
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
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_TILES = 25;
const DEFAULT_CACHE_CAPACITY = 64;
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
    } = opts;

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
    let currentTileSize = 0;
    let currentAltitudeOffset = 0;

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
        rid: number
    ): Promise<void> => {
        const key = toTileKey(coord);
        if (activeTiles.has(key)) return;

        loadingCount++;
        emitStatus();

        try {
            // キャッシュ or fetch
            let entry = cache.get(key);
            if (!entry) {
                const elevation = await loadElevationTile(
                    coord.zoom,
                    coord.x,
                    coord.y
                );
                if (rid !== requestId) return;
                entry = { coord, elevation };
                cache.set(key, entry);
            }

            if (rid !== requestId) return;
            if (activeTiles.has(key)) return;

            // メッシュ取得・配置
            const mesh = meshPool.acquire();
            const tileSize = currentTileSize;

            // スケーリング
            mesh.scaling.x = tileSize;
            mesh.scaling.z = tileSize;
            mesh.scaling.y = 1;

            // 中心タイルからのオフセット
            const dx = coord.x - currentCenter!.x;
            const dy = coord.y - currentCenter!.y;
            const { wx, wz } = tileOffsetToWorld(dx, dy, tileSize);
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

            activeTiles.set(key, { key, coord, mesh });
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

    /** 既存 activeTiles の position/scaling/標高を現在の中心・タイルサイズ・高度オフセットに合わせて再配置 */
    const repositionActiveTiles = (): void => {
        if (!currentCenter) return;
        for (const [key, tile] of activeTiles) {
            const { mesh, coord } = tile;

            // スケーリング
            mesh.scaling.x = currentTileSize;
            mesh.scaling.z = currentTileSize;
            mesh.scaling.y = 1;

            // 位置
            const dx = coord.x - currentCenter.x;
            const dy = coord.y - currentCenter.y;
            const { wx, wz } = tileOffsetToWorld(dx, dy, currentTileSize);
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
        coords: TileCoord[],
        rid: number
    ): Promise<void> => {
        let idx = 0;
        const next = async (): Promise<void> => {
            while (idx < coords.length && rid === requestId) {
                const coord = coords[idx++];
                await loadTile(coord, rid);
            }
        };

        const workers = Array.from(
            { length: Math.min(maxConcurrent, coords.length) },
            () => next()
        );
        await Promise.all(workers);
    };

    /** 可視タイルを再計算し、不要タイルを解放・新規タイルをロード */
    const refresh = async (
        lat: number,
        lon: number,
        altitudeOffset: number
    ): Promise<void> => {
        const rid = ++requestId;

        const center = toTileXY(lat, lon, zoom);
        const tileSize = tileEdgeMeters(lat, zoom);
        currentCenter = { zoom, x: center.x, y: center.y };
        currentTileSize = tileSize;
        currentAltitudeOffset = altitudeOffset;

        // Frustum planes 取得
        const frustumPlanes = extractFrustumPlanes(camera);

        // AABB maxY: (想定最大標高 + 高度オフセット) * heightScale
        const maxElevation =
            (MAX_BASE_ELEVATION + Math.max(0, altitudeOffset)) * heightScale;

        // 可視タイル算出
        const visibleCoords = computeVisibleTiles({
            center: currentCenter,
            tileSize,
            frustumPlanes,
            maxTiles,
            maxElevation,
        });
        const visibleKeys = new Set(visibleCoords.map(toTileKey));

        // 不要タイルを解放
        for (const [key, tile] of activeTiles) {
            if (!visibleKeys.has(key)) {
                meshPool.release(tile.mesh);
                activeTiles.delete(key);
            }
        }

        // 既存タイルの position/scaling/標高を新しい中心基準で再配置
        repositionActiveTiles();

        // 新規タイルのみロード
        const toLoad = visibleCoords.filter(
            (c) => !activeTiles.has(toTileKey(c))
        );

        if (toLoad.length > 0) {
            await loadTilesInQueue(toLoad, rid);
        }

        emitStatus();
    };

    // カメラ変更時のリフレッシュ（中心座標を保持して使用）
    const refreshFromCamera = async (): Promise<void> => {
        if (!currentCenter) return;
        const rid = ++requestId;

        const frustumPlanes = extractFrustumPlanes(camera);
        const maxElevation =
            (MAX_BASE_ELEVATION + Math.max(0, currentAltitudeOffset)) *
            heightScale;
        const visibleCoords = computeVisibleTiles({
            center: currentCenter,
            tileSize: currentTileSize,
            frustumPlanes,
            maxTiles,
            maxElevation,
        });
        const visibleKeys = new Set(visibleCoords.map(toTileKey));

        // 不要タイルを解放
        for (const [key, tile] of activeTiles) {
            if (!visibleKeys.has(key)) {
                meshPool.release(tile.mesh);
                activeTiles.delete(key);
            }
        }

        // 新規タイルのみロード
        const toLoad = visibleCoords.filter(
            (c) => !activeTiles.has(toTileKey(c))
        );

        if (toLoad.length > 0) {
            await loadTilesInQueue(toLoad, rid);
        }

        emitStatus();
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
