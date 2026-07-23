/**
 * 箱庭ジオラマの正方形（行列状）グリッド生成。
 *
 * 標高タイル（矩形のラスタデータ）は行列状のピクセル配列であり、グリッド自体も
 * 行列状（row/col）にすることで、標高サンプリング・メッシュ生成が素直な二重ループで
 * 済み、中心への頂点集中（旧・放射状グリッドで生じていたシワ状アーティファクト）が
 * 構造的に発生しない。フットプリントの外形は正方形そのものになる（円形クリップは
 * 行わない。Meta Quest 3 実機でのWebXRパフォーマンスを優先し、円形の見た目自体を
 * 採用しない方針としたため）。
 *
 * 中心からの距離が小さい範囲（footprintHalfSizeM は手元サイズの箱庭が対象とする
 * 実世界フットプリントの半辺長であり、通常は高々数km）を対象とするため、緯度経度への
 * 変換は WGS84 楕円体の曲率半径に基づく局所平面近似（東西/南北の1度あたりメートル）で
 * 十分な精度を持つ（globe 地形が必要とする ECEF 全球規模の厳密性は不要）。
 */
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

import { DEG2RAD } from "../geo/ecef";
import { MERCATOR_MAX_LAT } from "../geo/mapping";

/** 箱庭の中心（測地座標、度）。 */
export interface DioramaCenter {
    lat: number;
    lon: number;
}

/** 正方形グリッドの分割設定。 */
export interface DioramaGridOptions {
    /** 1辺あたりの分割数（>= 1）。頂点数は `(gridSegments+1) * (gridSegments+1)`。 */
    gridSegments: number;
}

/** グリッド上の1点。 */
export interface DioramaGridPoint {
    /** 中心からのローカル平面オフセット・東方向[m]。 */
    x: number;
    /** 中心からのローカル平面オフセット・北方向[m]。 */
    z: number;
    /** 緯度[deg]（DEM/テクスチャ取得用）。 */
    lat: number;
    /** 経度[deg]（DEM/テクスチャ取得用）。 */
    lon: number;
    /** 行番号（0 = 北端、gridSegments = 南端）。 */
    row: number;
    /** 列番号（0 = 西端、gridSegments = 東端）。 */
    col: number;
}

/**
 * 緯度[deg]における「1度あたりのメートル」（WGS84楕円体、東西/南北）。
 * `ecef.ts` と同じ `Wgs84Ellipsoid` 定数を用い、子午線曲率半径 M・卯酉線曲率半径 N から算出する。
 *
 * 極付近（|lat|→90°）では `cos(lat)→0` となり、経度方向の1度あたりメートル（`lon`）が
 * 0 に近づく。`offsetToLatLon` はこの値で除算するため、そのまま許すとゼロ除算で
 * `Infinity`/`NaN` を返してしまう。GSI タイルの実用域（`geo/mapping.ts` の
 * `MERCATOR_MAX_LAT`、Web メルカトルの緯度有効域）と同じ範囲に制限し、早期に
 * `RangeError` を投げることでこの破綻を防ぐ（箱庭が対象とする実世界地形は
 * いずれにせよこの範囲外に存在しない）。
 */
export const metersPerDegreeAt = (
    latDeg: number,
): { lat: number; lon: number } => {
    if (!(Math.abs(latDeg) <= MERCATOR_MAX_LAT)) {
        throw new RangeError(
            `latDeg must be within ±${MERCATOR_MAX_LAT} (got ${latDeg}); ` +
                "near-pole centers are unsupported (cos(lat)→0 causes division by zero in offsetToLatLon)",
        );
    }
    const a = Wgs84Ellipsoid.semiMajorAxis;
    const e2 = Wgs84Ellipsoid.firstEccentricitySquared;
    const lat = latDeg * DEG2RAD;
    const sinLat = Math.sin(lat);
    const denom = 1 - e2 * sinLat * sinLat;
    const meridionalRadius = (a * (1 - e2)) / Math.pow(denom, 1.5);
    const primeVerticalRadius = a / Math.sqrt(denom);
    return {
        lat: meridionalRadius * DEG2RAD,
        lon: primeVerticalRadius * Math.cos(lat) * DEG2RAD,
    };
};

/**
 * ローカル平面オフセット[m]（x=East, z=North）→ 緯度経度[deg]（局所平面近似）。
 */
export const offsetToLatLon = (
    center: DioramaCenter,
    x: number,
    z: number,
): { lat: number; lon: number } => {
    const mpd = metersPerDegreeAt(center.lat);
    return {
        lat: center.lat + z / mpd.lat,
        lon: center.lon + x / mpd.lon,
    };
};

/**
 * `gridSegments` が有限な整数かつ1以上であることを検証する。
 * 非整数（例: 4.5）や `NaN`/`Infinity` を許すと、`vertsPerSide = gridSegments + 1` を
 * 使う添字計算（`buildDioramaGridIndices`/`extractGridPerimeterIndices`）が非整数の
 * 頂点インデックスを生成し、`Uint32Array` への変換時に切り捨てられて誤った頂点を
 * 参照する破綻したメッシュになる。3関数（`buildDioramaGridPoints`/
 * `buildDioramaGridIndices`/`extractGridPerimeterIndices`）すべてで検証する。
 */
const assertValidGridSegments = (gridSegments: number): void => {
    if (!(Number.isInteger(gridSegments) && gridSegments >= 1)) {
        throw new RangeError(`gridSegments must be an integer >= 1 (got ${gridSegments})`);
    }
};

/**
 * 正方形（行列状）グリッドの点列を生成する。
 * 並び順: row-major（row=0..gridSegments、各row内でcol=0..gridSegments）。
 * row=0 が北端(z=+footprintHalfSizeM)、col=0 が西端(x=-footprintHalfSizeM)。
 * 合計点数は `(gridSegments+1) * (gridSegments+1)`。
 */
export const buildDioramaGridPoints = (
    center: DioramaCenter,
    footprintHalfSizeM: number,
    options: DioramaGridOptions,
): DioramaGridPoint[] => {
    const { gridSegments } = options;
    assertValidGridSegments(gridSegments);
    if (!(Number.isFinite(footprintHalfSizeM) && footprintHalfSizeM > 0)) {
        throw new RangeError(`footprintHalfSizeM must be a positive finite number (got ${footprintHalfSizeM})`);
    }

    const points: DioramaGridPoint[] = [];
    for (let row = 0; row <= gridSegments; row++) {
        // row=0→z=+footprintHalfSizeM（北端）、row=gridSegments→z=-footprintHalfSizeM（南端）。
        const z = footprintHalfSizeM * (1 - (2 * row) / gridSegments);
        for (let col = 0; col <= gridSegments; col++) {
            // col=0→x=-footprintHalfSizeM（西端）、col=gridSegments→x=+footprintHalfSizeM（東端）。
            const x = footprintHalfSizeM * ((2 * col) / gridSegments - 1);
            const { lat, lon } = offsetToLatLon(center, x, z);
            points.push({ x, z, lat, lon, row, col });
        }
    }
    return points;
};

/**
 * `buildDioramaGridPoints` の点列に対応する三角形インデックスを生成する。
 * 1セル（row,col）につき2枚の三角形（対角線 a-d で分割）。
 * 頂点順は Babylon 既定（左手系, Y-up）で表（+Y方向）を向くよう構成する。
 */
export const buildDioramaGridIndices = (
    options: DioramaGridOptions,
): Uint32Array => {
    const { gridSegments } = options;
    assertValidGridSegments(gridSegments);
    const vertsPerSide = gridSegments + 1;
    const gridIndex = (row: number, col: number): number => row * vertsPerSide + col;

    const indices: number[] = [];
    for (let row = 0; row < gridSegments; row++) {
        for (let col = 0; col < gridSegments; col++) {
            const a = gridIndex(row, col);
            const b = gridIndex(row, col + 1);
            const c = gridIndex(row + 1, col);
            const d = gridIndex(row + 1, col + 1);
            indices.push(a, c, b, b, c, d);
        }
    }
    return new Uint32Array(indices);
};

/**
 * `buildDioramaGridPoints` の点列から、正方形の外周（4辺）を巡る点インデックス列を
 * 抽出する。側面壁（`dioramaSkirt.buildDioramaSkirtGeometry`）が外周の閉曲線を
 * 必要とするため、行列状グリッドの境界を単一の閉じたループとして取り出す。
 *
 * 巡回順は 北辺(西→東) → 東辺(北→南) → 南辺(東→西) → 西辺(南→北) で、
 * 各辺の始点（四隅）が重複しないよう次の辺の開始点から詰める。これは旧・放射状
 * グリッドの角度増加方向（北→東→南→西の時計回り）と同じ回転方向になる。
 */
export const extractGridPerimeterIndices = (
    options: DioramaGridOptions,
): number[] => {
    const { gridSegments } = options;
    assertValidGridSegments(gridSegments);
    const vertsPerSide = gridSegments + 1;
    const gridIndex = (row: number, col: number): number => row * vertsPerSide + col;

    const perimeter: number[] = [];
    // 北辺: row=0, col=0..gridSegments-1（西→東）。
    for (let col = 0; col < gridSegments; col++) perimeter.push(gridIndex(0, col));
    // 東辺: col=gridSegments, row=0..gridSegments-1（北→南）。
    for (let row = 0; row < gridSegments; row++) perimeter.push(gridIndex(row, gridSegments));
    // 南辺: row=gridSegments, col=gridSegments..1（東→西）。
    for (let col = gridSegments; col > 0; col--) perimeter.push(gridIndex(gridSegments, col));
    // 西辺: col=0, row=gridSegments..1（南→北）。
    for (let row = gridSegments; row > 0; row--) perimeter.push(gridIndex(row, 0));

    return perimeter;
};
