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

/** 標高タイル取得失敗時の再試行バックオフ初期値 [ms]。 */
const FAILED_RETRY_BASE_MS = 5_000;
/** 同・上限 [ms]（no-data タイルを叩き続けないための頭打ち）。 */
const FAILED_RETRY_MAX_MS = 5 * 60_000;

/** attempts 回失敗したタイルの次回再試行までのバックオフ [ms]（指数・上限付き）。 */
const retryBackoffMs = (attempts: number): number =>
    Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_BASE_MS * 2 ** (attempts - 1));

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

    /** geom 標高が揃った desired タイルをメッシュ化する。 */
    const buildReadyTiles = (tiles: readonly GlobeTile[]): void => {
        for (const t of tiles) {
            const k = tileKey(t.zoom, t.x, t.y);
            const { gz, gx, gy } = geomCoordOf(t);
            const geomElev = elevCache.get(tileKey(gz, gx, gy));
            if (!geomElev) continue; // geom 標高が未ロード（または no-data 失敗）

            // クロスレベル「標高スナップ」は z<=geomMaxZoom の LOD 境界にのみ適用する。
            // crossLevel は細タイル zoom == その geom zoom を前提に、細グローバルピクセルを
            // 粗ラスタへ写像するため。z16-18 は z15 をサブサンプルして共有するので intra-level
            // は連続で、LOD 境界の「亀裂/穴」自体はスカート（垂直フランジ）が全境界で隠す。
            // 残る z16-18×粗 境界の「陰影シーム」除去（geom 座標へ写像した粗表面評価）は
            // 後続フェーズの磨き込み対象（#275）。
            let edges: readonly CoarseEdge[] = [];
            if (snapEnabled && t.zoom <= geomMaxZoom) {
                const r = selectCoarseEdges(
                    t,
                    (kk) => desiredKeys.has(kk),
                    (kk) => elevCache.get(kk),
                    (kk) => failedRetryAt.has(kk),
                    minZoom,
                );
                if (r.pending) continue; // 粗隣接の標高待ち
                edges = r.edges;
            }
            const sig = edgeSignature(edges);

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
                },
                // onError: ロード失敗（404/ネットワーク断等）時は scene に登録された
                // Texture を必ず破棄してリークを防ぐ（平面版 tileManager と同様）。
                () => {
                    tex.dispose();
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
            verticalFov: params.verticalFov,
            sseThreshold: params.sseThreshold,
            maxTiles: params.maxTiles,
            rootSearchRadius: params.rootSearchRadius,
            maxRootTiles: params.maxRootTiles,
            horizonDotThreshold: params.horizonDotThreshold,
            referenceAltitude: params.referenceAltitude,
        });
        desiredKeys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));
        // 必要な geom 標高タイルのキー集合（z16-18 は z15 祖先を共有）。
        const neededGeom = new Set(
            tiles.map((t) => {
                const { gz, gx, gy } = geomCoordOf(t);
                return tileKey(gz, gx, gy);
            }),
        );

        // 不要になったメッシュを破棄。
        for (const [key, mesh] of loaded) {
            if (!desiredKeys.has(key)) {
                mesh.dispose(false, true); // マテリアル・テクスチャごと破棄
                loaded.delete(key);
                builtEdgeSig.delete(key);
            }
        }
        // 不要になった geom 標高キャッシュを破棄（必要 geom キー集合で判定）。
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
        builtEdgeSig.clear();
        loading.clear();
        elevCache.clear();
        failedRetryAt.clear();
        newlyFailed.length = 0;
        desiredKeys = new Set<string>();
    };

    return { sync, terrainElevAt, dispose };
};
