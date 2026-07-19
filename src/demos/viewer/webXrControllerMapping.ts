/**
 * WebXR (immersive-vr) コントローラーのスティック入力を、地図パン/高度ズームの
 * 移動量へ変換する純粋関数群。
 *
 * DOM / Babylon.js Scene に依存しないため vitest で単体テスト可能。実際の WebXR
 * セッション制御・カメラ配置（Babylon 依存部分）は `webXrVrSession.ts` が担う。
 *
 * 操作割り当て:
 * - 左スティック: 地図平面移動（パン）。x = 東西、y = 前後。
 * - 右スティック: 高度（ズーム）。前後方向のみ使用（y軸）。
 *
 * 軸の符号は WebXR/Gamepad API の標準的な thumbstick 規約
 * （前方 = y 軸負値、右方向 = x 軸正値）に従う。
 *
 * 命名メモ: 本リポジトリでは "VR" は既存の Playwright Visual Regression テストの略称
 * としても使われているため、混同を避けるためシンボル名には "WebXr"/"webXr" を用いる。
 */

/** スティック入力のデッドゾーン既定値。 */
export const DEFAULT_STICK_DEADZONE = 0.15;

/** パン速度計算で高度が極端に低い場合の下限[m]（低高度で操作不能なほど遅くならないようにする）。 */
export const DEFAULT_MIN_ALTITUDE_FOR_PAN_SPEED_M = 30;

/** 高度ズームの秒間倍率既定値（1秒間フルで倒すと高度が概ね4倍/0.25倍になる）。 */
export const DEFAULT_ALTITUDE_ZOOM_RATE_PER_SEC = 4;

/**
 * VR突入時点の既定「地表からの高度」[m]（`viewer.altitude` を継承しない）。
 *
 * `viewer.altitude` は実体が ArcRotateCamera 系の `radius`（注視点からの距離）であり
 * （spec/package.md 参照）、デスクトップ既定値は 2000m。これをそのまま VR の地表高度に
 * 使うと、地表からはるか上空（ほぼ空しか見えない高度）にリグが配置されてしまう
 * （実機検証で確認済みの不具合）。VR では見下ろし観覧に適した控えめな高度を既定にする。
 * `?vrHoverHeight=<meters>` で実機調整用に上書き可能（{@link resolveVrHoverHeightM}）。
 */
export const DEFAULT_VR_HOVER_HEIGHT_M = 150;

/**
 * `refreshTerrainWithExternalFrustum` 内部の `camera.radius` 上書き式
 * （`FOLLOW_TILE_BASE_RADIUS_M * 2^-lodBias`）と同じ基準値。
 * `src/scenes/globeSceneController.ts` の private 定数 `FOLLOW_TILE_BASE_RADIUS_M`
 * と同値（意図的な重複。相手は非公開のため import 不可）。値を変更する場合は
 * 両者を同期させること。
 *
 * この基準値と `lodBias` から `camera.radius` を算出できることを利用し、
 * VR中の `camera.radius` が実際の地表高度（altitude）と一致するよう `lodBias` を
 * 逆算する（{@link computeLodBiasForAltitude}）。`camera.radius` は
 * マーカー/ポリゴン/サークルの距離ベース自動スケール計算（`computeCameraEcef` 経由）
 * にも使われるため、これを合わせないと VR中に固定 2000m 相当のスケールで計算され、
 * 近距離のマーカーが異常に巨大表示される（実機検証で確認済みの不具合）。
 */
export const FOLLOW_TILE_BASE_RADIUS_M_REFERENCE = 2000;

/**
 * {@link FOLLOW_TILE_BASE_RADIUS_M_REFERENCE} を基準に、`camera.radius` が
 * `targetRadiusM` と一致するような `lodBias` を算出する。
 *
 * @param targetRadiusM 正の有限値を想定（`altitude` は `clampAltitude` で
 *   [50, ALTITUDE_MAX] にクランプ済みのため常に満たされる）。
 */
export const computeLodBiasForAltitude = (targetRadiusM: number): number =>
    Math.log2(FOLLOW_TILE_BASE_RADIUS_M_REFERENCE / targetRadiusM);

/**
 * `?vrHoverHeight=` クエリ文字列から VR 突入時の既定高度[m]を解決する。
 * 未指定・不正値（非数値・0以下）は {@link DEFAULT_VR_HOVER_HEIGHT_M} にフォールバックする。
 */
export const resolveVrHoverHeightM = (search: string): number => {
    const raw = new URLSearchParams(search).get("vrHoverHeight");
    if (raw === null) return DEFAULT_VR_HOVER_HEIGHT_M;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_VR_HOVER_HEIGHT_M;
};

/** スティックの2軸入力（[-1,1] 想定）。 */
export interface StickAxes {
    x: number;
    y: number;
}

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

/** {@link computePanMetersFromStick} のオプション。 */
export interface PanFromStickOptions {
    deadzone?: number;
    minAltitudeForSpeedM?: number;
}

/**
 * 左スティック入力から、1フレーム分のパン移動量[m]（東西・南北）を算出する。
 *
 * 速度は現在高度に比例させる（既存のドラッグ/WASD パン ({@link module:src/scenes/globe.ts}) と
 * 同じ「高いほど速く動く」感覚を踏襲）。低高度では `minAltitudeForSpeedM` を下限にして、
 * 操作不能なほど遅くならないようにする。
 *
 * @param altitudeM 現在の高度[m]（{@link module:src/lib/jpmapTerrain.ts}.altitude 相当）。
 * @param basePanSpeedPerSec 高度1mあたりの基準パン速度[1/s]（`altitude * basePanSpeedPerSec` が
 *   フルスティック時の秒速[m/s]になる）。
 * @returns 東西(east)・南北(north)方向の移動量[m]。正の east は東へ、正の north は北へ。
 */
export const computePanMetersFromStick = (
    axes: StickAxes,
    dtSeconds: number,
    altitudeM: number,
    basePanSpeedPerSec: number,
    options: PanFromStickOptions = {},
): { eastM: number; northM: number } => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { eastM: 0, northM: 0 };
    const deadzone = options.deadzone ?? DEFAULT_STICK_DEADZONE;
    const minAltitudeForSpeedM = options.minAltitudeForSpeedM ?? DEFAULT_MIN_ALTITUDE_FOR_PAN_SPEED_M;
    const x = applyStickDeadzone(axes.x, deadzone);
    const y = applyStickDeadzone(axes.y, deadzone);
    if (x === 0 && y === 0) return { eastM: 0, northM: 0 };
    const effectiveAltitudeM = Number.isFinite(altitudeM)
        ? Math.max(altitudeM, minAltitudeForSpeedM)
        : minAltitudeForSpeedM;
    const speed = basePanSpeedPerSec * effectiveAltitudeM;
    return {
        eastM: x * speed * dtSeconds,
        // Gamepad 規約: y軸は前方向(奥へ倒す)が負値。前進 = 北 とするため符号を反転する。
        northM: -y * speed * dtSeconds,
    };
};

/**
 * 右スティックのy軸入力から、1フレーム分の高度倍率を算出する（乗算方式）。
 *
 * 既存ズームボタン（{@link module:src/scenes/globeSceneController.ts} の `zoomByFactor`、
 * `camera.radius *= factor`）と同じ「乗算スケール」方式を秒間レートへ拡張したもの。
 * 前に倒す(y<0)ほど高度が下がる(ズームイン)。
 *
 * @param zoomRatePerSecond 1秒間フルで倒し続けたときの倍率（>1 を想定）。
 * @returns 高度に乗算する係数（入力なしや不正な dt なら 1 = 変化なし）。
 */
export const computeAltitudeFactorFromStick = (
    axisY: number,
    dtSeconds: number,
    zoomRatePerSecond: number,
    deadzone: number = DEFAULT_STICK_DEADZONE,
): number => {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 1;
    if (!Number.isFinite(zoomRatePerSecond) || zoomRatePerSecond <= 0) return 1;
    const y = applyStickDeadzone(axisY, deadzone);
    if (y === 0) return 1;
    return Math.pow(zoomRatePerSecond, y * dtSeconds);
};
