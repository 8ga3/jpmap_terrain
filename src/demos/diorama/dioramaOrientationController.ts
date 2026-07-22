/**
 * diorama デモの「箱庭の回転角・設置高さオフセット」を単独で保持し、
 * 回転/高さ変更入力（入力源を問わない共通の軸表現、スティックX軸・左右トリガー値）を
 * 対象の `TransformNode` へ直接反映する。
 *
 * @remarks
 * `DioramaViewController`（地図移動・拡大縮小、`dioramaViewController.ts`）と同じ
 * 「AR中のコントローラー/GUI操作とデスクトップのキーボード操作の両方から共有される、
 * 単独の状態保持者」という設計方針を踏襲する。ただし回転・高さ変更は
 * DEM/テクスチャの再取得（非同期rebuild）を伴わないため、`DioramaViewController` の
 * ような「完了待ち合流」は不要で、毎フレーム同期的に対象ノードへ直接書き込む。
 *
 * **対象ノードは `dioramaTerrain.root` ではなく、専用の `orientationRoot` を渡すこと**
 * （`index.ts` が生成する）。理由: AR中は `webXrArSession.ts` の
 * `placeDioramaRelativeToCamera`/`restoreOnExit` が `dioramaTerrain.root.position` を
 * 実機カメラ位置基準の絶対値で書き換える。もし本コントローラーが同じノードの
 * `position.y` を高さオフセットとして書き込むと、AR入退場のたびに上書き・消失して
 * しまう。また、回転を「AR配置で絶対位置を持つノード」に適用すると、そのノードの
 * ローカル原点（＝世界原点）を中心に箱庭全体が公転してしまい、「その場で回転」に
 * ならない。そのため `index.ts` は以下の3階層を構築する想定:
 *
 * ```
 * placementRoot（AR配置/デスクトップ既定位置。position.x/y/zを絶対値で書く）
 *   └ orientationRoot（本コントローラーが rotation.y・position.y を書く）
 *       └ dioramaTerrain.root（スケールのみ、既存のまま）
 * ```
 *
 * `orientationRoot.position` はローカル座標（`placementRoot` 基準）のY成分のみを
 * 使うため、Y方向の平行移動とY軸回転は可換であり、両者を同一ノードに同居させても
 * 互いに干渉しない。
 */
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import {
    computeDioramaRotationRadFromStick,
    computeDioramaHeightMetersFromTriggers,
    clampDioramaHeightOffsetM,
} from "./dioramaControllerMapping";

export interface DioramaOrientationController {
    /** 現在の回転角[rad]（読み取り専用スナップショット）。 */
    getRotationRad(): number;
    /** 現在の高さオフセット[m]（読み取り専用スナップショット）。 */
    getHeightOffsetM(): number;
    /**
     * 回転軸（右スティックX相当）・左右トリガー値（[0,1]、キーボード等価入力では
     * 0 または 1）を1フレーム分適用する。呼び出し元が毎フレーム呼ぶこと。
     */
    feedAxes(rotationAxisX: number, leftTriggerValue: number, rightTriggerValue: number, dtSeconds: number): void;
}

/**
 * `DioramaOrientationController` を生成する。
 *
 * @param orientationRoot 回転・高さオフセットの適用先ノード（冒頭のコメント参照。
 *   `dioramaTerrain.root` ではなく専用の中間ノードを渡すこと）。初期状態は
 *   `orientationRoot.rotation.y`/`orientationRoot.position.y` の現在値を引き継ぐ
 *   （通常は生成直後の 0 のままで問題ない）。
 */
export const createDioramaOrientationController = (orientationRoot: TransformNode): DioramaOrientationController => {
    let rotationRad = orientationRoot.rotation.y;
    let heightOffsetM = clampDioramaHeightOffsetM(orientationRoot.position.y);
    orientationRoot.position.y = heightOffsetM;

    return {
        getRotationRad: () => rotationRad,
        getHeightOffsetM: () => heightOffsetM,
        feedAxes: (
            rotationAxisX: number,
            leftTriggerValue: number,
            rightTriggerValue: number,
            dtSeconds: number,
        ): void => {
            if (!(dtSeconds > 0)) return;

            const deltaRad = computeDioramaRotationRadFromStick(rotationAxisX, dtSeconds);
            if (deltaRad !== 0) {
                rotationRad += deltaRad;
                orientationRoot.rotation.y = rotationRad;
            }

            const deltaM = computeDioramaHeightMetersFromTriggers(leftTriggerValue, rightTriggerValue, dtSeconds);
            if (deltaM !== 0) {
                heightOffsetM = clampDioramaHeightOffsetM(heightOffsetM + deltaM);
                orientationRoot.position.y = heightOffsetM;
            }
        },
    };
};
