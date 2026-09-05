/** タイルのライフサイクルを統合管理する TileManager */

import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import {
    createElevationWorkerPool,
    type ElevationWorkerPool,
} from "./elevationWorkerPool";
import {
    fillInvalidPixels,
    isAllNaN,
    isInvalidElev,
    loadElevationTile,
    type MapType,
    NO_DATA_SENTINEL,
    TILE_SIZE,
    textureUrl,
    tileEdgeMeters,
    toTileXY,
} from "./gsiTile";
import { createMeshPool, type MeshPool, type ShadowHooks } from "./meshPool";
import { createTileCache, type TileCache } from "./tileCache";
import type { CoarseEdgeNeighbor, CoarseTileSource } from "./tileStitching";
import {
    selectCoarseEdgeNeighbors,
    stitchTileEdges,
    stitchTileEdgesCrossLevel,
} from "./tileStitching";
import {
    computeSubTileOffset,
    convertTileZoom,
    type TileCoord,
    type TileKey,
    tileOffsetToWorld,
    toTileKey,
} from "./tileTypes";
import {
    computeQuadtreeTiles,
    type FrustumPlane,
    type LodTileEntry,
} from "./visibleTiles";

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
        lodBias?: number,
    ): Promise<void>;
    setMapType(mapType: MapType): void;
    readonly mapType: MapType;
    attachCamera(): void;
    detachCamera(): void;
    dispose(): void;
    readonly activeTileCount: number;
    readonly pendingReleaseCount: number;
    readonly loadingCount: number;
    /** テスト用: タイルロード完了かつ debounce 待機なし かつ テクスチャ適用完了 かつ 再ステッチ完了 */
    readonly isIdle: boolean;
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
    /** 太陽影 caster/receiver フックを設定する。`null` で解除 */
    setShadowHooks(hooks: ShadowHooks | null): void;
    /** 現在アクティブな全タイルメッシュを列挙する（ON/OFF 切替用） */
    forEachActiveMesh(cb: (mesh: Mesh) => void): void;
}

interface ActiveTile {
    key: TileKey;
    coord: TileCoord;
    mesh: Mesh;
    tileSize: number;
}

/** LOD 遷移中に画面に残す旧タイル */
interface PendingReleaseTile {
    key: TileKey;
    coord: TileCoord;
    mesh: Mesh;
    tileSize: number;
    /** 強制解放用タイマーID */
    timerId: ReturnType<typeof setTimeout>;
    /**
     * pendingRelease 中も隣接細タイルから cross-level 縫い合わせ参照されるため、
     * cache が LRU で退避されても elevation を保持しておく。
     * filled が無い場合は raw elevation を利用する。
     */
    elevation: Float32Array;
    filled?: Float32Array;
    wasAllNaN?: boolean;
    unblocked?: boolean;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_TILES = 200;
const DEFAULT_CACHE_CAPACITY = 192;
const DEFAULT_DEBOUNCE_MS = 200;
/** Frustum 判定用の基準最大標高 (m) — 富士山 3776m + マージン */
const MAX_BASE_ELEVATION = 4000;
/*
 * 旧 NEAR_DISTANCE_TILES_FACTOR 定数は isTileNearCamera と共に撤廃済み。
 */
/** 旧タイルの強制解放までのタイムアウト (ms) */
const PENDING_RELEASE_TIMEOUT_MS = 5000;
/**
 * cache が LRU 退避済みで elevation を取得できない pendingRelease タイル向けの
 * 共有センチネルバッファ。wasAllNaN=true / unblocked=false と組み合わせて使い、
 * cross-level / queryLocalElevation の候補除外ゲートを通過させる目的のみに使う。
 * 実際に標高値として読まれることはないため、全タイルで 1 インスタンスを共有して
 * 毎回 new Float32Array(256*256) を確保するメモリスパイクを避ける。
 */
const EMPTY_NAN_ELEVATION = new Float32Array(TILE_SIZE * TILE_SIZE).fill(NaN);

// 標高反映は Web Worker 化に伴い `elevationCompute.ts` の
// `applyElevationToPositions` に集約されている。

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
                    : Math.round(originX),
            );
            const srcY = Math.min(
                tileSize - 1,
                tileSize > 1
                    ? Math.round(originY + (y / (tileSize - 1)) * (subSize - 1))
                    : Math.round(originY),
            );
            result[y * tileSize + x] = parentElev[srcY * tileSize + srcX];
        }
    }
    return result;
};

/** Babylon.js Frustum planes を FrustumPlane[] に変換 */
const extractFrustumPlanes = (camera: ArcRotateCamera): FrustumPlane[] => {
    // 2D (ortho) では camera.alpha 変更（画面回転）に伴って AABB-frustum 交差が
    // 拡大し、`computeQuadtreeTiles` の maxTiles / maxVisited に達して粗LODへの
    // 強制フォールバックや遠方タイル切捨てが起き、回転中にタイルレベルが乱れる。
    // タイル選択は地理的中心と orthoサイズだけで決めれば十分なので、
    // ortho 時は回転に依存しない axis-aligned な frustum 平面を構築する。
    if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
        return extractOrthoStableFrustumPlanes(camera);
    }
    const transform = Matrix.Identity();
    camera
        .getViewMatrix()
        .multiplyToRef(camera.getProjectionMatrix(), transform);
    const planes: Plane[] = Array.from(
        { length: 6 },
        () => new Plane(0, 0, 0, 0),
    );
    Frustum.GetPlanesToRef(transform, planes);

    return planes.map((p) => ({
        normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
        d: p.d,
    }));
};

/**
 * 2D (ortho) 用の回転安定な frustum 平面を返す。
 *
 * orthoLeft/Right/Top/Bottom が定義する可視矩形を、`camera.alpha` がどの値でも
 * 完全に内包する正方形（中心 `camera.target`、半辺 `hypot(halfW, halfH)`）
 * に展開して X/Z 軸方向の4平面を構築する。Y 方向は地形の標高範囲を十分に
 * カバーする大きな上下平面を返す。
 * これにより、画面回転だけでタイル選択集合が変動するのを防ぐ。
 */
export const extractOrthoStableFrustumPlanes = (camera: {
    orthoLeft?: number | null;
    orthoRight?: number | null;
    orthoTop?: number | null;
    orthoBottom?: number | null;
    target: { x: number; z: number };
}): FrustumPlane[] => {
    const left = camera.orthoLeft ?? 0;
    const right = camera.orthoRight ?? 0;
    const top = camera.orthoTop ?? 0;
    const bottom = camera.orthoBottom ?? 0;
    const halfW = (right - left) / 2;
    const halfH = (top - bottom) / 2;
    // 任意の回転角で可視矩形を内包する半辺（外接円半径）
    const radius = Math.hypot(halfW, halfH);
    const cx = camera.target.x;
    const cz = camera.target.z;
    // Y 方向は地形標高 ±数千m を大きく上回る値で常に内側判定にする。
    // isAABBInFrustum は `n·p + d < 0` で外側判定するため、上下とも d を大きく取る。
    const Y_HALF = 1e9;
    return [
        { normal: { x: 1, y: 0, z: 0 }, d: -(cx - radius) },
        { normal: { x: -1, y: 0, z: 0 }, d: cx + radius },
        { normal: { x: 0, y: 0, z: 1 }, d: -(cz - radius) },
        { normal: { x: 0, y: 0, z: -1 }, d: cz + radius },
        { normal: { x: 0, y: 1, z: 0 }, d: Y_HALF },
        { normal: { x: 0, y: -1, z: 0 }, d: Y_HALF },
    ];
};

/**
 * mesh の scaling(x/z, y=1)・position(x/z) を、`center`/`fracX`/`fracY`（呼び出し側で
 * `convertTileZoom` / `computeSubTileOffset` により currentCenter から求めた値）を用いて更新する。
 * 新規タイル生成時・Follow モードの軽量リポジション（active/pendingRelease 双方）で共用する。
 */
const applyTileTransform = (
    mesh: Mesh,
    coord: TileCoord,
    tileSize: number,
    center: TileCoord,
    fracX: number,
    fracY: number,
): void => {
    mesh.scaling.x = tileSize;
    mesh.scaling.z = tileSize;
    mesh.scaling.y = 1;
    const dx = coord.x - center.x;
    const dy = coord.y - center.y;
    const { wx, wz } = tileOffsetToWorld(dx - fracX, dy - fracY, tileSize);
    mesh.position.x = wx;
    mesh.position.z = wz;
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
    const minElevationZoom =
        minElevationZoomOpt ?? Math.max(minZoom, maxElevationZoom - 4);

    const cache: TileCache = createTileCache(cacheCapacity);
    const meshPool: MeshPool = createMeshPool({
        scene,
        subdivisions,
        tileSize: 1, // スケーリングで実サイズに合わせる
    });

    const activeTiles = new Map<TileKey, ActiveTile>();
    /**
     * LOD 遷移中に画面に残す旧タイル。
     * 新タイルが描画可能になるまで表示を維持し、カバー完了 or タイムアウトで解放する。
     */
    const pendingRelease = new Map<TileKey, PendingReleaseTile>();
    /**
     * pendingRelease の子孫候補を高速に引くためのインデックス。
     * 祖先キー → そのキーを祖先に持つ pending タイルのキー集合。
     * pendingRelease 追加/削除時に同期的にメンテナンスする。
     */
    const pendingAncestorIndex = new Map<TileKey, Set<TileKey>>();

    /** pendingRelease に登録し、祖先インデックスも更新する */
    const addPendingRelease = (
        key: TileKey,
        entry: PendingReleaseTile,
    ): void => {
        pendingRelease.set(key, entry);
        // 祖先キーをインデックスに追加
        for (let az = entry.coord.zoom - 1; az >= minZoom; az--) {
            const diff = entry.coord.zoom - az;
            const ak = toTileKey({
                zoom: az,
                x: entry.coord.x >> diff,
                y: entry.coord.y >> diff,
            });
            let s = pendingAncestorIndex.get(ak);
            if (!s) {
                s = new Set();
                pendingAncestorIndex.set(ak, s);
            }
            s.add(key);
        }
    };

    /** pendingRelease から削除し、祖先インデックスも更新する */
    const removePendingRelease = (
        key: TileKey,
    ): PendingReleaseTile | undefined => {
        const entry = pendingRelease.get(key);
        if (!entry) return undefined;
        pendingRelease.delete(key);
        // 祖先キーをインデックスから削除
        for (let az = entry.coord.zoom - 1; az >= minZoom; az--) {
            const diff = entry.coord.zoom - az;
            const ak = toTileKey({
                zoom: az,
                x: entry.coord.x >> diff,
                y: entry.coord.y >> diff,
            });
            const s = pendingAncestorIndex.get(ak);
            if (s) {
                s.delete(key);
                if (s.size === 0) pendingAncestorIndex.delete(ak);
            }
        }
        return entry;
    };
    /**
     * 親タイルが pendingRelease 中のため非表示待機している子タイルのキー。
     * 4枚揃ったタイミングで一斉に setEnabled(true) して親を解放する。
     */
    const hiddenChildTiles = new Set<TileKey>();
    /** テクスチャ適用の競合を防ぐためのリクエストID（mesh単位） */
    const textureRequestIds = new Map<Mesh, number>();
    let requestId = 0;
    let loadingCount = 0;
    /** dispose() 後は true。in-flight コールバックがカウンタを負にするのを防ぐ */
    let disposed = false;
    /** テクスチャダウンロード中のカウンタ（isIdle 判定用） */
    let pendingTextureCount = 0;
    /**
     * Follow モードで実行中の loadTilesInQueue の数（フレーム単位スロットリング制御用）。
     * 複数の loadTilesInQueue が並行して走っても正しく機能するようカウンタで管理する。
     */
    let followModeActiveCount = 0;
    /** Follow モードでのロード中かどうか（フレーム単位スロットリング制御用） */
    const followModeLoading = (): boolean => followModeActiveCount > 0;
    /**
     * loadingCount が正→0 に遷移したとき呼ばれるコールバック。
     * attachCamera 内で設定し、ロード中にカメラが移動した場合の再リフレッシュを行う。
     */
    let onLoadingComplete: (() => void) | null = null;
    let statusCallback: ((status: string) => void) | null = null;
    let terrainUpdatedCallback: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cameraObserver: ReturnType<
        typeof camera.onViewMatrixChangedObservable.add
    > | null = null;

    /** 再ステッチ待ちの隣接タイルキーを蓄積し、同一フレームで一括処理する */
    const pendingRestitch = new Set<TileKey>();
    let restitchRafId: number | null = null;
    /** RAF 非対応環境（Node.js / SSR）用の setTimeout フォールバック ID */
    let restitchTimerId: ReturnType<typeof setTimeout> | null = null;
    /** flushRestitch 内で実行中の applyStitchedElevation Promise 数 */
    let restitchingCount = 0;

    /** 最新の applyVisibleTiles で計算された必要タイルキー集合 */
    let currentVisibleKeys = new Set<TileKey>();

    /** 最新の applyVisibleTiles で構築された可視タイルの全祖先キー集合（isAreaCovered 枝刈り用）*/
    let currentVisibleAncestorKeys = new Set<TileKey>();

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
                `表示中 ${active}/${maxTiles} タイル (読込中: ${loading})`,
            );
        } else {
            statusCallback(`表示中 ${active}/${maxTiles} タイル`);
        }
    };

    /**
     * `hiddenChildTiles` のうち `(baseZoom, baseX, baseY)` の子孫（`includeSameZoom` が true なら
     * 同一 zoom のタイル自身も対象）で、テクスチャ ready なものを表示し `hiddenChildTiles` から
     * 除去する。`releasePendingTile`（子孫のみ・自身除く）と `enableDescendants`（自身も含む）の
     * 双方が使う共通処理（globe版 `globeTileManager.ts` の `revealReadyDescendants` に相当）。
     */
    const revealActiveDescendants = (
        baseZoom: number,
        baseX: number,
        baseY: number,
        includeSameZoom: boolean,
    ): void => {
        const toRemove: TileKey[] = [];
        for (const dk of hiddenChildTiles) {
            const parts = dk.split("/");
            const cz = Number(parts[0]);
            if (includeSameZoom ? cz < baseZoom : cz <= baseZoom) continue;
            const diff = cz - baseZoom;
            const cx = Number(parts[1]);
            const cy = Number(parts[2]);
            if (cx >> diff === baseX && cy >> diff === baseY) {
                toRemove.push(dk);
            }
        }
        for (const dk of toRemove) {
            hiddenChildTiles.delete(dk);
            const tile = activeTiles.get(dk);
            if (tile && isMeshTextureReady(tile.mesh)) {
                tile.mesh.setEnabled(true);
            }
        }
    };

    /** pendingRelease から単一タイルを解放する */
    const releasePendingTile = (key: TileKey): void => {
        const pending = pendingRelease.get(key);
        if (!pending) return;
        clearTimeout(pending.timerId);
        // タイムアウト等で強制解放する場合、待機中の子孫タイルを一斉に表示する。
        // hiddenChildTiles を走査して pending.coord の子孫だけを処理する（O(hiddenChildTiles)）。
        // ただしテクスチャ未 ready の mesh を setEnabled(true) すると null bind /
        // 描画穴の原因になるため、hiddenChildTiles から外すだけにとどめ、
        // テクスチャ onLoad 側で setEnabled(true) されるに委ねる。
        revealActiveDescendants(
            pending.coord.zoom,
            pending.coord.x,
            pending.coord.y,
            false,
        );
        // delete ではなく increment して in-flight コールバックを確実に無効化する。
        // delete 後に同 mesh がプールから再利用されると texReqId が 1 から再開し、
        // 残留していた古い onLoad（同じく texReqId=1）と衝突して誤テクスチャが適用される。
        textureRequestIds.set(
            pending.mesh,
            (textureRequestIds.get(pending.mesh) ?? 0) + 1,
        );
        meshPool.release(pending.mesh);
        removePendingRelease(key);
        // 解放した粗タイルにスナップしていた可能性のある隣接細 active タイルを
        // 再ステッチして、スナップ元消失後の整合性を取り直す。
        restitchNeighbors(pending.coord);
    };

    /** pendingRelease を全てクリアする */
    const clearAllPendingRelease = (): void => {
        for (const [key] of pendingRelease) {
            releasePendingTile(key);
        }
    };

    /** mesh のテクスチャが既にロード完了しているか */
    const isMeshTextureReady = (mesh: Mesh): boolean => {
        const mat = mesh.material as StandardMaterial | null;
        const tex = mat?.diffuseTexture;
        if (!tex) return false;
        return typeof tex.isReady === "function" ? tex.isReady() : true;
    };

    /**
     * 指定した矩形領域が activeTiles で完全にカバーされているか再帰的に判定する。
     * LOD により可視タイルは複数の zoom 階層に分散するため、各階層で
     *   - activeTiles に存在 かつテクスチャ ready → カバー済み
     *   - activeTiles に存在するがテクスチャ未 ready → 未カバー（描画穴防止）
     *   - currentVisibleKeys に存在する（=その階層で必要）が active でない → 未カバー
     *   - currentVisibleKeys に存在しない → 子へ降りて判定
     * 最深 (targetZoom) まで降りて visibleKeys に無ければ frustum 外 → カバー不要。
     */
    const isAreaCovered = (
        areaZoom: number,
        ax: number,
        ay: number,
        targetZoom: number,
    ): boolean => {
        const areaKey = toTileKey({ zoom: areaZoom, x: ax, y: ay });
        const active = activeTiles.get(areaKey);
        if (active) {
            return isMeshTextureReady(active.mesh);
        }
        // この階層で必要とされているのに active でない → 未カバー
        if (currentVisibleKeys.has(areaKey)) return false;
        if (areaZoom >= targetZoom) {
            // 最深レベルでかつ visibleKeys に無い → frustum 外なのでカバー不要
            return true;
        }
        // このノードが可視タイルの祖先でなければ子孫に可視タイルは存在しない → カバー不要
        if (!currentVisibleAncestorKeys.has(areaKey)) {
            return true;
        }
        // 4分割して再帰チェック
        const cz = areaZoom + 1;
        return (
            isAreaCovered(cz, ax * 2, ay * 2, targetZoom) &&
            isAreaCovered(cz, ax * 2 + 1, ay * 2, targetZoom) &&
            isAreaCovered(cz, ax * 2, ay * 2 + 1, targetZoom) &&
            isAreaCovered(cz, ax * 2 + 1, ay * 2 + 1, targetZoom)
        );
    };

    /**
     * 指定した矩形領域内の hiddenChildTiles を全て表示状態にする。
     * hiddenChildTiles を1回走査して該当領域の子孫だけを処理する（O(hiddenChildTiles)）。
     */
    const enableDescendants = (
        areaZoom: number,
        ax: number,
        ay: number,
    ): void => {
        revealActiveDescendants(areaZoom, ax, ay, true);
    };

    /**
     * 新タイルがロードされたとき、対応する旧タイルのカバレッジを判定して解放する。
     *
     * zoom アップ（細分化）: 旧タイル(Z) の領域が activeTiles で完全カバーされたら
     *   子孫タイルを一斉に setEnabled(true) して親を解放する。
     *   zoom が2段以上離れるケースも再帰的にカバー判定する。
     * zoom ダウン（統合）: 旧タイル(Z) の親タイル(Z-1) が active なら解放。
     *
     * `loadedCoord` を指定すると、その新タイルに関係する pending のみ判定する（高速化）。
     * 未指定時は全 pending を判定する（applyVisibleTiles 後の念のためチェック用）。
     */
    const checkAndReleaseCoveredTiles = (loadedCoord?: TileCoord): void => {
        // 判定対象 pending を絞り込む
        let candidateKeys: Iterable<TileKey>;
        if (loadedCoord) {
            const cands = new Set<TileKey>();
            // 同一キー（Case 3）
            cands.add(toTileKey(loadedCoord));
            // 祖先（Case 1 候補：新タイルが pending の子孫）
            for (let az = loadedCoord.zoom - 1; az >= minZoom; az--) {
                const diff = loadedCoord.zoom - az;
                const ak = toTileKey({
                    zoom: az,
                    x: loadedCoord.x >> diff,
                    y: loadedCoord.y >> diff,
                });
                if (pendingRelease.has(ak)) cands.add(ak);
            }
            // 子孫（Case 2 候補：新タイルが pending の祖先）
            // 祖先インデックスから O(1) で取得
            const loadedKey = toTileKey(loadedCoord);
            const descendants = pendingAncestorIndex.get(loadedKey);
            if (descendants) {
                for (const dk of descendants) cands.add(dk);
            }
            candidateKeys = cands;
        } else {
            candidateKeys = Array.from(pendingRelease.keys());
        }

        for (const key of candidateKeys) {
            const pending = pendingRelease.get(key);
            if (!pending) continue;
            const { coord } = pending;

            // Case 1: 旧タイル（粗）の領域が子孫新タイルで完全カバーされたか（zoom-up 用）。
            // pending が現在の可視タイル群の祖先である場合のみ評価する。
            // zoom-down 時に残った粗いタイルが子孫不在でも true と判定されるのを防ぐ。
            if (coord.zoom < zoom && currentVisibleAncestorKeys.has(key)) {
                if (isAreaCovered(coord.zoom, coord.x, coord.y, zoom)) {
                    // 子孫タイルを一斉に表示してから親を解放
                    enableDescendants(coord.zoom + 1, coord.x * 2, coord.y * 2);
                    enableDescendants(
                        coord.zoom + 1,
                        coord.x * 2 + 1,
                        coord.y * 2,
                    );
                    enableDescendants(
                        coord.zoom + 1,
                        coord.x * 2,
                        coord.y * 2 + 1,
                    );
                    enableDescendants(
                        coord.zoom + 1,
                        coord.x * 2 + 1,
                        coord.y * 2 + 1,
                    );
                    releasePendingTile(key);
                    continue;
                }
            }

            // Case 2: 旧タイルが祖先タイルでカバーされたか（zoom-down 2段以上対応）
            // 祖先タイルも isMeshTextureReady を満たしていなければ、まだ描画されていないので解放しない。
            let ancestorFound = false;
            for (let az = coord.zoom - 1; az >= minZoom; az--) {
                const diff = coord.zoom - az;
                const ancestorX = coord.x >> diff;
                const ancestorY = coord.y >> diff;
                const ancestorTile = activeTiles.get(
                    toTileKey({ zoom: az, x: ancestorX, y: ancestorY }),
                );
                if (ancestorTile && isMeshTextureReady(ancestorTile.mesh)) {
                    ancestorFound = true;
                    break;
                }
            }
            if (ancestorFound) {
                releasePendingTile(key);
                continue;
            }

            // Case 3: 同 zoom の新タイルが同じキーで既に active なら不要
            const sameTile = activeTiles.get(key);
            if (sameTile && isMeshTextureReady(sameTile.mesh)) {
                releasePendingTile(key);
            }
        }
    };

    /** 単一タイルをロードしてメッシュに適用 */
    const loadTile = async (
        coord: TileCoord,
        tileSize: number,
        rid: number,
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

                for (
                    let tryZoom = elevZoom;
                    tryZoom >= minElevationZoom;
                    tryZoom--
                ) {
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
                            tryCoord.y,
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
                        elevData,
                        coord,
                        actualElevZoom,
                        TILE_SIZE,
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
            // 飛行機アニメーションがちらつくのを防ぐ。
            const releaseSlot = await acquireApplySlot();
            try {
                if (rid !== requestId) return;
                if (activeTiles.has(key)) return;

                // メッシュ取得・配置
                const mesh = meshPool.acquire();

                // 中心タイルからのオフセット（サブタイルオフセット補正込み）でスケーリング・配置
                const center = convertTileZoom(currentCenter, coord.zoom);
                const { fracX, fracY } = computeSubTileOffset(
                    currentCenter,
                    coord.zoom,
                );
                applyTileTransform(mesh, coord, tileSize, center, fracX, fracY);

                // テクスチャを先に適用（Worker 待ちの applyStitchedElevation と無関係に
                //  非同期 fetch を開始しておく）。標高反映後でも順序的には問題ない。
                // 祖先タイルが pendingRelease 中の場合、この子タイルは非表示待機として登録する。
                // applyTexture の onLoad が setEnabled(true) を呼ぶ前に hiddenChildTiles に
                // 追加することで、テクスチャ onLoad での表示を抑止する（競合防止）。
                // zoom が2段以上離れるケースに対応するため、全祖先をチェック。
                let isHiddenChild = false;
                for (let az = coord.zoom - 1; az >= minZoom; az--) {
                    const diff = coord.zoom - az;
                    const ancestorX = coord.x >> diff;
                    const ancestorY = coord.y >> diff;
                    if (
                        pendingRelease.has(
                            toTileKey({ zoom: az, x: ancestorX, y: ancestorY }),
                        )
                    ) {
                        isHiddenChild = true;
                        break;
                    }
                }
                if (isHiddenChild) {
                    hiddenChildTiles.add(key);
                }
                applyTexture(mesh, coord);

                // 標高適用（ステッチ＋NaN埋め）— Worker でオフロード
                try {
                    await applyStitchedElevation(mesh, entry.elevation, coord);
                } catch (applyErr) {
                    // 失敗時: hiddenChildTiles / textureRequestIds をクリーンアップし
                    // mesh をプールへ戻す（状態残留によるリーク防止）
                    hiddenChildTiles.delete(key);
                    textureRequestIds.set(
                        mesh,
                        (textureRequestIds.get(mesh) ?? 0) + 1,
                    );
                    meshPool.release(mesh);
                    throw applyErr;
                }

                activeTiles.set(key, { key, coord, mesh, tileSize });

                // hiddenChildTiles から既に外れている（親が先に解放済み）のに
                // applyStitchedElevation を await していた間にテクスチャ onLoad も
                // 通り過ぎていた場合、mesh は永久に disabled のまま残る。
                // activeTiles に登録した時点で改めてガードをかける。
                if (!hiddenChildTiles.has(key) && isMeshTextureReady(mesh)) {
                    mesh.setEnabled(true);
                }

                // 新タイルが追加されたので、カバー完了した旧タイルを解放
                checkAndReleaseCoveredTiles(coord);

                // 隣接タイルのメッシュも再ステッチ
                restitchNeighbors(coord);

                terrainUpdatedCallback?.();
            } finally {
                releaseSlot();
            }
        } catch (e) {
            if (rid !== requestId) return;
            statusCallback?.(
                `タイル読込失敗 ${key}: ${e instanceof Error ? e.message : String(e)}`,
            );
        } finally {
            loadingCount--;
            if (loadingCount === 0) {
                onLoadingComplete?.();
            }
            emitStatus();
        }
    };

    /** 既存 activeTiles の position/scaling/標高を現在の中心・高度オフセットに合わせて再配置 */
    const repositionActiveTiles = async (): Promise<void> => {
        repositionActiveTilesGeom();
        if (!currentCenter) return;
        const promises: Promise<void>[] = [];
        for (const [key, tile] of activeTiles) {
            // キャッシュから標高データを取得し再適用（ステッチ＋NaN埋め）
            const entry = cache.get(key);
            if (entry) {
                promises.push(
                    applyStitchedElevation(
                        tile.mesh,
                        entry.elevation,
                        tile.coord,
                    ),
                );
            }
        }
        if (promises.length > 0) await Promise.all(promises);
        terrainUpdatedCallback?.();
    };

    /**
     * 既存 activeTiles の position/scaling のみを再計算する軽量リポジション。
     *
     * 中心タイルが 1 つ進んでも各タイルの world 座標上の地形そのものは
     * 不変なので、 elevation を再 apply する必要はない。Follow モードでは
     * 飛行機が連続的に中心タイル境界を跨ぐため、フル再ステッチ
     * (applyStitchedElevation × N) を毎秒走らせると全画面フラッシュとして
     * 視認されるため、Follow パスではこちらを呼ぶ。
     */
    const repositionActiveTilesGeom = (): void => {
        if (!currentCenter) return;
        for (const [, tile] of activeTiles) {
            const { mesh, coord } = tile;

            const tileSize = tileSizeForZoom(coord.zoom);
            tile.tileSize = tileSize;

            const center = convertTileZoom(currentCenter, coord.zoom);
            const { fracX, fracY } = computeSubTileOffset(
                currentCenter,
                coord.zoom,
            );
            applyTileTransform(mesh, coord, tileSize, center, fracX, fracY);
        }
        // pendingRelease タイルも同じ座標系に再配置する（位置ずれ防止）
        repositionPendingReleaseTiles();
    };

    /** pendingRelease タイルの position/scaling を currentCenter に合わせて再配置 */
    const repositionPendingReleaseTiles = (): void => {
        if (!currentCenter) return;
        for (const [, pending] of pendingRelease) {
            const { mesh, coord } = pending;

            const tileSize = tileSizeForZoom(coord.zoom);
            pending.tileSize = tileSize;

            const center = convertTileZoom(currentCenter, coord.zoom);
            const { fracX, fracY } = computeSubTileOffset(
                currentCenter,
                coord.zoom,
            );
            applyTileTransform(mesh, coord, tileSize, center, fracX, fracY);
        }
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
    // テスト環境（Vitest）では rAF が setTimeout(16) に近い挙動になり、
    // タイル数が多いと sync 完了までに 5s 以上かかってタイムアウトするため
    // 即時 resolve にして直列化のみ維持する。
    const isTestEnv =
        typeof process !== "undefined" &&
        typeof (process as { env?: Record<string, string | undefined> }).env !==
            "undefined" &&
        (process as { env: Record<string, string | undefined> }).env.VITEST ===
            "true";
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
     * タイル sync 適用の排他ロック。
     *
     * 並列フェッチ後の重い同期処理（applyStitchedElevation /
     * ComputeNormals / GPU upload / restitchNeighbors）を
     * シリアライズする Promise チェーン排他制御。
     * Follow モードでは 1 フレームに 1 タイルだけ走らせて
     * 飛行機アニメーションのちらつきを防ぐ。
     * 通常リフレッシュではフレーム yield を省略し高速に適用する。
     */
    let applyChain: Promise<void> = Promise.resolve();
    const acquireApplySlot = async (): Promise<() => void> => {
        const prev = applyChain;
        let release!: () => void;
        const slot = new Promise<void>((r) => {
            release = r;
        });
        applyChain = prev.then(() => slot);
        await prev;
        // Follow モードのみフレーム境界 yield でスパイクを分散する。
        // 通常リフレッシュでは yield を省略し、タイルを即座に連続適用する。
        if (followModeLoading()) await yieldToFrame();
        return release;
    };

    /** 並列数制限付きのロードキュー */
    /**
     * 新規タイル群を並列度制限付きで消化するスケジューラ。
     *
     * 通常パス（debounce 後の単発リフレッシュ）では `maxConcurrent` ワーカーで
     * 高速にタイルをロードする。
     *
     * Follow モード（`followMode = true`）では 300ms ごとに必ず新規タイル群を要求し、
     * 内部で fetch 完了がほぼ同時に揃った瞬間に「ステッチ + Worker post + texture 構築」
     * が同フレームに集中してフレーム飛びを起こす。並列度を
     * {@link FOLLOW_FRIENDLY_CONCURRENT} に制限し、かつ各 loadTile の後に
     * フレーム境界 yield を挟むことで GPU/メインスレッドのスパイクを
     * 時間方向に分散する。
     */
    const FOLLOW_FRIENDLY_CONCURRENT = 2;

    const loadTilesInQueue = async (
        entries: readonly LodTileEntry[],
        rid: number,
        followMode = false,
    ): Promise<void> => {
        if (followMode) followModeActiveCount++;
        try {
            let idx = 0;
            const concurrency = isTestEnv
                ? Math.min(maxConcurrent, entries.length)
                : followMode
                  ? Math.min(
                        maxConcurrent,
                        FOLLOW_FRIENDLY_CONCURRENT,
                        entries.length,
                    )
                  : Math.min(maxConcurrent, entries.length);
            const next = async (): Promise<void> => {
                while (idx < entries.length && rid === requestId) {
                    const { coord, tileSize } = entries[idx++];
                    await loadTile(coord, tileSize, rid);
                    if (rid !== requestId) return;
                    // Follow モードでは次のタイル投入前にフレーム境界で 1 回 yield する
                    // → fetch 完了の同時揃いによるスパイクを分散
                    if (followMode && idx < entries.length)
                        await yieldToFrame();
                }
            };

            const workers = Array.from({ length: concurrency }, () => next());
            await Promise.all(workers);
        } finally {
            if (followMode) followModeActiveCount--;
        }
    };

    /** tileSizeForZoom: 指定zoomでのタイル実サイズを返す */
    const tileSizeForZoom = (z: number): number =>
        tileEdgeMeters(currentLat, z);

    /** メッシュにテクスチャを適用する（取得失敗時は低zoomへフォールバック）。
     *
     * - `new Texture` の発行を「1フレームあたり最大 textureBudgetLimit 個」
     *   に制限することで GPU upload + mipmap 生成のスパイクを時間方向に分散する
     * - Follow モードでは 2/frame に制限し、通常リフレッシュでは 8/frame まで許容する
     * - スロット枠は requestAnimationFrame でフレーム境界ごとにリセットされるため、
     *   onLoad/onError が呼ばれないケース（tile unload による先 dispose、
     *   ネットワーク中断など）でも永久占有は発生しない
     * - キュー待ち中は `mat.diffuseTexture` が前のテクスチャのまま残るので、
     *   描画されないタイル（空が透ける症状）にはならない
     */
    const TEXTURE_PER_FRAME_FOLLOW = 2;
    const TEXTURE_PER_FRAME_NORMAL = 8;
    let textureBudgetUsed = 0;
    /** キューに積まれたジョブ。enqueue 時のモード（follow/normal）を保持する */
    const textureJobQueue: { job: () => void; follow: boolean }[] = [];
    let textureFlushScheduled = false;
    const flushTextureJobs = (): void => {
        if (disposed) {
            textureFlushScheduled = false;
            return;
        }
        textureFlushScheduled = false;
        textureBudgetUsed = 0;
        // キュー内に follow ジョブが1つでも残っていれば follow 扱いの制限を維持する
        const hasFollowJob = textureJobQueue.some((entry) => entry.follow);
        const limit =
            followModeLoading() || hasFollowJob
                ? TEXTURE_PER_FRAME_FOLLOW
                : TEXTURE_PER_FRAME_NORMAL;
        while (textureBudgetUsed < limit && textureJobQueue.length > 0) {
            const entry = textureJobQueue.shift();
            if (!entry) break;
            textureBudgetUsed++;
            entry.job();
        }
        if (textureJobQueue.length > 0) scheduleTextureFlush();
    };
    const scheduleTextureFlush = (): void => {
        if (textureFlushScheduled) return;
        textureFlushScheduled = true;
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(flushTextureJobs);
        } else {
            setTimeout(flushTextureJobs, 16);
        }
    };
    const enqueueTextureJob = (job: () => void): void => {
        if (disposed) return;
        const isFollow = followModeLoading();
        const limit = isFollow
            ? TEXTURE_PER_FRAME_FOLLOW
            : TEXTURE_PER_FRAME_NORMAL;
        if (textureBudgetUsed < limit) {
            textureBudgetUsed++;
            scheduleTextureFlush(); // 次フレームで budget をリセット
            job();
            return;
        }
        textureJobQueue.push({ job, follow: isFollow });
        scheduleTextureFlush();
    };

    const applyTexture = (
        mesh: Mesh,
        coord: TileCoord,
        fallbackZoom?: number,
    ): void => {
        const targetZoom = fallbackZoom ?? coord.zoom;
        const targetCoord = convertTileZoom(coord, targetZoom);

        const texReqId = (textureRequestIds.get(mesh) ?? 0) + 1;
        textureRequestIds.set(mesh, texReqId);

        enqueueTextureJob(() => {
            // キュー待ち中に別のリクエストで上書き / mesh 破棄されていたら即スキップ
            if (
                textureRequestIds.get(mesh) !== texReqId ||
                (typeof mesh.isDisposed === "function" && mesh.isDisposed())
            ) {
                return;
            }

            const mat = mesh.material as StandardMaterial;
            const prevTex = mat.diffuseTexture;
            const url = textureUrl(
                currentMapType,
                targetCoord.zoom,
                targetCoord.x,
                targetCoord.y,
            );

            pendingTextureCount++;
            const tex = new Texture(
                url,
                scene,
                false,
                true,
                Texture.TRILINEAR_SAMPLINGMODE,
                () => {
                    if (disposed) return;
                    pendingTextureCount--;
                    // 既に別タイル用へ差し替わっていれば自身を破棄
                    if (
                        textureRequestIds.get(mesh) !== texReqId ||
                        (typeof mesh.isDisposed === "function" &&
                            mesh.isDisposed())
                    ) {
                        tex.dispose();
                        return;
                    }
                    // GPU テクスチャが確実に存在する onLoad 内で diffuseTexture を差し替え、
                    // null gpu texture bind エラーを防ぐ。
                    mat.diffuseTexture = tex;
                    // 非表示待機中の子タイルは親が解放されるまで表示しない
                    if (!hiddenChildTiles.has(toTileKey(coord))) {
                        mesh.setEnabled(true);
                    }
                    // テクスチャが ready になったので、このタイルが含まれる祖先 pending の
                    // カバー判定を再評価して、まだ残っている親を解放する。
                    checkAndReleaseCoveredTiles(coord);
                    if (prevTex && prevTex !== tex) {
                        // 旧テクスチャが同フレームの GPU コマンドバッファにまだ残っている場合、
                        // 即座に dispose すると WebGPU の "Destroyed texture used in a submit"
                        // エラーになる。次フレームまで遅延して安全に破棄する。
                        setTimeout(() => prevTex.dispose(), 0);
                    }
                },
                () => {
                    if (disposed) return;
                    pendingTextureCount--;
                    if (textureRequestIds.get(mesh) !== texReqId) {
                        tex.dispose();
                        return;
                    }
                    tex.dispose();
                    if (targetZoom > minZoom) {
                        applyTexture(mesh, coord, targetZoom - 1);
                    } else {
                        // 全 zoom で失敗 — hiddenChildTiles に入っていても解除して
                        // テクスチャなしで表示する（穴を開けないため）。
                        const tileKey = toTileKey(coord);
                        hiddenChildTiles.delete(tileKey);
                        mesh.setEnabled(true);
                    }
                },
            );

            // UV補正（低zoomテクスチャ使用時）
            const uv = computeTextureUvParams(
                coord.zoom,
                coord.x,
                coord.y,
                targetZoom,
            );
            tex.uScale = uv.uScale;
            tex.vScale = uv.vScale;
            tex.uOffset = uv.uOffset;
            tex.vOffset = uv.vOffset;
        });
    };

    /** 全アクティブタイルのテクスチャを現在の mapType で差し替え */
    const retextureAll = (): void => {
        for (const [, tile] of activeTiles) {
            applyTexture(tile.mesh, tile.coord);
        }
        // LOD 遷移中に表示を維持している pendingRelease タイルも再テクスチャする。
        // 含めないと mapType 切替時に旧タイルだけが旧テクスチャで表示され続ける。
        for (const [, pending] of pendingRelease) {
            applyTexture(pending.mesh, pending.coord);
        }
    };

    /**
     * 同じzoomの隣接タイル標高をキャッシュから取得。
     * @param useFilled true なら filled（ステッチ＋NaN埋め済み）を優先して返す。
     *                  false なら raw elevation を返し、辺平均の対称性を保証する。
     */
    const getNeighborElevations = (
        coord: TileCoord,
        useFilled = false,
    ): {
        top?: Float32Array;
        bottom?: Float32Array;
        left?: Float32Array;
        right?: Float32Array;
        topLeft?: Float32Array;
        topRight?: Float32Array;
        bottomLeft?: Float32Array;
        bottomRight?: Float32Array;
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

    /*
     * 旧 isTileNearCamera ヘルパーは撤廃済み。
     * 高 zoom (例: 18) では tileSize が小さく、カメラ高度が少しでもあると
     * 近傍判定が常に false になり cross-level 縫い合わせが走らず、zoom 17/18
     * 混在境界で隙間が顕在化していた。現在は粗タイル隣接が存在する場合のみ
     * `stitchTileEdgesCrossLevel` が実コストを発生させる no-op 安全な
     * 設計のため、距離ゲートを撤廃して常時適用に切り替えている。
     */

    /**
     * target タイルの 4 辺それぞれについて、辺を共有する粗 zoom のアクティブタイルを
     * 1 つだけ選んで返す（同じ辺で複数候補があれば最も細かい粗 zoom を採用）。
     * 同 zoom の隣接タイルが存在する場合はその辺は対象外（同 zoom の縫い合わせに任せる）。
     */
    const getCoarseEdgeNeighbors = (coord: TileCoord): CoarseEdgeNeighbor[] => {
        const isSameZoomVisible = (c: {
            zoom: number;
            x: number;
            y: number;
        }): boolean => {
            const k = toTileKey(c);
            // hiddenChildTiles に入っている同 zoom 隣接は実画面上は未描画 (親 pendingRelease を表示中)
            // のため、cross-level 探索を継続させる。
            return activeTiles.has(k) && !hiddenChildTiles.has(k);
        };
        const lookupCoarse = (c: {
            zoom: number;
            x: number;
            y: number;
        }): CoarseTileSource | undefined => {
            const k = toTileKey(c);
            // 優先: active な粗タイル（cache から elevation を取得）
            if (activeTiles.has(k)) {
                const entry = cache.get(k);
                if (entry) {
                    return {
                        elevation: entry.filled ?? entry.elevation,
                        wasAllNaN: entry.wasAllNaN,
                        unblocked: entry.unblocked,
                    };
                }
            }
            // フォールバック: pendingRelease 中の旧粗タイル
            // cache が LRU 退避済みでも pending entry は elevation を保持している。
            const pending = pendingRelease.get(k);
            if (pending) {
                const entry = cache.get(k);
                return {
                    elevation:
                        entry?.filled ??
                        entry?.elevation ??
                        pending.filled ??
                        pending.elevation,
                    wasAllNaN: entry?.wasAllNaN ?? pending.wasAllNaN,
                    unblocked: entry?.unblocked ?? pending.unblocked,
                };
            }
            return undefined;
        };
        return selectCoarseEdgeNeighbors(
            coord,
            minZoom,
            isSameZoomVisible,
            lookupCoarse,
        );
    };

    /** Web Worker による標高 → 頂点 / 法線変換のオフロード用プール */
    const elevationWorkerPool: ElevationWorkerPool =
        createElevationWorkerPool(2);

    /** 補間済み標高データをメッシュ頂点・法線に反映する（Web Worker オフロード版） */
    const applyElevationDataToMesh = async (
        mesh: Mesh,
        filled: Float32Array,
    ): Promise<void> => {
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
        const idx = mesh.getIndices();
        if (!pos || !idx) return;

        // worker に transfer するため必ずコピーを作る（mesh 内部バッファを detach しない）
        const typed = new Float32Array(pos);
        // indices を TypedArray にコピー（number[] / TypedArray いずれにも対応）
        let indices: Int32Array | Uint32Array | Uint16Array;
        if (
            idx instanceof Int32Array ||
            idx instanceof Uint32Array ||
            idx instanceof Uint16Array
        ) {
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
            if (typeof mesh.isDisposed === "function" && mesh.isDisposed())
                return;
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
        stitchTileEdges(
            stitched,
            getNeighborElevations(coord, useFilled),
            TILE_SIZE,
        );
        if (crossLevel) {
            const coarse = getCoarseEdgeNeighbors(coord);
            if (coarse.length > 0)
                stitchTileEdgesCrossLevel(stitched, coarse, TILE_SIZE);
        }

        const last = TILE_SIZE - 1;
        let hasSeed = false;
        for (let i = 0; i < TILE_SIZE && !hasSeed; i++) {
            if (!isInvalidElev(stitched[i])) {
                hasSeed = true;
                break;
            }
            if (!isInvalidElev(stitched[last * TILE_SIZE + i])) {
                hasSeed = true;
                break;
            }
            if (!isInvalidElev(stitched[i * TILE_SIZE])) {
                hasSeed = true;
                break;
            }
            if (!isInvalidElev(stitched[i * TILE_SIZE + last])) {
                hasSeed = true;
                break;
            }
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
        // - 粗タイル隣接が存在する場合のみ実コストが発生する純粋な no-op 安全な処理。
        //   高 zoom (例: 18) ではタイル辺長が小さく、旧 `isTileNearCamera` ゲートが
        //   ほぼ常に false となり cross-level が走らず、zoom 17/18 混在境界で
        //   隙間が顕在化していた。よって候補が無ければ no-op になる
        //   stitchAndCheckSeed に常に crossLevel=true を渡し、近傍距離ゲートは撤廃する。
        // - all-NaN タイルは同 zoom 近傍からシードが得られない場合があるため、
        //   こちらも従来通り cross-level でシードを取りに行く（true なので包含）。
        const { stitched, hasSeed } = stitchAndCheckSeed(
            elevation,
            coord,
            true,
        );

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
        const meshData =
            cacheEntryPre?.wasAllNaN && !hasSeed && cacheEntryPre.filled
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
        restitchTimerId = null;
        const promises: Promise<void>[] = [];
        for (const key of pendingRestitch) {
            const neighborTile = activeTiles.get(key);
            if (!neighborTile) continue;
            const entry = cache.get(key);
            if (!entry) continue;
            promises.push(
                applyStitchedElevation(
                    neighborTile.mesh,
                    entry.elevation,
                    neighborTile.coord,
                ),
            );
        }
        pendingRestitch.clear();
        if (promises.length === 0) {
            terrainUpdatedCallback?.();
            return;
        }
        restitchingCount++;
        void Promise.all(promises)
            .then(() => {
                if (disposed) return;
                restitchingCount--;
                terrainUpdatedCallback?.();
            })
            .catch(() => {
                if (disposed) return;
                restitchingCount--;
                // Worker エラーや mesh dispose 時の reject は無視する。
                // 再ステッチ失敗は致命的ではなく、次回のタイル更新で再試行される。
            });
    };

    /** 新タイルの隣接タイル（同zoom、アクティブなもの）を再ステッチキューに追加 */
    const restitchNeighbors = (coord: TileCoord): void => {
        // dispose 後に clearAllPendingRelease → releasePendingTile 経由で呼ばれても
        // スケジューリングしない（タイマー残留・dispose 後 callback 発火を防ぐ）。
        if (disposed) return;
        const { zoom: z, x, y } = coord;
        const deltas = [
            [0, -1],
            [0, 1],
            [-1, 0],
            [1, 0],
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
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

        if (restitchRafId === null && restitchTimerId === null) {
            if (typeof requestAnimationFrame === "function") {
                restitchRafId = requestAnimationFrame(flushRestitch);
            } else {
                // RAF 非対応環境（SSR / Node.js / 一部テスト）向けフォールバック。
                // scheduleTextureFlush と同様に setTimeout(..., 16) で次フレーム相当に遅延する。
                restitchTimerId = setTimeout(flushRestitch, 16);
            }
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
                const { stitched, hasSeed } = stitchAndCheckSeed(
                    entry.elevation,
                    tile.coord,
                    true,
                    true,
                );

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
            meshPromises.push(
                applyElevationDataToMesh(tile.mesh, entry.filled),
            );
            progressed = true;
        }

        // Step 4: レスキューパス（反復で到達できなかったタイルを代表標高で平坦化）
        const stillBlocked: Array<[TileKey, ActiveTile]> = [];
        for (const [key, tile] of allNanTiles) {
            const entry = cache.get(key);
            if (entry?.wasAllNaN && !entry.unblocked)
                stillBlocked.push([key, tile]);
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
                if (!isInvalidElev(v)) {
                    sum += v;
                    count++;
                }
            }
            if (count > 0) {
                const fallbackElev = sum / count;
                for (const [, tile] of stillBlocked) {
                    const entry = cache.get(toTileKey(tile.coord));
                    if (!entry) continue;
                    const filled = new Float32Array(TILE_SIZE * TILE_SIZE).fill(
                        fallbackElev,
                    );
                    entry.filled = filled;
                    entry.unblocked = true;
                    entry.isRescue = true;
                    meshPromises.push(
                        applyElevationDataToMesh(tile.mesh, filled),
                    );
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
        // maxElevationZoom ではなく zoom から探索を開始する。
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
            // 表示中タイルのデータのみ使用する。activeTiles に加え、
            // LOD 遷移中で表示を維持している pendingRelease タイルも含める。
            // ただし hiddenChildTiles のタイルは mesh disabled で実際には描画されて
            // いないため除外し、親(pendingRelease)へフォールバックさせる。
            // キャッシュには古い zoom レベルのデータが残留していることがあり、
            // 表示メッシュと異なる標高データを返すとアバターが地面に潜る原因になる。
            if (hiddenChildTiles.has(key)) continue;
            if (!activeTiles.has(key) && !pendingRelease.has(key)) continue;
            // cache が LRU 退避済みの pendingRelease タイルは PendingReleaseTile に保持した
            // elevation/filled をフォールバックとして使う。
            const cacheEntry = cache.get(key);
            const entry = cacheEntry ?? pendingRelease.get(key);
            if (!entry) continue;
            const wasAllNaN = entry.wasAllNaN;
            const unblocked = entry.unblocked;
            // まだ解決できていない all-NaN タイルはスキップ
            if (wasAllNaN && !unblocked) continue;
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
        maxElevation: number,
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
        reposition: boolean,
        /** true: 標高再 apply をスキップして position/scaling のみ更新する軽量モード */
        geomOnlyReposition = false,
        /** true: Follow モード用スロットリング（低並列度 + フレーム yield） */
        followMode = false,
    ): Promise<void> => {
        const visibleKeys = new Set(
            visibleEntries.map((e) => toTileKey(e.coord)),
        );
        currentVisibleKeys = visibleKeys;

        // 可視タイルの全祖先キーを事前構築（hasZoomRelation の子孫判定を O(1) 化）
        const visibleAncestorKeys = new Set<TileKey>();
        for (const entry of visibleEntries) {
            for (let az = entry.coord.zoom - 1; az >= minZoom; az--) {
                const diff = entry.coord.zoom - az;
                visibleAncestorKeys.add(
                    toTileKey({
                        zoom: az,
                        x: entry.coord.x >> diff,
                        y: entry.coord.y >> diff,
                    }),
                );
            }
        }
        currentVisibleAncestorKeys = visibleAncestorKeys;

        /**
         * 旧タイル `coord` が新可視タイル群と zoom 階層関係にあるか判定。
         * - 祖先が新可視に含まれる（zoom-down）
         * - 子孫が新可視に含まれる（zoom-up）
         * いずれでもなければ単なる横パン外なので即座解放する。
         */
        const hasZoomRelation = (coord: TileCoord): boolean => {
            // 祖先チェック: coord の祖先が visibleKeys に含まれるか
            for (let az = coord.zoom - 1; az >= minZoom; az--) {
                const diff = coord.zoom - az;
                const ak = toTileKey({
                    zoom: az,
                    x: coord.x >> diff,
                    y: coord.y >> diff,
                });
                if (visibleKeys.has(ak)) return true;
            }
            // 子孫チェック: coord が可視タイルの祖先か（事前構築セットで O(1) 判定）
            if (visibleAncestorKeys.has(toTileKey(coord))) return true;
            return false;
        };

        // 不要タイルを処理: zoom 階層関係があれば pendingRelease、なければ即座解放
        for (const [key, tile] of activeTiles) {
            if (!visibleKeys.has(key)) {
                // hiddenChildTiles のタイルはメッシュが disabled 状態のため、
                // pendingRelease に入れても穴を塞ぐ役割を果たせない。即座に解放する。
                const wasHidden = hiddenChildTiles.has(key);
                // activeTiles から外す際、hiddenChildTiles に残留すると
                // 同 key 再ロード時に onLoad で setEnabled(true) されない問題を防ぐ。
                hiddenChildTiles.delete(key);
                if (!wasHidden && hasZoomRelation(tile.coord)) {
                    // 既に pendingRelease にある場合はタイマーリセット不要
                    if (!pendingRelease.has(key)) {
                        const timerId = setTimeout(() => {
                            releasePendingTile(key);
                        }, PENDING_RELEASE_TIMEOUT_MS);
                        // cache が LRU 退避しても cross-level 縫い合わせから参照できるように
                        // elevation/filled を pending entry に保持する。
                        // entry が undefined（LRU 退避済み）の場合は NaN バッファを保持し、
                        // wasAllNaN=true / unblocked=false で cross-level 候補から自動除外する。
                        const entry = cache.get(key);
                        addPendingRelease(key, {
                            key: tile.key,
                            coord: tile.coord,
                            mesh: tile.mesh,
                            tileSize: tile.tileSize,
                            timerId,
                            elevation: entry?.elevation ?? EMPTY_NAN_ELEVATION,
                            filled: entry?.filled,
                            wasAllNaN: entry?.wasAllNaN ?? true,
                            unblocked: entry?.unblocked ?? false,
                        });
                        // pendingRelease に新規追加された粗タイルの境界に接する
                        // 既存細 active タイルを再ステッチキューに積む。
                        restitchNeighbors(tile.coord);
                    }
                } else {
                    // 横パン外 or hiddenChildTiles タイル: 即座にメッシュ解放
                    textureRequestIds.set(
                        tile.mesh,
                        (textureRequestIds.get(tile.mesh) ?? 0) + 1,
                    );
                    meshPool.release(tile.mesh);
                }
                activeTiles.delete(key);
            }
        }

        // pendingRelease にあるタイルが再び可視になった場合、activeTiles に復元する
        for (const key of visibleKeys) {
            const pending = pendingRelease.get(key);
            if (pending) {
                clearTimeout(pending.timerId);
                activeTiles.set(key, {
                    key: pending.key,
                    coord: pending.coord,
                    mesh: pending.mesh,
                    tileSize: pending.tileSize,
                });
                removePendingRelease(key);
            }
        }

        // pendingRelease 内でもはや現在の可視タイル群と zoom 階層関係が無いものを即時解放する。
        // 可視領域が連続して変わった場合、stale な pending がタイムアウトまで滞留して
        // maxTiles 超過やメモリ圧迫の原因になるのを防ぐ。
        for (const [key, pending] of pendingRelease) {
            if (!hasZoomRelation(pending.coord)) {
                releasePendingTile(key);
            }
        }

        if (reposition) {
            if (geomOnlyReposition) {
                repositionActiveTilesGeom();
            } else {
                await repositionActiveTiles();
            }
        }

        // 新規タイルのみロード
        const toLoad = visibleEntries.filter(
            (e) => !activeTiles.has(toTileKey(e.coord)),
        );

        if (toLoad.length > 0) {
            await loadTilesInQueue(toLoad, rid, followMode);
        }

        // 2D 回転や同一可視集合での再 refresh など、新規ロードが発生しないケースでは
        // loadTile 経路の checkAndReleaseCoveredTiles が呼ばれないため、既に祖先タイルが
        // ロード済みの pendingRelease タイルがタイムアウト (5s) まで滞留してしまう。
        // ここで全 pending を対象に再判定し、カバー済みのものを即時解放する。
        if (pendingRelease.size > 0) {
            checkAndReleaseCoveredTiles();
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
        altitudeOffset: number,
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
        // 既存タイルの position を現在の currentCenter に合わせて再配置する。
        // Follow モード離脱直後など、currentCenter が変わった状態で呼ばれた場合に
        // 古い位置のままのタイルが残るのを防ぐ。
        repositionActiveTilesGeom();
        await applyVisibleTiles(visibleEntries, rid, false);
    };

    return {
        async setCenter(
            lat: number,
            lon: number,
            altitudeOffset = 0,
        ): Promise<void> {
            await refresh(lat, lon, altitudeOffset);
        },

        async refreshWithExternalFrustum(
            lat: number,
            lon: number,
            frustumPlanes: FrustumPlane[],
            cameraPosition: { x: number; y: number; z: number },
            lodBias = 0,
        ): Promise<void> {
            const rid = ++requestId;

            const center = toTileXY(lat, lon, zoom);
            // 中心タイルが変わった場合のみ reposition する
            const needsReposition =
                !currentCenter ||
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
                lodBias,
            });

            // Follow パスでは中心タイルが変わっても各タイルの世界座標上の地形は
            // 不変なので、 elevation の再 apply はスキップして position/scaling
            // のみ更新する（フル再ステッチが毎秒走るとフラッシュ感の原因になる）。
            await applyVisibleTiles(
                visibleEntries,
                rid,
                needsReposition,
                true,
                true,
            );
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
            // ArcRotateCamera の onViewMatrixChangedObservable は毎フレーム発火する
            // 仕様のため、単純に debounce すると永遠に reset され refresh が走らない。
            // 直近 refresh トリガ時のカメラ状態と比較し、実質的な変化があった場合のみ
            // debounce タイマを再設定する。
            const snapshot = (): {
                alpha: number;
                beta: number;
                radius: number;
                tx: number;
                ty: number;
                tz: number;
                oL: number | null;
                oR: number | null;
                oT: number | null;
                oB: number | null;
            } => ({
                alpha: camera.alpha,
                beta: camera.beta,
                radius: camera.radius,
                tx: camera.target.x,
                ty: camera.target.y,
                tz: camera.target.z,
                oL: camera.orthoLeft,
                oR: camera.orthoRight,
                oT: camera.orthoTop,
                oB: camera.orthoBottom,
            });
            type Snap = ReturnType<typeof snapshot>;
            const EPS_ANG = 1e-4; // ~0.006°
            const EPS_LEN = 0.05; // 5cm
            const EPS_ORTHO = 0.5; // 0.5m
            const changed = (a: Snap, b: Snap): boolean =>
                Math.abs(a.alpha - b.alpha) > EPS_ANG ||
                Math.abs(a.beta - b.beta) > EPS_ANG ||
                Math.abs(a.radius - b.radius) > EPS_LEN ||
                Math.abs(a.tx - b.tx) > EPS_LEN ||
                Math.abs(a.ty - b.ty) > EPS_LEN ||
                Math.abs(a.tz - b.tz) > EPS_LEN ||
                Math.abs((a.oL ?? 0) - (b.oL ?? 0)) > EPS_ORTHO ||
                Math.abs((a.oR ?? 0) - (b.oR ?? 0)) > EPS_ORTHO ||
                Math.abs((a.oT ?? 0) - (b.oT ?? 0)) > EPS_ORTHO ||
                Math.abs((a.oB ?? 0) - (b.oB ?? 0)) > EPS_ORTHO;
            let lastSnap: Snap = snapshot();
            /** スナップショットが実質的に変化していれば debounce タイマを再設定して refresh をスケジュールする。 */
            const scheduleRefreshIfCameraChanged = (): void => {
                const cur = snapshot();
                if (!changed(lastSnap, cur)) return;
                lastSnap = cur;
                if (debounceTimer !== null) {
                    clearTimeout(debounceTimer);
                }
                debounceTimer = setTimeout(() => {
                    debounceTimer = null;
                    void refreshFromCamera();
                }, debounceMs);
            };
            cameraObserver = camera.onViewMatrixChangedObservable.add(() => {
                // タイル読み込み中はカメラ-地形衝突による微小 radius 変更で
                // refreshFromCamera が再発火して現在の読み込みを中断（requestId++）するのを防ぐ。
                // 読み込み完了後に onViewMatrixChanged が再度発火すれば正しく refresh される。
                if (loadingCount > 0) return;
                scheduleRefreshIfCameraChanged();
            });
            // ロード完了時にカメラが移動していたら再リフレッシュをスケジュールする。
            // clampCameraAboveTerrain がロード中にカメラを調整するが、observer が
            // loadingCount > 0 で早期リターンするため、ロード完了後にカメラが既に
            // 収束していると onViewMatrixChanged が再発火せず再リフレッシュが漏れる。
            onLoadingComplete = scheduleRefreshIfCameraChanged;
            // 再アタッチ直後はカメラが動いていなくても view matrix イベントが発火しないため、
            // 即時 refresh を1回発火させてタイルを確実に更新する。
            void refreshFromCamera();
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
            onLoadingComplete = null;
        },

        dispose(): void {
            disposed = true;
            requestId++; // 進行中の loadTile（rid !== requestId チェック）を即キャンセル
            this.detachCamera();
            if (restitchRafId !== null) {
                cancelAnimationFrame(restitchRafId);
                restitchRafId = null;
            }
            if (restitchTimerId !== null) {
                clearTimeout(restitchTimerId);
                restitchTimerId = null;
            }
            pendingRestitch.clear();
            restitchingCount = 0;
            clearAllPendingRelease();
            hiddenChildTiles.clear();
            for (const [, tile] of activeTiles) {
                meshPool.release(tile.mesh);
            }
            activeTiles.clear();
            textureRequestIds.clear();
            textureJobQueue.length = 0;
            textureFlushScheduled = false;
            pendingTextureCount = 0;
            cache.clear();
            meshPool.dispose();
            elevationWorkerPool.dispose();
        },

        get activeTileCount(): number {
            return activeTiles.size;
        },

        get pendingReleaseCount(): number {
            return pendingRelease.size;
        },

        get loadingCount(): number {
            return loadingCount;
        },

        /** テスト用: タイルロード完了かつ debounce 待機なし かつ texture 適用完了 かつ 再ステッチ完了 */
        get isIdle(): boolean {
            return (
                loadingCount === 0 &&
                debounceTimer === null &&
                textureJobQueue.length === 0 &&
                pendingTextureCount === 0 &&
                restitchRafId === null &&
                restitchTimerId === null &&
                restitchingCount === 0
            );
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
