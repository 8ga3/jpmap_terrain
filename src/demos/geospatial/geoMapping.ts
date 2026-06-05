/**
 * Geospatial PoC: カメラ UI / URL 状態と GeospatialCamera のマッピング (Issue #321 / 親 #275)
 *
 * 既存（平面版）の UI / URL 共有は `azimuth`(方位) / `tilt`(チルト) / `altitude`(高度) と
 * `@lat,lon,...` を用いる。これを GeospatialCamera の `yaw` / `pitch` / `radius` / `center`(ECEF)
 * へ相互変換できるかを検証するための純関数群。
 *
 * 対応関係（本 PoC で確認）:
 * - azimuth[deg] ⇄ yaw[rad]   （どちらも 0 = 北、+ = 東回り）
 * - tilt[deg]    ⇄ pitch[rad] （0 = 直下、90 = 水平。既存 UI の「地面からの傾き」と同義）
 * - altitude[m]  ⇄ radius     （注視点（center）からのカメラ距離。既存の ArcRotate radius と同義）
 * - lat,lon      ⇄ center(ECEF)（往路: EcefFromLatLonAltToRef / 復路: 本ファイルの ecefToGeodetic）
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** 測地座標（度・メートル）。 */
export interface Geodetic {
    latDeg: number;
    lonDeg: number;
    altMeters: number;
}

/**
 * ECEF → 測地座標（WGS84）の逆変換。Bowring の閉形式（1 反復で mm 級精度）。
 *
 * 軸の規約は `EcefFromLatLonAltToRef` と同じ（X→経度0, Y→東経90°, Z→北極）。
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
        const latDeg = (z >= 0 ? 90 : -90);
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

/** 既存 UI の azimuth/tilt[deg] → GeospatialCamera の yaw/pitch[rad]。 */
export const uiToYawPitch = (
    azimuthDeg: number,
    tiltDeg: number,
): { yaw: number; pitch: number } => ({
    yaw: azimuthDeg * DEG2RAD,
    pitch: tiltDeg * DEG2RAD,
});

/** GeospatialCamera の yaw/pitch[rad] → 既存 UI の azimuth/tilt[deg]。 */
export const yawPitchToUi = (
    yaw: number,
    pitch: number,
): { azimuthDeg: number; tiltDeg: number } => {
    // azimuth は 0..360 に正規化（既存 URL 表現に合わせる）。
    let az = (yaw * RAD2DEG) % 360;
    if (az < 0) az += 360;
    return { azimuthDeg: az, tiltDeg: pitch * RAD2DEG };
};

/** `@lat,lon,altitude,azimuth,tilt` 形式の at-path を生成（既存 URL 共有形式と同じ）。 */
export const toAtPath = (
    latDeg: number,
    lonDeg: number,
    altitude: number,
    azimuthDeg: number,
    tiltDeg: number,
): string =>
    `@${latDeg.toFixed(6)},${lonDeg.toFixed(6)},${Math.round(altitude)},` +
    `${azimuthDeg.toFixed(1)},${tiltDeg.toFixed(1)}`;
