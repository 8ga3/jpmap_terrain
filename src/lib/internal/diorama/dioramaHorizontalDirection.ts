/**
 * カメラのローカル軸（`Vector3.Forward()`/`Vector3.Right()`）をワールド空間へ変換し、
 * 水平面（XZ平面、東西・南北に相当）へ投影した単位ベクトルを返すヘルパー。
 *
 * @remarks
 * 元は `dioramaKeyboardControls.ts`（`ArcRotateCamera` の向き基準でWASDパンを
 * 実現する）専用のprivate関数だったが、`dioramaTouchControls.ts`（通常モードの
 * 常時表示タッチHUD、`ArcRotateCamera` の向き基準でバーチャルジョイスティックの
 * パンを実現する）でも同じ処理が必要になったため、`Camera` 基底型
 * （`ArcRotateCamera`/`WebXRCamera` いずれも `getDirection` を持つ）を受け取る
 * 共有ヘルパーとして切り出した。
 *
 * `dioramaArControls.ts`（AR中のコントローラー/GUI操作）は当初カメラの視線方向
 * 基準だったが、ユーザーが物理的に移動すると基準が不安定になる問題があったため、
 * 「ユーザー位置↔箱庭中心＋箱庭の回転角」基準へ再設計され、本ヘルパーは使わなく
 * なった（`computeHorizontalDisplacement`/`rotateHorizontalUnitVector` 参照）。
 */
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { HorizontalUnitVector } from "./dioramaControllerMapping";

/** 水平方向がほぼ0（カメラが真上/真下を向いている等の退化ケース）とみなす閾値。 */
const HORIZONTAL_DIRECTION_EPSILON = 1e-6;

/**
 * カメラのローカル軸をワールド空間へ変換し、水平面へ投影した単位ベクトルを返す。
 * カメラが真上/真下を向く退化ケースでは `{x:0, z:0}` を返す（呼び出し側で無視される）。
 */
export const getHorizontalDirectionUnit = (
    camera: Camera,
    localAxis: Vector3,
): HorizontalUnitVector => {
    const dir = camera.getDirection(localAxis);
    const lenSq = dir.x * dir.x + dir.z * dir.z;
    if (lenSq < HORIZONTAL_DIRECTION_EPSILON) return { x: 0, z: 0 };
    const invLen = 1 / Math.sqrt(lenSq);
    return { x: dir.x * invLen, z: dir.z * invLen };
};
