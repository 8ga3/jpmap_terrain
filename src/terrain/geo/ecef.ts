/**
 * ECEF（Earth-Centered, Earth-Fixed / WGS84）座標と測地座標の相互変換。
 *
 * グローブ地形（Issue #275）の座標基盤。Babylon.js の `EcefFromLatLonAltToRef`
 * （測地→ECEF）に対し、本モジュールは度数入力のラッパと、ECEF→測地の逆変換
 * （Bowring 閉形式）を提供する。PoC（Issue #321 / `geoMapping.ts`）の純関数を
 * 本体共有モジュールへ昇格したもの。
 *
 * 軸の規約は Babylon の `EcefFromLatLonAltToRef` と同一:
 * - X 軸 → 経度 0°（本初子午線）
 * - Y 軸 → 東経 90°
 * - Z 軸 → 北極
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
    EcefFromLatLonAltToRef,
    Wgs84Ellipsoid,
} from "@babylonjs/core/Maths/math.geospatial.functions";
import type { ILatLonAltLike } from "@babylonjs/core/Maths/math.geospatial";

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** 測地座標（度・メートル）。 */
export interface Geodetic {
    /** 緯度[deg]。 */
    latDeg: number;
    /** 経度[deg]。 */
    lonDeg: number;
    /** 楕円体面からの高度[m]。 */
    altMeters: number;
}

/** 度数の測地座標を radian の `ILatLonAltLike` に詰める内部バッファ。 */
const scratchLatLonAlt: ILatLonAltLike = { lat: 0, lon: 0, alt: 0 };

/**
 * 測地座標（度・メートル）→ ECEF[m]。Babylon の `EcefFromLatLonAltToRef` の
 * 度数入力ラッパ。結果を `ref` に書き込んで返す（アロケーション回避）。
 */
export const geodeticToEcefToRef = (
    latDeg: number,
    lonDeg: number,
    altMeters: number,
    ref: Vector3,
): Vector3 => {
    scratchLatLonAlt.lat = latDeg * DEG2RAD;
    scratchLatLonAlt.lon = lonDeg * DEG2RAD;
    scratchLatLonAlt.alt = altMeters;
    EcefFromLatLonAltToRef(scratchLatLonAlt, Wgs84Ellipsoid, ref);
    return ref;
};

/** 測地座標（度・メートル）→ ECEF[m]。新規 `Vector3` を返す簡易版。 */
export const geodeticToEcef = (
    latDeg: number,
    lonDeg: number,
    altMeters: number,
): Vector3 => geodeticToEcefToRef(latDeg, lonDeg, altMeters, new Vector3());

/**
 * ECEF[m] → 測地座標（WGS84）の逆変換。Bowring の閉形式（1 反復で mm 級精度）。
 *
 * 軸の規約は `geodeticToEcef` / Babylon の `EcefFromLatLonAltToRef` と同じ
 * （X→経度0, Y→東経90°, Z→北極）。
 */
export const ecefToGeodetic = (ecef: Vector3): Geodetic => {
    const a = Wgs84Ellipsoid.semiMajorAxis;
    const b = Wgs84Ellipsoid.semiMinorAxis;
    const e2 = Wgs84Ellipsoid.firstEccentricitySquared;
    const ep2 = Wgs84Ellipsoid.secondEccentricitySquared;

    const x = ecef.x;
    const y = ecef.y;
    const z = ecef.z;

    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    // 極（p≈0）の特異点を回避。
    if (p < 1e-6) {
        const latDeg = z >= 0 ? 90 : -90;
        return { latDeg, lonDeg: lon * RAD2DEG, altMeters: Math.abs(z) - b };
    }
    const theta = Math.atan2(z * a, p * b);
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const lat = Math.atan2(
        z + ep2 * b * sinT * sinT * sinT,
        p - e2 * a * cosT * cosT * cosT,
    );
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat); // 卯酉線曲率半径
    const alt = p / Math.cos(lat) - N;

    return { latDeg: lat * RAD2DEG, lonDeg: lon * RAD2DEG, altMeters: alt };
};
