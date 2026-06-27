/**
 * 矩形リージョン定義・座標変換
 *
 * 高尾山山頂付近を中心とした矩形リージョンを定義し、
 * 地理座標 (lat, lon) ⇔ ローカルメートル座標 (x, y) の変換を行う。
 */

/** 地球半径 (m)。WGS84 平均半径。 */
const EARTH_RADIUS_M = 6_371_008.8;

/** リージョン定義（地理座標） */
export interface RegionDef {
    /** 中心緯度 (度) */
    centerLat: number;
    /** 中心経度 (度) */
    centerLon: number;
    /** 東西幅 (m) */
    widthM: number;
    /** 南北幅 (m) */
    heightM: number;
}

/** 高尾山山頂のデフォルトリージョン */
export const DEFAULT_REGION: Readonly<RegionDef> = {
    centerLat: 35.6251,
    centerLon: 139.2436,
    widthM: 300,
    heightM: 300,
};

/**
 * リージョンの 4 頂点を地理座標で返す（Polygon API 用）。
 * 左下 → 右下 → 右上 → 左上 の順（時計回り）。
 */
export const regionCorners = (
    region: RegionDef,
): { lat: number; lon: number }[] => {
    const halfW = region.widthM / 2;
    const halfH = region.heightM / 2;

    const dLat = halfH / ((Math.PI / 180) * EARTH_RADIUS_M);
    const cosLat = Math.cos((region.centerLat * Math.PI) / 180);
    const dLon =
        cosLat !== 0
            ? halfW / ((Math.PI / 180) * EARTH_RADIUS_M * cosLat)
            : 0;

    return [
        { lat: region.centerLat - dLat, lon: region.centerLon - dLon },
        { lat: region.centerLat - dLat, lon: region.centerLon + dLon },
        { lat: region.centerLat + dLat, lon: region.centerLon + dLon },
        { lat: region.centerLat + dLat, lon: region.centerLon - dLon },
    ];
};

/**
 * 地理座標 → ローカルメートル座標 (x=東, y=北)。
 * リージョン中心が原点。
 */
export const geoToLocal = (
    lat: number,
    lon: number,
    region: RegionDef,
): { x: number; y: number } => {
    const dLat = lat - region.centerLat;
    const dLon = lon - region.centerLon;
    const y = dLat * (Math.PI / 180) * EARTH_RADIUS_M;
    const cosLat = Math.cos((region.centerLat * Math.PI) / 180);
    const x = dLon * (Math.PI / 180) * EARTH_RADIUS_M * cosLat;
    return { x, y };
};

/**
 * ローカルメートル座標 → 地理座標。
 */
export const localToGeo = (
    x: number,
    y: number,
    region: RegionDef,
): { lat: number; lon: number } => {
    const dLat = y / ((Math.PI / 180) * EARTH_RADIUS_M);
    const cosLat = Math.cos((region.centerLat * Math.PI) / 180);
    const dLon =
        cosLat !== 0
            ? x / ((Math.PI / 180) * EARTH_RADIUS_M * cosLat)
            : 0;
    return {
        lat: region.centerLat + dLat,
        lon: region.centerLon + dLon,
    };
};

/**
 * リージョンの Boids 境界（ローカルメートル座標系）を返す。
 */
export const regionBounds = (
    region: RegionDef,
): { minX: number; maxX: number; minY: number; maxY: number } => {
    const halfW = region.widthM / 2;
    const halfH = region.heightM / 2;
    return {
        minX: -halfW,
        maxX: halfW,
        minY: -halfH,
        maxY: halfH,
    };
};

/**
 * ローカル座標がリージョン内かどうか判定する。
 */
export const isInsideRegion = (
    x: number,
    y: number,
    region: RegionDef,
): boolean => {
    const halfW = region.widthM / 2;
    const halfH = region.heightM / 2;
    return x >= -halfW && x <= halfW && y >= -halfH && y <= halfH;
};

/** 初期配置を境界から内側に寄せる係数（境界付近での初期衝突を回避） */
const SPAWN_INNER_RATIO = 0.8;

/**
 * リージョン内のランダムな位置を返す（ローカル座標）。
 */
export const randomPositionInRegion = (
    region: RegionDef,
): { x: number; y: number } => {
    const halfW = region.widthM / 2;
    const halfH = region.heightM / 2;
    return {
        x: (Math.random() - 0.5) * 2 * halfW * SPAWN_INNER_RATIO,
        y: (Math.random() - 0.5) * 2 * halfH * SPAWN_INNER_RATIO,
    };
};

/**
 * ランダムな初期速度ベクトルを返す。
 */
export const randomVelocity = (speed: number): { vx: number; vy: number } => {
    const angle = Math.random() * 2 * Math.PI;
    return {
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
    };
};
