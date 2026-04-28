/**
 * MarkerManager (Issue #167)。
 *
 * `JpmapTerrain.addMarker / updateMarker / removeMarker / setMarkerEnabled / listMarkers / getMarker`
 * から呼び出される。マーカーの ID 管理・スタブ標高解決・毎フレームの位置更新を担う。
 */

import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import { JAPAN_BOUNDS } from "./gsiTile";
import { createMarkerNode, type MarkerNode } from "./marker";
import { METERS_PER_DEGREE_LAT, type MarkerContext } from "../scenes/default";
import type {
    MarkerHandle,
    MarkerOptions,
    MarkerUpdate,
} from "../lib/types";

export interface MarkerManager {
    add(id: string, options: MarkerOptions): MarkerHandle;
    get(id: string): MarkerHandle | null;
    update(id: string, partial: MarkerUpdate): MarkerHandle;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    dispose(): void;
}

const assertInBounds = (lat: number, lon: number): void => {
    if (
        lat < JAPAN_BOUNDS.minLat ||
        lat > JAPAN_BOUNDS.maxLat ||
        lon < JAPAN_BOUNDS.minLon ||
        lon > JAPAN_BOUNDS.maxLon
    ) {
        throw new Error(
            `marker: lat/lon out of JAPAN_BOUNDS (lat=${lat}, lon=${lon})`,
        );
    }
};

export const createMarkerManager = (ctx: MarkerContext): MarkerManager => {
    const nodes = new Map<string, MarkerNode>();

    const computeWorld = (
        lat: number,
        lon: number,
    ): { wx: number; wz: number } => {
        const origin = ctx.getOrigin();
        const metersPerDegLon =
            METERS_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
        const wx = (lon - origin.lon) * metersPerDegLon + origin.gridResidualX;
        const wz = (lat - origin.lat) * METERS_PER_DEGREE_LAT + origin.gridResidualZ;
        return { wx, wz };
    };

    /**
     * スケール基準距離 (m)。カメラ距離がこの値なら scale=1、それ以上は distance/refDistance
     * 倍してスクリーン空間サイズを一定に保つ。
     */
    const REF_DISTANCE_M = 1000;

    const computeDistScale = (wx: number, wy: number, wz: number): number => {
        const cam = ctx.getCameraPosition();
        const dx = cam.x - wx;
        const dy = cam.y - wy;
        const dz = cam.z - wz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const scale = dist / REF_DISTANCE_M;
        // 近すぎるとテクスチャ補間が荷重になるため下限を設ける
        return Math.max(scale, 0.1);
    };

    /**
     * 動的な線高さ (m) をカメラ位置と beta 角度から計算する。
     *
     * 画面中央付近にマーカーが表示されるよう、カメラ距離 (radius) に対して
     * 一定割合の高さにしつつ、仰角 (beta=真上が 0、水平が π/2) で豊かに調整する。
     * - radius * 0.1 をベースとし、sin(beta) で 0.3 〜1.0 にクランプした係数を掛ける。
     * - 下限 100m、上限 10000m で見た目の肉付きを安定させる。
     */
    const computeDynamicLineHeight = (): number => {
        const cam = ctx.getCameraPosition();
        const radius = Math.max(cam.radius, 1);
        const sinBeta = Math.sin(cam.beta);
        const factor = Math.min(1, Math.max(0.3, sinBeta));
        const h = radius * 0.1 * factor;
        return Math.min(10000, Math.max(100, h));
    };

    const tickFrame = (): void => {
        if (nodes.size === 0) return;
        const dynamicLineHeight = computeDynamicLineHeight();
        for (const node of nodes.values()) {
            const { wx, wz } = computeWorld(node.lat, node.lon);
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            if (elev === null) {
                node.setElevationResolved(false);
                continue;
            }
            node.setElevationResolved(true);
            const scale = computeDistScale(wx, elev, wz);
            node.applyTransform(wx, elev, wz, scale, dynamicLineHeight);
        }
    };

    const observer: Observer<Scene> | null =
        ctx.scene.onBeforeRenderObservable.add(tickFrame);

    const unsubscribeTerrain = ctx.tileManager.subscribeTerrainUpdated(() => {
        // 標高更新があれば次フレームに即時反映するため何もしない（tickFrame で再評価）。
        // 明示的にここで再評価したい場合は tickFrame() を呼んでも良いが、
        // scene.onBeforeRender で十分早いので副次効果を避けて noop。
    });

    let disposed = false;

    const requireNode = (id: string): MarkerNode => {
        const node = nodes.get(id);
        if (!node) {
            throw new Error(`Marker id "${id}" not found`);
        }
        return node;
    };

    return {
        add(id: string, options: MarkerOptions): MarkerHandle {
            if (disposed) {
                throw new Error("MarkerManager has been disposed");
            }
            if (nodes.has(id)) {
                throw new Error(
                    `JpmapTerrain.addMarker: id "${id}" already exists`,
                );
            }
            assertInBounds(options.lat, options.lon);
            const node = createMarkerNode(ctx.scene, id, options);
            nodes.set(id, node);
            // 初回 tick で標高解決を試みる
            const { wx, wz } = computeWorld(options.lat, options.lon);
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            if (elev !== null) {
                node.setElevationResolved(true);
                const scale = computeDistScale(wx, elev, wz);
                const dynamicLineHeight = computeDynamicLineHeight();
                node.applyTransform(wx, elev, wz, scale, dynamicLineHeight);
            }
            return node.getHandle();
        },
        get(id: string): MarkerHandle | null {
            const node = nodes.get(id);
            return node ? node.getHandle() : null;
        },
        update(id: string, partial: MarkerUpdate): MarkerHandle {
            if (disposed) {
                throw new Error("MarkerManager has been disposed");
            }
            const node = requireNode(id);
            const newLat = partial.lat ?? node.lat;
            const newLon = partial.lon ?? node.lon;
            const latLonChanged =
                partial.lat !== undefined || partial.lon !== undefined;
            if (latLonChanged) {
                assertInBounds(newLat, newLon);
            }
            node.update(partial, newLat, newLon);
            if (latLonChanged) {
                node.setElevationResolved(false);
            }
            return node.getHandle();
        },
        remove(id: string): void {
            const node = nodes.get(id);
            if (!node) {
                console.warn(
                    `[jpmap-terrain] removeMarker: id "${id}" not found`,
                );
                return;
            }
            node.dispose();
            nodes.delete(id);
        },
        setEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("MarkerManager has been disposed");
            }
            const node = requireNode(id);
            node.setEnabledLogical(enabled);
        },
        list(): readonly string[] {
            return Array.from(nodes.keys());
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            if (observer) {
                ctx.scene.onBeforeRenderObservable.remove(observer);
            }
            unsubscribeTerrain();
            for (const node of nodes.values()) {
                node.dispose();
            }
            nodes.clear();
        },
    };
};
