/**
 * フライトルートライン (Issue #265)。
 *
 * 飛行機の前方に「これから飛行するルート」を半透明のリボン（帯）として描画する。
 *
 * 仕様:
 * - 飛行機先頭から ROUTE_START_OFFSET_M 先から描画開始
 * - ROUTE_LENGTH_M 分だけ表示
 * - 両端が徐々に透明にフェード
 * - グラデーションカラーアニメーション
 * - Babylon.js CreateRibbon + StandardMaterial + 頂点カラーで実装
 */

import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";

import { circularOrbitPosition, circularOrbitHeading } from "../avatar/orbit";
import { geodeticToEcefToRef } from "../../terrain/geo/ecef";
import { geographicTangentBasisToRef } from "../../terrain/geo/cameraMapping";

// ─── 調整可能な定数 ─────────────────────────────────────
/** 飛行機中心から先頭までの距離 (m) */
const NOSE_OFFSET_M = 5;
/** 先頭からルートライン開始までのギャップ (m) */
const START_GAP_M = 2;
/** ルートライン開始地点 = 中心から前方への距離 (m) */
const ROUTE_START_OFFSET_M = NOSE_OFFSET_M + START_GAP_M;
/** ルートラインの表示距離 (m) */
const ROUTE_LENGTH_M = 400;
/** リボンの幅 (m)。進行方向に対して左右に半幅ずつ広がる */
const RIBBON_HALF_WIDTH_M = 3;
/** 経路上のサンプル点数（固定）。多いほど滑らか・負荷大 */
const SAMPLE_COUNT = 40;
/** リボンを飛行機のわずか下に配置し Follow カメラからの視認性を上げる (m) */
const RIBBON_Y_OFFSET_M = -2;

// ─── フェード区間 ─────────────────────────────────────
/** 先端フェード区間の割合 (0-1)。飛行機側 15% でフェードイン */
const FADE_IN_RATIO = 0.15;
/** 末端フェード区間の割合 (0-1)。末尾 25% でフェードアウト */
const FADE_OUT_RATIO = 0.25;

// ─── 型 ─────────────────────────────────────────────────
export interface RouteLineContext {
    scene: Scene;
    /** 現在の軌道角度 (deg) */
    angleDeg: number;
    /** 軌道の中心緯度 */
    centerLat: number;
    /** 軌道の中心経度 */
    centerLon: number;
    /** 軌道半径 (m) */
    radiusM: number;
    /** 飛行機の絶対標高 (m)。頂点 ECEF 計算に使用 */
    altitudeM?: number;
}

export interface RouteLine {
    /** 毎フレーム呼び出してリボンを更新する */
    update(ctx: RouteLineContext, time: number): void;
    /** リボンの表示/非表示を切り替える */
    setVisible(visible: boolean): void;
    /** リソース解放 */
    dispose(): void;
}

/** smoothstep helper */
const smoothstep = (edge0: number, edge1: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

/**
 * グラデーションカラーを t (0-1) と time から計算する。
 * 3色グラデーション (cyan → magenta → yellow) を時間でスクロールし、
 * 両端を smoothstep でフェードアウトする。
 */
const computeGradientColor = (t: number, timeSec: number): Color4 => {
    const phase = ((t * 2.0 + timeSec * 0.4) % 1.0 + 1.0) % 1.0;
    const c1 = { r: 0.0, g: 0.8, b: 1.0 };
    const c2 = { r: 1.0, g: 0.2, b: 0.6 };
    const c3 = { r: 1.0, g: 0.9, b: 0.1 };

    let r: number, g: number, b: number;
    if (phase < 0.5) {
        const f = phase * 2.0;
        r = c1.r + (c2.r - c1.r) * f;
        g = c1.g + (c2.g - c1.g) * f;
        b = c1.b + (c2.b - c1.b) * f;
    } else {
        const f = (phase - 0.5) * 2.0;
        r = c2.r + (c3.r - c2.r) * f;
        g = c2.g + (c3.g - c2.g) * f;
        b = c2.b + (c3.b - c2.b) * f;
    }

    // t=0 (飛行機側) は透明 → t が進むほど不透明、末端で再びフェードアウト
    const alphaStart = smoothstep(0, FADE_IN_RATIO, t);
    const alphaEnd = smoothstep(0, FADE_OUT_RATIO, 1.0 - t);
    const alpha = alphaStart * alphaEnd * 0.8;

    return new Color4(r, g, b, alpha);
};

/**
 * ルートラインを作成する。
 * 呼び出し側は毎フレーム `update()` を呼ぶこと。
 */
export const createRouteLine = (scene: Scene): RouteLine => {
    // StandardMaterial + 頂点カラー (hasVertexAlpha) で
    // グラデーション + アルファフェードを実現する。
    const material = new StandardMaterial("flightRouteMat", scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.White();
    material.backFaceCulling = false;
    material.alpha = 1;

    // 初期 Ribbon 用のダミーパス（2列、SAMPLE_COUNT 点ずつ）
    const initPath = (): Vector3[][] => {
        const left: Vector3[] = [];
        const right: Vector3[] = [];
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            left.push(new Vector3(0, 0, 0));
            right.push(new Vector3(0, 0, 0));
        }
        return [left, right];
    };

    const pathArray = initPath();

    const ribbon: Mesh = CreateRibbon(
        "flightRouteRibbon",
        { pathArray, updatable: true, sideOrientation: Mesh.DOUBLESIDE },
        scene,
    );
    ribbon.material = material;
    ribbon.isPickable = false;
    ribbon.alwaysSelectAsActiveMesh = true;
    ribbon.hasVertexAlpha = true;

    // 頂点カラーバッファ: 固定長 Float32Array を再利用して GC を抑制
    // 頂点数 = SAMPLE_COUNT * 2 (path0 + path1)、各頂点 RGBA 4 要素
    const colorBuffer = new Float32Array(SAMPLE_COUNT * 2 * 4);
    let colorBufferInitialized = false;

    // globe モード用の再利用スクラッチ（毎フレーム allocation を避ける）
    const gEcef = new Vector3();
    const gEast = new Vector3();
    const gNorth = new Vector3();
    const gAnchor = new Vector3();

    const update = (ctx: RouteLineContext, time: number): void => {
        const { angleDeg, centerLat, centerLon, radiusM } = ctx;
        const altitudeM = ctx.altitudeM ?? 0;

        const startArcLen = ROUTE_START_OFFSET_M;
        const endArcLen = ROUTE_START_OFFSET_M + ROUTE_LENGTH_M;

        // 飛行機の現在 lat/lon
        const planePos = circularOrbitPosition(centerLat, centerLon, radiusM, angleDeg);

        // リボンは機体直近（近接）のため、頂点を真の ECEF（~6.4e6）で焼くと
        // float32 精度（~0.5m）のジッターが目立つ。そこで機体直下を **アンカー（真の
        // ECEF）= リボンメッシュの position（translation）** とし、各頂点はアンカーからの
        // **ローカル小座標** で表現する。translation は floating origin により CPU 側で
        // float64 リベースされ、頂点（数百 m）は float32 でも精度十分でジッターを抑えられる。
        geodeticToEcefToRef(planePos.lat, planePos.lon, altitudeM, gAnchor);
        ribbon.position.copyFrom(gAnchor);

        const timeSec = time * 0.001;

        for (let i = 0; i < SAMPLE_COUNT; i++) {
            const t = i / (SAMPLE_COUNT - 1); // 0..1
            const arcLen = startArcLen + t * (endArcLen - startArcLen);

            // 弧長を角度に変換 (時計回り)
            const deltaAngleDeg = (arcLen / radiusM) * (180 / Math.PI);
            const futureAngle = angleDeg + deltaAngleDeg;

            // 未来の位置を lat/lon で計算
            const futurePos = circularOrbitPosition(centerLat, centerLon, radiusM, futureAngle);

            // 未来点での接線方向（進行方向に垂直にリボン幅を出す）
            const futureHeading = circularOrbitHeading(futureAngle);
            const fhRad = (futureHeading * Math.PI) / 180;
            const perpX = Math.cos(fhRad);
            const perpZ = -Math.sin(fhRad);

            // 未来点の真の ECEF を求め、アンカーからのローカル小座標に変換する。
            geodeticToEcefToRef(
                futurePos.lat,
                futurePos.lon,
                altitudeM + RIBBON_Y_OFFSET_M,
                gEcef,
            );
            if (!geographicTangentBasisToRef(gEcef, gEast, gNorth)) {
                continue;
            }
            // アンカー相対のローカル座標（数百 m オーダー）。
            const lx = gEcef.x - gAnchor.x;
            const ly = gEcef.y - gAnchor.y;
            const lz = gEcef.z - gAnchor.z;
            // perp(perpX=east, perpZ=north) を ENU 基底に写像する。
            const px =
                gEast.x * perpX * RIBBON_HALF_WIDTH_M +
                gNorth.x * perpZ * RIBBON_HALF_WIDTH_M;
            const py =
                gEast.y * perpX * RIBBON_HALF_WIDTH_M +
                gNorth.y * perpZ * RIBBON_HALF_WIDTH_M;
            const pz =
                gEast.z * perpX * RIBBON_HALF_WIDTH_M +
                gNorth.z * perpZ * RIBBON_HALF_WIDTH_M;
            pathArray[0][i].set(lx - px, ly - py, lz - pz);
            pathArray[1][i].set(lx + px, ly + py, lz + pz);

            // 頂点カラーを colorBuffer に直接書き込み (path0[i], path1[i] それぞれ)
            const col = computeGradientColor(t, timeSec);
            const idx0 = i * 4;                      // path0 側
            const idx1 = (SAMPLE_COUNT + i) * 4;     // path1 側
            colorBuffer[idx0] = col.r;
            colorBuffer[idx0 + 1] = col.g;
            colorBuffer[idx0 + 2] = col.b;
            colorBuffer[idx0 + 3] = col.a;
            colorBuffer[idx1] = col.r;
            colorBuffer[idx1 + 1] = col.g;
            colorBuffer[idx1 + 2] = col.b;
            colorBuffer[idx1 + 3] = col.a;
        }

        // Ribbon を更新 (instance 指定時は同じ Mesh が返る)
        CreateRibbon(
            "flightRouteRibbon",
            { pathArray, updatable: true, instance: ribbon },
        );

        // 頂点カラーバッファを更新
        if (!colorBufferInitialized) {
            ribbon.setVerticesData(VertexBuffer.ColorKind, colorBuffer, true);
            colorBufferInitialized = true;
        } else {
            ribbon.updateVerticesData(VertexBuffer.ColorKind, colorBuffer);
        }
    };

    const setVisible = (visible: boolean): void => {
        ribbon.setEnabled(visible);
    };

    const dispose = (): void => {
        ribbon.dispose();
        material.dispose();
    };

    return { update, setVisible, dispose };
};
