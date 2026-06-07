/**
 * グローブオーバーレイ（Issue #275 Phase 3）の配置ユーティリティ（純関数）。
 *
 * 平面版（`overlayCoords.ts`）は wx/wz と +Y up を前提とするが、グローブでは位置ごとに up
 * （地心方向）が変わる。本モジュールは「緯度経度＋標高 → ECEF 位置と地心 up」「カメラ距離に
 * 応じたスクリーン定スケール」「ドロップ線高さ」を ECEF ベースで提供する。平面オーバーレイ
 * とは独立（並行構築）で、`GeospatialCamera` を直接 import しない（jest 環境を軽く保つ）。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { geodeticToEcefToRef } from "./ecef";

/**
 * スケール基準距離 [m]。カメラ距離がこの値で scale=1、それ以上は distance/refDistance 倍して
 * スクリーン空間サイズを一定に保つ（平面版 `REF_DISTANCE_M` と同義）。
 */
export const OVERLAY_REF_DISTANCE_M = 1000;

/** スケール下限（近距離での過大スケール抑制）。 */
const MIN_SCALE = 0.1;

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
): number =>
    computeOverlayDistanceScaleFromDistance(
        Vector3.Distance(cameraEcef, posEcef),
        refDistanceM,
    );

/**
 * 既に算出済みの距離 [m] からスクリーン定スケール係数を計算する（下限あり）。
 * 距離を別途使う呼び出し側で `Vector3.Distance` の二重計算（sqrt）を避けるための入口。
 */
export const computeOverlayDistanceScaleFromDistance = (
    distanceM: number,
    refDistanceM: number = OVERLAY_REF_DISTANCE_M,
): number => {
    // 0 以下の基準距離は不正（Infinity/-Infinity を防ぐ）。既定値へフォールバックする。
    const ref = refDistanceM > 0 ? refDistanceM : OVERLAY_REF_DISTANCE_M;
    return Math.max(distanceM / ref, MIN_SCALE);
};

/**
 * カメラ距離に応じたドロップ線高さ [m]。距離に比例（×0.1）しつつ [100, 10000] にクランプし、
 * 遠景でも近景でも見た目の立ち上がりを安定させる（平面版 computeDynamicLineHeight 相当）。
 */
export const computeOverlayLineHeight = (distanceM: number): number => {
    const h = distanceM * 0.1;
    return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, h));
};
