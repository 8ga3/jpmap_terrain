/**
 * diorama デモのコントローラー/タッチ入力を、地図移動（パン）・拡大縮小（ズーム）の
 * 移動量へ変換する純粋関数群。
 *
 * @remarks
 * DOM / Babylon.js Scene / WebXR に依存しないため vitest で単体テスト可能。実際の
 * 入力取得（XRコントローラーのthumbstick・画面タッチのGUI）とテレイン更新の呼び出しは
 * `dioramaArControls.ts` が担う。
 *
 * `feature/533-webxr-vr-viewer` の `webXrControllerMapping.ts`（immersive-vr PoC）と
 * 同じ設計方針（deadzone処理・現在値に比例したパン速度・乗算方式のズーム）を踏襲するが、
 * 本モジュールは実寸大の惑星ECEF座標系ではなく、箱庭の実世界フットプリント半径
 * （`footprintRadiusM`）を基準にする点が異なる。
 *
 * 操作割り当て（PR #549で確定した一覧、以降のコントローラー操作機能もこれに従う）:
 * - 左スティック / GUI仮想ジョイスティック: 地図中心の東西・南北移動（パン）
 * - 右スティックY（前後） / GUIズームボタン: フットプリント半径のズーム
 *   （前方向・GUIの「+」= ズームイン/縮小、後方向・GUIの「-」= ズームアウト/拡大）
 * - 右スティックX（左右）: 箱庭の回転（本モジュールで実装、{@link computeDioramaRotationRadFromStick}）
 * - トリガー（左右）: 箱庭の設置高さ変更（本モジュールで実装、{@link computeDioramaHeightMetersFromTriggers}）
 * - グリップ + 左スティック（モディファイア）: 太陽の方位角・高度（別途実装予定）
 * - A/Xボタン / GUIタイル切替ボタン: 地図タイル種別切替（本モジュールで実装、
 *   {@link nextDioramaTileMode}。std→photo→wireframeの順に巡回する）
 * - B/Yボタン / GUIリセットボタン: トップ（初期center/footprintRadius・回転・高さ）復帰
 *   （箱庭の表示状態を初期値へ戻す。ポータル画面への画面遷移ではない）
 */
import type { DioramaTileMode } from "../../terrain/diorama/dioramaTerrain";

/** スティック/ジョイスティック入力のデッドゾーン既定値。 */
export const DEFAULT_STICK_DEADZONE = 0.15;

/**
 * スティック入力のデッドゾーン処理。
 * `|value| <= deadzone` は 0 を返し、それ以外はデッドゾーン分を除いた [-1,1] へ再マップする
 * （デッドゾーン境界での急な入力開始を避け、滑らかに立ち上がるようにする）。
 *
 * @param deadzone [0,1) を想定。1 以上は常に 0（入力を全て無視）を返す。
 */
export const applyStickDeadzone = (value: number, deadzone: number): number => {
    if (!Number.isFinite(value) || !Number.isFinite(deadzone) || deadzone >= 1) return 0;
    const abs = Math.abs(value);
    if (abs <= deadzone) return 0;
    const sign = Math.sign(value);
    return sign * ((abs - deadzone) / (1 - deadzone));
};

/** スティック/ジョイスティックの2軸入力（[-1,1] 想定）。 */
export interface StickAxes {
    x: number;
    y: number;
}

/** {@link computeDioramaPanMetersFromStick} のオプション。 */
export interface PanFromStickOptions {
    deadzone?: number;
    minFootprintRadiusForSpeedM?: number;
}

/** パン速度計算でフットプリント半径が極端に小さい場合の下限[m]（操作不能なほど遅くならないようにする）。 */
export const DEFAULT_MIN_FOOTPRINT_RADIUS_FOR_PAN_SPEED_M = 20;

/** 1秒間フルでスティックを倒し続けたときのパン速度（footprintRadiusMに対する倍率/秒）の既定値。 */
export const DEFAULT_PAN_SPEED_PER_SEC = 0.6;

/**
 * スティック入力から、1フレーム分のパン移動量[m]（東西・南北）を算出する。
 *
 * 速度は現在の `footprintRadiusM` に比例させる（ズームアウトして広域表示している時は
 * 速く、ズームインして詳細表示している時はゆっくり動く。VR PoCの「高度に比例した
 * パン速度」と同じ考え方）。
 *
 * @param footprintRadiusM 現在のフットプリント半径[m]。
 * @param basePanSpeedPerSec footprintRadiusMに対する秒間倍率（フルスティック時、
 *   `footprintRadiusM * basePanSpeedPerSec` が秒速[m/s]になる）。
 * @returns 東西(east)・南北(north)方向の移動量[m]。正のeastは東へ、正のnorthは北へ。
 */
export const computeDioramaPanMetersFromStick = (
    axes: StickAxes,
    dtSeconds: number,
    footprintRadiusM: number,
    basePanSpeedPerSec: number = DEFAULT_PAN_SPEED_PER_SEC,
    options: PanFromStickOptions = {},
): { eastM: number; northM: number } => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { eastM: 0, northM: 0 };
    const deadzone = options.deadzone ?? DEFAULT_STICK_DEADZONE;
    const minRadiusM = options.minFootprintRadiusForSpeedM ?? DEFAULT_MIN_FOOTPRINT_RADIUS_FOR_PAN_SPEED_M;
    const x = applyStickDeadzone(axes.x, deadzone);
    const y = applyStickDeadzone(axes.y, deadzone);
    if (x === 0 && y === 0) return { eastM: 0, northM: 0 };
    const effectiveRadiusM = Number.isFinite(footprintRadiusM) ? Math.max(footprintRadiusM, minRadiusM) : minRadiusM;
    const speed = basePanSpeedPerSec * effectiveRadiusM;
    return {
        eastM: x * speed * dtSeconds,
        // Gamepad規約: y軸は前方向（奥へ倒す）が負値。前進 = 北 とするため符号を反転する。
        northM: -y * speed * dtSeconds,
    };
};

/** フットプリント半径ズームの秒間倍率既定値（1秒間フルで倒すと半径が概ね1/2倍/2倍になる）。 */
export const DEFAULT_FOOTPRINT_ZOOM_RATE_PER_SEC = 2;

/**
 * フットプリント半径の下限・上限既定値[m]。
 *
 * 上限は、日本全体（北海道〜沖縄、概ね南北2500km程度）がズームアウトで見渡せる
 * ことを目安に設定する（2000kmあれば、既定中心（富士山付近）から沖縄・北海道
 * いずれの端までも十分カバーできる）。DEM/テクスチャの取得ズームレベルは
 * 固定ではなく `footprintRadiusM` に応じて自動的に粗くなる
 * （`dioramaTerrain.ts` の `computeAutoZoomLevel` 参照）ため、上限を広げても
 * 取得タイル数が際限なく増えて重くなることはない。
 */
export const DEFAULT_FOOTPRINT_RADIUS_MIN_M = 100;
export const DEFAULT_FOOTPRINT_RADIUS_MAX_M = 2_000_000;

/**
 * 右スティックY軸（またはGUIズームボタン相当の軸値）から、1フレーム分の
 * フットプリント半径への乗算係数を算出する（乗算方式）。
 *
 * 前に倒す（y<0）ほど半径が縮む（ズームイン、より詳細な狭い範囲を表示）。
 *
 * @param zoomRatePerSecond 1秒間フルで倒し続けたときの倍率（>1 を想定）。
 * @returns フットプリント半径に乗算する係数（入力なしや不正な dt なら 1 = 変化なし）。
 */
export const computeFootprintRadiusFactorFromStick = (
    axisY: number,
    dtSeconds: number,
    zoomRatePerSecond: number = DEFAULT_FOOTPRINT_ZOOM_RATE_PER_SEC,
    deadzone: number = DEFAULT_STICK_DEADZONE,
): number => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 1;
    if (!Number.isFinite(zoomRatePerSecond) || zoomRatePerSecond <= 0) return 1;
    const y = applyStickDeadzone(axisY, deadzone);
    if (y === 0) return 1;
    return Math.pow(zoomRatePerSecond, y * dtSeconds);
};

/**
 * フットプリント半径を [minM, maxM] へクランプする。
 * `NaN` のみ `minM` へフォールバックしてからクランプする（`Math.min`/`Math.max` は
 * `NaN` を伝播させてしまうため）。`Infinity`/`-Infinity` は通常の `Math.min`/`Math.max`
 * でそれぞれ `maxM`/`minM` に正しくクランプされるため特別扱いしない。
 */
export const clampFootprintRadiusM = (
    radiusM: number,
    minM: number = DEFAULT_FOOTPRINT_RADIUS_MIN_M,
    maxM: number = DEFAULT_FOOTPRINT_RADIUS_MAX_M,
): number => {
    const safe = Number.isNaN(radiusM) ? minM : radiusM;
    return Math.min(maxM, Math.max(minM, safe));
};

/** 箱庭回転操作の秒間最大角速度[rad/s]（フルスティック時）の既定値。 */
export const DEFAULT_ROTATION_SPEED_RAD_PER_SEC = Math.PI / 2; // 90°/秒

/**
 * 右スティックX軸（またはキーボード等価入力の軸値）から、1フレーム分の箱庭回転角[rad]を
 * 算出する（累積方式。呼び出し元が現在の回転角へ加算して使う）。
 *
 * 正の入力（右へ倒す）で正方向（Babylonの左手系Y軸回転規約に従う）へ回転する。
 * 回転には上限・下限（クランプ）を設けない（自由に周回できる）。
 *
 * @param axisX スティックのX軸入力（[-1,1] 想定）。
 */
export const computeDioramaRotationRadFromStick = (
    axisX: number,
    dtSeconds: number,
    rotationSpeedRadPerSec: number = DEFAULT_ROTATION_SPEED_RAD_PER_SEC,
    deadzone: number = DEFAULT_STICK_DEADZONE,
): number => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0;
    if (!Number.isFinite(rotationSpeedRadPerSec)) return 0;
    const x = applyStickDeadzone(axisX, deadzone);
    if (x === 0) return 0;
    return x * rotationSpeedRadPerSec * dtSeconds;
};

/** 箱庭の高さ変更操作の秒間最大速度[m/s]（フルトリガー押下時）の既定値。 */
export const DEFAULT_HEIGHT_SPEED_M_PER_SEC = 0.15;

/**
 * 左右トリガー押下量（各 [0,1]、コントローラー無し環境ではキーボード等価入力として
 * 0 または 1 を渡す）から、1フレーム分の箱庭高さ変更量[m]を算出する（累積方式）。
 *
 * 右トリガー = 上げる（+）、左トリガー = 下げる（-）。両方同時に押されている場合は
 * 差分（right - left）を使う。
 *
 * @param leftTriggerValue 左トリガー押下量 [0,1]。範囲外の値（例: -1, 1.5）は [0,1] へ
 *   クランプし、非有限値（`NaN`/`Infinity`等）は 0 として扱う。
 * @param rightTriggerValue 右トリガー押下量 [0,1]（同上）。
 */
export const computeDioramaHeightMetersFromTriggers = (
    leftTriggerValue: number,
    rightTriggerValue: number,
    dtSeconds: number,
    heightSpeedMPerSec: number = DEFAULT_HEIGHT_SPEED_M_PER_SEC,
): number => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0;
    if (!Number.isFinite(heightSpeedMPerSec)) return 0;
    const left = Number.isFinite(leftTriggerValue) ? Math.max(0, Math.min(1, leftTriggerValue)) : 0;
    const right = Number.isFinite(rightTriggerValue) ? Math.max(0, Math.min(1, rightTriggerValue)) : 0;
    const axis = right - left;
    if (axis === 0) return 0;
    return axis * heightSpeedMPerSec * dtSeconds;
};

/**
 * 箱庭の高さオフセット可動域既定値[m]（既定卓上表示半径 tableRadiusM=0.35m を踏まえた
 * 目安。上下に概ね半径分程度動かせれば十分で、動かしすぎるとカメラの注視点
 * （常に世界原点、`index.ts` の `ArcRotateCamera` target）から外れて見づらくなる）。
 */
export const DEFAULT_HEIGHT_OFFSET_MIN_M = -0.3;
export const DEFAULT_HEIGHT_OFFSET_MAX_M = 0.3;

/**
 * 箱庭の高さオフセットを [minM, maxM] へクランプする。
 * `NaN` は 0（オフセット無し）へフォールバックしてからクランプする
 * （`clampFootprintRadiusM` と同じ方針）。
 */
export const clampDioramaHeightOffsetM = (
    offsetM: number,
    minM: number = DEFAULT_HEIGHT_OFFSET_MIN_M,
    maxM: number = DEFAULT_HEIGHT_OFFSET_MAX_M,
): number => {
    const safe = Number.isNaN(offsetM) ? 0 : offsetM;
    return Math.min(maxM, Math.max(minM, safe));
};

/**
 * タイル種別の巡回順序（A/Xボタン・GUIタイル切替ボタン共通）。
 * `DioramaTileMode`（`dioramaTerrain.ts`、型のみimport）を直接使うことで、
 * 巡回対象の値集合を型定義側と同期させる。
 */
export const DIORAMA_TILE_MODE_CYCLE_ORDER: readonly DioramaTileMode[] = ["std", "photo", "wireframe"];

/**
 * 現在のタイル種別から、巡回順序（{@link DIORAMA_TILE_MODE_CYCLE_ORDER}）における
 * 次のタイル種別を返す純粋関数。末尾（wireframe）の次は先頭（std）へ戻る。
 *
 * @param current 現在のタイル種別。巡回順序に含まれない値が渡された場合
 *   （型システム上は起こり得ないが、念のため）は先頭（std）を返す。
 */
export const nextDioramaTileMode = (current: DioramaTileMode): DioramaTileMode => {
    const currentIndex = DIORAMA_TILE_MODE_CYCLE_ORDER.indexOf(current);
    if (currentIndex < 0) return DIORAMA_TILE_MODE_CYCLE_ORDER[0];
    return DIORAMA_TILE_MODE_CYCLE_ORDER[(currentIndex + 1) % DIORAMA_TILE_MODE_CYCLE_ORDER.length];
};
