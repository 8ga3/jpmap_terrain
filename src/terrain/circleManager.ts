/**
 * CircleManager (Issue #201 / #203)。
 *
 * `JpmapTerrain.addCircle / getCircle / removeCircle / setCircle*Enabled / listCircles`
 * から呼び出される（公開 API への wiring は #204 で対応）。
 *
 * - 各 circle を `OverlayContext` 共有のフレームループで毎フレーム位置更新する。
 * - `altitudeMode === "terrain"` のとき、中心または円周点で 1 点でも標高未解決なら
 *   円全体を非表示にする（PolygonManager と同じ方針）。
 * - `altitudeMode === "absolute"` のとき、`center.altitude` を Y として使用する。
 */

import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import {
    assertLatLonInBounds,
    computeDistanceScale,
    latLonToWorld,
    type OverlayContext,
} from "./overlayCoords";
import { createCircleNode, type CircleNode } from "./circle";
import {
    CIRCLE_DEFAULTS,
    CIRCLE_RADIUS_MAX_M,
    CIRCLE_SEGMENTS_MAX,
    CIRCLE_SEGMENTS_MIN,
    type CircleHandle,
    type CircleOptions,
} from "../lib/types";

const ERROR_PREFIX = "JpmapTerrain.addCircle";

export interface CircleManager {
    add(id: string, options: CircleOptions): CircleHandle;
    get(id: string): CircleHandle | null;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    setPointEnabled(id: string, enabled: boolean): void;
    setLineEnabled(id: string, enabled: boolean): void;
    setWallEnabled(id: string, enabled: boolean): void;
    setLabelEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    dispose(): void;
}

/**
 * `addCircle` 時のオプション検証。
 *
 * - 中心の lat/lon が JAPAN_BOUNDS 内であること
 * - radius が `(0, CIRCLE_RADIUS_MAX_M]` の範囲内
 * - segments が `[CIRCLE_SEGMENTS_MIN, CIRCLE_SEGMENTS_MAX]` の範囲内（指定時）
 * - `altitudeMode === "absolute"` のとき `center.altitude` が指定されていること
 */
const validateOptions = (options: CircleOptions): void => {
    if (!options.center) {
        throw new Error(`${ERROR_PREFIX}: center is required`);
    }
    assertLatLonInBounds(
        options.center.lat,
        options.center.lon,
        ERROR_PREFIX,
    );
    if (
        !Number.isFinite(options.radius) ||
        options.radius <= 0 ||
        options.radius > CIRCLE_RADIUS_MAX_M
    ) {
        throw new Error(
            `${ERROR_PREFIX}: radius must be in (0, ${CIRCLE_RADIUS_MAX_M}] m (got ${options.radius})`,
        );
    }
    if (options.segments !== undefined) {
        if (
            !Number.isInteger(options.segments) ||
            options.segments < CIRCLE_SEGMENTS_MIN ||
            options.segments > CIRCLE_SEGMENTS_MAX
        ) {
            throw new Error(
                `${ERROR_PREFIX}: segments must be an integer in [${CIRCLE_SEGMENTS_MIN}, ${CIRCLE_SEGMENTS_MAX}] (got ${options.segments})`,
            );
        }
    }
    const altitudeMode = options.altitudeMode ?? CIRCLE_DEFAULTS.altitudeMode;
    if (altitudeMode === "absolute" && options.center.altitude === undefined) {
        throw new Error(
            `${ERROR_PREFIX}: altitudeMode="absolute" requires center.altitude`,
        );
    }
};

export const createCircleManager = (ctx: OverlayContext): CircleManager => {
    const nodes = new Map<string, CircleNode>();
    let disposed = false;

    /**
     * 1 円の 1 フレーム分更新。
     *
     * - 中心を `latLonToWorld` で求め、terrain なら標高解決。
     * - 円周点は world 平面で polar 展開（緯度補正は `latLonToWorld` の origin 補正で
     *   中心点に対して既に反映済み。半径方向は world m なので追加の補正は不要）。
     * - terrain で 1 点でも未解決なら円全体を非表示。
     */
    const tickCircle = (node: CircleNode): void => {
        const { wx: cwx, wz: cwz } = latLonToWorld(
            ctx,
            node.center.lat,
            node.center.lon,
        );
        const centerOffset = node.center.altitude ?? 0;
        let cy: number;
        if (node.altitudeMode === "absolute") {
            cy = centerOffset;
        } else {
            const elev = ctx.tileManager.queryElevationAtWorld(cwx, cwz);
            if (elev === null) {
                node.setElevationResolved(false);
                return;
            }
            cy = elev + centerOffset;
        }

        // 円周点（world 平面で polar 展開）。
        const segments = node.segments;
        const radius = node.radius;
        const step = (Math.PI * 2) / segments;
        const ringWorld: Vector3[] = [];
        for (let i = 0; i < segments; i++) {
            const θ = i * step;
            const px = cwx + radius * Math.cos(θ);
            const pz = cwz + radius * Math.sin(θ);
            let py: number;
            if (node.altitudeMode === "absolute") {
                py = centerOffset;
            } else {
                const elev = ctx.tileManager.queryElevationAtWorld(px, pz);
                if (elev === null) {
                    node.setElevationResolved(false);
                    return;
                }
                py = elev + centerOffset;
            }
            ringWorld.push(new Vector3(px, py, pz));
        }

        const scale = computeDistanceScale(ctx, cwx, cy, cwz);
        node.setElevationResolved(true);
        node.applyTransform(new Vector3(cwx, cy, cwz), ringWorld, scale);
    };

    const tickFrame = (): void => {
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            tickCircle(node);
        }
    };

    const observer: Observer<Scene> | null =
        ctx.scene.onBeforeRenderObservable.add(tickFrame);

    const unsubscribeTerrain = ctx.tileManager.subscribeTerrainUpdated(() => {
        // tickFrame で次フレームに反映される。明示的な再評価は不要。
    });

    const requireNode = (id: string): CircleNode => {
        const node = nodes.get(id);
        if (!node) {
            throw new Error(`Circle id "${id}" not found`);
        }
        return node;
    };

    return {
        add(id: string, options: CircleOptions): CircleHandle {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            if (nodes.has(id)) {
                throw new Error(
                    `JpmapTerrain.addCircle: id "${id}" already exists`,
                );
            }
            validateOptions(options);
            const node = createCircleNode(ctx.scene, id, options);
            nodes.set(id, node);
            tickCircle(node);
            return node.getHandle();
        },
        get(id: string): CircleHandle | null {
            const node = nodes.get(id);
            return node ? node.getHandle() : null;
        },
        remove(id: string): void {
            const node = nodes.get(id);
            if (!node) {
                console.warn(
                    `[jpmap-terrain] removeCircle: id "${id}" not found`,
                );
                return;
            }
            node.dispose();
            nodes.delete(id);
        },
        setEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            requireNode(id).setEnabledLogical(enabled);
        },
        setPointEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            requireNode(id).setPointEnabledLogical(enabled);
        },
        setLineEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            requireNode(id).setLineEnabledLogical(enabled);
        },
        setWallEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            requireNode(id).setWallEnabledLogical(enabled);
        },
        setLabelEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            requireNode(id).setLabelEnabledLogical(enabled);
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
