/**
 * 弾道計算の純粋関数群 (Issue #259)
 *
 * Angle（仰角）と Powder（火力 = 初速スカラー）から
 * 3D 初速ベクトルを算出する。
 */

/** 度 → ラジアン */
export const degToRad = (deg: number): number => (deg * Math.PI) / 180;

/** ラジアン → 度 */
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * 仰角（elevation）と方位角（azimuth）、初速スカラーから
 * ワールド空間の初速ベクトル (x, y, z) を返す。
 *
 * Babylon.js 座標系: Y = 上、X = 東、Z = 北
 * azimuthDeg: 北(+Z) 基準で時計回り（0=北, 90=東, 180=南, 270=西）
 * elevationDeg: 水平面からの仰角 (0–90°)
 */
export interface LaunchVector {
    x: number;
    y: number;
    z: number;
}

export const computeLaunchVector = (
    elevationDeg: number,
    azimuthDeg: number,
    speed: number,
): LaunchVector => {
    const elRad = degToRad(elevationDeg);
    const azRad = degToRad(azimuthDeg);

    const horizontalSpeed = speed * Math.cos(elRad);
    const y = speed * Math.sin(elRad);
    const x = horizontalSpeed * Math.sin(azRad);
    const z = horizontalSpeed * Math.cos(azRad);

    return { x, y, z };
};

/**
 * Powder 値 (0–100) を初速にマッピングする。
 *
 * 命名について:
 *   内部ロジック・変数名は当初の仕様どおり「powder（火薬量）」を使用する。
 *   一方、画面 UI のラベルはコンパクトなボトムバーに収めるため「Power」と
 *   短縮表記している（ユーザー承認済み）。両者は同一概念を指す。
 *
 * デフォルメ物理: 重力150、大砲間距離1500を基準に
 * R = v^2 / g (θ=45°) → v = sqrt(R * g) = sqrt(1500 * 150) ≈ 474
 * 50%パワーで射程が大砲間距離に届くよう設定。
 */
export const MAX_SPEED = 600;
export const MIN_SPEED = 200;

export const powderToSpeed = (powder: number): number => {
    const clamped = Math.max(0, Math.min(100, powder));
    return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (clamped / 100);
};

/**
 * 2 点間の水平距離 (m) を Haversine で算出。
 */
export const haversineDistance = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): number => {
    const R = 6371000;
    const dLat = degToRad(lat2 - lat1);
    const dLon = degToRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(degToRad(lat1)) *
            Math.cos(degToRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
    const h = Math.min(1, a);
    return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * 2 点間の方位角（北基準時計回り）を度で返す。
 */
export const bearing = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): number => {
    const φ1 = degToRad(lat1);
    const φ2 = degToRad(lat2);
    const Δλ = degToRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
        Math.cos(φ1) * Math.sin(φ2) -
        Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((radToDeg(Math.atan2(y, x)) % 360) + 360) % 360;
};
