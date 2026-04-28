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
            `addMarker: lat/lon out of JAPAN_BOUNDS (lat=${lat}, lon=${lon})`,
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

    const tickFrame = (): void => {
        for (const node of nodes.values()) {
            const { wx, wz } = computeWorld(node.lat, node.lon);
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            if (elev === null) {
                node.setElevationResolved(false);
                continue;
            }
            node.setElevationResolved(true);
            node.applyTransform(wx, elev, wz);
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
                node.applyTransform(wx, elev, wz);
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
