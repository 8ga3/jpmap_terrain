/**
 * グローブオーバーレイの配置ユーティリティ（純関数）。
 *
 * 平面版（`overlayCoords.ts`）は wx/wz と +Y up を前提とするが、グローブでは位置ごとに up
 * （地心方向）が変わる。本モジュールは「緯度経度＋標高 → ECEF 位置と地心 up」「カメラ距離に
 * 応じたスクリーン定スケール」「ドロップ線高さ」を ECEF ベースで提供する。平面オーバーレイ
 * とは独立（並行構築）で、`GeospatialCamera` を直接 import しない（jest 環境を軽く保つ）。
 */
import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";

import { DEG2RAD, geodeticToEcefToRef } from "./ecef";

/** 緯度経度 1 点（オーバーレイ頂点）。 */
export interface LatLonPoint {
    lat: number;
    lon: number;
}

/**
 * スケール基準距離 [m]。カメラ距離がこの値で scale=1、それ以上は distance/refDistance 倍して
 * スクリーン空間サイズを一定に保つ（平面版 `REF_DISTANCE_M` と同義）。
 */
export const OVERLAY_REF_DISTANCE_M = 1000;

/** スケール下限（近距離での過大スケール抑制）。 */
const MIN_SCALE = 0.1;

/** 緯度 1 度あたりのメートル（平面版と同じ近似）。円周点生成の等距離近似に使う。 */
const METERS_PER_DEGREE_LAT = 111320;

/** ドロップ線高さの下限・上限 [m]（平面版 computeDynamicLineHeight と同レンジ）。 */
const LINE_HEIGHT_MIN = 100;
const LINE_HEIGHT_MAX = 10000;

/**
 * 緯度経度＋標高 → 地表 ECEF 位置（`posRef`）と地心 up（`upRef`）を書き込む。
 * up は位置ベクトルの正規化（楕円体の厳密法線ではなく地心方向の近似だが、オーバーレイの
 * 立ち上がり方向としては十分）。
 */
export const groundPlacementToRef = (
    latDeg: number,
    lonDeg: number,
    elevMeters: number,
    posRef: Vector3,
    upRef: Vector3,
): void => {
    geodeticToEcefToRef(latDeg, lonDeg, elevMeters, posRef);
    upRef.copyFrom(posRef);
    const len = upRef.length();
    if (len > 0) upRef.scaleInPlace(1 / len);
};

/**
 * カメラ ECEF とオーバーレイ ECEF 位置からスクリーン定スケール係数を計算する（下限あり）。
 */
export const computeOverlayDistanceScale = (
    cameraEcef: Vector3,
    posEcef: Vector3,
    refDistanceM: number = OVERLAY_REF_DISTANCE_M,
    minScale: number = MIN_SCALE,
): number =>
    computeOverlayDistanceScaleFromDistance(
        Vector3.Distance(cameraEcef, posEcef),
        refDistanceM,
        minScale,
    );

/**
 * 既に算出済みの距離 [m] からスクリーン定スケール係数を計算する（下限あり）。
 * 距離を別途使う呼び出し側で `Vector3.Distance` の二重計算（sqrt）を避けるための入口。
 *
 * `minScale` は下限値。3D 透視では近接時に過小化（消失）しないよう既定 {@link MIN_SCALE}。
 * 2D 正射ではフラスタムが radius に比例するため、下限なし（0）にすると全ズームで画面上の
 * 見かけサイズが一定になる（マーカー同等の挙動）。
 */
export const computeOverlayDistanceScaleFromDistance = (
    distanceM: number,
    refDistanceM: number = OVERLAY_REF_DISTANCE_M,
    minScale: number = MIN_SCALE,
): number => {
    // 0 以下の基準距離は不正（Infinity/-Infinity を防ぐ）。既定値へフォールバックする。
    const ref = refDistanceM > 0 ? refDistanceM : OVERLAY_REF_DISTANCE_M;
    return Math.max(distanceM / ref, minScale);
};

/**
 * カメラ距離に応じたドロップ線高さ [m]。距離に比例（×0.1）しつつ [100, 10000] にクランプし、
 * 遠景でも近景でも見た目の立ち上がりを安定させる（平面版 computeDynamicLineHeight 相当）。
 */
export const computeOverlayLineHeight = (distanceM: number): number => {
    const h = distanceM * 0.1;
    return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, h));
};

// computeScreenUpToRef のスクラッチ（毎フレーム・点数ぶん呼ばれるため割り当て回避）。
const _suToCam = new Vector3();
const _suRight = new Vector3();

/**
 * ワールド点 `point` におけるカメラ視点の「画面上方向（screen up）」を `ref` に書き込む（純関数）。
 *
 * ラベルを点の上（画面上）へオフセットして点を覆い隠さないために使う（平面版 polygon と同手法）。
 * カメラ上方向 `camUp` を、点→カメラ方向（`toCam`）に直交する成分へ Gram-Schmidt 射影して
 * 正規化する。これにより 2D トップダウン（視線=地心 up）でもラベルが点に重ならない。
 *
 * @returns 計算できたら true（`ref` に screen up）。点とカメラが一致／`camUp` が視線と平行などの
 *   特異時は false（`ref` は不変。呼び出し側は地心 up 等へフォールバックする）。
 */
export const computeScreenUpToRef = (
    camPos: Vector3,
    camUp: Vector3,
    point: Vector3,
    ref: Vector3,
): boolean => {
    camPos.subtractToRef(point, _suToCam);
    const tlen = _suToCam.length();
    if (tlen <= 1e-6) return false;
    _suToCam.scaleInPlace(1 / tlen);
    // right = camUp × toCam
    Vector3.CrossToRef(camUp, _suToCam, _suRight);
    if (_suRight.lengthSquared() < 1e-12) return false; // camUp ∥ toCam
    _suRight.normalize();
    // screenUp = toCam × right
    Vector3.CrossToRef(_suToCam, _suRight, ref);
    const slen = ref.length();
    if (slen <= 1e-6) return false;
    ref.scaleInPlace(1 / slen);
    return true;
};

// surfaceOrientationToRef のスクラッチ（毎フレーム・モデル数ぶん呼ばれるため割り当て回避）。
const ORI_POLE = new Vector3(0, 0, 1);
const _oriUp = new Vector3();
const _oriEast = new Vector3();
const _oriNorth = new Vector3();
const _oriFwd = new Vector3();
const _oriTmp = new Vector3();
const _oriX = new Vector3();
const _oriMat = new Matrix();

/**
 * 地表 ECEF 位置に置くモデル等の **向き（回転クォータニオン）** を `ref` に書き込む。
 * モデルのローカル +Y を地心 up へ、ローカル +Z を方位 `headingDeg`（0=北, +=東回り）方向へ向ける
 * （地表で「立つ」姿勢）。極（東が定義できない）では `false` を返す（呼び出し側は向き更新をスキップ）。
 *
 * @returns 計算できたら true（`ref` に回転）、極などの特異点で false。
 */
export const surfaceOrientationToRef = (
    positionEcef: Vector3,
    headingDeg: number,
    ref: Quaternion,
): boolean => {
    const r = positionEcef.length();
    if (r < 1) return false;
    positionEcef.scaleToRef(1 / r, _oriUp); // 地心 up
    Vector3.CrossToRef(ORI_POLE, _oriUp, _oriEast);
    if (_oriEast.lengthSquared() < 1e-12) return false; // 極
    _oriEast.normalize();
    Vector3.CrossToRef(_oriUp, _oriEast, _oriNorth); // 北
    _oriNorth.normalize();
    // forward = north*cos(h) + east*sin(h)（0=北, +=東回り）。
    const h = headingDeg * DEG2RAD;
    _oriFwd.copyFrom(_oriNorth).scaleInPlace(Math.cos(h));
    _oriTmp.copyFrom(_oriEast).scaleInPlace(Math.sin(h));
    _oriFwd.addInPlace(_oriTmp).normalize();
    // 右手系の正規直交基底 {x=up×fwd, y=up, z=fwd} から回転行列→クォータニオン。
    Vector3.CrossToRef(_oriUp, _oriFwd, _oriX);
    _oriX.normalize();
    Matrix.FromXYZAxesToRef(_oriX, _oriUp, _oriFwd, _oriMat);
    Quaternion.FromRotationMatrixToRef(_oriMat, ref);
    return true;
};

/**
 * 中心 lat/lon から半径 `radiusMeters` の円周上の lat/lon 点列を生成する（純関数）。
 * 局所等距離近似（緯度方向 111320 m/deg、経度方向はその cos(lat) 倍）で、数十 km までの円に十分。
 * 返すのは `segments` 個の点（始点 = θ=0、北方向）。輪を閉じるのは描画側（closed）に委ねる。
 */
export const generateGeodesicRing = (
    centerLat: number,
    centerLon: number,
    radiusMeters: number,
    segments: number,
): LatLonPoint[] => {
    // 公開 API のため自身で検証して呼び出し側のバグを早期検出する（JSDoc の「segments 個の点」を保証）。
    if (!(radiusMeters > 0)) {
        throw new Error(`generateGeodesicRing: radiusMeters must be > 0 (got ${radiusMeters})`);
    }
    if (!Number.isInteger(segments) || segments < 3) {
        throw new Error(
            `generateGeodesicRing: segments must be an integer >= 3 (got ${segments})`,
        );
    }
    const latRad = (centerLat * Math.PI) / 180;
    const metersPerDegLon = METERS_PER_DEGREE_LAT * Math.max(1e-6, Math.cos(latRad));
    const ring: LatLonPoint[] = [];
    for (let i = 0; i < segments; i++) {
        const theta = (i / segments) * 2 * Math.PI;
        // θ=0 を北（+lat）、+ を東回り（+lon）にする。
        const dLat = (radiusMeters * Math.cos(theta)) / METERS_PER_DEGREE_LAT;
        const dLon = (radiusMeters * Math.sin(theta)) / metersPerDegLon;
        ring.push({ lat: centerLat + dLat, lon: centerLon + dLon });
    }
    return ring;
};

/**
 * グローブポリゴンの ECEF パスを生成する（純関数）。
 * - `top`: 各頂点を地形標高 `elevs[i]` で接地した ECEF（アウトライン／壁の上端）。
 * - `bottom`: 同 lat/lon の楕円体面（alt=0）の ECEF（壁＝カーテンの下端）。
 *
 * `closed` かつ頂点 2 つ以上のとき、先頭頂点を末尾へ複製して輪を閉じる。
 * Babylon の `CreateLines`/`CreateRibbon` の path 配列としてそのまま渡せる。
 */
export const buildDrapedPolygonPaths = (
    points: readonly LatLonPoint[],
    elevs: readonly number[],
    closed: boolean,
): { top: Vector3[]; bottom: Vector3[] } => {
    const len = drapedPolygonPathLength(points.length, closed);
    const top = Array.from({ length: len }, () => new Vector3());
    const bottom = Array.from({ length: len }, () => new Vector3());
    writeDrapedPolygonPathsToRef(points, elevs, closed, top, bottom);
    return { top, bottom };
};

/**
 * `closed` を考慮したパス配列長（`buildDrapedPolygonPaths` の top/bottom の要素数）。
 * 呼び出し側が再利用バッファを確保するために使う。
 */
export const drapedPolygonPathLength = (
    pointCount: number,
    closed: boolean,
): number => pointCount + (closed && pointCount >= 2 ? 1 : 0);

/**
 * `buildDrapedPolygonPaths` の in-place 版。事前確保した `topRef`/`bottomRef`
 * （長さは {@link drapedPolygonPathLength}）へ書き込み、毎フレーム更新の割り当てを避ける。
 */
export const writeDrapedPolygonPathsToRef = (
    points: readonly LatLonPoint[],
    elevs: readonly number[],
    closed: boolean,
    topRef: Vector3[],
    bottomRef: Vector3[],
): void => {
    for (let i = 0; i < points.length; i++) {
        geodeticToEcefToRef(points[i].lat, points[i].lon, elevs[i] ?? 0, topRef[i]);
        geodeticToEcefToRef(points[i].lat, points[i].lon, 0, bottomRef[i]);
    }
    if (closed && points.length >= 2) {
        topRef[points.length].copyFrom(topRef[0]);
        bottomRef[points.length].copyFrom(bottomRef[0]);
    }
};
