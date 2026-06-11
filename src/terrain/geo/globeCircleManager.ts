/**
 * グローブ用サークルマネージャ (Issue #275 Phase 3, circle スライス)。
 *
 * 平面版（`circleManager` + `circle`）に対する **並行構築** のグローブ実装。中心 + 半径 + 分割数から
 * 円周上の lat/lon 点列を生成し、**閉じたポリゴン**として `globePolygonManager` に委譲して描画する
 * （アウトライン＋地心 up カーテン壁・地形ドレープ・深度交差は polygon と共通）。これにより
 * 円専用の描画コードを重複させず、polygon の堅牢化（dispose ガード等）をそのまま享受する。
 */
import {
    createGlobePolygonManager,
    type GlobePolygonManagerDeps,
} from "./globePolygonManager";
import { generateGeodesicRing } from "./overlayPlacement";

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
    /** アウトライン色（hex）。 */
    outlineColor?: string;
    /** 壁色（hex）。 */
    wallColor?: string;
    /** 壁の不透明度 [0,1]。 */
    wallOpacity?: number;
    /** 壁（カーテン）の表示。default true。 */
    wallsEnabled?: boolean;
    /** top を固定する楕円体高度[m]（未指定なら地形ドレープ）。 */
    topAltitudeMeters?: number;
    /** default true。 */
    enabled?: boolean;
}

export type GlobeCircleManagerDeps = GlobePolygonManagerDeps;

export interface GlobeCircleManager {
    /** サークルを追加し、id を返す。 */
    add(opts: GlobeCircleOptions): string;
    /** サークルを削除する。 */
    remove(id: string): void;
    /** 表示/非表示を切り替える。 */
    setEnabled(id: string, enabled: boolean): void;
    /** 毎フレーム: 地形へ再ドレープ。 */
    update(): void;
    /** 全サークルを破棄する。 */
    dispose(): void;
}

/**
 * グローブ用サークルマネージャを生成する（内部に専用の `GlobePolygonManager` を持つ）。
 */
export const createGlobeCircleManager = (
    deps: GlobeCircleManagerDeps,
): GlobeCircleManager => {
    // サークル専用のポリゴンマネージャ（ユーザーポリゴンとは別インスタンス）。
    const polygons = createGlobePolygonManager(deps);

    const add = (opts: GlobeCircleOptions): string => {
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
        const points = generateGeodesicRing(
            opts.centerLat,
            opts.centerLon,
            opts.radiusMeters,
            segments,
        );
        // 閉じたポリゴンとして描画（始点・終点を結ぶ）。スタイルはそのまま委譲。
        return polygons.add({
            points,
            closed: true,
            outlineColor: opts.outlineColor,
            wallColor: opts.wallColor,
            wallOpacity: opts.wallOpacity,
            pointsEnabled: false,
            verticalsEnabled: false,
            labelsEnabled: false,
            wallsEnabled: opts.wallsEnabled,
            topAltitudeMeters: opts.topAltitudeMeters,
            enabled: opts.enabled,
        });
    };

    return {
        add,
        remove: (id) => polygons.remove(id),
        setEnabled: (id, enabled) => polygons.setEnabled(id, enabled),
        update: () => polygons.update(),
        dispose: () => polygons.dispose(),
    };
};
