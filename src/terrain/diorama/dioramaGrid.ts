/**
 * 箱庭ジオラマの放射状（極座標）グリッド生成。
 *
 * 「正方形タイルを円形にクリップする」問題を、放射状グリッド自体の外形が
 * そのまま円になることで構造的に回避する（シェーダーdiscard/ステンシル/
 * ジオメトリ切断は不要）。中心からの距離が小さい範囲（footprintRadiusM は
 * 手元サイズの箱庭が対象とする実世界footprint半径であり、通常は高々数km）
 * を対象とするため、緯度経度への変換は WGS84 楕円体の曲率半径に基づく
 * 局所平面近似（東西/南北の1度あたりメートル）で十分な精度を持つ
 * （globe 地形が必要とする ECEF 全球規模の厳密性は不要）。
 */
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

import { DEG2RAD } from "../geo/ecef";

/** 箱庭の中心（測地座標、度）。 */
export interface DioramaCenter {
    lat: number;
    lon: number;
}

/** 放射状グリッドの分割設定。 */
export interface DioramaGridOptions {
    /** 中心を除く同心円リング数（>= 1）。 */
    ringCount: number;
    /** 1リングあたりの分割数（>= 3）。 */
    radialSegments: number;
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
    /** リング番号（0 = 中心点）。 */
    ring: number;
    /** リング内のセグメント番号（中心点は 0）。 */
    segment: number;
}

/**
 * 緯度[deg]における「1度あたりのメートル」（WGS84楕円体、東西/南北）。
 * `ecef.ts` と同じ `Wgs84Ellipsoid` 定数を用い、子午線曲率半径 M・卯酉線曲率半径 N から算出する。
 */
export const metersPerDegreeAt = (
    latDeg: number,
): { lat: number; lon: number } => {
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
 * 放射状（同心円）グリッドの点列を生成する。
 * 並び順: 中心点(1個) → ring=1..ringCount（各 radialSegments 個、角度0=北、時計回り）。
 * 合計点数は `1 + ringCount * radialSegments`。
 */
export const buildDioramaGridPoints = (
    center: DioramaCenter,
    footprintRadiusM: number,
    options: DioramaGridOptions,
): DioramaGridPoint[] => {
    const { ringCount, radialSegments } = options;
    if (ringCount < 1) {
        throw new RangeError(`ringCount must be >= 1 (got ${ringCount})`);
    }
    if (radialSegments < 3) {
        throw new RangeError(`radialSegments must be >= 3 (got ${radialSegments})`);
    }
    if (!(footprintRadiusM > 0)) {
        throw new RangeError(`footprintRadiusM must be > 0 (got ${footprintRadiusM})`);
    }

    const points: DioramaGridPoint[] = [
        { x: 0, z: 0, lat: center.lat, lon: center.lon, ring: 0, segment: 0 },
    ];
    for (let ring = 1; ring <= ringCount; ring++) {
        const radius = (footprintRadiusM * ring) / ringCount;
        for (let segment = 0; segment < radialSegments; segment++) {
            const angle = (2 * Math.PI * segment) / radialSegments;
            // 角度0を北(+z)とし、時計回り（東→南→西）に進める。
            const x = radius * Math.sin(angle);
            const z = radius * Math.cos(angle);
            const { lat, lon } = offsetToLatLon(center, x, z);
            points.push({ x, z, lat, lon, ring, segment });
        }
    }
    return points;
};

/**
 * `buildDioramaGridPoints` の点列に対応する三角形インデックスを生成する。
 * - 中心 → ring1: 扇形（radialSegments 枚）
 * - ring(r) → ring(r+1): 帯（radialSegments * 2 枚 / 段）
 * 頂点順は Babylon 既定（左手系, Y-up）で表を向くよう時計回りにする。
 */
export const buildDioramaGridIndices = (
    options: DioramaGridOptions,
): Uint32Array => {
    const { ringCount, radialSegments } = options;
    const indices: number[] = [];
    const ringStart = (ring: number): number =>
        ring === 0 ? 0 : 1 + (ring - 1) * radialSegments;

    // 中心 → ring1 の扇形。
    const ring1Start = ringStart(1);
    for (let seg = 0; seg < radialSegments; seg++) {
        const a = ring1Start + seg;
        const b = ring1Start + ((seg + 1) % radialSegments);
        indices.push(0, b, a);
    }

    // ring(r) → ring(r+1) の帯。
    for (let ring = 1; ring < ringCount; ring++) {
        const innerStart = ringStart(ring);
        const outerStart = ringStart(ring + 1);
        for (let seg = 0; seg < radialSegments; seg++) {
            const segNext = (seg + 1) % radialSegments;
            const i0 = innerStart + seg;
            const i1 = innerStart + segNext;
            const o0 = outerStart + seg;
            const o1 = outerStart + segNext;
            indices.push(i0, o1, o0);
            indices.push(i0, i1, o1);
        }
    }

    return new Uint32Array(indices);
};
