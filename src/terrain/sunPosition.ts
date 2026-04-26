/**
 * 太陽位置計算（NOAA Solar Position Algorithm 簡易版）
 *
 * 緯度・経度・UTC 日時から太陽の見かけ高度・方位角を返す純粋関数。
 *
 * - アルゴリズム: NOAA Solar Calculator のフーリエ級数近似（精度 ±1° 程度）。
 *   大気差・視差補正は省略している。
 * - 入力 `date` は UTC として解釈する（`Date.UTC` 系で比較するため）。
 * - 副作用なし、Babylon.js 依存なし（unit test しやすい純粋関数）。
 *
 * 参考: https://gml.noaa.gov/grad/solcalc/calcdetails.html
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));

/**
 * UTC 日時を「年初からの通算日数(1始まり) + UTC 時刻(時)」へ分解する。
 */
const toDayOfYearAndUtcHour = (
    date: Date,
): { dayOfYear: number; utcHour: number } => {
    const startOfYearUtc = Date.UTC(date.getUTCFullYear(), 0, 1);
    const dayOfYear =
        Math.floor((date.getTime() - startOfYearUtc) / 86400000) + 1;
    const utcHour =
        date.getUTCHours() +
        date.getUTCMinutes() / 60 +
        date.getUTCSeconds() / 3600 +
        date.getUTCMilliseconds() / 3600000;
    return { dayOfYear, utcHour };
};

/**
 * 緯度・経度・UTC 日時から太陽の見かけ位置を返す。
 *
 * @param lat 緯度（度）。北緯正・南緯負
 * @param lon 経度（度）。東経正・西経負
 * @param date UTC として解釈する `Date`
 * @returns `altitudeDeg`: -90..90（負値は地平線下）。`azimuthDeg`: 0..360（北=0、東=90、南=180、西=270）。
 */
export function computeSunPosition(
    lat: number,
    lon: number,
    date: Date,
): { altitudeDeg: number; azimuthDeg: number } {
    const { dayOfYear, utcHour } = toDayOfYearAndUtcHour(date);

    // 年内フラクション角 γ（ラジアン）
    const gamma =
        ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHour - 12) / 24);

    const cosG = Math.cos(gamma);
    const sinG = Math.sin(gamma);
    const cos2G = Math.cos(2 * gamma);
    const sin2G = Math.sin(2 * gamma);
    const cos3G = Math.cos(3 * gamma);
    const sin3G = Math.sin(3 * gamma);

    // 均時差（分）
    const eqTimeMin =
        229.18 *
        (0.000075 +
            0.001868 * cosG -
            0.032077 * sinG -
            0.014615 * cos2G -
            0.040849 * sin2G);

    // 太陽赤緯（ラジアン）
    const declRad =
        0.006918 -
        0.399912 * cosG +
        0.070257 * sinG -
        0.006758 * cos2G +
        0.000907 * sin2G -
        0.002697 * cos3G +
        0.00148 * sin3G;

    // 真太陽時（分）。UTC 基準なのでタイムゾーン項は 0。
    const timeOffsetMin = eqTimeMin + 4 * lon;
    const trueSolarTimeMin = utcHour * 60 + timeOffsetMin;

    // 時角（ラジアン）。太陽が子午線上で 0、午後で正、午前で負。
    const hourAngleRad = ((trueSolarTimeMin / 4 - 180) * Math.PI) / 180;

    const latRad = lat * DEG2RAD;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinDecl = Math.sin(declRad);
    const cosDecl = Math.cos(declRad);

    const cosZenith =
        sinLat * sinDecl + cosLat * cosDecl * Math.cos(hourAngleRad);
    const zenithRad = Math.acos(clamp(cosZenith, -1, 1));
    const altitudeDeg = 90 - zenithRad * RAD2DEG;

    const sinZenith = Math.sin(zenithRad);
    let azimuthDeg: number;
    if (sinZenith < 1e-9 || cosLat < 1e-9) {
        // 太陽が天頂近傍、または極点。方位は意味を持たないが既定値として南を返す。
        azimuthDeg = 180;
    } else {
        const cosAzNumerator =
            (sinLat * Math.cos(zenithRad) - sinDecl) / (cosLat * sinZenith);
        const azRefRad = Math.acos(clamp(cosAzNumerator, -1, 1));
        const azRefDeg = azRefRad * RAD2DEG;
        // NOAA 規約: HA>0（午後）→ 180+az、HA≤0（午前）→ 540-az
        if (hourAngleRad > 0) {
            azimuthDeg = (azRefDeg + 180) % 360;
        } else {
            azimuthDeg = (540 - azRefDeg) % 360;
        }
    }

    return { altitudeDeg, azimuthDeg };
}
