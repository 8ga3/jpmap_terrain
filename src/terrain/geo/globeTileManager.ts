/**
 * グローブ地形タイルのライフサイクル管理 (Issue #275 Phase 1)。
 *
 * 平面版 `src/terrain/tileManager.ts` のグローブ（ECEF）相当。`globeLod` で可視タイルを
 * 選択し、`globeMesh` のジオメトリ + 地理院タイル画像テクスチャから Babylon `Mesh` を
 * 組み立て、不要になったメッシュ・標高キャッシュを破棄する。floating origin 下での
 * メモリ/ライフサイクルを担う。データ取得層（`gsiTile.loadElevationTile` /
 * `textureUrl`）は温存して流用する。
 *
 * 標高 z15／テクスチャ z18 のデカップリング:
 * - ジオメトリは geom タイル（<= geomMaxZoom=z15）からサブサンプル。
 * - テクスチャは描画 zoom（<= maxZoom=z18）。
 * - z16-18 は z15 祖先の標高を共有し、geom キャッシュ上でデデュプされる。
 */
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import {
    loadElevationTile,
    textureUrl,
    toTileXY,
    TILE_SIZE,
    type MapType,
} from "../gsiTile";
import { ecefToGeodetic } from "./ecef";
import { latLonToPixel, totalPixelsForZoom } from "./mapping";
import { selectGlobeTiles, tileKey, type GlobeTile } from "./globeLod";
import { selectCoarseEdges, type CoarseEdge } from "./crossLevel";
import { buildGlobeTileMeshData, type GlobeTileMeshData } from "./globeMesh";
import { sampleElevBilinear } from "./elevSample";

/** タイルマテリアルの鏡面反射（地形なので弱め）。 */
const TILE_SPECULAR = new Color3(0.02, 0.02, 0.02);

/**
 * 海面（標高 0m）フラット標高の共有バッファ（Issue #335）。海上など DEM が no-data で確定失敗した
 * タイルは、これを使って平坦メッシュとして建築し、GSI テクスチャ（海・海岸の画像）を描画する。
 * これがないと no-data タイルはメッシュ未生成のままで、背景スフィアの単色が見えるだけになる
 * （相模湾などで「タイルが欠ける」症状）。読み取り専用で共有（建築側で値を書き換えない）。
 */
const FLAT_SEA_ELEV = new Float32Array(TILE_SIZE * TILE_SIZE);

/** 標高タイル取得失敗時の再試行バックオフ初期値 [ms]。 */
const FAILED_RETRY_BASE_MS = 5_000;
/** 同・上限 [ms]（no-data タイルを叩き続けないための頭打ち）。 */
const FAILED_RETRY_MAX_MS = 5 * 60_000;

/** attempts 回失敗したタイルの次回再試行までのバックオフ [ms]（指数・上限付き）。 */
const retryBackoffMs = (attempts: number): number =>
    Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_BASE_MS * 2 ** (attempts - 1));

/**
 * LOD 遷移中に残した旧タイルを強制解放するまでのタイムアウト [ms]（平面版 #281 と同値）。
 * 新タイルのテクスチャ/標高が揃わずカバー判定が成立しない場合の安全網。短すぎると遷移途中で
 * 背景球が見え、長すぎると古い LOD のタイルが残ってちらつく。
 */
const PENDING_RELEASE_TIMEOUT_MS = 5_000;

/**
 * LOD シームレス遷移（pendingRelease / hiddenChild / カバー判定）で祖先タイルを探索する際の
 * 最下限 zoom。manager の `minZoom`（標高が視覚的に意味を持つ下限。グローブ既定 11）とは別概念で、
 * selectGlobeTiles は `rootZoomFloor`(既定 2) まで粗いタイルを返すため、祖先探索を `minZoom` で
 * 打ち切ると zoom 11 未満の LOD 遷移で祖先が一切見つからず、旧タイルが即破棄されて背景球が
 * ちらつく（#330）。四分木の全祖先を対象にするため floor は 0 とする（探索回数は最大でも zoom 段数）。
 */
const SEAMLESS_FLOOR_ZOOM = 0;


export interface GlobeTileManagerOptions {
    /** タイルメッシュを生成するシーン。 */
    scene: Scene;
    /** 地図種別（std / photo）。 */
    mapType: MapType;
    /** 最低ズーム（root）。 */
    minZoom: number;
    /** ジオメトリ（標高）の最高ズーム。GSI DEM は z15 まで。 */
    geomMaxZoom: number;
    /** タイルあたりの分割数。 */
    segments: number;
    /** クロスレベル標高スナップを有効化するか。 */
    snapEnabled: boolean;
}

/** 1 回の LOD 同期で必要なカメラ・ビュー状態。 */
export interface GlobeTileSyncParams {
    /** カメラの真の ECEF 位置。 */
    cameraEcef: Vector3;
    /** root 探索中心の注視点 ECEF（カメラ center）。 */
    centerEcef: Vector3;
    /** 最高ズーム（テクスチャ）。 */
    maxZoom: number;
    /** ビューポート高さ [px]。 */
    viewportHeight: number;
    /** ビューポート幅 [px]（水平 FOV＝横方向被覆の算出に使用）。 */
    viewportWidth: number;
    /** 垂直 FOV [rad]。 */
    verticalFov: number;
    /** SSE 採用しきい値 [px]。 */
    sseThreshold: number;
    /** 同時保持タイル数の上限。 */
    maxTiles: number;
    /** root 帯の横半幅／後方マージン（±N 格子）。 */
    rootSearchRadius: number;
    /** root 帯に張る minZoom タイル数の予算（上限）。 */
    maxRootTiles: number;
    /** 地平線カリングの内積しきい値。 */
    horizonDotThreshold: number;
    /** SSE 距離評価の基準標高 [m]（中心付近の地形標高）。 */
    referenceAltitude: number;
    /** 遠景 root の最粗 zoom（距離適応ルートレベルの下限, Issue #335）。省略時 minZoom。 */
    rootZoomFloor?: number;
}

/** 同期結果の統計。 */
export interface GlobeTileSyncStats {
    /** 選択された可視タイル。 */
    selected: readonly GlobeTile[];
    /** 選択タイルの最小 zoom（選択なしは null）。 */
    minZoom: number | null;
    /** 選択タイルの最大 zoom（選択なしは null）。 */
    maxZoom: number | null;
    /** 現在ロード済みのメッシュ数。 */
    loadedCount: number;
    /** ロード中の標高タイル数。 */
    loadingCount: number;
}

/**
 * LOD 遷移中に画面へ残す旧タイル（平面版 #281 の PendingReleaseTile 相当）。
 * 新タイルが描画可能になるまで表示を維持し、カバー完了 or タイムアウトで解放する。
 */
interface PendingTile {
    /** 表示を維持する旧メッシュ。 */
    mesh: Mesh;
    /** 旧タイルの zoom/x/y（祖先・子孫判定に使う）。 */
    zoom: number;
    x: number;
    y: number;
    /** 強制解放用タイマーID。 */
    timerId: ReturnType<typeof setTimeout>;
}

export interface GlobeTileManager {
    /** カメラ状態に応じて可視タイルを再選択し、ロード/ビルド/破棄する。 */
    sync: (params: GlobeTileSyncParams) => GlobeTileSyncStats;
    /**
     * 緯度経度の地形標高[m]を、ロード済みの最も詳細な geom タイルから bilinear 取得。
     * geomMaxZoom→minZoom を探索し最初に見つかったものを使う（無ければ null）。
     */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
    /** 全メッシュ・キャッシュを破棄する。 */
    dispose: () => void;
}

/**
 * グローブ地形タイルマネージャを生成する。
 */
export const createGlobeTileManager = (
    opts: GlobeTileManagerOptions,
): GlobeTileManager => {
    const { scene, mapType, minZoom, geomMaxZoom, segments, snapEnabled } = opts;

    const loaded = new Map<string, Mesh>();
    // 各ロード済みタイルがどのクロスレベル coarse-edge 集合で建築されたかの署名。
    // LOD 再評価で隣接関係（同 zoom 隣接 ⇄ 粗タイル隣接）が変わると署名が変化し、
    // ジオメトリを再構築してスナップを更新する（境界の陰影シームを残さないため）。
    const builtEdgeSig = new Map<string, string>();
    const loading = new Set<string>();
    // クロスレベルスナップのため、ビルド後も標高配列を保持する（隣接細タイルが参照）。
    const elevCache = new Map<string, Float32Array>();
    // 取得失敗した geom タイルのバックオフ状態（キー → 再試行可能時刻[ms] と試行回数）。
    // `loadElevationTile` は no-data(404) と一時的なネットワーク障害の双方で throw し、
    // 投げられたエラーから両者を区別できない。失敗を永続化すると一時障害でも地形が恒久
    // 欠落するため、指数バックオフで再試行する（no-data は再試行しても成功しないが、上限間隔で
    // 抑制される）。
    const failedRetryAt = new Map<string, { retryAt: number; attempts: number }>();
    // sync ごとにまとめてログするための、新たに取得失敗した geom タイルキー。
    // GSI 側に標高データが無い箇所（no-data/404）は珍しくなく、per-tile 警告だとログが
    // 溢れるため、sync 時に 1 行へ間引いて出力する。
    const newlyFailed: string[] = [];
    // 直近の LOD 選択キー集合（取得完了時に「まだ必要か」を判定するために参照する）。
    let desiredKeys = new Set<string>();

    // --- LOD シームレス遷移（Issue #330 / 平面版 #281 同等） ---
    // LOD 切替で不要になった旧タイルを即破棄せず、新タイルが描画可能になるまで画面に残す。
    // これにより zoom-in/out の遷移中にタイルが欠けて背景球が見える/ちらつくのを防ぐ。
    const pendingRelease = new Map<string, PendingTile>();
    // pendingRelease の子孫候補を高速に引くための祖先インデックス（祖先キー → pending キー集合）。
    const pendingAncestorIndex = new Map<string, Set<string>>();
    // 祖先タイルが pendingRelease 中のため、テクスチャが揃っても非表示で待機している子タイルキー。
    // 4枚（=旧粗タイル領域）が揃ったタイミングで一斉に表示して旧タイルを解放する（原子的スワップ）。
    const hiddenChildTiles = new Set<string>();
    // テクスチャ（onLoad/onError）到達で「描画可能」になったメッシュ集合。
    // mesh.isEnabled() とは独立に持つ（hiddenChild は描画可能だが非表示のため）。
    const readyMeshes = new Set<Mesh>();
    // 現在の可視タイルの全祖先キー集合（isAreaCovered / hasZoomRelation の枝刈り用）。
    let visibleAncestorKeys = new Set<string>();
    // 現在の可視タイルの最大 zoom（zoom-in カバー判定の targetZoom）。
    let currentMaxZoom = minZoom;

    /** 描画タイル(zoom 最大18) → ジオメトリ用標高タイル(最大 geomMaxZoom=15)の対応。 */
    const geomCoordOf = (t: GlobeTile): { gz: number; gx: number; gy: number } => {
        const gz = Math.min(t.zoom, geomMaxZoom);
        const d = t.zoom - gz;
        return { gz, gx: t.x >> d, gy: t.y >> d };
    };

    const terrainElevAt = (latDeg: number, lonDeg: number): number | null => {
        // 探索は geomMaxZoom から下る。minZoom > geomMaxZoom（例: ?zoom=18）でもループが
        // 1 回は回るよう下限を min(minZoom, geomMaxZoom) とする（さもないと常に null を返し
        // seat-on-terrain / referenceAltitude が機能しなくなる）。
        const lowerGz = Math.min(minZoom, geomMaxZoom);
        for (let gz = geomMaxZoom; gz >= lowerGz; gz--) {
            const { x, y } = toTileXY(latDeg, lonDeg, gz);
            const e = elevCache.get(tileKey(gz, x, y));
            if (!e) continue;
            const total = totalPixelsForZoom(gz);
            const { px, py } = latLonToPixel(latDeg, lonDeg, total);
            return sampleElevBilinear(e, px - x * TILE_SIZE, py - y * TILE_SIZE);
        }
        return null;
    };

    /** 標高取得（geom タイル単位）はキャッシュに溜めるだけ。z16-18 は z15 を共有しデデュプ。 */
    const loadTile = (t: GlobeTile): void => {
        const { gz, gx, gy } = geomCoordOf(t);
        const gk = tileKey(gz, gx, gy);
        if (elevCache.has(gk) || loading.has(gk)) return;
        // 過去に失敗していてもバックオフ経過後は再試行する（一時障害からの回復）。
        const prevFail = failedRetryAt.get(gk);
        if (prevFail !== undefined && Date.now() < prevFail.retryAt) return;
        loading.add(gk);
        loadElevationTile(gz, gx, gy)
            .then((elev) => {
                // dispose() や sync() で loading から外された後の遅延 resolve は無視する
                // （不要・dispose 済みマネージャの状態を書き戻さない）。
                if (!loading.has(gk)) return;
                loading.delete(gk);
                elevCache.set(gk, elev);
                failedRetryAt.delete(gk); // 回復したのでバックオフ状態を解消
            })
            .catch(() => {
                // 取得失敗（no-data/404 と一時的なネットワーク障害を区別できない）。
                // 指数バックオフで再試行できるよう次回再試行時刻を記録する。遅延 reject はゲート。
                if (!loading.has(gk)) return;
                loading.delete(gk);
                const attempts = (failedRetryAt.get(gk)?.attempts ?? 0) + 1;
                failedRetryAt.set(gk, {
                    attempts,
                    retryAt: Date.now() + retryBackoffMs(attempts),
                });
                // per-tile では警告せず、sync 時にまとめて間引いて出力する。
                newlyFailed.push(gk);
            });
    };

    /** クロスレベル coarse-edge 集合の署名（順不同で同一なら同値）。 */
    const edgeSignature = (edges: readonly CoarseEdge[]): string =>
        edges
            .map((e) => `${e.edge}:${e.coarseX}/${e.coarseY}/${e.scale}`)
            .sort()
            .join("|");

    /** メッシュへ頂点データを適用する（新規・再構築 共通）。 */
    const applyGeometry = (mesh: Mesh, data: GlobeTileMeshData): void => {
        const vertexData = new VertexData();
        vertexData.positions = data.positions;
        vertexData.indices = data.indices;
        vertexData.normals = data.normals;
        vertexData.uvs = data.uvs;
        vertexData.applyToMesh(mesh);
        mesh.position.copyFrom(data.anchor);
    };

    // ===== LOD シームレス遷移ヘルパ（平面版 tileManager.ts の同名関数を移植） =====

    /** タイルキー `"z/x/y"` を数値へ分解する。 */
    const parseKey = (key: string): { zoom: number; x: number; y: number } => {
        const [z, x, y] = key.split("/");
        return { zoom: Number(z), x: Number(x), y: Number(y) };
    };

    /**
     * メッシュのテクスチャが描画可能（onLoad/onError 到達済み）か。
     * mesh.isEnabled() とは独立に判定する（hiddenChild は描画可能だが非表示のため）。
     */
    const isMeshTextureReady = (mesh: Mesh): boolean => readyMeshes.has(mesh);

    /** メッシュを破棄し、付随する状態（readyMeshes / builtEdgeSig）も片付ける。 */
    const disposeMesh = (key: string, mesh: Mesh): void => {
        readyMeshes.delete(mesh);
        mesh.dispose(false, true); // マテリアル・テクスチャごと破棄
        builtEdgeSig.delete(key);
    };

    /** pendingRelease に登録し、祖先インデックスも更新する。 */
    const addPendingRelease = (key: string, entry: PendingTile): void => {
        pendingRelease.set(key, entry);
        for (let az = entry.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
            const diff = entry.zoom - az;
            const ak = tileKey(az, entry.x >> diff, entry.y >> diff);
            let s = pendingAncestorIndex.get(ak);
            if (!s) {
                s = new Set();
                pendingAncestorIndex.set(ak, s);
            }
            s.add(key);
        }
    };

    /** pendingRelease から削除し、祖先インデックスも更新する。 */
    const removePendingRelease = (key: string): PendingTile | undefined => {
        const entry = pendingRelease.get(key);
        if (!entry) return undefined;
        pendingRelease.delete(key);
        for (let az = entry.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
            const diff = entry.zoom - az;
            const ak = tileKey(az, entry.x >> diff, entry.y >> diff);
            const s = pendingAncestorIndex.get(ak);
            if (s) {
                s.delete(key);
                if (s.size === 0) pendingAncestorIndex.delete(ak);
            }
        }
        return entry;
    };

    /** pendingRelease から単一タイルを解放する（メッシュを破棄）。 */
    const releasePendingTile = (key: string): void => {
        const pending = pendingRelease.get(key);
        if (!pending) return;
        clearTimeout(pending.timerId);
        // 強制解放時は、待機中の子孫タイルを hiddenChildTiles から外して表示可能にする。
        // テクスチャ未 ready のメッシュは onLoad 側で表示されるため、ここでは ready のもののみ表示。
        const toRemove: string[] = [];
        for (const dk of hiddenChildTiles) {
            const c = parseKey(dk);
            if (c.zoom <= pending.zoom) continue;
            const diff = c.zoom - pending.zoom;
            if ((c.x >> diff) === pending.x && (c.y >> diff) === pending.y) {
                toRemove.push(dk);
            }
        }
        for (const dk of toRemove) {
            hiddenChildTiles.delete(dk);
            const mesh = loaded.get(dk);
            if (mesh && isMeshTextureReady(mesh)) mesh.setEnabled(true);
        }
        disposeMesh(key, pending.mesh);
        removePendingRelease(key);
    };

    /**
     * 指定矩形領域が loaded タイルで完全カバーされているか再帰的に判定する（平面版 isAreaCovered）。
     * - loaded に存在しテクスチャ ready → カバー済み
     * - loaded に存在するが未 ready → 未カバー（描画穴防止）
     * - desiredKeys に存在するが loaded に無い → 未カバー
     * - desiredKeys に無く targetZoom 到達 → frustum 外でカバー不要
     * - 可視タイルの祖先でなければカバー不要
     */
    const isAreaCovered = (
        areaZoom: number,
        ax: number,
        ay: number,
        targetZoom: number,
    ): boolean => {
        const areaKey = tileKey(areaZoom, ax, ay);
        const mesh = loaded.get(areaKey);
        if (mesh) return isMeshTextureReady(mesh);
        if (desiredKeys.has(areaKey)) return false;
        if (areaZoom >= targetZoom) return true;
        if (!visibleAncestorKeys.has(areaKey)) return true;
        const cz = areaZoom + 1;
        return (
            isAreaCovered(cz, ax * 2, ay * 2, targetZoom) &&
            isAreaCovered(cz, ax * 2 + 1, ay * 2, targetZoom) &&
            isAreaCovered(cz, ax * 2, ay * 2 + 1, targetZoom) &&
            isAreaCovered(cz, ax * 2 + 1, ay * 2 + 1, targetZoom)
        );
    };

    /** 指定矩形領域内の hiddenChildTiles を一斉に表示状態にする（平面版 enableDescendants）。 */
    const enableDescendants = (areaZoom: number, ax: number, ay: number): void => {
        const toRemove: string[] = [];
        for (const dk of hiddenChildTiles) {
            const c = parseKey(dk);
            if (c.zoom < areaZoom) continue;
            const diff = c.zoom - areaZoom;
            if ((c.x >> diff) === ax && (c.y >> diff) === ay) {
                toRemove.push(dk);
            }
        }
        for (const dk of toRemove) {
            hiddenChildTiles.delete(dk);
            const mesh = loaded.get(dk);
            if (mesh && isMeshTextureReady(mesh)) mesh.setEnabled(true);
        }
    };

    /**
     * 新タイルが描画可能になったとき、カバーされた旧 pending タイルを解放する（平面版同等）。
     * Case 1 (zoom-in): 旧粗タイル領域が子孫新タイルで完全カバー → 子孫一斉表示 + 親解放。
     * Case 2 (zoom-out): 旧細タイルの祖先タイルが ready → 即解放。
     * Case 3 (同 zoom): 同キーが ready → 解放。
     * `loadedCoord` 指定時は関連 pending のみ判定（高速化）。未指定時は全 pending。
     */
    const checkAndReleaseCoveredTiles = (loadedCoord?: {
        zoom: number;
        x: number;
        y: number;
    }): void => {
        let candidateKeys: Iterable<string>;
        if (loadedCoord) {
            const cands = new Set<string>();
            cands.add(tileKey(loadedCoord.zoom, loadedCoord.x, loadedCoord.y));
            for (let az = loadedCoord.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = loadedCoord.zoom - az;
                const ak = tileKey(az, loadedCoord.x >> diff, loadedCoord.y >> diff);
                if (pendingRelease.has(ak)) cands.add(ak);
            }
            const descendants = pendingAncestorIndex.get(
                tileKey(loadedCoord.zoom, loadedCoord.x, loadedCoord.y),
            );
            if (descendants) for (const dk of descendants) cands.add(dk);
            candidateKeys = cands;
        } else {
            candidateKeys = Array.from(pendingRelease.keys());
        }

        for (const key of candidateKeys) {
            const pending = pendingRelease.get(key);
            if (!pending) continue;
            const { zoom: pz, x: px, y: py } = pending;

            // Case 1: 旧粗タイル領域が子孫新タイルで完全カバー（zoom-in）。
            if (pz < currentMaxZoom && visibleAncestorKeys.has(key)) {
                if (isAreaCovered(pz, px, py, currentMaxZoom)) {
                    enableDescendants(pz + 1, px * 2, py * 2);
                    enableDescendants(pz + 1, px * 2 + 1, py * 2);
                    enableDescendants(pz + 1, px * 2, py * 2 + 1);
                    enableDescendants(pz + 1, px * 2 + 1, py * 2 + 1);
                    releasePendingTile(key);
                    continue;
                }
            }

            // Case 2: 旧細タイルが ready な祖先タイルでカバー（zoom-out, 多段対応）。
            let ancestorFound = false;
            for (let az = pz - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = pz - az;
                const am = loaded.get(tileKey(az, px >> diff, py >> diff));
                if (am && isMeshTextureReady(am)) {
                    ancestorFound = true;
                    break;
                }
            }
            if (ancestorFound) {
                releasePendingTile(key);
                continue;
            }

            // Case 3: 同 zoom の新タイルが同キーで ready なら不要。
            const same = loaded.get(key);
            if (same && isMeshTextureReady(same)) releasePendingTile(key);
        }
    };

    /** geom 標高が揃った desired タイルをメッシュ化する。 */
    const buildReadyTiles = (tiles: readonly GlobeTile[]): void => {
        for (const t of tiles) {
            const k = tileKey(t.zoom, t.x, t.y);
            const { gz, gx, gy } = geomCoordOf(t);
            const gk = tileKey(gz, gx, gy);
            const cachedElev = elevCache.get(gk);
            // 実標高が未取得（ロード中 or no-data 失敗）の場合の暫定値（海面フラット 0m）。
            // ただしフラットで暫定建築するのは「no-data 確定(failedRetryAt)」または
            // 「minZoom 未満（高高度で標高が無意味）」に限る。それ以外（minZoom 以上のロード中）は
            // 直後の分岐で建築自体をスキップする（フラット→実標高の近景チラつきを避けるため, #330）。
            // 実標高が届いたら次 sync で実標高へ再構築（sig で検知）、no-data なら海面のまま残す。
            const isFlatFallback = !cachedElev;
            const geomElev = cachedElev ?? FLAT_SEA_ELEV;

            // 標高が視覚的に意味を持つ zoom レベル（minZoom 以上）では、標高ロード中は建築をスキップ。
            // フラット(0m)で一度表示してから実標高で再構築するとカメラ近景でチラつくため (#330)。
            // - failedRetryAt（no-data/海）は「フラット確定」扱いで即建築（恒久欠けを防ぐ）。
            // - minZoom 未満（高高度グローバルビュー）は標高が視覚的に無意味なので即建築。
            if (isFlatFallback && !failedRetryAt.has(gk) && t.zoom >= minZoom) continue;

            // クロスレベル「標高スナップ」は z<=geomMaxZoom の LOD 境界にのみ適用する。
            // crossLevel は細タイル zoom == その geom zoom を前提に、細グローバルピクセルを
            // 粗ラスタへ写像するため。z16-18 は z15 をサブサンプルして共有するので intra-level
            // は連続で、LOD 境界の「亀裂/穴」自体はスカート（垂直フランジ）が全境界で隠す。
            // 残る z16-18×粗 境界の「陰影シーム」除去（geom 座標へ写像した粗表面評価）は
            // 後続フェーズの磨き込み対象（#275）。
            let edges: readonly CoarseEdge[] = [];
            if (snapEnabled && t.zoom <= geomMaxZoom && !isFlatFallback) {
                const r = selectCoarseEdges(
                    t,
                    (kk) => desiredKeys.has(kk),
                    (kk) => elevCache.get(kk),
                    (kk) => failedRetryAt.has(kk),
                    minZoom,
                );
                // r.pending（粗隣接の標高がまだロード中）でもビルドは遅延しない。遅延すると、
                // 海上・列島外など no-data の粗タイルが 404 を返すまで（または視界出入りで失敗記録が
                // 消える間）、その粗タイルに接する細タイルが恒久的に未建築＝LOD 境界で「四分木の
                // 2 個／1 ライン分が欠ける」症状になる（#335, tilt 65-70°）。利用可能な edges だけで
                // 即建築し、粗標高が届いたら sig 変化で再建築してスナップを適用する（一時的な陰影
                // シームは許容。欠けるよりは良い）。
                edges = r.edges;
            }
            // フラット建築かどうかも署名に含める（no-data 回復で flat→実標高に変わったら、
            // coarse-edge が同一でもジオメトリを再構築させるため）。
            const sig = (isFlatFallback ? "flat|" : "") + edgeSignature(edges);

            // 既存メッシュは coarse-edge 集合が同一ならそのまま、変化していれば
            // ジオメトリのみ差し替える（テクスチャ・マテリアルは再利用し再読込を避ける）。
            const existing = loaded.get(k);
            if (existing) {
                if (builtEdgeSig.get(k) === sig) continue;
                applyGeometry(
                    existing,
                    buildGlobeTileMeshData({
                        zoom: t.zoom, tx: t.x, ty: t.y,
                        geomElev, geomZoom: gz, geomX: gx, geomY: gy, segments, edges,
                    }),
                );
                builtEdgeSig.set(k, sig);
                continue;
            }

            const data = buildGlobeTileMeshData({
                zoom: t.zoom,
                tx: t.x,
                ty: t.y,
                geomElev,
                geomZoom: gz,
                geomX: gx,
                geomY: gy,
                segments,
                edges,
            });

            const mesh = new Mesh(`tile-${k}`, scene);
            applyGeometry(mesh, data);

            // 地理院タイル画像を diffuseTexture として適用（同一 z/x/y）。タイルごとに専有し、
            // アンロード時に mesh.dispose(_, true) でテクスチャごと破棄する。
            const mat = new StandardMaterial(`tile-mat-${k}`, scene);
            mat.specularColor = TILE_SPECULAR;
            // 巻き順を外向きに揃えたので片面描画。スカート壁は両面三角形で culling 下でも見える。
            mat.backFaceCulling = true;
            mesh.material = mat;

            // テクスチャ未ロード中は白色メッシュが見えるので非表示にする。
            // onLoad / onError 到着時に表示する（背景球が代わりに見える）。#330
            mesh.setEnabled(false);

            // 祖先タイルが pendingRelease 中なら、この子タイルは非表示待機として登録する（#281）。
            // テクスチャ onLoad での表示を抑止し、旧粗タイル解放と同時に一斉表示して原子的に
            // スワップする（レベルの違うタイルの重なりちらつきを防ぐ）。多段 zoom も全祖先を確認。
            let isHiddenChild = false;
            for (let az = t.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = t.zoom - az;
                if (pendingRelease.has(tileKey(az, t.x >> diff, t.y >> diff))) {
                    isHiddenChild = true;
                    break;
                }
            }
            if (isHiddenChild) hiddenChildTiles.add(k);

            // GPU テクスチャが確実に生成された onLoad 内で diffuseTexture を設定する
            // （WebGPU の "null gpu texture bind" を避ける。平面版 tileManager と同様）。
            // invertY=true は UV（v=1 が北端）の前提に必要。ロード前に mesh が破棄されていれば
            // 孤立テクスチャを破棄する。
            const tex = new Texture(
                textureUrl(mapType, t.zoom, t.x, t.y),
                scene,
                false,
                true,
                Texture.TRILINEAR_SAMPLINGMODE,
                () => {
                    if (mesh.isDisposed()) {
                        tex.dispose();
                        return;
                    }
                    mat.diffuseTexture = tex;
                    // 描画可能になったことを記録（isAreaCovered / カバー判定で参照）。
                    readyMeshes.add(mesh);
                    // 非表示待機中（祖先が pendingRelease 中）の子タイルは表示しない。
                    if (!hiddenChildTiles.has(k)) mesh.setEnabled(true);
                    // このタイルでカバーされた旧 pending タイルを解放する。
                    checkAndReleaseCoveredTiles({ zoom: t.zoom, x: t.x, y: t.y });
                },
                // onError: ロード失敗（404/ネットワーク断等）時は Texture を破棄してリークを防ぐ。
                // テクスチャなし（白）でもホールより良いので mesh は表示する。
                () => {
                    tex.dispose();
                    if (mesh.isDisposed()) return;
                    readyMeshes.add(mesh);
                    // テクスチャ無しでも描画可能扱い。非表示待機を解除して表示する。
                    hiddenChildTiles.delete(k);
                    mesh.setEnabled(true);
                    checkAndReleaseCoveredTiles({ zoom: t.zoom, x: t.x, y: t.y });
                },
            );
            tex.wrapU = Texture.CLAMP_ADDRESSMODE;
            tex.wrapV = Texture.CLAMP_ADDRESSMODE;

            loaded.set(k, mesh);
            builtEdgeSig.set(k, sig);
        }
    };

    const sync = (params: GlobeTileSyncParams): GlobeTileSyncStats => {
        // root 探索はカメラの現在の注視点(center)を追従する（パン後もカメラ直下を選択）。
        const camGeo = ecefToGeodetic(params.centerEcef);
        const tiles = selectGlobeTiles({
            cameraEcef: params.cameraEcef,
            centerLat: camGeo.latDeg,
            centerLon: camGeo.lonDeg,
            minZoom,
            maxZoom: params.maxZoom,
            viewportHeight: params.viewportHeight,
            viewportWidth: params.viewportWidth,
            verticalFov: params.verticalFov,
            sseThreshold: params.sseThreshold,
            maxTiles: params.maxTiles,
            rootSearchRadius: params.rootSearchRadius,
            maxRootTiles: params.maxRootTiles,
            horizonDotThreshold: params.horizonDotThreshold,
            referenceAltitude: params.referenceAltitude,
            rootZoomFloor: params.rootZoomFloor,
        });
        desiredKeys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));
        // 可視タイルの全祖先キー集合と最大 zoom を構築（カバー判定・zoom 階層判定に使う）。
        visibleAncestorKeys = new Set<string>();
        currentMaxZoom = SEAMLESS_FLOOR_ZOOM;
        for (const t of tiles) {
            if (t.zoom > currentMaxZoom) currentMaxZoom = t.zoom;
            for (let az = t.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = t.zoom - az;
                visibleAncestorKeys.add(tileKey(az, t.x >> diff, t.y >> diff));
            }
        }
        /**
         * 旧タイルが新可視タイル群と zoom 階層関係にあるか（祖先 or 子孫が可視）。
         * いずれでもなければ単なる横パン外なので pendingRelease せず即破棄する（フレーム落ち対策）。
         */
        const hasZoomRelation = (z: number, x: number, y: number): boolean => {
            for (let az = z - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = z - az;
                if (desiredKeys.has(tileKey(az, x >> diff, y >> diff))) return true;
            }
            return visibleAncestorKeys.has(tileKey(z, x, y));
        };

        // 不要になったメッシュを処理: zoom 階層関係があれば pendingRelease で表示を維持し、
        // なければ即破棄する（平面版 #281 の applyVisibleTiles 同等）。
        for (const [key, mesh] of loaded) {
            if (desiredKeys.has(key)) continue;
            const c = parseKey(key);
            // 非表示待機中(hiddenChild)のメッシュは描画されていないので pending にせず即破棄。
            const wasHidden = hiddenChildTiles.has(key);
            hiddenChildTiles.delete(key);
            if (
                !wasHidden &&
                isMeshTextureReady(mesh) &&
                hasZoomRelation(c.zoom, c.x, c.y)
            ) {
                if (!pendingRelease.has(key)) {
                    const timerId = setTimeout(
                        () => releasePendingTile(key),
                        PENDING_RELEASE_TIMEOUT_MS,
                    );
                    // builtEdgeSig は残す（再可視化で復元する際の不要な再構築を避ける）。
                    addPendingRelease(key, { mesh, zoom: c.zoom, x: c.x, y: c.y, timerId });
                }
            } else {
                disposeMesh(key, mesh);
            }
            loaded.delete(key);
        }

        // pendingRelease にあるタイルが再び可視になった場合、loaded に復元する。
        for (const key of desiredKeys) {
            const pending = pendingRelease.get(key);
            if (pending) {
                clearTimeout(pending.timerId);
                loaded.set(key, pending.mesh);
                removePendingRelease(key);
            }
        }

        // 現在の可視タイル群ともはや zoom 階層関係が無い stale な pending を即時解放する
        // （視界が連続して変わった場合にタイムアウトまで滞留してちらつくのを防ぐ）。
        for (const [key, pending] of pendingRelease) {
            if (!hasZoomRelation(pending.zoom, pending.x, pending.y)) {
                releasePendingTile(key);
            }
        }
        // 不要になった geom 標高キャッシュを破棄（必要 geom キー集合で判定）。
        // 必要な geom 標高タイルのキー集合（z16-18 は z15 祖先を共有）。
        const neededGeom = new Set(
            tiles.map((t) => {
                const { gz, gx, gy } = geomCoordOf(t);
                return tileKey(gz, gx, gy);
            }),
        );
        for (const key of elevCache.keys()) {
            if (!neededGeom.has(key)) elevCache.delete(key);
        }
        // 不要になった in-flight ロードを loading から外す。これにより、その後 resolve した
        // 結果は loadTile の then/catch ゲート（loading.has）で無視され、不要な geom が
        // elevCache に入ってメモリを占有するのを防ぐ。再度必要になれば次 sync で再取得する。
        for (const key of loading) {
            if (!neededGeom.has(key)) loading.delete(key);
        }
        // 視界外になった失敗タイルのバックオフ状態も破棄（メモリ無制限増加を防ぐ。
        // 再び視界に入れば即座に新規試行できる）。
        for (const key of failedRetryAt.keys()) {
            if (!neededGeom.has(key)) failedRetryAt.delete(key);
        }
        // 新規タイルをロードし、標高が揃ったものを（クロスレベルスナップ付きで）建築。
        for (const t of tiles) loadTile(t);
        buildReadyTiles(tiles);

        // 新規ロードが発生しない再 sync（同一可視集合での再評価など）では loadTile 経路の
        // checkAndReleaseCoveredTiles が呼ばれず、既に祖先/子孫が揃った pending が
        // タイムアウトまで滞留しうる。全 pending を対象に再判定し即時解放する（#281 同等）。
        if (pendingRelease.size > 0) checkAndReleaseCoveredTiles();


        // 新規取得失敗を 1 行へ間引いて出力（per-tile 警告の氾濫を防ぐ）。失敗要因は
        // no-data/404 と一時的なネットワーク障害の双方があり区別しないため、中立な文言にする。
        if (newlyFailed.length > 0) {
            if (process.env.NODE_ENV !== "production") {
                const sample = newlyFailed.slice(0, 3).join(", ");
                const more = newlyFailed.length > 3 ? " …" : "";
                console.debug(
                    `[globeTileManager] ${newlyFailed.length} geom tile(s) failed to load ` +
                        `(no-data or transient errors; will retry with backoff): ${sample}${more}`,
                );
            }
            newlyFailed.length = 0;
        }

        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const t of tiles) {
            if (t.zoom < minZ) minZ = t.zoom;
            if (t.zoom > maxZ) maxZ = t.zoom;
        }

        return {
            selected: tiles,
            minZoom: Number.isFinite(minZ) ? minZ : null,
            maxZoom: Number.isFinite(maxZ) ? maxZ : null,
            loadedCount: loaded.size,
            loadingCount: loading.size,
        };
    };

    const dispose = (): void => {
        for (const mesh of loaded.values()) mesh.dispose(false, true);
        loaded.clear();
        // LOD 遷移中に残した pending タイルのタイマー解除＋メッシュ破棄。
        for (const pending of pendingRelease.values()) {
            clearTimeout(pending.timerId);
            pending.mesh.dispose(false, true);
        }
        pendingRelease.clear();
        pendingAncestorIndex.clear();
        hiddenChildTiles.clear();
        readyMeshes.clear();
        visibleAncestorKeys = new Set<string>();
        builtEdgeSig.clear();
        loading.clear();
        elevCache.clear();
        failedRetryAt.clear();
        newlyFailed.length = 0;
        desiredKeys = new Set<string>();
    };

    return { sync, terrainElevAt, dispose };
};
