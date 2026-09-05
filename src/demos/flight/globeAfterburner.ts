/**
 * アフターバーナーエフェクト。
 *
 * `routeLine.ts` と同じ「アンカー（真 ECEF）= メッシュの translation、各頂点はアンカーからの
 * ローカル小座標」パターンで短尺トレイルを自作する。トレイル頂点は常にアンカーとの差分
 * （数十 m）なので float32 で精度十分、translation は floating origin により CPU 側で
 * float64 リベースされる。絶対 ECEF 履歴を保持して毎フレームローカル座標へ変換するため、
 * グリッド原点ジャンプの影響も受けない。
 */

import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { geographicTangentBasisToRef } from "../../terrain/geo/cameraMapping";
import { geodeticToEcefToRef } from "../../terrain/geo/ecef";
import { circularOrbitHeading, circularOrbitPosition } from "../avatar/orbit";

// ─── 型 ─────────────────────────────────────────────────
/**
 * 毎フレームの更新コンテキスト。軌道パラメータから真 ECEF を都度算出して
 * トレイルをリビルドするため、これらの値を受け取る。
 */
export interface AfterburnerUpdateContext {
    /** 軌道の中心緯度 */
    centerLat: number;
    /** 軌道の中心経度 */
    centerLon: number;
    /** 軌道半径 (m) */
    radiusM: number;
    /** 飛行機の絶対標高 (m) */
    altitudeM: number;
    /** 現在の軌道角度 (deg) */
    angleDeg: number;
}

export interface Afterburner {
    /** トレイル生成を開始（Follow モード ON 時に呼ぶ） */
    start(): void;
    /** トレイル生成を停止（Follow モード OFF 時に呼ぶ） */
    stop(): void;
    /** 表示/非表示切替 */
    setVisible(visible: boolean): void;
    /**
     * 毎フレーム更新。軌道パラメータから真 ECEF を算出してトレイルをリビルドする。
     * Follow モードかつモデルロード後に呼ぶこと。
     */
    update(ctx: AfterburnerUpdateContext): void;
    /** リソース解放 */
    dispose(): void;
}

// ─── 調整可能な定数 ─────────────────────────────────────
/** 左右エンジンの横方向オフセット (m) */
const ENGINE_LATERAL_OFFSET_M = 1.4;
/** エンジン位置の後方オフセット (m) */
const ENGINE_REAR_OFFSET_M = 4.5;
/** エンジン位置の垂直オフセット (m) */
const ENGINE_VERTICAL_OFFSET_M = 1.5;
/** トレイルのサンプル点数（履歴フレーム数）。多いほど長く・負荷大 */
const SAMPLE_COUNT = 14;
/** エンジン側（先端）の炎の半幅 (m)。末端へ向けて 0 にテーパーする */
const HALF_WIDTH_HEAD_M = 0.6;

/**
 * 軌道パラメータから左右エンジンの真 ECEF 位置を求めて `leftRef`/`rightRef` に書き込む。
 *
 * 飛行機ローカル基底（Babylon 規約: X=右, Y=上, Z=前方, 後方=-Z）を ENU/ECEF に写像する:
 * - forward(進行方向, 水平) = east·sin(h) + north·cos(h)   （h = compass heading[rad], 0=北）
 * - right                    = east·cos(h) - north·sin(h)
 * - up                       = 地心 up（ECEF 正規化）
 * エンジン位置 = 機体中心 + right·(±lateral) + up·vertical + forward·(-rear)。
 *
 * @returns 接線基底が計算できれば true、極などの特異点で計算不能なら false（呼び出し側は更新スキップ）。
 */
export const computeEngineEcefToRef = (
    centerLat: number,
    centerLon: number,
    radiusM: number,
    altitudeM: number,
    angleDeg: number,
    leftRef: Vector3,
    rightRef: Vector3,
    scratch?: {
        plane: Vector3;
        east: Vector3;
        north: Vector3;
    },
): boolean => {
    const plane = scratch?.plane ?? new Vector3();
    const east = scratch?.east ?? new Vector3();
    const north = scratch?.north ?? new Vector3();

    const planePos = circularOrbitPosition(
        centerLat,
        centerLon,
        radiusM,
        angleDeg,
    );
    geodeticToEcefToRef(planePos.lat, planePos.lon, altitudeM, plane);
    if (!geographicTangentBasisToRef(plane, east, north)) return false;

    const r = plane.length();
    if (r < 1) return false;
    // 地心 up = 機体 ECEF を正規化
    const ux = plane.x / r;
    const uy = plane.y / r;
    const uz = plane.z / r;

    const hRad = (circularOrbitHeading(angleDeg) * Math.PI) / 180;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);

    // forward / right ベクトル（ENU → ECEF）
    const fx = east.x * sinH + north.x * cosH;
    const fy = east.y * sinH + north.y * cosH;
    const fz = east.z * sinH + north.z * cosH;
    const rx = east.x * cosH - north.x * sinH;
    const ry = east.y * cosH - north.y * sinH;
    const rz = east.z * cosH - north.z * sinH;

    // 共通オフセット（上方 + 後方）
    const baseX =
        plane.x + ux * ENGINE_VERTICAL_OFFSET_M - fx * ENGINE_REAR_OFFSET_M;
    const baseY =
        plane.y + uy * ENGINE_VERTICAL_OFFSET_M - fy * ENGINE_REAR_OFFSET_M;
    const baseZ =
        plane.z + uz * ENGINE_VERTICAL_OFFSET_M - fz * ENGINE_REAR_OFFSET_M;

    leftRef.set(
        baseX - rx * ENGINE_LATERAL_OFFSET_M,
        baseY - ry * ENGINE_LATERAL_OFFSET_M,
        baseZ - rz * ENGINE_LATERAL_OFFSET_M,
    );
    rightRef.set(
        baseX + rx * ENGINE_LATERAL_OFFSET_M,
        baseY + ry * ENGINE_LATERAL_OFFSET_M,
        baseZ + rz * ENGINE_LATERAL_OFFSET_M,
    );
    return true;
};

/**
 * トレイル履歴（絶対 ECEF, [0]=末端〜[N-1]=先端/エンジン側）から、アンカー相対のローカル
 * リボン頂点（左右2列）を `outLeft`/`outRight` に書き込む純関数。
 *
 * 各サンプルで進行方向（前後の点の差分）と地心 up の外積から横方向（cross-track）を求め、
 * 先端 `halfWidthHeadM` から末端 0 へテーパーした半幅で左右に振り分ける。
 *
 * @returns 書き込んだサンプル数。
 */
export const buildTrailRibbonLocal = (
    history: Vector3[],
    anchor: Vector3,
    halfWidthHeadM: number,
    outLeft: Vector3[],
    outRight: Vector3[],
): number => {
    const n = history.length;
    for (let i = 0; i < n; i++) {
        const p = history[i];
        const lx = p.x - anchor.x;
        const ly = p.y - anchor.y;
        const lz = p.z - anchor.z;

        // 進行方向（前後の点の差分）
        const a = history[Math.max(0, i - 1)];
        const b = history[Math.min(n - 1, i + 1)];
        const dirX = b.x - a.x;
        const dirY = b.y - a.y;
        const dirZ = b.z - a.z;

        // 地心 up（点 p の正規化）
        const pl = Math.hypot(p.x, p.y, p.z) || 1;
        const ux = p.x / pl;
        const uy = p.y / pl;
        const uz = p.z / pl;

        // 横方向 = normalize(cross(dir, up))
        let perpX = dirY * uz - dirZ * uy;
        let perpY = dirZ * ux - dirX * uz;
        let perpZ = dirX * uy - dirY * ux;
        const perpLen = Math.hypot(perpX, perpY, perpZ);
        if (perpLen < 1e-6) {
            // 退化（静止 or dir∥up）: 幅 0 にして中心線へ畳む
            perpX = 0;
            perpY = 0;
            perpZ = 0;
        } else {
            perpX /= perpLen;
            perpY /= perpLen;
            perpZ /= perpLen;
        }

        // テーパー: 先端(t=1)で halfWidthHeadM、末端(t=0)で 0
        const t = n > 1 ? i / (n - 1) : 1;
        const hw = halfWidthHeadM * t;

        outLeft[i].set(lx - perpX * hw, ly - perpY * hw, lz - perpZ * hw);
        outRight[i].set(lx + perpX * hw, ly + perpY * hw, lz + perpZ * hw);
    }
    return n;
};

/**
 * トレイルのサンプル位置 t(0=末端,1=先端) に対する炎の頂点カラー（RGBA）を返す。
 * 先端は明るい黄、末端へ向けてオレンジ→赤へ落ち、アルファも 0 へフェードする（additive 前提）。
 */
export const computeFlameColor = (t: number): Color4 => {
    // 先端(黄白)→末端(赤)
    const r = 1.0;
    const g = 0.3 + 0.6 * t;
    const b = 0.05 + 0.25 * t;
    // 末端で透明、先端で最も明るい（additive なのでアルファ=寄与度）
    const alpha = t * t;
    return new Color4(r, g, b, alpha);
};

interface TrailRibbon {
    mesh: Mesh;
    pathArray: Vector3[][];
    colorBuffer: Float32Array;
    colorInitialized: boolean;
    history: Vector3[];
}

const createAfterburnerMaterial = (scene: Scene): StandardMaterial => {
    const mat = new StandardMaterial("globe-afterburner-mat", scene);
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(1.0, 0.7, 0.2);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.alpha = 1;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.backFaceCulling = false;
    return mat;
};

/**
 * アフターバーナーを作成する。`Afterburner` インターフェースを実装し、
 * 毎フレーム `update()` で軌道パラメータから真 ECEF を算出してトレイルをリビルドする。
 */
export const createGlobeAfterburner = (scene: Scene): Afterburner => {
    const material = createAfterburnerMaterial(scene);
    let glow: GlowLayer | null = null;
    let ribbons: TrailRibbon[] = [];
    let running = false;
    let visible = true;
    let disposed = false;
    let initialized = false;

    // スクラッチ（毎フレーム allocation を避ける）
    const curLeft = new Vector3();
    const curRight = new Vector3();
    const anchor = new Vector3();
    const scratch = {
        plane: new Vector3(),
        east: new Vector3(),
        north: new Vector3(),
    };

    const makeRibbon = (name: string): TrailRibbon => {
        const left: Vector3[] = [];
        const right: Vector3[] = [];
        const history: Vector3[] = [];
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            left.push(new Vector3());
            right.push(new Vector3());
            history.push(new Vector3());
        }
        const pathArray = [left, right];
        // sideOrientation は既定 (FRONTSIDE)。両面表示は material.backFaceCulling = false で
        // 実現する。DOUBLESIDE は頂点を複製して総頂点数を 2 倍にするため、固定長の頂点カラー
        // バッファ (SAMPLE_COUNT * 2 頂点ぶん) と齟齬が生じ、複製側が未着色（白）のまま
        // additive 合成され、炎が白飛びして正しく表示されない。
        const mesh = CreateRibbon(name, { pathArray, updatable: true }, scene);
        mesh.material = material;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 1;
        mesh.hasVertexAlpha = true;
        mesh.setEnabled(visible);
        return {
            mesh,
            pathArray,
            colorBuffer: new Float32Array(SAMPLE_COUNT * 2 * 4),
            colorInitialized: false,
            history,
        };
    };

    const disposeMeshes = (): void => {
        for (const r of ribbons) r.mesh.dispose();
        ribbons = [];
        glow?.dispose();
        glow = null;
        initialized = false;
    };

    // トレイルは軌道パラメータ（update のコンテキスト）から真 ECEF を都度算出する。
    const start = (): void => {
        if (disposed || running) return;
        disposeMeshes();
        glow = new GlowLayer("globe-afterburner-glow", scene, {
            blurKernelSize: 64,
        });
        glow.intensity = 1.5;
        // [0]=左エンジン, [1]=右エンジン
        ribbons = [
            makeRibbon("globe-afterburner-left"),
            makeRibbon("globe-afterburner-right"),
        ];
        for (const r of ribbons) glow.addIncludedOnlyMesh(r.mesh);
        glow.isEnabled = visible;
        running = true;
        initialized = false;
    };

    const stop = (): void => {
        if (!running) return;
        disposeMeshes();
        running = false;
    };

    /** 全履歴を現在のエンジン位置に揃えてトレイルを畳む（origin ジャンプ後などに呼ぶ）。 */
    const setVisible = (v: boolean): void => {
        visible = v;
        for (const r of ribbons) r.mesh.setEnabled(v);
        if (glow) glow.isEnabled = v;
    };

    const updateRibbon = (r: TrailRibbon, current: Vector3): void => {
        const n = r.history.length;
        if (!initialized) {
            // 履歴を現在位置で初期化（原点→機体の伸びた折れ線を防ぐ）
            for (let i = 0; i < n; i++) r.history[i].copyFrom(current);
        } else {
            // 1フレーム分シフトして末尾（先端）に現在位置を追加
            for (let i = 0; i < n - 1; i++)
                r.history[i].copyFrom(r.history[i + 1]);
            r.history[n - 1].copyFrom(current);
        }

        buildTrailRibbonLocal(
            r.history,
            anchor,
            HALF_WIDTH_HEAD_M,
            r.pathArray[0],
            r.pathArray[1],
        );
        r.mesh.position.copyFrom(anchor);

        CreateRibbon(r.mesh.name, {
            pathArray: r.pathArray,
            updatable: true,
            instance: r.mesh,
        });

        // 頂点カラーは t = i/(n-1)（頂点インデックス）のみに依存しフレーム間で不変なので、
        // 初回のみ計算・アップロードする（毎フレームの allocation と GPU 転送を避ける）。
        if (!r.colorInitialized) {
            for (let i = 0; i < n; i++) {
                const t = n > 1 ? i / (n - 1) : 1;
                const col = computeFlameColor(t);
                const i0 = i * 4;
                const i1 = (n + i) * 4;
                r.colorBuffer[i0] = col.r;
                r.colorBuffer[i0 + 1] = col.g;
                r.colorBuffer[i0 + 2] = col.b;
                r.colorBuffer[i0 + 3] = col.a;
                r.colorBuffer[i1] = col.r;
                r.colorBuffer[i1 + 1] = col.g;
                r.colorBuffer[i1 + 2] = col.b;
                r.colorBuffer[i1 + 3] = col.a;
            }
            r.mesh.setVerticesData(VertexBuffer.ColorKind, r.colorBuffer, true);
            r.colorInitialized = true;
        }
    };

    const update = (ctx: AfterburnerUpdateContext): void => {
        if (!running || ribbons.length < 2) return;
        const ok = computeEngineEcefToRef(
            ctx.centerLat,
            ctx.centerLon,
            ctx.radiusM,
            ctx.altitudeM,
            ctx.angleDeg,
            curLeft,
            curRight,
            scratch,
        );
        if (!ok) return;
        // アンカー = 左右エンジンの中点（先端付近）。
        anchor.set(
            (curLeft.x + curRight.x) * 0.5,
            (curLeft.y + curRight.y) * 0.5,
            (curLeft.z + curRight.z) * 0.5,
        );
        updateRibbon(ribbons[0], curLeft);
        updateRibbon(ribbons[1], curRight);
        initialized = true;
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        stop();
        material.dispose();
    };

    return { start, stop, setVisible, update, dispose };
};
