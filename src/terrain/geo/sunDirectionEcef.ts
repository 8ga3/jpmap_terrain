/**
 * 太陽の地理的見かけ位置（高度・方位角）を、グローブシーンの ECEF 太陽方向ベクトルへ変換する。
 *
 * かつての平面シーン（撤去済み planar 実装）は Babylon 左手系（X=東/Y=上/Z=北）で太陽方向を組んでいたが、
 * グローブシーン（`scenes/globe.ts`）は **右手系 ECEF**（X→経度0 / Y→東経90° / Z→北極、
 * `geo/ecef` と同一規約）で動く。観測点（lat/lon）でのローカル ENU（East-North-Up）基底を
 * ECEF で構成し、地平座標（azimuth/altitude）の太陽方向を ECEF へ写す。
 *
 * - 副作用なし・Babylon の `Vector3` のみに依存する純粋関数（unit test しやすい）。
 * - 戻り値は「地表→太陽」を指す ECEF 単位ベクトル。`DirectionalLight.direction` には
 *   その符号反転（太陽→地表）を渡すこと。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

const DEG2RAD = Math.PI / 180;

/**
 * 観測点 `(latDeg, lonDeg)` における地平座標の太陽位置を ECEF 太陽方向単位ベクトルへ変換し
 * `ref` に書き込む（アロケーション回避）。
 *
 * @param latDeg 観測点の緯度[deg]（北緯正）
 * @param lonDeg 観測点の経度[deg]（東経正）
 * @param altitudeDeg 太陽の地平高度[deg]（地平線=0、天頂=90、負値は地平線下）
 * @param azimuthDeg 太陽の方位角[deg]（北=0、東=90、南=180、西=270）
 * @param ref 結果を書き込む `Vector3`
 * @returns `ref`（地表→太陽の ECEF 単位ベクトル）
 */
export const sunDirectionEcefToRef = (
    latDeg: number,
    lonDeg: number,
    altitudeDeg: number,
    azimuthDeg: number,
    ref: Vector3,
): Vector3 => {
    const lat = latDeg * DEG2RAD;
    const lon = lonDeg * DEG2RAD;
    const alt = altitudeDeg * DEG2RAD;
    const az = azimuthDeg * DEG2RAD;

    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);

    // 地平座標の太陽方向を ENU 成分へ分解する。
    const cosAltitude = Math.cos(alt);
    const east = Math.sin(az) * cosAltitude;
    const north = Math.cos(az) * cosAltitude;
    const up = Math.sin(alt);

    // ECEF（右手系: X→経度0 / Y→東経90° / Z→北極）における ENU 基底ベクトル。
    //   East  = (-sinLon,           cosLon,            0     )
    //   North = (-sinLat*cosLon,   -sinLat*sinLon,     cosLat)
    //   Up    = ( cosLat*cosLon,    cosLat*sinLon,     sinLat)
    const x =
        east * -sinLon + north * (-sinLat * cosLon) + up * (cosLat * cosLon);
    const y =
        east * cosLon + north * (-sinLat * sinLon) + up * (cosLat * sinLon);
    const z = north * cosLat + up * sinLat;

    ref.set(x, y, z);
    return ref.normalize();
};

/**
 * {@link sunDirectionEcefToRef} の新規 `Vector3` を返す簡易版。
 */
export const sunDirectionEcef = (
    latDeg: number,
    lonDeg: number,
    altitudeDeg: number,
    azimuthDeg: number,
): Vector3 =>
    sunDirectionEcefToRef(
        latDeg,
        lonDeg,
        altitudeDeg,
        azimuthDeg,
        new Vector3(),
    );
