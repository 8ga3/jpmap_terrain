/**
 * Havok 物理エンジン初期化ユーティリティ (Issue #259)
 *
 * Babylon.js v9 + @babylonjs/havok での物理エンジン初期化。
 */
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import "@babylonjs/core/Physics/v2/physicsEngineComponent";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import HavokPhysics from "@babylonjs/havok";

/**
 * デフォルメ重力 (Y 下向き)。
 * 大砲・砲弾を現実より大きいスケールで表示しているため、現実の 9.81 では
 * 放物線が間延びして気持ちよくない。射程が大砲間距離に合うよう強めに設定する。
 *
 * 射程調整メモ:
 * - g=-150 (初期値): Power=100% の射程約3398 → 大砲間距離(約1288)を大きくオーバーシュート
 * - g=-250: 射程約2040 → 若干強すぎて地形によっては届かない
 * - g=-180 (現値): g=-150 より少し強め。flat R = v²/|g| = 600²/180 ≈ 2000。
 *   Power=100% でギリギリ届く難易度に調整。
 */
export const DEMO_GRAVITY_Y = -180;

/**
 * Havok の最大線形速度。
 * Havok プラグインのデフォルト上限は小さく（約 200）、砲弾の初速（最大 600）が
 * 頭打ちされて射程が出なかった (#259)。大きいスケールに合わせて十分大きく設定する。
 */
export const MAX_LINEAR_VELOCITY = 5000;
/** Havok の最大角速度（砲弾の回転用、デフォルト同等で十分大きく） */
export const MAX_ANGULAR_VELOCITY = 1000;

/**
 * シーンに Havok 物理エンジンを有効化して返す。
 * @param gravityY 重力加速度の Y 成分（デフォルト: デフォルメ重力）
 */
export const initPhysics = async (
    scene: Scene,
    gravityY: number = DEMO_GRAVITY_Y,
): Promise<HavokPlugin> => {
    const havokInstance = await HavokPhysics();
    const plugin = new HavokPlugin(true, havokInstance);
    // 初速クランプを回避するため速度上限を引き上げる（デフォルトは砲弾初速より低い）
    plugin.setVelocityLimits(MAX_LINEAR_VELOCITY, MAX_ANGULAR_VELOCITY);
    scene.enablePhysics(new Vector3(0, gravityY, 0), plugin);
    return plugin;
};
