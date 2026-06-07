/**
 * グローブカメラ（Issue #275 Phase 2）の UI/URL ⇄ `GeospatialCamera` マッピングと、
 * floating origin 下で `scene.pick` に依存しないパン（地表接線移動）・カメラ地形衝突の純関数群。
 *
 * 既存（平面版）の UI / URL 共有は `azimuth`(方位) / `tilt`(チルト) / `altitude`(高度) を用いる。
 * これを `GeospatialCamera` の `yaw` / `pitch` / `radius` / `center`(ECEF) と相互変換する。
 * PoC（Issue #321 `geoMapping.ts`）の純関数を本体共有モジュールへ昇格したもの。
 *
 * 対応関係:
 * - azimuth[deg] ⇄ yaw[rad]   （どちらも 0 = 北、+ = 東回り）
 * - tilt[deg]    ⇄ pitch[rad] （0 = 直下、90 = 水平。既存 UI の「地面からの傾き」と同義）
 *
 * 本モジュールは `GeospatialCamera` を直接 import しない（jest 環境を軽く保つ）。`yaw`/`pitch`
 * から視線（lookAt）を組む処理は Babylon の `ComputeLookAtFromYawPitchToRef` を呼ぶ
 * 呼び出し側（`scenes/globe.ts`）が担い、本モジュールには算出済みのベクトルを渡す。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { DEG2RAD, RAD2DEG } from "./ecef";

/** ECEF 北極軸（`EcefFromLatLonAltToRef` 規約: X→経度0, Y→東経90°, Z→北極）。 */
const ECEF_POLE = new Vector3(0, 0, 1);

/** 接線基底が縮退（特異点）とみなす長さ二乗のしきい値。 */
const DEGENERATE_EPS = 1e-12;

/** 既存 UI の azimuth/tilt[deg] → `GeospatialCamera` の yaw/pitch[rad]。 */
export const uiToYawPitch = (
    azimuthDeg: number,
    tiltDeg: number,
): { yaw: number; pitch: number } => ({
    yaw: azimuthDeg * DEG2RAD,
    pitch: tiltDeg * DEG2RAD,
});

/** `GeospatialCamera` の yaw/pitch[rad] → 既存 UI の azimuth/tilt[deg]。 */
export const yawPitchToUi = (
    yaw: number,
    pitch: number,
): { azimuthDeg: number; tiltDeg: number } => ({
    // azimuth は既存 URL 表現に合わせ [0, 360) に正規化（JS の % は負値を返すため二重剰余）。
    azimuthDeg: (((yaw * RAD2DEG) % 360) + 360) % 360,
    tiltDeg: pitch * RAD2DEG,
});

/**
 * 注視点(center)の地表における **地理的接線基底**（東・北）を `ref` に書き込む。WASD パン用。
 *
 * 地心 up（center 正規化）と ECEF 北極軸の外積で東を、up×東 で北を作る。極（up が北極軸と平行）
 * では東が定義できないため `false` を返す（呼び出し側はパンをスキップ）。
 *
 * @returns 基底を計算できたら true、極などの特異点で計算不能なら false。
 */
export const geographicTangentBasisToRef = (
    center: Vector3,
    eastRef: Vector3,
    northRef: Vector3,
): boolean => {
    const r = center.length();
    if (r < 1) return false;
    const up = center.scale(1 / r);
    Vector3.CrossToRef(ECEF_POLE, up, eastRef);
    if (eastRef.lengthSquared() < DEGENERATE_EPS) return false;
    eastRef.normalize();
    Vector3.CrossToRef(up, eastRef, northRef); // 北
    northRef.normalize();
    return true;
};

/**
 * 注視点(center)から見たカメラ視線(lookAt)を基準に、地表に沿った **右・前方向** を `ref` に書き込む。
 * 左ドラッグパン用（「マップを掴む」操作の縮尺をカメラ向きに合わせる）。
 *
 * `lookAt` はカメラ→center 方向（`ComputeLookAtFromYawPitchToRef` の出力）。地心 up との外積で
 * 画面右、up×右 で地表に沿った前方を作る。真下視点（lookAt ∥ up）では右が定義できず `false`。
 *
 * @returns 基底を計算できたら true、真下視点などの特異点で計算不能なら false。
 */
export const cameraTangentBasisToRef = (
    center: Vector3,
    lookAt: Vector3,
    rightRef: Vector3,
    fwdRef: Vector3,
): boolean => {
    const r = center.length();
    if (r < 1) return false;
    const up = center.scale(1 / r);
    Vector3.CrossToRef(lookAt, up, rightRef);
    if (rightRef.lengthSquared() < DEGENERATE_EPS) return false; // 真下視点
    rightRef.normalize();
    Vector3.CrossToRef(up, rightRef, fwdRef); // 地表に沿ったカメラ前方
    fwdRef.normalize();
    return true;
};

/**
 * 注視点(center)を接線移動量 `tangentMove`[m] だけ動かし、地心距離 |center| を保つよう
 * 球面へ再投影した結果を `ref` に書き込む。パン共通の後処理。
 */
export const panCenterOnSphereToRef = (
    center: Vector3,
    tangentMove: Vector3,
    ref: Vector3,
): Vector3 => {
    const r = center.length();
    ref.copyFrom(center).addInPlace(tangentMove);
    const moved = ref.length();
    if (moved < 1) {
        ref.copyFrom(center);
        return ref;
    }
    ref.scaleInPlace(r / moved); // 地心距離 r を保って球面上へ戻す
    return ref;
};

/**
 * カメラが地形に潜らないための最小クリアランスを満たす `radius` を返す（カメラ地形衝突）。
 *
 * `GeospatialCamera` のカメラ位置は center/yaw/pitch/radius から導出されるため、潜り込みは
 * radius を増やして解消する。カメラ高度はおおむね radius に線形（係数 `dAltPerRadius`
 * = カメラ位置での地心 up・(center→camera 方向)）で増えるので、不足分を 1 ステップで補う。
 *
 * @param radius            現在の radius[m]。
 * @param camAltMeters      カメラの楕円体高度[m]（`ecefToGeodetic(cameraEcef).altMeters`）。
 * @param terrainElevMeters カメラ直下の地形標高[m]（無ければ呼び出し側で 0）。
 * @param minClearance      地表からの最小クリアランス[m]。
 * @param dAltPerRadius     radius あたりのカメラ高度増加率（up・(center→camera 単位方向)）。
 * @returns クリアランスを満たす radius[m]（潜っていなければ入力 radius のまま）。
 */
export const clampRadiusForGroundClearance = (
    radius: number,
    camAltMeters: number,
    terrainElevMeters: number,
    minClearance: number,
    dAltPerRadius: number,
): number => {
    const deficit = terrainElevMeters + minClearance - camAltMeters;
    if (deficit <= 0) return radius; // 既にクリアランスを満たす
    // 水平視（dAltPerRadius≈0）では radius を増やしても高度が上がらないので諦める（発散回避）。
    if (dAltPerRadius < 1e-3) return radius;
    return radius + deficit / dAltPerRadius;
};
