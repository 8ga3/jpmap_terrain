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
 * 極付近のパン減速係数（[0,1]）を返す。極では東西の一定メートル移動が経度（極回りの方位角）の
 * 巨大な変化に対応し、地球が高速回転して見える（#356）。Babylon 組み込みパン
 * (`geospatialCameraMovement.computeCurrentFrameDeltas`) の緯度ダンピングと同等の式で、
 * 独自パン（`scenes/globe.ts`）にも極減速を与える。
 *
 * - 赤道では 1.0（減速なし）、極へ近づくほど 0 へ漸近する（`sqrt(cos(lat))`）。
 * - 高度が低い（`cameraHeight` が地心距離に対して小さい）ほど減速を緩め、地表付近では
 *   緯度の影響を受けないようにする（`max(1, centerRadius/height)` でスケール）。
 *
 * @param center      注視点(ECEF)。`center.z/|center|` が球面緯度の sin。
 * @param cameraHeight カメラの対地高度相当[m]（独自パンでは `camera.radius` を渡す）。
 * @returns           [0,1] のパン速度係数。`center` が原点近傍など退化時は 1。
 */
export const polePanSpeedMultiplier = (
    center: Vector3,
    cameraHeight: number,
): number => {
    const centerRadius = center.length();
    if (centerRadius < 1) return 1;
    const sineLat = Math.min(1, Math.max(-1, center.z / centerRadius));
    const cosLat = Math.sqrt(Math.max(0, 1 - sineLat * sineLat));
    const latitudeDampening = Math.sqrt(cosLat); // sqrt で赤道付近の効きを弱める
    const height = Math.max(cameraHeight, DEGENERATE_EPS);
    // 地表付近（height が小さい）では係数を 1 へ寄せ、緯度減速を無効化する。
    const latitudeDampeningScale = Math.max(1, centerRadius / height);
    const m = latitudeDampeningScale * latitudeDampening;
    return Math.min(1, Math.max(0, m));
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
 * 原点 `origin` から方向 `dir` のレイと、**世界原点中心の楕円体**
 * `(x/radiusX)² + (y/radiusY)² + (z/radiusZ)² = 1` との手前側交点を `ref` に書き込む。
 * `dir` は**正規化不要**（二次方程式の係数 `t` がスケールに追従するだけで、交点
 * `origin + t·dir` は `dir` の長さに依らず正しく求まる）。
 * zoom-to-cursor のカーソル下の目標点を `scene.pick` 非依存かつ**地球楕円体上の固定点**として
 * 求める用途（球近似だとカメラがズームで動くたび `center.length()` 変化＋楕円体との差で目標点が
 * フレーム毎にずれ、カーソル下の地点が固定されず揺れる。WGS84 楕円体で解けば物理的に同一点へ収束）。
 *
 * 楕円体を各軸 `1/radius*` でスケールすると単位球に写るため、スケール空間でレイ係数 `t` を解く
 * （`t` はスケール変換に不変なので元空間の `origin + t·dir` に適用できる）。
 *
 * @param dir レイ方向。正規化は不要（長さは交点に影響しない）。
 * @returns 交点があり t>=0 なら true（`ref` に交点。t=0 は origin が楕円体面上の境界ケース）、
 *          レイが楕円体を外す/両交点とも背面、または半径・origin・dir が非有限/半径が非正なら false。
 */
export const rayEllipsoidNearHitToRef = (
    origin: Vector3,
    dir: Vector3,
    radiusX: number,
    radiusY: number,
    radiusZ: number,
    ref: Vector3,
): boolean => {
    // 半径が非有限/非正だと 0 除算で NaN が伝播し、disc<0 / t<0 判定を素通りして ref に NaN を
    // 書きつつ true を返し得る。origin/dir に NaN/Infinity が入った場合も同様に NaN が比較を
    // 素通りする。export 関数として入力（半径・origin・dir）の有限性を早期ガードする
    // （呼び出し側は通常正の有限値を渡す。退化入力時は ref を変更せず false）。
    if (
        !(radiusX > 0) ||
        !(radiusY > 0) ||
        !(radiusZ > 0) ||
        !Number.isFinite(radiusX) ||
        !Number.isFinite(radiusY) ||
        !Number.isFinite(radiusZ) ||
        !Number.isFinite(origin.x) ||
        !Number.isFinite(origin.y) ||
        !Number.isFinite(origin.z) ||
        !Number.isFinite(dir.x) ||
        !Number.isFinite(dir.y) ||
        !Number.isFinite(dir.z)
    ) {
        return false;
    }
    const ox = origin.x / radiusX;
    const oy = origin.y / radiusY;
    const oz = origin.z / radiusZ;
    const dx = dir.x / radiusX;
    const dy = dir.y / radiusY;
    const dz = dir.z / radiusZ;
    const a = dx * dx + dy * dy + dz * dz;
    if (a <= 0) return false;
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false; // レイが楕円体と交わらない（空を指している等）
    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a); // 手前側
    if (t < 0) t = (-b + sq) / (2 * a); // 手前が背面なら奥側（カメラが内部＝地中の保険）
    if (t < 0) return false; // 両交点とも背面
    ref.copyFrom(dir).scaleInPlace(t).addInPlace(origin);
    return true;
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
    // 水平視（dAltPerRadius≈0）や非有限値（NaN/Infinity）では radius を増やしても高度が
    // 上がらない/壊れるので入力 radius を返す（NaN は比較が常に false のため明示判定する）。
    if (!Number.isFinite(dAltPerRadius) || dAltPerRadius < 1e-3) return radius;
    const next = radius + deficit / dAltPerRadius;
    return Number.isFinite(next) ? next : radius;
};
