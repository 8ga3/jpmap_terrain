/**
 * ズームループ デモのカメラ経路計算。
 *
 * DOM / Babylon Scene に依存しない純粋関数群として実装し、vitest で単体テスト可能にする。
 * - 位置（lat/lon）: 緯度経度を単位球面上のベクトルとみなし、`Quaternion.RotationAxis` に
 *   よる回転として補間する（大圏＝球面上の最短測地線に沿った経路になる）。単純な数値
 *   線形補間だと日付変更線・極付近で破綻しうる上、`extraTurns` のような周回表現も
 *   できないため、より汎用的なクォータニオンベースの手法を採用する。
 * - 高度（altitude）: 2570m ⇔ 3,176,946m と桁違いに変化するため、対数空間で補間して
 *   一定速度に見える「ズーム」にする（線形補間だと終盤にしか変化を感じられない）。
 * - 向き（azimuth/tilt）: `Quaternion.Slerp` で補間する。azimuth の単純な数値線形補間は
 *   0°/360° 境界（本デモの端点は 0.35° と 359.83° で実質 0.52° しか離れていない）で
 *   最短方向ではなく長い方向へ回転してしまう不具合が起きるため、回転として補間する
 *   Quaternion Slerp（最短回転経路を自動で選ぶ）を採用する。
 */
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { uiToYawPitch, yawPitchToUi } from "../../terrain/geo/cameraMapping";

/** カメラ姿勢の端点（緯度経度＋高度＋向き）。 */
export interface CameraEndpoint {
    lat: number;
    lon: number;
    altitude: number;
    /** 方位角 [deg]（0-360, 0=北, +=東回り）。 */
    azimuth: number;
    /** チルト角 [deg]（0=直下, 90=水平）。 */
    tilt: number;
}

/** 補間結果として適用するカメラフレーム。 */
export type CameraFrame = CameraEndpoint;

/** ズームループの4状態。往復を無限に繰り返す。 */
export type LoopPhase = "holdZoomIn" | "toZoomOut" | "holdZoomOut" | "toZoomIn";

/** ズームループの設定（端点・移動時間・静止時間）。 */
export interface ZoomLoopConfig {
    zoomIn: CameraEndpoint;
    zoomOut: CameraEndpoint;
    /** 片道の移動時間 [ms]。 */
    moveDurationMs: number;
    /** 各端点での静止時間 [ms]。 */
    holdDurationMs: number;
}

/** ズームループの進行状態。 */
export interface ZoomLoopState {
    phase: LoopPhase;
    /** 現在のフェーズに入ってからの経過時間 [ms]。 */
    elapsedInPhaseMs: number;
}

/** イージング関数（加減速して滑らかに見せる）。高度・向きの補間に使用。 */
export const easeInOutCubic = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * `easeInOutCubic` の逆関数（値 t から元の入力 p を求める）。
 * 位置の移動しきい値を「高度（対数補間の t 軸）」から「生の進行度 p 軸」へ
 * 変換するために使う（`positionTFromAltitude` 参照）。
 */
const easeInOutCubicInverse = (t: number): number =>
    t < 0.5 ? Math.cbrt(t / 4) : 1 - Math.cbrt(2 * (1 - t)) / 2;

/** [0,1] にクランプする。 */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 位置（lat/lon）移動の固定/移動を切り替える基準高度 [m] の既定値
 * （「大気圏」の目安。カルマン線に近い 100km を既定値とする）。
 * 進行度ベースのしきい値（`easeInExpo` や固定 progress 値）だと、ズームアウト
 * （低高度→高高度）とズームイン（高高度→低高度）とで対称な見え方にならないため、
 * 実際に補間された高度そのものと比較するように変更した。
 * これにより、方向によらず「基準高度を上回っている間だけ位置が動く」という
 * 統一的な規則になる:
 * - ズームアウト（上昇）: 基準高度に達するまで start に固定 → 達したら移動開始
 * - ズームイン（下降）: 開始直後（高高度）から移動 → 基準高度を下回ったら end に固定
 */
export const DEFAULT_POSITION_HOLD_ALTITUDE = 200_000;

/**
 * 対数補間 `altitude(t) = startAlt * (endAlt/startAlt)^t` の逆算。
 * 高度 `altValue` に到達する t を求める（`altValue` が start/end の外側なら 0/1 にクランプ）。
 */
const altitudeToT = (startAlt: number, endAlt: number, altValue: number): number => {
    if (startAlt <= 0 || endAlt <= 0 || altValue <= 0 || startAlt === endAlt) {
        return 0;
    }
    return clamp01(Math.log(altValue / startAlt) / Math.log(endAlt / startAlt));
};

/**
 * 現在の進行度 `p`（生の値、イージング適用前）と基準高度 `holdAltitude` の関係から、
 * 位置補間用の t（0..1）を求める。
 *
 * 高度のしきい値は対数補間の t 軸（`altitudeToT`）で求まるが、そのまま
 * 既にイージング済みの t を使って位置側にもう一段 `easeInOutCubic` を掛けると、
 * 二重にイージングがかかって「動き始めが不自然に遅れ、しきい値付近で急に動く」
 * 見た目になってしまう。そのためしきい値を `easeInOutCubicInverse` で
 * 生の進行度 p 軸へ変換し、位置補間のイージングは1回だけ（p 軸上で）適用する。
 * - 上昇方向（endAlt > startAlt、ズームアウト）: 基準高度に達するまで 0（start に固定）、
 *   達した後の残り区間で 0→1 へ滑らかに移動する。
 * - 下降方向（endAlt < startAlt、ズームイン）: 開始直後（高高度）から 0→1 へ滑らかに移動し、
 *   基準高度を下回ったら 1（end に固定）のまま動かさない。
 */
const positionTFromAltitude = (
    p: number,
    startAlt: number,
    endAlt: number,
    holdAltitude: number,
): number => {
    const thresholdP = easeInOutCubicInverse(altitudeToT(startAlt, endAlt, holdAltitude));
    if (endAlt >= startAlt) {
        if (thresholdP >= 1 || p <= thresholdP) return 0;
        return easeInOutCubic(clamp01((p - thresholdP) / (1 - thresholdP)));
    }
    if (thresholdP <= 0 || p >= thresholdP) return 1;
    return easeInOutCubic(clamp01(p / thresholdP));
};

/**
 * 緯度経度[deg]を単位球面上の方向ベクトルへ変換する（高度非考慮、向きのみ）。
 * y=sin(lat) を極軸とする内部規約で、`unitVectorToLatLon` とペアで往復変換が閉じていれば
 * よく、実際のECEF/世界座標系の軸とは無関係（このモジュール内でのみ使用する）。
 */
const latLonToUnitVector = (latDeg: number, lonDeg: number): Vector3 => {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    return new Vector3(cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon));
};

/** 単位球面上の方向ベクトルを緯度経度[deg]へ変換する（`latLonToUnitVector` の逆変換）。 */
const unitVectorToLatLon = (v: Vector3): { lat: number; lon: number } => {
    const latRad = Math.asin(Math.max(-1, Math.min(1, v.y)));
    const lonRad = Math.atan2(v.z, v.x);
    return { lat: (latRad * 180) / Math.PI, lon: (lonRad * 180) / Math.PI };
};

/** 回転軸が定まらない場合（始点・終点が同一/対蹠点）のフォールバック許容誤差。 */
const POSITION_AXIS_EPSILON = 1e-9;

/**
 * 緯度経度をクォータニオン（大圏上の回転）で補間する。
 *
 * 始点・終点を単位球面上のベクトルとみなし、その間の回転を `Quaternion.RotationAxis` で
 * 構築して補間することで、常に大圏（球面上の最短測地線）に沿った経路になる
 * （数値線形補間と異なり、日付変更線・極付近でも破綻しない）。
 *
 * `extraTurns` に 0 以外の値を指定すると、大圏の回転軸周りに指定回数分の丸ごとの
 * 周回を追加してから終点へ到達するようになる。例えば `extraTurns=1` を指定すると、
 * 地球を1周させながらズームする、といった表現が可能（既定値 0 では従来通り最短経路）。
 * 始点・終点が一致/ほぼ対蹠点で回転軸が定まらない場合は、極軸（またはその代替軸）を
 * 仮の回転軸として使う（`extraTurns` を使った周回表現のためのフォールバック）。
 */
export const interpolatePosition = (
    start: Pick<CameraEndpoint, "lat" | "lon">,
    end: Pick<CameraEndpoint, "lat" | "lon">,
    t: number,
    extraTurns = 0,
): { lat: number; lon: number } => {
    const v0 = latLonToUnitVector(start.lat, start.lon);
    const v1 = latLonToUnitVector(end.lat, end.lon);

    let axis = Vector3.Cross(v0, v1);
    if (axis.lengthSquared() < POSITION_AXIS_EPSILON) {
        // 始点・終点がほぼ同一/対蹠点で軸が定まらない場合のフォールバック軸。
        axis = Math.abs(v0.y) < 0.999 ? Vector3.Cross(v0, Vector3.Up()) : Vector3.Right();
    }
    axis.normalize();

    const dot = Math.max(-1, Math.min(1, Vector3.Dot(v0, v1)));
    const baseAngle = Math.acos(dot);
    const totalAngle = baseAngle + extraTurns * 2 * Math.PI;

    const q = Quaternion.RotationAxis(axis, totalAngle * clamp01(t));
    const rotated = Vector3.Zero();
    v0.rotateByQuaternionToRef(q, rotated);

    return unitVectorToLatLon(rotated);
};

/**
 * 高度を対数空間で補間する（`altitude(t) = start * (end/start)^t`）。
 * 一方が 0 以下（本来ありえないが防御的に）の場合は線形補間へフォールバックする。
 */
export const interpolateAltitude = (
    startAlt: number,
    endAlt: number,
    t: number,
): number => {
    if (startAlt <= 0 || endAlt <= 0) {
        return startAlt + (endAlt - startAlt) * t;
    }
    return startAlt * Math.pow(endAlt / startAlt, t);
};

/**
 * 向き（azimuth/tilt）を Quaternion Slerp で補間する。
 * `uiToYawPitch`/`yawPitchToUi`（`terrain/geo/cameraMapping.ts`）と同じ規約
 * （yaw=azimuth[rad], pitch=tilt[rad], roll=0）でクォータニオンを構築するため、
 * 実際のカメラ（`GeospatialCamera`）の yaw/pitch 表現と整合する。
 */
export const interpolateOrientation = (
    start: Pick<CameraEndpoint, "azimuth" | "tilt">,
    end: Pick<CameraEndpoint, "azimuth" | "tilt">,
    t: number,
): { azimuth: number; tilt: number } => {
    const s = uiToYawPitch(start.azimuth, start.tilt);
    const e = uiToYawPitch(end.azimuth, end.tilt);
    const q0 = Quaternion.RotationYawPitchRoll(s.yaw, s.pitch, 0);
    const q1 = Quaternion.RotationYawPitchRoll(e.yaw, e.pitch, 0);
    const qt = Quaternion.Slerp(q0, q1, clamp01(t));
    const euler = qt.toEulerAngles();
    const { azimuthDeg, tiltDeg } = yawPitchToUi(euler.y, euler.x);
    return { azimuth: azimuthDeg, tilt: tiltDeg };
};

/**
 * 2端点間・進行度（0..1, イージング適用前）からカメラフレームを算出する。
 * `positionExtraTurns` は `interpolatePosition` にそのまま渡す周回数（既定値 0）。
 * `positionHoldAltitude` は位置移動の固定/移動を切り替える基準高度[m]（既定値
 * `DEFAULT_POSITION_HOLD_ALTITUDE`）。ズームアウト（上昇）では基準高度に達するまで
 * 位置を固定し、ズームイン（下降）では基準高度を下回った後に位置を固定する
 * （`positionTFromAltitude` 参照）。高度・向きは従来通り `easeInOutCubic` で補間する。
 */
export const computeCameraFrame = (
    start: CameraEndpoint,
    end: CameraEndpoint,
    progress: number,
    positionExtraTurns = 0,
    positionHoldAltitude = DEFAULT_POSITION_HOLD_ALTITUDE,
): CameraFrame => {
    const p = clamp01(progress);
    const t = easeInOutCubic(p);
    const positionT = positionTFromAltitude(p, start.altitude, end.altitude, positionHoldAltitude);
    const { lat, lon } = interpolatePosition(start, end, positionT, positionExtraTurns);
    const altitude = interpolateAltitude(start.altitude, end.altitude, t);
    const { azimuth, tilt } = interpolateOrientation(start, end, t);
    return { lat, lon, altitude, azimuth, tilt };
};

/** 現フェーズの次に遷移するフェーズ（無限往復）。 */
const nextPhase = (phase: LoopPhase): LoopPhase => {
    switch (phase) {
        case "holdZoomIn":
            return "toZoomOut";
        case "toZoomOut":
            return "holdZoomOut";
        case "holdZoomOut":
            return "toZoomIn";
        case "toZoomIn":
            return "holdZoomIn";
    }
};

/** フェーズの目標時間 [ms]（0 以下・NaN は即座に次のフェーズへ進めるため 0 として扱う）。 */
const phaseDurationMs = (phase: LoopPhase, config: ZoomLoopConfig): number => {
    const raw =
        phase === "holdZoomIn" || phase === "holdZoomOut"
            ? config.holdDurationMs
            : config.moveDurationMs;
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
};

/**
 * 経過時間 `deltaMs` を進めてループ状態を更新する。
 * タブが非アクティブだった場合等、`deltaMs` がフェーズ長より大きくても、
 * ループを回してフェーズを正しく複数回進める（フレームスキップに強い実装）。
 */
export const advanceZoomLoop = (
    state: ZoomLoopState,
    deltaMs: number,
    config: ZoomLoopConfig,
): ZoomLoopState => {
    let phase = state.phase;
    let elapsedInPhaseMs = state.elapsedInPhaseMs + Math.max(0, deltaMs);

    // 無限ループ防止のための安全弁（全フェーズ長が 0 のような異常設定時に抜ける）。
    const MAX_ITER = 1000;
    for (let i = 0; i < MAX_ITER; i++) {
        const duration = phaseDurationMs(phase, config);
        if (duration <= 0) {
            // 長さ 0 のフェーズは deltaMs=0 の呼び出しでも必ず1段階進める。
            // 全フェーズが 0 の異常設定時は MAX_ITER で抜ける。
            phase = nextPhase(phase);
            elapsedInPhaseMs = 0;
            continue;
        }
        if (elapsedInPhaseMs < duration) break;
        elapsedInPhaseMs -= duration;
        phase = nextPhase(phase);
    }

    return { phase, elapsedInPhaseMs };
};

/** 現在のループ状態からカメラフレームを算出する。 */
export const cameraFrameForState = (
    state: ZoomLoopState,
    config: ZoomLoopConfig,
): CameraFrame => {
    switch (state.phase) {
        case "holdZoomIn":
            return { ...config.zoomIn };
        case "holdZoomOut":
            return { ...config.zoomOut };
        case "toZoomOut": {
            const progress =
                config.moveDurationMs > 0
                    ? state.elapsedInPhaseMs / config.moveDurationMs
                    : 1;
            return computeCameraFrame(config.zoomIn, config.zoomOut, progress);
        }
        case "toZoomIn": {
            const progress =
                config.moveDurationMs > 0
                    ? state.elapsedInPhaseMs / config.moveDurationMs
                    : 1;
            return computeCameraFrame(config.zoomOut, config.zoomIn, progress);
        }
    }
};
