/**
 * ローカル ENU（East-North-Up）フレームと ECEF（WGS84）座標の相互変換。
 *
 * グローブ地形（Issue #275 / #404）上で物理を解くための座標基盤。ECEF 絶対座標
 * （~6.4e6 m）で Havok を解くと float32 量子化でコリジョンが破綻するため、物理は
 * ある測地原点に張った ENU の原点近傍小座標で解き、描画のみ ECEF へ写像する。
 *
 * 軸の割り当ては artillery の物理規約に合わせる:
 * - X 軸 → East（東）
 * - Y 軸 → Up（上, 重力の反対）
 * - Z 軸 → North（北）
 *
 * ECEF 側の軸規約は `ecef.ts` / Babylon の `EcefFromLatLonAltToRef` と同一
 * （X→経度0, Y→東経90°, Z→北極）。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DEG2RAD, geodeticToEcef } from "./ecef";

/**
 * 測地原点に張られた ENU フレーム。
 * `east` / `up` / `north` は ECEF 空間における正規直交基底ベクトル。
 */
export interface EnuFrame {
    /** ENU 原点の ECEF 座標[m]。 */
    originEcef: Vector3;
    /** East 方向（ECEF 単位ベクトル）。ENU の +X。 */
    east: Vector3;
    /** Up 方向（ECEF 単位ベクトル）。ENU の +Y。 */
    up: Vector3;
    /** North 方向（ECEF 単位ベクトル）。ENU の +Z。 */
    north: Vector3;
}

/**
 * 測地原点（度・メートル）に張る ENU フレームを構築する。
 *
 * 基底ベクトルは球面測地の標準式（X→経度0, Y→経度90°, Z→北極の ECEF 上）:
 * - East  = (-sinLon, cosLon, 0)
 * - North = (-sinLat·cosLon, -sinLat·sinLon, cosLat)
 * - Up    = ( cosLat·cosLon,  cosLat·sinLon, sinLat)
 */
export const buildEnuFrame = (
    latDeg: number,
    lonDeg: number,
    altMeters = 0,
): EnuFrame => {
    const lat = latDeg * DEG2RAD;
    const lon = lonDeg * DEG2RAD;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);

    const east = new Vector3(-sinLon, cosLon, 0);
    const north = new Vector3(
        -sinLat * cosLon,
        -sinLat * sinLon,
        cosLat,
    );
    const up = new Vector3(cosLat * cosLon, cosLat * sinLon, sinLat);

    return {
        originEcef: geodeticToEcef(latDeg, lonDeg, altMeters),
        east,
        up,
        north,
    };
};

/**
 * ENU ローカル座標（x=East, y=Up, z=North）→ ECEF[m]。
 * `ecef = origin + x·East + y·Up + z·North`。結果を `ref` に書き込んで返す。
 */
export const enuToEcefToRef = (
    frame: EnuFrame,
    x: number,
    y: number,
    z: number,
    ref: Vector3,
): Vector3 => {
    ref.set(
        frame.originEcef.x +
            x * frame.east.x +
            y * frame.up.x +
            z * frame.north.x,
        frame.originEcef.y +
            x * frame.east.y +
            y * frame.up.y +
            z * frame.north.y,
        frame.originEcef.z +
            x * frame.east.z +
            y * frame.up.z +
            z * frame.north.z,
    );
    return ref;
};

/** ENU ローカル `Vector3`（x=East, y=Up, z=North）→ ECEF[m]。`ref` に書き込む。 */
export const enuVectorToEcefToRef = (
    frame: EnuFrame,
    enu: Vector3,
    ref: Vector3,
): Vector3 => enuToEcefToRef(frame, enu.x, enu.y, enu.z, ref);

/**
 * ECEF[m] → ENU ローカル座標（x=East, y=Up, z=North）。
 * `enu = Rᵀ(ecef − origin)`（R の列は East/Up/North）。`ref` に書き込んで返す。
 */
export const ecefToEnuToRef = (
    frame: EnuFrame,
    ecef: Vector3,
    ref: Vector3,
): Vector3 => {
    const dx = ecef.x - frame.originEcef.x;
    const dy = ecef.y - frame.originEcef.y;
    const dz = ecef.z - frame.originEcef.z;
    ref.set(
        dx * frame.east.x + dy * frame.east.y + dz * frame.east.z,
        dx * frame.up.x + dy * frame.up.y + dz * frame.up.z,
        dx * frame.north.x + dy * frame.north.y + dz * frame.north.z,
    );
    return ref;
};
