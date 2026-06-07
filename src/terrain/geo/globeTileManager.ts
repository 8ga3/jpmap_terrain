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
import { buildGlobeTileMeshData, sampleElevBilinear } from "./globeMesh";

/** タイルマテリアルの鏡面反射（地形なので弱め）。 */
const TILE_SPECULAR = new Color3(0.02, 0.02, 0.02);

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
    /** root 探索半径（±N 格子）。 */
    rootSearchRadius: number;
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
    const loading = new Set<string>();
    // クロスレベルスナップのため、ビルド後も標高配列を保持する（隣接細タイルが参照）。
    const elevCache = new Map<string, Float32Array>();
    const failed = new Set<string>();
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
        for (let gz = geomMaxZoom; gz >= minZoom; gz--) {
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
        if (elevCache.has(gk) || loading.has(gk) || failed.has(gk)) return;
        loading.add(gk);
        loadElevationTile(gz, gx, gy)
            .then((elev) => {
                // dispose() や sync() で loading から外された後の遅延 resolve は無視する
                // （不要・dispose 済みマネージャの状態を書き戻さない）。
                if (!loading.has(gk)) return;
                loading.delete(gk);
                elevCache.set(gk, elev);
            })
            .catch(() => {
                // 取得不可（GSI に標高データが無い no-data/404 を含む）。per-tile では警告せず、
                // sync 時にまとめて間引いて出力する。遅延 reject も同様にゲートする。
                if (!loading.has(gk)) return;
                loading.delete(gk);
                failed.add(gk);
                newlyFailed.push(gk);
            });
    };

    /** geom 標高が揃った desired タイルをメッシュ化する。 */
    const buildReadyTiles = (tiles: readonly GlobeTile[]): void => {
        for (const t of tiles) {
            const k = tileKey(t.zoom, t.x, t.y);
            if (loaded.has(k)) continue;
            const { gz, gx, gy } = geomCoordOf(t);
            const geomElev = elevCache.get(tileKey(gz, gx, gy));
            if (!geomElev) continue; // geom 標高が未ロード（または no-data 失敗）

            let edges: readonly CoarseEdge[] = [];
            if (snapEnabled && t.zoom <= geomMaxZoom) {
                const r = selectCoarseEdges(
                    t,
                    (kk) => desiredKeys.has(kk),
                    (kk) => elevCache.get(kk),
                    (kk) => failed.has(kk),
                    minZoom,
                );
                if (r.pending) continue; // 粗隣接の標高待ち
                edges = r.edges;
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

            const vertexData = new VertexData();
            vertexData.positions = data.positions;
            vertexData.indices = data.indices;
            vertexData.normals = data.normals;
            vertexData.uvs = data.uvs;

            const mesh = new Mesh(`tile-${k}`, scene);
            vertexData.applyToMesh(mesh);
            mesh.position.copyFrom(data.anchor);

            // 地理院タイル画像を diffuseTexture として適用（同一 z/x/y）。タイルごとに専有し、
            // アンロード時に mesh.dispose(_, true) でテクスチャごと破棄する。
            const mat = new StandardMaterial(`tile-mat-${k}`, scene);
            const tex = new Texture(textureUrl(mapType, t.zoom, t.x, t.y), scene);
            tex.wrapU = Texture.CLAMP_ADDRESSMODE;
            tex.wrapV = Texture.CLAMP_ADDRESSMODE;
            mat.diffuseTexture = tex;
            mat.specularColor = TILE_SPECULAR;
            // 巻き順を外向きに揃えたので片面描画。スカート壁は両面三角形で culling 下でも見える。
            mat.backFaceCulling = true;
            mesh.material = mat;

            loaded.set(k, mesh);
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
        // 新規タイルをロードし、標高が揃ったものを（クロスレベルスナップ付きで）建築。
        for (const t of tiles) loadTile(t);
        buildReadyTiles(tiles);

        // 新規取得失敗を 1 行へ間引いて出力（no-data/404 の per-tile 警告の氾濫を防ぐ）。
        if (newlyFailed.length > 0) {
            if (process.env.NODE_ENV !== "production") {
                const sample = newlyFailed.slice(0, 3).join(", ");
                const more = newlyFailed.length > 3 ? " …" : "";
                console.debug(
                    `[globeTileManager] geom タイル ${newlyFailed.length} 件が取得不可（no-data/404）: ${sample}${more}`,
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
        loading.clear();
        elevCache.clear();
        failed.clear();
        newlyFailed.length = 0;
        desiredKeys = new Set<string>();
    };

    return { sync, terrainElevAt, dispose };
};
