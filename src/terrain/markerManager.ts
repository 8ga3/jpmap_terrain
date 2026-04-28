/**
 * MarkerManager (Issue #167)。
 *
 * `JpmapTerrain.addMarker / updateMarker / removeMarker / setMarkerEnabled / listMarkers / getMarker`
 * から呼び出される。マーカーの ID 管理・スタブ標高解決・毎フレームの位置更新を担う。
 *
 * Issue #170 で座標系ユーティリティを `./overlayCoords` に分離したが、
 * `MarkerManager` の挙動は不変。
 */

import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import { createMarkerNode, type MarkerNode } from "./marker";
import {
    assertLatLonInBounds,
    computeDistanceScale,
    computeDynamicLineHeight,
    latLonToWorld,
} from "./overlayCoords";
import { type MarkerContext } from "../scenes/default";
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

const ERROR_PREFIX = "marker";

export const createMarkerManager = (ctx: MarkerContext): MarkerManager => {
    const nodes = new Map<string, MarkerNode>();

    const tickFrame = (): void => {
        if (nodes.size === 0) return;
        const dynamicLineHeight = computeDynamicLineHeight(ctx);
        for (const node of nodes.values()) {
            const { wx, wz } = latLonToWorld(ctx, node.lat, node.lon);
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            if (elev === null) {
                node.setElevationResolved(false);
                continue;
            }
            node.setElevationResolved(true);
            const scale = computeDistanceScale(ctx, wx, elev, wz);
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
            assertLatLonInBounds(options.lat, options.lon, ERROR_PREFIX);
            const node = createMarkerNode(ctx.scene, id, options);
            nodes.set(id, node);
            // 初回 tick で標高解決を試みる
            const { wx, wz } = latLonToWorld(ctx, options.lat, options.lon);
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            if (elev !== null) {
                node.setElevationResolved(true);
                const scale = computeDistanceScale(ctx, wx, elev, wz);
                const dynamicLineHeight = computeDynamicLineHeight(ctx);
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
                assertLatLonInBounds(newLat, newLon, ERROR_PREFIX);
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
