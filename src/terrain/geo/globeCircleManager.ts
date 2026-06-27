/**
 * グローブ用サークルマネージャ (Issue #275 Phase 3 / Phase 4 Slice 2b-2)。
 *
 * 平面版（`circleManager` + `circle`）に対する **並行構築** のグローブ実装。中心 + 半径 + 分割数から
 * 円周上の lat/lon 点列を生成し、内部の `GlobePolygonManager` に委譲して描画する。
 *
 * 1 サークルは 2 つのポリゴンノードで構成する:
 * - **ring ノード**: 円周（閉ポリゴン）。アウトライン（線）＋カーテン壁。頂点マーカー/垂線/ラベルは無効。
 * - **center ノード**: 中心 1 点。中心点マーカー＋中心ラベル。線/壁/垂線は無効。
 *
 * これにより planar の「中心点・中心ラベル・円周線・壁」パリティを保ちつつ、polygon の堅牢化
 * （dispose ガード・距離スケール・地形ドレープ）をそのまま享受する。
 */
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

import {
    createGlobePolygonManager,
    type GlobePolygonManager,
    type GlobePolygonManagerDeps,
} from "./globePolygonManager";
import { generateGeodesicRing } from "./overlayPlacement";
import type { AltitudeMode, PolygonStyleOptions } from "../../lib/types";

/** サークルの分割数の既定・範囲。 */
const DEFAULT_SEGMENTS = 64;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 512;

export interface GlobeCircleOptions {
    /** 中心の緯度 [deg]。 */
    centerLat: number;
    /** 中心の経度 [deg]。 */
    centerLon: number;
    /** 半径 [m]（> 0）。 */
    radiusMeters: number;
    /** 円周の分割数（既定 64、[3, 512]）。 */
    segments?: number;
    /** 高度モード。default terrain。 */
    altitudeMode?: AltitudeMode;
    /** 中心高度 [m]。terrain では地表からのオフセット、absolute では楕円体高度。 */
    centerAltitudeMeters?: number;
    /** 中心ラベル文言。null/undefined はラベル無し。 */
    label?: string | null;
    /** スタイル（polygon と共通のキー）。 */
    style?: PolygonStyleOptions;
    /** top を固定する楕円体高度[m]（未指定なら地形ドレープ）。 */
    topAltitudeMeters?: number;
    /** 円全体の表示。default true。 */
    enabled?: boolean;
    /** 中心点マーカーの表示。default true。 */
    pointEnabled?: boolean;
    /** 円周線（アウトライン）の表示。default true。 */
    lineEnabled?: boolean;
    /** 壁（カーテン）の表示。default true。 */
    wallEnabled?: boolean;
    /** 中心ラベルの表示。default true。 */
    labelEnabled?: boolean;
}

export type GlobeCircleManagerDeps = GlobePolygonManagerDeps;

export interface GlobeCircleManager {
    /** サークルを追加し、id を返す。 */
    add(opts: GlobeCircleOptions): string;
    /** サークルを削除する。 */
    remove(id: string): void;
    /** 表示/非表示を切り替える（中心点・円周線・壁・ラベルをまとめて）。 */
    setEnabled(id: string, enabled: boolean): void;
    /**
     * 2D（トップダウン正射）縮退の有効/無効を切り替える (#395)。内部ポリゴンへ委譲し、
     * `true` で壁（カーテン）を無効化して接地リングのみを残す。`false` で復元する。
     */
    setFlatten(flat: boolean): void;
    /** 毎フレーム: 地形へ再ドレープし距離スケールを更新する。 */
    update(cameraEcef?: Vector3, flatScale?: number): void;
    /** 全サークルを破棄する。 */
    dispose(): void;
}

interface CircleEntry {
    ringId: string;
    centerId: string;
}

/**
 * グローブ用サークルマネージャを生成する（内部に専用の `GlobePolygonManager` を持つ）。
 */
export const createGlobeCircleManager = (
    deps: GlobeCircleManagerDeps,
): GlobeCircleManager => {
    // サークル専用のポリゴンマネージャ（ユーザーポリゴンとは別インスタンス）。
    const polygons: GlobePolygonManager = createGlobePolygonManager(deps);
    const entries = new Map<string, CircleEntry>();
    let seq = 0;
    let disposed = false;

    const add = (opts: GlobeCircleOptions): string => {
        if (disposed) throw new Error("GlobeCircleManager.add: called after dispose");
        if (!(opts.radiusMeters > 0)) {
            throw new Error(
                `GlobeCircleManager.add: radiusMeters must be > 0 (got ${opts.radiusMeters})`,
            );
        }
        const segments = opts.segments ?? DEFAULT_SEGMENTS;
        if (!Number.isInteger(segments) || segments < MIN_SEGMENTS || segments > MAX_SEGMENTS) {
            throw new Error(
                `GlobeCircleManager.add: segments must be an integer in [${MIN_SEGMENTS}, ${MAX_SEGMENTS}] (got ${segments})`,
            );
        }
        const altitudeMode = opts.altitudeMode ?? "terrain";
        const altitude = opts.centerAltitudeMeters;
        // absolute は高度を一意に決める必要がある。centerAltitudeMeters / topAltitudeMeters の
        // いずれも無いと暗黙に 0m 扱いになり誤用を見逃すため、ここで早期 throw する
        // （public CircleManager の absolute=center.altitude 必須と整合）。
        if (
            altitudeMode === "absolute" &&
            altitude == null &&
            opts.topAltitudeMeters == null
        ) {
            throw new Error(
                'GlobeCircleManager.add: altitudeMode="absolute" requires centerAltitudeMeters (or topAltitudeMeters)',
            );
        }
        const enabled = opts.enabled ?? true;
        const wallEnabled = opts.wallEnabled ?? true;
        const ringPoints = generateGeodesicRing(
            opts.centerLat,
            opts.centerLon,
            opts.radiusMeters,
            segments,
        ).map((p) => ({ lat: p.lat, lon: p.lon, altitude }));

        // ring ノード: 円周線 + 壁。頂点マーカー/垂線/ラベルは無効。
        const ringId = polygons.add({
            points: ringPoints,
            closed: true,
            altitudeMode,
            topAltitudeMeters: opts.topAltitudeMeters,
            style: opts.style,
            pointsEnabled: false,
            verticalsEnabled: false,
            labelsEnabled: false,
            lineEnabled: opts.lineEnabled ?? true,
            wallsEnabled: wallEnabled,
            enabled,
        });

        // center ノード: 中心点マーカー + 中心ラベル。線/壁/垂線は無効。
        const hasLabel = opts.label != null && (opts.labelEnabled ?? true);
        const centerId = polygons.add({
            points: [{ lat: opts.centerLat, lon: opts.centerLon, altitude }],
            closed: false,
            altitudeMode,
            topAltitudeMeters: opts.topAltitudeMeters,
            style: opts.style,
            labels: hasLabel ? [opts.label as string] : undefined,
            pointsEnabled: opts.pointEnabled ?? true,
            verticalsEnabled: false,
            labelsEnabled: hasLabel,
            lineEnabled: false,
            wallsEnabled: false,
            enabled,
        });

        const id = `globe-circle-${seq++}`;
        entries.set(id, { ringId, centerId });
        return id;
    };

    const remove = (id: string): void => {
        const e = entries.get(id);
        if (!e) {
            console.warn(`[globe-circle] remove: id "${id}" not found`);
            return;
        }
        polygons.remove(e.ringId);
        polygons.remove(e.centerId);
        entries.delete(id);
    };

    const setEnabled = (id: string, enabled: boolean): void => {
        const e = entries.get(id);
        if (!e) {
            console.warn(`[globe-circle] setEnabled: id "${id}" not found`);
            return;
        }
        polygons.setEnabled(e.ringId, enabled);
        polygons.setEnabled(e.centerId, enabled);
    };

    return {
        add,
        remove,
        setEnabled,
        setFlatten: (flat) => polygons.setFlatten(flat),
        update: (cameraEcef, flatScale) => polygons.update(cameraEcef, flatScale),
        dispose: () => {
            disposed = true;
            polygons.dispose();
            entries.clear();
        },
    };
};
