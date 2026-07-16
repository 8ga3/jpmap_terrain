/**
 * 太陽の地理座標（高度・方位角）を、Babylon.js シーンで使う描画パラメータへ変換する。
 *
 * - `sunDir`: ワールド空間で「太陽が見える方向」を指す単位ベクトル（地表→空）。
 *   Babylon.js は左手系で X=東、Y=上、Z=北。地理的方位角 0°=北 を Z+ に対応付ける。
 * - `dayFactor`: 0=夜、1=昼。altitude を [-6°, +6°] の薄明帯で smoothstep し、
 *   薄明〜真昼を連続変化させる（民間薄明 ±6° を採用）。
 * - `skyInclination` / `skyAzimuth`: `@babylonjs/materials/sky/skyMaterial` の入力。
 * - `skyLuminance`: 同マテリアルの輝度。夜に近づくほど小さくする。
 * - `visibleAboveHorizon`: 太陽メッシュ表示可否。
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { smoothstep } from "./mathUtils";

const DEG2RAD = Math.PI / 180;

/** 昼の明るい空色（`scene.clearColor` 初期値相当、薄い青空） */
const DAY_CLEAR_COLOR = new Color3(0.75, 0.86, 0.95);
/** 夜の深い紺色。`Skybox` を非表示にした際に背景として見える */
const NIGHT_CLEAR_COLOR = new Color3(0.02, 0.03, 0.08);
/** 日の出・日の入りの茜色（暖色のオレンジ赤）。地平線付近でブレンドする */
const DUSK_CLEAR_COLOR = new Color3(0.8, 0.4, 0.22);

/**
 * 茜色が現れる太陽高度の半幅（度）。地平線（高度 0°）を中心に ±この範囲で茜色を強める。
 * 民間薄明（±6°）よりやや広く取り、日の出/入り前後を滑らかに彩る。
 */
const DUSK_BAND_DEG = 8;
/** 茜色ブレンドの最大強度（0..1）。1.0 だと地平線でほぼ完全に茜色になる。 */
const DUSK_STRENGTH = 0.7;

/** Scene へ適用する太陽パラメータ束。Babylon.js への依存はここで吸収する。 */
export interface SunState {
    /** 太陽方向の単位ベクトル（地表→太陽）。ライト方向は `sunDir.scale(-1)` を使う */
    sunDir: Vector3;
    /** 0=夜、1=昼。薄明帯（-6°..+6°）で滑らかに補間 */
    dayFactor: number;
    /** SkyMaterial.inclination 入力 */
    skyInclination: number;
    /** SkyMaterial.azimuth 入力（0..1, 1 周で 360°） */
    skyAzimuth: number;
    /** SkyMaterial.luminance 入力。夜は小さく、昼は 1.0 付近 */
    skyLuminance: number;
    /**
     * Skybox メッシュを有効にするか。夜は SkyMaterial の物理モデルが太陽を頼りに色を出せないため
     * Skybox を消して `clearColor`（夜色）を背景に見せる。
     */
    skyVisible: boolean;
    /** 時刻連動の `scene.clearColor`。夜は深い紺、昼は薄い青空色 */
    clearColor: Color3;
    /** 太陽メッシュ表示可否（地平線下では非表示） */
    visibleAboveHorizon: boolean;
}

/**
 * 太陽の高度・方位角から `SunState` を導出する。
 *
 * 入力は地理的な角度（度）：
 * - `altitudeDeg`: -90..90、地平線=0
 * - `azimuthDeg`: 0..360、北=0、東=90、南=180、西=270
 */
export function deriveSunState(
    altitudeDeg: number,
    azimuthDeg: number,
): SunState {
    const altRad = altitudeDeg * DEG2RAD;
    const azRad = azimuthDeg * DEG2RAD;
    const cosAlt = Math.cos(altRad);
    const sinAlt = Math.sin(altRad);
    const cosAz = Math.cos(azRad);
    const sinAz = Math.sin(azRad);

    // Babylon.js 左手系（X=東, Y=上, Z=北）。
    // 方位 0°=北 → Z+、方位 90°=東 → X+。よって x=sin(az)*cos(alt), z=cos(az)*cos(alt)。
    const sunDir = new Vector3(sinAz * cosAlt, sinAlt, cosAz * cosAlt);

    const dayFactor = smoothstep(-6, 6, altitudeDeg);

    // Babylon `SkyMaterial` 規約: inclination ∈ [-0.5, 0.5]、内部で theta = π(inc - 0.5)、
    // sunPosition.y = sin(-theta) となり **inclination=0 で太陽が天頂、 ±0.5 で地平線**。
    // よって altitudeDeg=90 → 0、 altitudeDeg=0 → 0.5 の対応が正しい。
    // 地平線下（altitudeDeg < 0）は SkyMaterial が想定しない領域のため 0.5 でクランプし、
    // 実際の夜表現は `skyVisible=false` + `clearColor` 切替で行う。
    const rawInclination = 0.5 - altitudeDeg / 180;
    const skyInclination = Math.max(-0.5, Math.min(0.5, rawInclination));
    const skyAzimuth = (((azimuthDeg % 360) + 360) % 360) / 360;
    const skyLuminance = 0.05 + 0.95 * dayFactor;
    const visibleAboveHorizon = altitudeDeg > -1;
    // 太陽が地平線下に深く入ったら Skybox を消し、夜色背景を出す。
    // 薄明帯の連続性は `clearColor` 補間で担保。
    const skyVisible = altitudeDeg > -6;
    const clearColor = Color3.Lerp(
        NIGHT_CLEAR_COLOR,
        DAY_CLEAR_COLOR,
        dayFactor,
    );

    return {
        sunDir,
        dayFactor,
        skyInclination,
        skyAzimuth,
        skyLuminance,
        skyVisible,
        clearColor,
        visibleAboveHorizon,
    };
}

/**
 * 太陽高度（度）から「時刻連動の背景（skybox）色」を導く純関数。
 *
 * SkyMaterial を使わない globe シーン向けに、太陽位置だけで空色を決める。
 * 紺→青の基調色は薄明帯（±6°）で連続補間し、さらに地平線付近（±`DUSK_BAND_DEG`=8°）で
 * 茜色を重ねる。そのため色が変化する高度帯は、基調色（±6°）と茜色（±8°）の和集合になる。
 * - 夜（高度 ≲ -8°）: 深い紺（`NIGHT_CLEAR_COLOR`）
 * - 昼（高度 ≳ +8°）: 薄い青空（`DAY_CLEAR_COLOR`）
 * - 日の出・日の入り（地平線付近 ±8°）: 上記基調色に茜色（`DUSK_CLEAR_COLOR`）をブレンド
 *
 * planar シーン（`deriveSunState` + SkyMaterial）と色味の方向性を揃えつつ、
 * 高度連動の宇宙黒化（`computeSpaceFactor`）は呼び出し側で別途合成する。
 *
 * @param altitudeDeg 太陽高度（度, -90..90, 地平線=0）。非有限値は昼色フォールバック。
 */
export function deriveSkyColor(altitudeDeg: number): Color3 {
    if (!Number.isFinite(altitudeDeg)) return DAY_CLEAR_COLOR.clone();
    // 夜→昼の基調色（紺→青）。薄明帯（-6°..+6°）で連続補間。
    const dayFactor = smoothstep(-6, 6, altitudeDeg);
    const base = Color3.Lerp(NIGHT_CLEAR_COLOR, DAY_CLEAR_COLOR, dayFactor);
    // 地平線（高度 0°）を中心に三角プロファイルで茜色を強める。±DUSK_BAND_DEG の外では 0。
    const duskFactor =
        Math.max(0, 1 - Math.abs(altitudeDeg) / DUSK_BAND_DEG) * DUSK_STRENGTH;
    return Color3.Lerp(base, DUSK_CLEAR_COLOR, duskFactor);
}
