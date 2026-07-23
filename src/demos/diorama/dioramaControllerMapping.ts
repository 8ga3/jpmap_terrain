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
 * 本モジュールは実寸大の惑星ECEF座標系ではなく、箱庭の実世界フットプリントの半辺長
 * （`footprintHalfSizeM`）を基準にする点が異なる。
 *
 * 操作割り当て（PR #549で確定した一覧、以降のコントローラー操作機能もこれに従う）:
 * - 左スティック / GUI仮想ジョイスティック: 地図中心の東西・南北移動（パン）
 * - 右スティックY（前後） / GUIズームボタン: フットプリントの半辺長のズーム
 *   （前方向・GUIの「+」= ズームイン/縮小、後方向・GUIの「-」= ズームアウト/拡大）
 * - 右スティックX（左右）: 箱庭の回転（本モジュールで実装、{@link computeDioramaRotationRadFromStick}）
 *
 * **右スティックは十字ボタン相当の排他動作**: 物理コントローラーの右スティックは
 * X（回転）・Y（ズーム）を同時に検知しうるが、上下・左右いずれか一方だけを
 * 操作するつもりでもわずかに斜めへずれやすく、意図しない同時発火（下へ倒して
 * ズームしているつもりが、わずかな左右のずれで回転も発火する等）が起きやすい。
 * そのため物理スティックの生入力（`dioramaArControls.ts`の`sticks.right`）へは
 * 個別デッドゾーン処理の前段で{@link applyDPadGate}を適用し、支配的な軸のみを
 * 有効にする（十字ボタンと同じ「一方向のみ」の挙動。速度自体はアナログのまま）。
 * GUIのズーム/回転ボタン（`dioramaArControlHud.ts`）はもともと個別のボタンで
 * 排他的なため、本ゲート処理の対象外（適用不要）。
 * - トリガー（左右）: 箱庭の設置高さ変更（本モジュールで実装、{@link computeDioramaHeightMetersFromTriggers}）
 * - グリップ + 左スティック（モディファイア）: 太陽の方位角・高度（別途実装予定）
 * - A/Xボタン / GUIタイル切替ボタン: 地図タイル種別切替（本モジュールで実装、
 *   {@link nextDioramaTileMode}。std→photo→wireframeの順に巡回する）
 * - B/Yボタン / GUIのARを終了するボタン: ARモードを終了し通常表示へ戻る
 *   （`dioramaArControls.ts`が`xr.baseExperience.exitXRAsync()`を直接呼ぶ。
 *   AR中でなければ意味を持たない操作のため、常時表示のタッチHUD側では
 *   このボタンをグレーアウトして無効化する。箱庭の表示状態
 *   （center/footprintHalfSizeM/回転/高さ）はリセットしない）
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

/**
 * 2軸スティック入力を「十字ボタン（十字キー）的な排他動作」へ整形する。
 *
 * @remarks
 * 右スティック（X軸=箱庭回転、Y軸=ズーム、`dioramaArControls.ts`参照）は、
 * 本来は単純な十字ボタンの代替として上下・左右のいずれか一方だけを
 * 操作するつもりで倒しても、物理スティックの構造上わずかに斜めに
 * ずれてしまいやすい。X/Yを完全に独立してデッドゾーン処理すると、
 * 「下へ倒してズームしているつもりが、わずかな左右のずれで同時に
 * 回転も発火してしまう」という誤操作が起きる。
 *
 * 本関数は、X/Yのうち絶対値が大きい方（支配的な軸）のみ元の値を残し、
 * もう一方を強制的に `0` にすることで、常にどちらか一方の軸のみが
 * 有効になる十字ボタン相当の入力へ変換する。速度自体は従来通り
 * アナログ（倒し具合に比例）のまま、同時発火のみを防ぐ。
 *
 * 呼び出し側で各軸のデッドゾーン処理（{@link applyStickDeadzone}を
 * 内部で使う {@link computeDioramaRotationRadFromStick}/
 * {@link computeFootprintHalfSizeFactorFromStick}）を行う前段として使うこと。
 *
 * @param x スティックのX軸入力（[-1,1] 想定）。
 * @param y スティックのY軸入力（[-1,1] 想定）。
 * @returns `|x| >= |y|` ならXのみ残し `y:0`、そうでなければYのみ残し `x:0`。
 *   非有限値（`NaN`/`Infinity`等）は `0` として扱う。
 */
export const applyDPadGate = (x: number, y: number): StickAxes => {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    if (Math.abs(safeX) >= Math.abs(safeY)) return { x: safeX, y: 0 };
    return { x: 0, y: safeY };
};

/** {@link computeDioramaPanMetersFromStick} のオプション。 */
export interface PanFromStickOptions {
    deadzone?: number;
    minFootprintHalfSizeForSpeedM?: number;
}

/** パン速度計算でフットプリントの半辺長が極端に小さい場合の下限[m]（操作不能なほど遅くならないようにする）。 */
export const DEFAULT_MIN_FOOTPRINT_HALF_SIZE_FOR_PAN_SPEED_M = 20;

/** 1秒間フルでスティックを倒し続けたときのパン速度（footprintHalfSizeMに対する倍率/秒）の既定値。 */
export const DEFAULT_PAN_SPEED_PER_SEC = 0.6;

/**
 * スティック入力から、1フレーム分のパン移動量[m]（東西・南北）を算出する。
 *
 * 速度は現在の `footprintHalfSizeM` に比例させる（ズームアウトして広域表示している時は
 * 速く、ズームインして詳細表示している時はゆっくり動く。VR PoCの「高度に比例した
 * パン速度」と同じ考え方）。
 *
 * @param footprintHalfSizeM 現在のフットプリントの半辺長[m]。
 * @param basePanSpeedPerSec footprintHalfSizeMに対する秒間倍率（フルスティック時、
 *   `footprintHalfSizeM * basePanSpeedPerSec` が秒速[m/s]になる）。
 * @returns 東西(east)・南北(north)方向の移動量[m]。正のeastは東へ、正のnorthは北へ。
 */
export const computeDioramaPanMetersFromStick = (
    axes: StickAxes,
    dtSeconds: number,
    footprintHalfSizeM: number,
    basePanSpeedPerSec: number = DEFAULT_PAN_SPEED_PER_SEC,
    options: PanFromStickOptions = {},
): { eastM: number; northM: number } => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { eastM: 0, northM: 0 };
    const deadzone = options.deadzone ?? DEFAULT_STICK_DEADZONE;
    const minHalfSizeM = options.minFootprintHalfSizeForSpeedM ?? DEFAULT_MIN_FOOTPRINT_HALF_SIZE_FOR_PAN_SPEED_M;
    const x = applyStickDeadzone(axes.x, deadzone);
    const y = applyStickDeadzone(axes.y, deadzone);
    if (x === 0 && y === 0) return { eastM: 0, northM: 0 };
    const effectiveHalfSizeM = Number.isFinite(footprintHalfSizeM) ? Math.max(footprintHalfSizeM, minHalfSizeM) : minHalfSizeM;
    const speed = basePanSpeedPerSec * effectiveHalfSizeM;
    return {
        eastM: x * speed * dtSeconds,
        // Gamepad規約: y軸は前方向（奥へ倒す）が負値。前進 = 北 とするため符号を反転する。
        northM: -y * speed * dtSeconds,
    };
};

/**
 * 水平面（XZ平面、東西・南北に相当）の単位ベクトル。`y`成分は扱わない
 * （呼び出し側で「カメラの水平forward/right」等をXZ平面へ投影済みの値を渡すこと）。
 */
export interface HorizontalUnitVector {
    x: number;
    z: number;
}

/**
 * 水平単位ベクトルから向き角[rad]を算出する（`atan2(x, z)`）。
 *
 * 本モジュール内の角度は全てこの規約（`z`軸=北=0rad、`x`軸=東=+π/2rad、
 * 時計回りが正方向）に統一する。Babylonの左手系Y軸回転規約（`rotation.y`が
 * 正方向で+Z軸から+X軸へ回転する）と一致するよう選んでいるため、
 * {@link computeDioramaRotationRadFromStick} が加算する回転角とも整合する。
 *
 * @returns ベクトルが零ベクトル、または非有限値を含む場合は `0`。
 */
export const computeHeadingRadFromHorizontal = (x: number, z: number): number => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    if (x === 0 && z === 0) return 0;
    return Math.atan2(x, z);
};

/**
 * 水平単位ベクトルを `deltaRad` だけ回転させる。
 *
 * {@link computeHeadingRadFromHorizontal} と同じ`atan2(x, z)`規約に基づいて
 * 自己完結的に導出した回転式を使う（Babylonの`Matrix.RotationY`等、外部の
 * 回転規約には依存しない）。`vec` の向き角を `h` とすると、返り値は
 * 向き角 `h + deltaRad` で同じ長さのベクトルになる。
 */
export const rotateHorizontalUnitVector = (vec: HorizontalUnitVector, deltaRad: number): HorizontalUnitVector => {
    if (!Number.isFinite(deltaRad) || deltaRad === 0) return { x: vec.x, z: vec.z };
    const cos = Math.cos(deltaRad);
    const sin = Math.sin(deltaRad);
    return {
        x: vec.x * cos + vec.z * sin,
        z: vec.z * cos - vec.x * sin,
    };
};

/**
 * 前後・左右の方向入力（各[-1,1]、斜め入力は合成後に1へ正規化）を、現在の
 * 前方向・右方向の水平単位ベクトルへ投影し、{@link computeDioramaPanMetersFromStick}
 * にそのまま渡せる `StickAxes`（x=東、y軸は前方向が負値というGamepad規約）へ
 * 変換する。
 *
 * `forwardUnit`/`rightUnit`（現在の「前方向」を表す水平単位ベクトル）の算出方法は
 * 呼び出し元ごとに異なる（本関数はその結果を入力へ投影するだけで関知しない）。
 * - `dioramaKeyboardControls.ts`: `ArcRotateCamera`の向き基準（WASD）。
 * - `dioramaTouchControls.ts`: 同じくカメラの向き基準（常時表示タッチHUD）。
 * - `dioramaArControls.ts`: AR中は「ユーザー（実機カメラ）位置↔箱庭中心」の
 *   水平方向を箱庭の回転角で補正した向き基準（カメラの視線方向ではない。
 *   `computeHorizontalDisplacement`/`rotateHorizontalUnitVector` 参照）。
 *
 * @param forwardAxis 前方向入力（前進が正）。
 * @param rightAxis 右方向入力（右が正）。
 * @param forwardUnit 現在の前方向の水平単位ベクトル。
 * @param rightUnit 現在の右方向の水平単位ベクトル（`forwardUnit`と直交する単位ベクトル）。
 */
export const computePanAxesFromDirectionalInput = (
    forwardAxis: number,
    rightAxis: number,
    forwardUnit: HorizontalUnitVector,
    rightUnit: HorizontalUnitVector,
): StickAxes => {
    if (forwardAxis === 0 && rightAxis === 0) return { x: 0, y: 0 };
    let eastUnit = forwardAxis * forwardUnit.x + rightAxis * rightUnit.x;
    let northUnit = forwardAxis * forwardUnit.z + rightAxis * rightUnit.z;
    // 斜め入力（例: 前進+右同時）が軸沿い入力よりも速くならないよう、大きさが1を
    // 超える場合は単位ベクトルへ正規化する（スティックの最大偏倚量が半径1の円に
    // 収まる規約と揃える）。
    const magnitude = Math.hypot(eastUnit, northUnit);
    if (magnitude > 1) {
        eastUnit /= magnitude;
        northUnit /= magnitude;
    }
    // `computeDioramaPanMetersFromStick` の規約（y軸は前方向が負値）に合わせて
    // 符号反転する。`northUnit`が`0`のとき`-northUnit`が`-0`になるのを避けるため`+0`する。
    return { x: eastUnit, y: -northUnit + 0 };
};

/** 向きスナップのステップ角既定値（45° = 8方位）。 */
export const DEFAULT_HEADING_SNAP_STEP_RAD = Math.PI / 4;
/** 向きスナップのヒステリシス角既定値（境界付近での揺らぎによる頻繁な切り替わりを防ぐ）。 */
export const DEFAULT_HEADING_SNAP_HYSTERESIS_RAD = Math.PI / 36; // 5°

const TWO_PI = Math.PI * 2;

/** 任意の角度[rad]を `(-π, π]` へ正規化する。 */
export const normalizeAngleRad = (angleRad: number): number => {
    let normalized = angleRad % TWO_PI;
    if (normalized > Math.PI) normalized -= TWO_PI;
    if (normalized <= -Math.PI) normalized += TWO_PI;
    return normalized;
};

/**
 * `a` から `b` への最短の符号付き角度差（`(-π, π]`）。
 *
 * 単純な引き算（`b - a`）だと、±π境界を跨ぐ場合に差分がほぼ`±2π`（実際の
 * 最短差はほぼ0）になり得る。`Math.sin`/`Math.cos`へ渡す前提の値
 * （{@link rotateHorizontalUnitVector}等）では、引数が大きくなるほど
 * 浮動小数点の相対誤差が増え、安定化のための丸め処理が意図通りに働かなく
 * なるおそれがあるため、`(-π, π]`へ正規化した最短差分を返す。
 */
export const angleDeltaRad = (a: number, b: number): number => normalizeAngleRad(b - a);

/**
 * ヒステリシス付きで向き角を離散方位（既定8方位）へスナップする。
 *
 * 頭部トラッキング/デバイス姿勢はユーザーの体の揺れ等で常に微小に変動するため、
 * 生の向き角をそのままパン方向へ使うと、静止しているつもりでもパン方向が
 * 小刻みに変わってしまう。本関数は以下の2段階で安定化する。
 *
 * 1. 最も近い `stepRad` の倍数（既定45°刻み＝8方位）へ丸める。
 * 2. 前回のスナップ結果からの角度差が `stepRad/2 + hysteresisRad` 以内であれば、
 *    前回値を維持する（境界ぎりぎりでの往復による頻繁な切り替わりを防ぐ）。
 *
 * @param rawHeadingRad 生の向き角[rad]（{@link computeHeadingRadFromHorizontal}の出力）。
 * @param previousSnappedHeadingRad 前回のスナップ結果[rad]。初回呼び出し等で
 *   スナップ結果が無い場合は `undefined` を渡す（この場合ヒステリシス無しで
 *   最も近い方位へスナップする）。
 * @returns スナップ後の向き角[rad]（`(-π, π]`に正規化済み）。
 */
export const snapHeadingRad = (
    rawHeadingRad: number,
    previousSnappedHeadingRad: number | undefined,
    stepRad: number = DEFAULT_HEADING_SNAP_STEP_RAD,
    hysteresisRad: number = DEFAULT_HEADING_SNAP_HYSTERESIS_RAD,
): number => {
    if (!Number.isFinite(rawHeadingRad) || !(stepRad > 0)) {
        return previousSnappedHeadingRad !== undefined && Number.isFinite(previousSnappedHeadingRad)
            ? previousSnappedHeadingRad
            : 0;
    }
    const raw = normalizeAngleRad(rawHeadingRad);
    const nearestBucketRad = normalizeAngleRad(Math.round(raw / stepRad) * stepRad);
    if (previousSnappedHeadingRad === undefined || !Number.isFinite(previousSnappedHeadingRad)) {
        return nearestBucketRad;
    }
    const previous = normalizeAngleRad(previousSnappedHeadingRad);
    const diffFromPreviousRad = Math.abs(angleDeltaRad(previous, raw));
    const safeHysteresisRad = Number.isFinite(hysteresisRad) ? Math.max(0, hysteresisRad) : 0;
    if (diffFromPreviousRad <= stepRad / 2 + safeHysteresisRad) {
        return previous;
    }
    return nearestBucketRad;
};

/**
 * 水平面上の2点間（`from` から `to` への方向）の変位を、単位ベクトルと距離[m]に
 * 分解する。AR中の「ユーザー（実機カメラ）から箱庭中心への向き」算出に使う
 * （{@link module:src/demos/diorama/dioramaArControls.ts} 参照）。
 *
 * @returns 2点が同一（距離0）、または非有限値を含む場合は `unit: {x:0,z:0}`、
 *   `distanceM` は有限値なら実際の距離（0）、非有限なら `0` にフォールバックする。
 */
export const computeHorizontalDisplacement = (
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
): { unit: HorizontalUnitVector; distanceM: number } => {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    if (![dx, dz].every(Number.isFinite)) return { unit: { x: 0, z: 0 }, distanceM: 0 };
    const distanceM = Math.hypot(dx, dz);
    if (!(distanceM > 0)) return { unit: { x: 0, z: 0 }, distanceM: 0 };
    return { unit: { x: dx / distanceM, z: dz / distanceM }, distanceM };
};

/**
 * デッドゾーン境界のヒステリシス幅既定値[m]。デッドゾーン境界付近で
 * ユーザーの立ち位置が微小に揺らいでも、パン有効/無効が頻繁に切り替わらない
 * ようにする（{@link snapHeadingRad}のヒステリシスと同じ考え方）。
 */
export const DEFAULT_DEAD_ZONE_HYSTERESIS_M = 0.05;

/**
 * ユーザー（実機カメラ）が箱庭に重なるように立っている（デッドゾーン内）かどうかを、
 * ヒステリシス付きで判定する。
 *
 * @remarks
 * 箱庭のすぐ近く・真上にユーザーが立つと、「ユーザーから箱庭中心への向き」
 * （{@link computeHorizontalDisplacement}）が不安定になる（距離が0に近づくほど
 * わずかな立ち位置のずれで向きが大きく変わる）。この状態でパン方向を計算しても
 * 実用的な結果にならないため、デッドゾーン内ではパン入力自体を無効化する
 * （呼び出し元、`dioramaArControls.ts`参照）。
 *
 * @param distanceM ユーザーから箱庭中心までの水平距離[m]（{@link computeHorizontalDisplacement}の`distanceM`）。
 * @param wasInsideDeadZone 前フレームの判定結果。
 * @param deadZoneRadiusM デッドゾーンの半径[m]（通常は箱庭の卓上表示半径 tableRadiusM）。
 * @param hysteresisM デッドゾーンを抜ける際に追加で必要な距離[m]
 *   （既に内側にいる場合のみ適用。境界ちょうどでの頻繁な切り替わりを防ぐ）。
 * @returns 非有限値の場合は前フレームの判定を維持する。
 */
export const isInsideDioramaDeadZone = (
    distanceM: number,
    wasInsideDeadZone: boolean,
    deadZoneRadiusM: number,
    hysteresisM: number = DEFAULT_DEAD_ZONE_HYSTERESIS_M,
): boolean => {
    if (!Number.isFinite(distanceM) || !(deadZoneRadiusM >= 0)) return wasInsideDeadZone;
    const safeHysteresisM = Number.isFinite(hysteresisM) ? Math.max(0, hysteresisM) : 0;
    if (wasInsideDeadZone) {
        return distanceM <= deadZoneRadiusM + safeHysteresisM;
    }
    return distanceM <= deadZoneRadiusM;
};


/** フットプリントの半辺長ズームの秒間倍率既定値（1秒間フルで倒すと半径が概ね1/2倍/2倍になる）。 */
export const DEFAULT_FOOTPRINT_ZOOM_RATE_PER_SEC = 2;

/**
 * フットプリントの半辺長の下限・上限既定値[m]。
 *
 * 上限は、日本全体（北海道〜沖縄、概ね南北2500km程度）がズームアウトで見渡せる
 * ことを目安に設定する（2000kmあれば、既定中心（富士山付近）から沖縄・北海道
 * いずれの端までも十分カバーできる）。DEM/テクスチャの取得ズームレベルは
 * 固定ではなく `footprintHalfSizeM` に応じて自動的に粗くなる
 * （`dioramaTerrain.ts` の `computeAutoZoomLevel` 参照）ため、上限を広げても
 * 取得タイル数が際限なく増えて重くなることはない。
 */
export const DEFAULT_FOOTPRINT_HALF_SIZE_MIN_M = 100;
export const DEFAULT_FOOTPRINT_HALF_SIZE_MAX_M = 2_000_000;

/**
 * 右スティックY軸（またはGUIズームボタン相当の軸値）から、1フレーム分の
 * フットプリントの半辺長への乗算係数を算出する（乗算方式）。
 *
 * 前に倒す（y<0）ほど半径が縮む（ズームイン、より詳細な狭い範囲を表示）。
 *
 * @param zoomRatePerSecond 1秒間フルで倒し続けたときの倍率（>1 を想定）。
 * @returns フットプリントの半辺長に乗算する係数（入力なしや不正な dt なら 1 = 変化なし）。
 */
export const computeFootprintHalfSizeFactorFromStick = (
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
 * フットプリントの半辺長を [minM, maxM] へクランプする。
 * `NaN` のみ `minM` へフォールバックしてからクランプする（`Math.min`/`Math.max` は
 * `NaN` を伝播させてしまうため）。`Infinity`/`-Infinity` は通常の `Math.min`/`Math.max`
 * でそれぞれ `maxM`/`minM` に正しくクランプされるため特別扱いしない。
 */
export const clampFootprintHalfSizeM = (
    radiusM: number,
    minM: number = DEFAULT_FOOTPRINT_HALF_SIZE_MIN_M,
    maxM: number = DEFAULT_FOOTPRINT_HALF_SIZE_MAX_M,
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
 * （`clampFootprintHalfSizeM` と同じ方針）。
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
