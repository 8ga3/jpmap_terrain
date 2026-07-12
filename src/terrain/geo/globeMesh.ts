/**
 * グローブ曲面タイルメッシュのジオメトリ生成（純粋関数）。
 *
 * 1 タイルぶんの標高データから ECEF 曲面メッシュの頂点データ
 * （positions / normals / uvs / indices / anchor）を生成する。Babylon の `Mesh` /
 * `Texture` 生成からは分離し、座標計算を純関数として切り出すことで単体テスト可能にする
 * （`globeTileManager` が本データから実際の `Mesh` を組み立てる）。PoC の
 * メッシュ生成から幾何部分を昇格したもの。
 *
 * floating origin 下での Float32 頂点バッファ精度を担保するため、頂点はタイル中心の
 * ECEF アンカーからの **相対座標**（タイル内なので数百 m オーダー）で格納し、真の
 * ECEF（大きな値）は `anchor`（呼び出し側で `mesh.position` = double 精度 world matrix
 * へ載せる）に分離する。
 *
 * LOD 境界の T 字クラック対策として、タイル周縁から地心方向へ垂らす **スカート**
 * （垂直フランジ）を付与する。隣接タイルの LOD を知らずに隙間を隠せる方式で、
 * Cesium / Google Earth 等のグローブ地形レンダラーで標準的に使われる。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";

import { TILE_SIZE, tileEdgeMeters } from "../gsiTile";
import { geodeticToEcefToRef } from "./ecef";
import { pixelToLatLon, totalPixelsForZoom } from "./mapping";
import { sampleElevBilinear } from "./elevSample";
import { snapEdgeElevation, type CoarseEdge } from "./crossLevel";

/** スカート深さの下限・上限 [m]、および辺長に対する係数。 */
const SKIRT_MIN_DEPTH = 150;
const SKIRT_MAX_DEPTH = 1500;
const SKIRT_DEPTH_RATIO = 0.05;

/**
 * 遠方（粗い zoom）タイルのメッシュ分割数を距離適応で増やす際の目標頂点間隔 [m]。
 * メッシュは DEM(256px) を (segments+1) 頂点へサブサンプルするため、既定 segments=32 では遠方の
 * 粗 zoom タイル（例: 東京→富士山 ≈100km で zoom=10, 1辺≈32km）が 1 頂点 ≈1km となり、富士山級の
 * 急峻な独立峰が数頂点に潰れて稜線が失われる。1 辺実距離をこの目標で割った分割数へ引き上げ、
 * ロード済み DEM 詳細（z10 で ≈125m/sample）を活かす。250m は zoom=10 タイルで 128 分割
 * （≈250m/頂点＝zoom12 相当）となり富士山山頂部を約 12 頂点で表現できる実測閾値
 * （計測: tests/farViewGeomResolution.unit.spec.ts）。
 */
export const ADAPTIVE_SEGMENTS_TARGET_M = 250;

/**
 * 距離適応で引き上げるメッシュ分割数の上限（遠方タイルの頂点数暴発を抑制, #460）。
 * zoom=10（最粗の遠方タイル）で到達し、それ以上は DEM(256/tile) の情報量的にも過剰。
 */
export const ADAPTIVE_SEGMENTS_MAX = 128;

/**
 * タイルのメッシュ分割数を距離適応で決める。目標頂点間隔（`ADAPTIVE_SEGMENTS_TARGET_M`）
 * からタイル 1 辺実距離で分割数を決め、`baseSegments` を下限、DEM 利用可能サンプル数
 * （この描画タイルが覆う geom DEM 範囲 = 256 / 2^(displayZoom-geomZoom)）と `ADAPTIVE_SEGMENTS_MAX`
 * を上限にクランプする。近景の細タイル（displayZoom>geomZoom, z16-18）は avail<=baseSegments と
 * なり実質据え置き（ロード済み DEM の情報量を超えて細分せず、詳細を捏造しない）。
 */
export const adaptiveMeshSegments = (
    tileSizeMeters: number,
    displayZoom: number,
    geomZoom: number,
    baseSegments: number,
): number => {
    const availDemSamples = TILE_SIZE >> Math.max(0, displayZoom - geomZoom);
    const target = Math.round(tileSizeMeters / ADAPTIVE_SEGMENTS_TARGET_M);
    return Math.max(
        baseSegments,
        Math.min(target, availDemSamples, ADAPTIVE_SEGMENTS_MAX),
    );
};

/** 生成された曲面タイルメッシュの頂点データ。 */
export interface GlobeTileMeshData {
    /** アンカー相対の頂点座標（地表面 + スカート頂点）。 */
    positions: number[];
    /** 地表面 + スカート壁のインデックス。 */
    indices: number[];
    /** 法線（地表面のみで計算、スカート頂点は元の周縁頂点へ揃える）。 */
    normals: number[];
    /** UV。 */
    uvs: number[];
    /** タイル中心の真の ECEF（mesh.position に載せる）。 */
    anchor: Vector3;
    /** タイル中心緯度 [deg]（スカート深さ・ライティング等に流用可）。 */
    centerLat: number;
    /** タイル中心経度 [deg]。 */
    centerLon: number;
}

export interface BuildGlobeTileMeshParams {
    /** 描画タイルの zoom（テクスチャ解像度。最大 z18）。 */
    zoom: number;
    /** 描画タイル X。 */
    tx: number;
    /** 描画タイル Y。 */
    ty: number;
    /** ジオメトリ用標高タイル（DEM 上限 z15。z16-18 は z15 祖先を使う）。 */
    geomElev: Float32Array;
    /** geom 標高タイルの zoom。 */
    geomZoom: number;
    /** geom 標高タイル X。 */
    geomX: number;
    /** geom 標高タイル Y。 */
    geomY: number;
    /** タイルあたりの分割数（頂点は (segments+1)^2）。 */
    segments: number;
    /** クロスレベル標高スナップ対象の粗タイル辺（無ければ空配列）。 */
    edges: readonly CoarseEdge[];
}

/**
 * タイルの標高データから曲面メッシュの頂点データを生成する（純粋関数）。
 *
 * ジオメトリは geom 標高タイル（<=z15）からサブサンプルし、描画 zoom（<=z18）の
 * 格子で配置する（標高 z15／テクスチャ z18 のデカップリング）。境界辺はクロスレベル
 * スナップ（`edges`）で粗タイル表面へ標高を合わせ、陰影シームを消す。
 */
export const buildGlobeTileMeshData = (
    params: BuildGlobeTileMeshParams,
): GlobeTileMeshData => {
    const { zoom, tx, ty, geomElev, geomZoom, geomX, geomY, segments, edges } =
        params;

    // この描画タイル(zoom)の 1 ピクセルが geom タイルの 1/geomScale ピクセルに対応。
    const geomScale = 2 ** (zoom - geomZoom);
    const totalPixels = totalPixelsForZoom(zoom);

    // タイル中心をアンカー ECEF とする。
    const center = pixelToLatLon(
        tx * TILE_SIZE + TILE_SIZE / 2,
        ty * TILE_SIZE + TILE_SIZE / 2,
        totalPixels,
    );
    const anchor = new Vector3();
    geodeticToEcefToRef(center.lat, center.lon, 0, anchor);

    const vertsPerSide = segments + 1;
    const positions: number[] = [];
    const uvs: number[] = [];
    const ecef = new Vector3();
    const gridIndex = (row: number, col: number): number =>
        row * vertsPerSide + col;

    for (let row = 0; row < vertsPerSide; row++) {
        for (let col = 0; col < vertsPerSide; col++) {
            // タイル内ピクセル位置（0..TILE_SIZE）。
            const pxF = (col / segments) * TILE_SIZE;
            const pyF = (row / segments) * TILE_SIZE;
            // この頂点のグローバルピクセル(zoom)→ geom タイルのローカルピクセルへ写像し、
            // geom 標高（z16-18 は z15 祖先）を bilinear サンプル。
            const glx = (tx * TILE_SIZE + pxF) / geomScale - geomX * TILE_SIZE;
            const gly = (ty * TILE_SIZE + pyF) / geomScale - geomY * TILE_SIZE;
            let elev = sampleElevBilinear(geomElev, glx, gly);
            // クロスレベル: 境界辺なら粗タイル表面へ標高をスナップ（陰影シーム解消、z<=15 のみ）。
            const snapped = snapEdgeElevation(edges, row, col, segments, tx, ty, pxF, pyF);
            if (snapped !== null) elev = snapped;
            // no-data（NaN）は海面(0m)に倒す。GSI 標高は海上・湖面・カバー外で NaN を返すことがあり、
            // そのまま使うと頂点座標が NaN になりメッシュが不可視＝タイルが欠ける。海域は
            // 海面、海岸の部分 no-data も海面として描画する（GSI テクスチャは別途貼られる）。
            if (!Number.isFinite(elev)) elev = 0;

            const { lat, lon } = pixelToLatLon(
                tx * TILE_SIZE + pxF,
                ty * TILE_SIZE + pyF,
                totalPixels,
            );
            geodeticToEcefToRef(lat, lon, elev, ecef);

            // アンカー相対（小さな値）で格納する。
            positions.push(ecef.x - anchor.x, ecef.y - anchor.y, ecef.z - anchor.z);

            // UV: col→u（西→東）。地理院タイル画像は row=0（pyF=0）が北端。
            // Babylon の既定 Texture は invertY=true で、v=1 が画像上端（=北）、
            // v=0 が下端（=南）に対応する。よって北端頂点(row=0)は v=1 にする必要があり、
            // v = 1 - row/segments とする（row/segments だと per-tile で南北が反転する）。
            uvs.push(col / segments, 1 - row / segments);
        }
    }

    // 地表メッシュのインデックス（2 三角形 / セル）。法線はこの地表面のみで計算する
    // （スカート壁を含めるとエッジ頂点の法線が壁に引っ張られ、境界が暗い帯になる）。
    const surfaceIndices: number[] = [];
    for (let row = 0; row < segments; row++) {
        for (let col = 0; col < segments; col++) {
            const a = gridIndex(row, col);
            const b = a + 1;
            const c = a + vertsPerSide;
            const d = c + 1;
            // 巻き順は法線が外向き（地心と反対）になる向き。表面が外を向く。
            surfaceIndices.push(a, b, c, b, d, c);
        }
    }

    // ---- スカート: 周縁頂点を地心方向へ押し下げた壁を追加して T 字クラックを隠す ----
    // 深さはタイル辺長に比例（LOD 段差を吸収する程度）。粗タイルほど深く、上限あり。
    const skirtDepth = Math.min(
        SKIRT_MAX_DEPTH,
        Math.max(SKIRT_MIN_DEPTH, tileEdgeMeters(center.lat, zoom) * SKIRT_DEPTH_RATIO),
    );
    const down = anchor.clone().normalize().scaleInPlace(-skirtDepth); // 地心方向（タイル内ほぼ一定）
    const skirtOf = new Map<number, number>();
    const addSkirtVertex = (gi: number): number => {
        const existing = skirtOf.get(gi);
        if (existing !== undefined) return existing;
        const base = gi * 3;
        const si = positions.length / 3;
        positions.push(
            positions[base] + down.x,
            positions[base + 1] + down.y,
            positions[base + 2] + down.z,
        );
        // スカート頂点の UV は元の周縁頂点と同じ（辺のテクセルを縦に引き延ばす）。
        uvs.push(uvs[gi * 2], uvs[gi * 2 + 1]);
        skirtOf.set(gi, si);
        return si;
    };
    // 連続する 2 周縁頂点とそのスカート頂点で壁（2 三角形）を張る。
    // 壁の表裏（外周のどちら向きが外か）を厳密に決めず両面分の三角形を出すことで、
    // backFaceCulling=true でもスカートが常に見えるようにする（隙間隠しを確実にする）。
    const wallIndices: number[] = [];
    const addWall = (gA: number, gB: number): void => {
        const sA = addSkirtVertex(gA);
        const sB = addSkirtVertex(gB);
        wallIndices.push(gA, gB, sA, gB, sB, sA); // 表
        wallIndices.push(gA, sA, gB, gB, sA, sB); // 裏（両面化）
    };
    for (let i = 0; i < segments; i++) {
        addWall(gridIndex(0, i), gridIndex(0, i + 1)); // 上辺
        addWall(gridIndex(segments, i), gridIndex(segments, i + 1)); // 下辺
        addWall(gridIndex(i, 0), gridIndex(i + 1, 0)); // 左辺
        addWall(gridIndex(i, segments), gridIndex(i + 1, segments)); // 右辺
    }

    // 法線は地表面のみで計算（スカート壁を除外）。スカート頂点の法線は元の周縁頂点に
    // 揃え、壁が地表と同じ陰影になるようにする（暗い帯を防ぐ）。
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, surfaceIndices, normals);
    for (const [gi, si] of skirtOf) {
        normals[si * 3] = normals[gi * 3];
        normals[si * 3 + 1] = normals[gi * 3 + 1];
        normals[si * 3 + 2] = normals[gi * 3 + 2];
    }

    return {
        positions,
        indices: surfaceIndices.concat(wallIndices),
        normals,
        uvs,
        anchor,
        centerLat: center.lat,
        centerLon: center.lon,
    };
};
