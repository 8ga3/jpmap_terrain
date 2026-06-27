/**
 * 円軌道の位置・方位計算ユーティリティ。
 *
 * 中心 (lat, lon) から指定半径 (m) の円周上の地理座標と、
 * 接線方向（進行方向）の方位角を計算する。
 */

/** 地球半径 (m)。WGS84 平均半径。 */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * 中心 (lat, lon) から半径 radius (m)、角度 angleDeg (度, 北=0, 時計回り) の
 * 円周上の緯度経度を返す。
 *
 * 距離の概算（球面近似）で地形上でのわずかな誤差は許容する。
 */
export const circularOrbitPosition = (
    centerLat: number,
    centerLon: number,
    radiusM: number,
    angleDeg: number,
): { lat: number; lon: number } => {
    const angleRad = (angleDeg * Math.PI) / 180;
    // 緯度方向: 1度 ≈ EARTH_RADIUS_M * π / 180 m
    const dLat = (radiusM * Math.cos(angleRad)) / ((Math.PI / 180) * EARTH_RADIUS_M);
    // 経度方向: cos(lat) 補正
    const cosLat = Math.cos((centerLat * Math.PI) / 180);
    const dLon =
        cosLat !== 0
            ? (radiusM * Math.sin(angleRad)) / ((Math.PI / 180) * EARTH_RADIUS_M * cosLat)
            : 0;
    return {
        lat: centerLat + dLat,
        lon: centerLon + dLon,
    };
};

/**
 * 円軌道上の角度 angleDeg における接線方向の方位角（Y軸回転, 度）を返す。
 *
 * 時計回りの円軌道なので、進行方向は角度 + 90° (接線方向)。
 */
export const circularOrbitHeading = (angleDeg: number): number => {
    return ((angleDeg + 90) % 360 + 360) % 360;
};
