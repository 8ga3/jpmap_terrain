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
 * `lodBias` 算出（{@link computeLodBiasForAltitude}）に使う実効半径の下限[m]。
 *
 * VR の地表高度（`altitude`、`clampAltitude` で最小 50m まで許容）をそのまま
 * `lodBias` の基準にすると、低高度でタイル LOD が過剰に高精細（深いズームレベル）を
 * 要求し、可視範囲内のタイル数が `maxVisited` 等の上限を超えて欠け（表示しきれない
 * タイルが発生）が生じる不具合を実機検証で確認した（ユーザーからも「もっとズーム
 * レベルを下げても十分」との指摘あり）。この下限で高度が極端に低い場合の要求詳細度を
 * 抑える。`camera.radius`（マーカー等の距離ベース自動スケールにも使われる）も
 * 同じ値になるため、大きくしすぎるとマーカーが小さく見えすぎる可能性がある
 * トレードオフがある。
 */
export const DEFAULT_VR_LOD_EFFECTIVE_RADIUS_MIN_M = 400;

/**
 * `altitudeM` に {@link DEFAULT_VR_LOD_EFFECTIVE_RADIUS_MIN_M} 未満の下限を適用した
 * 「lodBias 算出用の実効半径」を返す（高高度側の挙動は変えない）。
 */
export const resolveVrLodEffectiveRadiusM = (
    altitudeM: number,
    minM: number = DEFAULT_VR_LOD_EFFECTIVE_RADIUS_MIN_M,
): number => Math.max(altitudeM, minM);

/** WGS84 の赤道半径[m]（near/far clip 計算の基準）。 */
export const PLANET_RADIUS_M_FOR_CLIP_PLANES = 6378137;

/** {@link computeVrCameraClipPlanes} の既定パラメータ。 */
export const DEFAULT_VR_MIN_Z_ALTITUDE_FACTOR = 0.01;
export const DEFAULT_VR_MIN_Z_FLOOR_M = 0.5;
export const DEFAULT_VR_MAX_Z_HORIZON_MARGIN_FACTOR = 2;
export const DEFAULT_VR_MAX_Z_FLOOR_M = 2000;
/**
 * `maxZ`（far clip）の絶対上限[m]。
 *
 * `horizonDistM * DEFAULT_VR_MAX_Z_HORIZON_MARGIN_FACTOR` は高度が上がるほど際限なく
 * 巨大化する（例: 高度 200km で約 3,200km）。WebXR (`XRSession.updateRenderState`) の
 * `depthFar` にこのような非現実的に大きい値を渡すと、多くのブラウザ/ランタイムが
 * これを妥当な範囲外として無視・クランプし、内部既定値（Babylon.js の `WebXRCamera` は
 * `maxZ` 既定 10000m）にフォールバックする可能性が高い。これが、高高度
 * （タイルレベル8＝高度200〜300km相当）でカメラ直下の地形が広範囲に渡って全く
 * 描画されない（円形の穴）症状の実機検証で確認された原因と推定される
 * （`updateRenderState` 呼び出し自体は正しく行われていても、渡した値がブラウザ側で
 * 無視されるため見た目には反映されない）。
 * VR は局所的な地表観覧が主目的で地球全体の水平線まで見える必要はないため、
 * この上限で頭打ちにする（Babylon 既定の 10000m よりは広く、かつ非現実的に
 * 巨大にはならない値として 50000m を採用）。
 */
export const DEFAULT_VR_MAX_Z_CAP_M = 50000;

/**
 * VR カメラの `minZ`/`maxZ` を、実際の地表高度（地心距離 - 惑星半径）に応じて算出する。
 *
 * デスクトップの `GeospatialCamera` に付与されている `GeospatialClippingBehavior`
 * （`horizonDist + planetRadius*0.1` で maxZ を求める式）をそのまま VR に流用すると、
 * 惑星半径の1割（地球なら約638km）が常に maxZ の下限になってしまう。この式は
 * `engine.useReverseDepthBuffer`（reverse-Z）による深度精度改善を前提にした設計だが、
 * **WebXR カメラはブラウザが提供する `XRView.projectionMatrix` を直接使う実装のため
 * reverse-Z の恩恵を受けられない**（Babylon の `Camera.getProjectionMatrix()` 経由の
 * reverse-Z ロジックを通らない）。そのため標準（非reverse）深度バッファのままこの
 * 巨大な maxZ を使うと、低高度で地球楕円体の背景球と地形タイルが z-fighting する
 * 不具合を実機検証で確認した。
 *
 * VR は局所的な地表観覧が主目的で地球全体の水平線まで見える必要はないため、
 * 地平線距離に適度な倍率（{@link DEFAULT_VR_MAX_Z_HORIZON_MARGIN_FACTOR}）を掛けた、
 * より狭い範囲を使う。さらに {@link DEFAULT_VR_MAX_Z_CAP_M} で絶対上限を設ける
 * （ブラウザ側が極端な depthFar を無視する問題への対策。上記コメント参照）。
 */
export const computeVrCameraClipPlanes = (
    altitudeM: number,
    planetRadiusM: number = PLANET_RADIUS_M_FOR_CLIP_PLANES,
): { minZ: number; maxZ: number } => {
    const safeAltitudeM = Math.max(1, altitudeM);
    const minZ = Math.max(DEFAULT_VR_MIN_Z_FLOOR_M, safeAltitudeM * DEFAULT_VR_MIN_Z_ALTITUDE_FACTOR);
    const horizonDistM = Math.sqrt(2 * planetRadiusM * safeAltitudeM + safeAltitudeM * safeAltitudeM);
    const maxZ = Math.min(
        DEFAULT_VR_MAX_Z_CAP_M,
        Math.max(DEFAULT_VR_MAX_Z_FLOOR_M, horizonDistM * DEFAULT_VR_MAX_Z_HORIZON_MARGIN_FACTOR),
    );
    return { minZ, maxZ };
};

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
