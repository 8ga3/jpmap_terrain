/**
 * アバターコントローラ用 純粋ヘルパ (Issue #270)
 *
 * キーボード / Gamepad / Virtual Joystick の各入力を共通の正規化ベクトル
 * (east = vx, north = vy, |v| <= 1) に変換し、移動後の緯度経度と進行方向の
 * 方位角を計算する純粋関数群。
 *
 * 座標系・規約:
 * - 入力ベクトル: 平面ローカル (East, North)、-1..1 の単位ベクトル想定。
 * - `movementHeading` が返す方位角: 北 = 0°、時計回り (CW) に増加（Babylon の Y 軸回転角と一致）。
 * - `rotateByAzimuth` が受け取る `azimuthDeg`: 本プロジェクトのカメラ方位規約に従い、
 *   北 = 0°・反時計回り (CCW) 正方向（ArcRotateCamera の alpha 由来）。
 */

/** WGS84 平均半径 (m)。`orbit.ts` と同値。 */
const EARTH_RADIUS_M = 6_371_008.8;

/** ジョイスティック等のデッドゾーン。入力ノイズを切り捨てる。 */
export const INPUT_DEADZONE = 0.1;

/** 2D ベクトル (east, north)。各成分は -1..1（合成後のみ |v|<=1）。 */
export interface MoveVector {
    /** 東方向成分 */
    vx: number;
    /** 北方向成分 */
    vy: number;
}

/** キーボード押下状態 (`KeyboardEvent.code` のセット) から (east, north) 方向の入力ベクトルを得る。 */
export const keyboardVector = (keys: ReadonlySet<string>): MoveVector => {
    const up = keys.has("ArrowUp") || keys.has("KeyW");
    const down = keys.has("ArrowDown") || keys.has("KeyS");
    const left = keys.has("ArrowLeft") || keys.has("KeyA");
    const right = keys.has("ArrowRight") || keys.has("KeyD");

    const vy = (up ? 1 : 0) + (down ? -1 : 0);
    const vx = (right ? 1 : 0) + (left ? -1 : 0);
    return { vx, vy };
};

/**
 * 入力ベクトルにデッドゾーンを適用する。
 * 大きさが `deadzone` 未満なら 0、それ以上なら `(|v| - deadzone)/(1 - deadzone)` で再スケール。
 */
export const applyDeadzone = (
    v: MoveVector,
    deadzone: number = INPUT_DEADZONE,
): MoveVector => {
    const mag = Math.hypot(v.vx, v.vy);
    if (mag < deadzone) return { vx: 0, vy: 0 };
    const scale = (mag - deadzone) / (1 - deadzone) / mag;
    return { vx: v.vx * scale, vy: v.vy * scale };
};

/**
 * 複数の入力ベクトルから「最も大きい」ものを採用する。
 * いずれもデッドゾーン未満なら (0,0) を返す。
 * 同時操作時の合成によるブースト発生を避ける。
 */
export const combineInputs = (
    inputs: readonly MoveVector[],
    deadzone: number = INPUT_DEADZONE,
): MoveVector => {
    let best: MoveVector = { vx: 0, vy: 0 };
    let bestMag = 0;
    for (const raw of inputs) {
        const v = applyDeadzone(raw, deadzone);
        const m = Math.hypot(v.vx, v.vy);
        if (m > bestMag) {
            bestMag = m;
            best = v;
        }
    }
    if (bestMag === 0) return { vx: 0, vy: 0 };
    if (bestMag > 1) {
        return { vx: best.vx / bestMag, vy: best.vy / bestMag };
    }
    return best;
};

/** 入力ベクトルの大きさ。 */
export const moveVectorMagnitude = (v: MoveVector): number =>
    Math.hypot(v.vx, v.vy);

/**
 * 平面上の入力ベクトル (east, north) で速度 `speedMps` (m/s) を `dtSec` 秒間
 * 適用したときの新しい緯度経度を返す。球面近似。
 */
export const stepPosition = (
    lat: number,
    lon: number,
    v: MoveVector,
    speedMps: number,
    dtSec: number,
): { lat: number; lon: number } => {
    if (dtSec <= 0 || speedMps <= 0) return { lat, lon };
    const dxM = v.vx * speedMps * dtSec;
    const dyM = v.vy * speedMps * dtSec;
    const dLat = dyM / ((Math.PI / 180) * EARTH_RADIUS_M);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const dLon =
        cosLat !== 0 ? dxM / ((Math.PI / 180) * EARTH_RADIUS_M * cosLat) : 0;
    return { lat: lat + dLat, lon: lon + dLon };
};

/**
 * 入力ベクトルを画面（カメラ）方位角に従って回転し、ワールド (east, north) に変換する。
 *
 * `azimuthDeg` は本プロジェクト規約のカメラ方位（北=0°・反時計回り正、
 * ArcRotateCamera の alpha 由来）。画面の「右=+x / 上=+y」入力をワールドの
 * (east, north) に揃えるため、内部では `-azimuthDeg` で回転する。
 */
export const rotateByAzimuth = (
    v: MoveVector,
    azimuthDeg: number,
): MoveVector => {
    const rad = (-azimuthDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return {
        vx: v.vx * c + v.vy * s,
        vy: -v.vx * s + v.vy * c,
    };
};

/**
 * 入力ベクトルから進行方向の方位角（北=0°, 時計回り, 度）を返す。
 * ベクトルが (0,0) のときは `null`（向きを更新しない目印）を返す。
 */
export const movementHeading = (v: MoveVector): number | null => {
    if (v.vx === 0 && v.vy === 0) return null;
    const rad = Math.atan2(v.vx, v.vy);
    const deg = (rad * 180) / Math.PI;
    return ((deg % 360) + 360) % 360;
};
