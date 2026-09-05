/**
 * artillery のステージ座標フレーム
 *
 * globe（ECEF + floating origin）上でステージ物理を成立させるための薄い抽象。
 *
 * `stageRoot`（ENU→ECEF の world 変換を固定した TransformNode）を作り、
 * ステージの全メッシュをその子として配置する。子はローカル座標（= ENU:
 * X=East, Y=Up, Z=North）で扱えるため、既存の配置/発射/命中ロジックを
 * ほぼ無改変で流用できる。描画は floating origin が ECEF を正しく扱い、Havok は
 * `scene.floatingOriginMode` の region 機能でステージ ECEF 近傍を float32 安全に解く。
 *
 * ステージのローカル軸割り当て（X=East, Y=Up, Z=North）は East×Up = -North、すなわち
 * X×Y = -Z となる左手順序のため、ENU 基底 [east, up, north] を列に並べた行列の
 * 行列式は -1（鏡映）になりうる（globe シーンは `useRightHandedSystem=true` の右手系
 * だが、det=-1 はこの軸割り当て自体に起因し、シーンの左右手系とは独立）。
 * そのため `freezeWorldMatrix` で world 変換を直接固定する（decompose を避ける）。
 * この鏡映（det=-1）により stageRoot 配下の可視メッシュ（大砲）は winding が
 * 反転しうるが、実 GPU での目視確認では大砲の見えに問題はなく（砲弾は球で不変、
 * 地形タイルは stageRoot 配下ではない）、物理は projectile / collider が同一の
 * 鏡映ワールドを共有して自己整合するため、描画側の面反転補正は不要と判断した。
 */

import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import { buildEnuFrame, buildEnuWorldMatrix } from "../../terrain/geo/enu";
import { DEMO_GRAVITY_Y } from "./physics";

export interface StageOrigin {
    lat: number;
    lon: number;
    alt?: number;
}

export interface StageFrame {
    /** ENU→ECEF の stageRoot。 */
    readonly root: TransformNode;
    /** Havok へ渡すワールド重力ベクトル。 */
    readonly gravity: Vector3;
    /** 生成したステージノードをフレームへ取り込む（stageRoot へ parent）。 */
    attach(node: TransformNode): void;
    /** ステージローカル座標（= ENU）→ ワールド。 */
    localToWorld(local: Vector3, ref: Vector3): Vector3;
    /** ワールド → ステージローカル座標。 */
    worldToLocal(world: Vector3, ref: Vector3): Vector3;
    /** ワールド方向ベクトル → ステージローカル方向。 */
    worldDirToLocal(dir: Vector3, ref: Vector3): Vector3;
    /** ステージローカルの「下」方向（重力方向）をワールドで返す単位ベクトル。 */
    readonly downWorld: Vector3;
}

/**
 * ステージフレームを構築する。
 * @param scene  ステージを配置するシーン。
 * @param origin ENU 原点（測地座標）。
 */
export const createStageFrame = (
    scene: Scene,
    origin: StageOrigin,
): StageFrame => {
    const frame = buildEnuFrame(origin.lat, origin.lon, origin.alt ?? 0);
    const world = buildEnuWorldMatrix(frame);
    const inv = Matrix.Invert(world);

    const root = new TransformNode("artillery-stage-root", scene);
    // 左手系で det=-1 になりうるため decompose を避け world を直接固定する。
    root.freezeWorldMatrix(world);

    // 重力: ステージローカルの -Y(= -Up)。Havok はワールド重力で解くため up*(-|g|)。
    const gravity = frame.up.scale(DEMO_GRAVITY_Y);
    const downWorld = frame.up.scale(-1);

    return {
        root,
        gravity,
        attach: (node: TransformNode): void => {
            node.parent = root;
        },
        localToWorld: (local: Vector3, ref: Vector3): Vector3 =>
            Vector3.TransformCoordinatesToRef(local, world, ref),
        worldToLocal: (w: Vector3, ref: Vector3): Vector3 =>
            Vector3.TransformCoordinatesToRef(w, inv, ref),
        worldDirToLocal: (dir: Vector3, ref: Vector3): Vector3 =>
            Vector3.TransformNormalToRef(dir, inv, ref),
        downWorld,
    };
};
