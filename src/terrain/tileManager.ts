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
} from "./gsiTile";
import { stitchTileEdges, stitchTileEdgesCrossLevel } from "./tileStitching";
import type { CoarseEdgeNeighbor } from "./tileStitching";

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
        const get = (nx: number, ny: number): Float32Array | undefined => {
            const e = cache.get(toTileKey({ zoom: z, x: nx, y: ny }));
            if (!e) return undefined;
            // 元データが all-NaN かつ未補間なら参照しない（誤った 0 を伝搬させない）
            if (e.wasAllNaN && !e.unblocked) return undefined;
            return e.filled ?? e.elevation;
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

    /** 補間済み標高データをメッシュ頂点・法線に反映する */
    const applyElevationDataToMesh = (mesh: Mesh, filled: Float32Array): void => {
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
        const idx = mesh.getIndices();
        if (!pos || !idx) return;
        const typed = pos instanceof Float32Array ? pos : new Float32Array(pos);
        applyElevation(typed, filled, currentAltitudeOffset, heightScale, subdivisions);
        mesh.updateVerticesData(VertexBuffer.PositionKind, typed);
        const normals = new Float32Array(typed.length);
        VertexData.ComputeNormals(typed, idx, normals);
        mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
        mesh.refreshBoundingInfo();
    };

    /** タイルの標高データをステッチ＋NaN埋めしてメッシュに適用 */
    const applyStitchedElevation = (
        mesh: Mesh,
        elevation: Float32Array,
        coord: TileCoord,
    ): void => {
        const cacheEntryPre = cache.get(toTileKey(coord));

        // 常に元データ(elevation)からコピー。
        // 再ステッチ時に古い filled を引き継がないことで、隣接ズーム変更後も正しい値に収束する。
        const stitched = new Float32Array(elevation);

        // 隣接タイルと辺を縫い合わせ（同 zoom）
        const neighbors = getNeighborElevations(coord);
        stitchTileEdges(stitched, neighbors, TILE_SIZE);

        // 異 zoom 隣接（粗タイル）と縫い合わせ。
        // - 通常タイルはカメラ近傍のみ対象（再適用時の計算コスト抑制）
        // - all-NaN タイルは同 zoom 近傍からシードが得られない場合があるため
        //   カメラ距離に関わらず常に試行する
        const tileSize = tileSizeForZoom(coord.zoom);
        if (cacheEntryPre?.wasAllNaN || isTileNearCamera(coord, tileSize)) {
            const coarse = getCoarseEdgeNeighbors(coord);
            if (coarse.length > 0) {
                stitchTileEdgesCrossLevel(stitched, coarse, TILE_SIZE);
            }
        }

        // wasAllNaN タイルのシード判定（ステッチ後、辺に有効値が 1 つでもあるか）
        let hasSeed = false;
        if (cacheEntryPre?.wasAllNaN) {
            const last = TILE_SIZE - 1;
            for (let i = 0; i < TILE_SIZE && !hasSeed; i++) {
                // 上辺・下辺
                if (!isInvalidElev(stitched[i])) { hasSeed = true; break; }
                if (!isInvalidElev(stitched[last * TILE_SIZE + i])) { hasSeed = true; break; }
                // 左辺・右辺
                if (!isInvalidElev(stitched[i * TILE_SIZE])) { hasSeed = true; break; }
                if (!isInvalidElev(stitched[i * TILE_SIZE + last])) { hasSeed = true; break; }
            }
        }

        // NaN を埋める（BFS）
        fillInvalidPixels(stitched, TILE_SIZE, TILE_SIZE);

        // メッシュに適用:
        // - シードあり: 今回のステッチ結果を使用
        // - シードなし（wasAllNaN）: 旧 filled があれば維持（Y=0 凹み防止）
        const meshData = (cacheEntryPre?.wasAllNaN && !hasSeed && cacheEntryPre.filled)
            ? cacheEntryPre.filled
            : stitched;
        applyElevationDataToMesh(mesh, meshData);

        // キャッシュ更新: シードが得られた場合のみ filled/unblocked を更新
        if (cacheEntryPre?.wasAllNaN && hasSeed) {
            cacheEntryPre.filled = stitched;
            cacheEntryPre.unblocked = true;
        }
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
    const refineAllNaNTiles = (): void => {
        // wasAllNaN タイルを収集
        const allNanTiles: Array<[TileKey, ActiveTile]> = [];
        for (const [key, tile] of activeTiles) {
            const entry = cache.get(key);
            if (entry?.wasAllNaN) allNanTiles.push([key, tile]);
        }
        if (allNanTiles.length === 0) return;

        // Step 1: wasAllNaN タイルをリセット（前回の rescue 値も含めて毎回やり直す）
        for (const [key] of allNanTiles) {
            const entry = cache.get(key);
            if (entry) { entry.filled = undefined; entry.unblocked = false; }
        }

        // Step 2: 反復ステッチ + NaN 埋め
        for (let iter = 0; iter < ALL_NAN_REFINE_MAX_ITER; iter++) {
            let resolvedThisIter = 0;
            let remainingCount = 0;

            for (const [key, tile] of allNanTiles) {
                const entry = cache.get(key);
                if (!entry || entry.unblocked) continue; // 解決済みはスキップ

                remainingCount++;

                // elevation ベース（all-NaN）でステッチ
                const stitched = new Float32Array(entry.elevation);
                stitchTileEdges(stitched, getNeighborElevations(tile.coord), TILE_SIZE);
                const coarse = getCoarseEdgeNeighbors(tile.coord);
                if (coarse.length > 0) stitchTileEdgesCrossLevel(stitched, coarse, TILE_SIZE);

                // 辺シード判定
                const last = TILE_SIZE - 1;
                let hasSeed = false;
                for (let i = 0; i < TILE_SIZE && !hasSeed; i++) {
                    if (!isInvalidElev(stitched[i])) { hasSeed = true; break; }
                    if (!isInvalidElev(stitched[last * TILE_SIZE + i])) { hasSeed = true; break; }
                    if (!isInvalidElev(stitched[i * TILE_SIZE])) { hasSeed = true; break; }
                    if (!isInvalidElev(stitched[i * TILE_SIZE + last])) { hasSeed = true; break; }
                }

                if (hasSeed) {
                    fillInvalidPixels(stitched, TILE_SIZE, TILE_SIZE);
                    entry.filled = stitched;
                    entry.unblocked = true;
                    resolvedThisIter++;
                    remainingCount--;
                }
            }

            if (remainingCount === 0 || resolvedThisIter === 0) break;
        }

        // Step 3: メッシュ適用（解決済みタイルのみ）
        let progressed = false;
        for (const [, tile] of allNanTiles) {
            const entry = cache.get(toTileKey(tile.coord));
            if (!entry?.filled) continue;
            applyElevationDataToMesh(tile.mesh, entry.filled);
            progressed = true;
        }

        // Step 4: レスキューパス（反復で到達できなかったタイルを代表標高で平坦化）
        const stillBlocked: Array<[string, ActiveTile]> = [];
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
                if (!entry || entry.wasAllNaN) continue;
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
                    applyElevationDataToMesh(tile.mesh, filled);
                }
                progressed = true;
            }
        }

        if (progressed) {
            terrainUpdatedCallback?.();
        }
    };

    /**
     * キャッシュ済み標高データからワールド座標のY値を返す（ヒットしなければ null）。
     * メッシュ適用時（fillInvalidPixels）と同様に、NaN ピクセルは近傍8方向から補間する。
     * 近傍にも有効値がなければ低 zoom へフォールバックし、全 zoom で見つからなければ null。
     */
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
            // まだ解決できていない all-NaN タイルはスキップ
            if (entry.wasAllNaN && !entry.unblocked) continue;
            const data = entry.filled ?? entry.elevation;
            const fx = tileXFloat - tileXInt;
            const fy = tileYFloat - tileYInt;
            const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.round(fx * (TILE_SIZE - 1))));
            const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.round(fy * (TILE_SIZE - 1))));
            const val = data[py * TILE_SIZE + px];
            if (!isInvalidElev(val)) {
                return (val + currentAltitudeOffset) * heightScale;
            }
            // 無効値の場合は近傍8ピクセルから補間（fillInvalidPixels と同等の方針）。
            // 近傍にも有効値がなければ低 zoom へフォールバックする。
            let sum = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = px + dx;
                    const ny = py + dy;
                    if (nx < 0 || nx >= TILE_SIZE || ny < 0 || ny >= TILE_SIZE) continue;
                    const nv = data[ny * TILE_SIZE + nx];
                    if (!isInvalidElev(nv)) {
                        sum += nv;
                        count++;
                    }
                }
            }
            if (count > 0) {
                return (sum / count + currentAltitudeOffset) * heightScale;
            }
            // 近傍全て NaN → 低 zoom へフォールバック
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
            repositionActiveTiles();
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
            refineAllNaNTiles();
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

        setShadowHooks(hooks: ShadowHooks | null): void {
            meshPool.setShadowHooks(hooks);
        },

        forEachActiveMesh(cb: (mesh: Mesh) => void): void {
            meshPool.forEachActive(cb);
        },
    };
};
