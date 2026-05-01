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
    type CircleUpdate,
} from "../lib/types";

const ERROR_PREFIX = "JpmapTerrain.addCircle";
const UPDATE_ERROR_PREFIX = "JpmapTerrain.updateCircle";

export interface CircleManager {
    add(id: string, options: CircleOptions): CircleHandle;
    update(id: string, partial: CircleUpdate): CircleHandle;
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
    /** add 時に渡された完全な CircleOptions（update 時の差分マージ元）。 */
    const storedOptions = new Map<string, CircleOptions>();
    let disposed = false;

    /**
     * 円ごとのジオメトリキャッシュ。
     *
     * - `cwx`/`cwz`/`ringXZ`: center / ring の world XZ。add 時に 1 回だけ計算し、
     *   center・radius・segments が変わらない限り再計算不要。
     * - `centerWorld`/`ringWorld`: 標高解決済みの world 座標。未解決なら null。
     *   terrain タイル更新イベント時に再解決する。
     */
    interface CircleCache {
        cwx: number;
        cwz: number;
        ringXZ: { x: number; z: number }[];
        centerWorld: Vector3 | null;
        ringWorld: readonly Vector3[] | null;
    }
    const caches = new Map<string, CircleCache>();

    /**
     * 標高を解決して `cache` を更新し、解決済みなら `node.applyTransform` を呼ぶ。
     *
     * - terrain モード: 中心 + 全円周点の標高を `queryElevationAtWorld` で取得。
     *   1 点でも null なら `elevationResolved=false` にして処理を終了する。
     * - absolute モード: 標高クエリ不要。`center.altitude` を Y として使う。
     */
    const resolveElevations = (node: CircleNode, cache: CircleCache): void => {
        const { cwx, cwz, ringXZ } = cache;
        const centerOffset = node.center.altitude ?? 0;

        if (node.altitudeMode === "absolute") {
            const cy = centerOffset;
            const centerWorld = new Vector3(cwx, cy, cwz);
            const ringWorld = ringXZ.map(({ x, z }) => new Vector3(x, cy, z));
            cache.centerWorld = centerWorld;
            cache.ringWorld = ringWorld;
            node.setElevationResolved(true);
            node.applyTransform(
                centerWorld,
                ringWorld,
                computeDistanceScale(ctx, cwx, cy, cwz),
            );
            return;
        }

        // terrain モード
        const elevCenter = ctx.tileManager.queryElevationAtWorld(cwx, cwz);
        if (elevCenter === null) {
            cache.centerWorld = null;
            cache.ringWorld = null;
            node.setElevationResolved(false);
            return;
        }
        const cy = elevCenter + centerOffset;
        const ringWorld: Vector3[] = [];
        for (const { x, z } of ringXZ) {
            const elev = ctx.tileManager.queryElevationAtWorld(x, z);
            if (elev === null) {
                cache.centerWorld = null;
                cache.ringWorld = null;
                node.setElevationResolved(false);
                return;
            }
            ringWorld.push(new Vector3(x, elev + centerOffset, z));
        }
        const centerWorld = new Vector3(cwx, cy, cwz);
        cache.centerWorld = centerWorld;
        cache.ringWorld = ringWorld;
        node.setElevationResolved(true);
        node.applyTransform(
            centerWorld,
            ringWorld,
            computeDistanceScale(ctx, cwx, cy, cwz),
        );
    };

    /**
     * フレームループ。
     *
     * 標高解決はキャッシュ済みの値を使い、ラベルがカメラ方向を追従するために
     * 毎フレーム `applyTransform` を呼ぶ（`pointScale` のみ更新）。
     * 標高未解決の円はスキップする。
     */
    const tickFrame = (): void => {
        if (nodes.size === 0) return;
        for (const [id, node] of nodes) {
            const cache = caches.get(id);
            if (!cache || cache.centerWorld === null || cache.ringWorld === null)
                continue;
            const scale = computeDistanceScale(
                ctx,
                cache.cwx,
                cache.centerWorld.y,
                cache.cwz,
            );
            node.applyTransform(cache.centerWorld, cache.ringWorld, scale);
        }
    };

    const observer: Observer<Scene> | null =
        ctx.scene.onBeforeRenderObservable.add(tickFrame);

    // タイル更新イベント時に全円の標高を再解決する。
    const unsubscribeTerrain = ctx.tileManager.subscribeTerrainUpdated(() => {
        for (const [id, node] of nodes) {
            const cache = caches.get(id);
            if (cache) resolveElevations(node, cache);
        }
    });

    const requireNode = (id: string): CircleNode => {
        const node = nodes.get(id);
        if (!node) {
            throw new Error(`Circle id "${id}" not found`);
        }
        return node;
    };

    /**
     * center / radius / segments から ring XZ キャッシュを構築し、標高解決を行う。
     * `add` と `update`（ジオメトリ変化時）の共通処理。
     */
    const buildCacheAndResolve = (id: string, node: CircleNode): void => {
        const { wx: cwx, wz: cwz } = latLonToWorld(
            ctx,
            node.center.lat,
            node.center.lon,
        );
        const segments = node.segments;
        const radius = node.radius;
        const step = (Math.PI * 2) / segments;
        const ringXZ: { x: number; z: number }[] = [];
        for (let i = 0; i < segments; i++) {
            const θ = i * step;
            ringXZ.push({
                x: cwx + radius * Math.cos(θ),
                z: cwz + radius * Math.sin(θ),
            });
        }
        const cache: CircleCache = {
            cwx,
            cwz,
            ringXZ,
            centerWorld: null,
            ringWorld: null,
        };
        caches.set(id, cache);
        resolveElevations(node, cache);
    };

    /**
     * `CircleUpdate` で指定されたフィールドのバリデーション。
     * `addCircle` と同一のルールを適用するが、未指定のフィールドはスキップする。
     */
    const validatePartial = (
        partial: CircleUpdate,
        currentNode: CircleNode,
    ): void => {
        if (partial.center !== undefined) {
            assertLatLonInBounds(
                partial.center.lat,
                partial.center.lon,
                UPDATE_ERROR_PREFIX,
            );
        }
        if (partial.radius !== undefined) {
            if (
                !Number.isFinite(partial.radius) ||
                partial.radius <= 0 ||
                partial.radius > CIRCLE_RADIUS_MAX_M
            ) {
                throw new Error(
                    `${UPDATE_ERROR_PREFIX}: radius must be in (0, ${CIRCLE_RADIUS_MAX_M}] m (got ${partial.radius})`,
                );
            }
        }
        if (partial.segments !== undefined) {
            if (
                !Number.isInteger(partial.segments) ||
                partial.segments < CIRCLE_SEGMENTS_MIN ||
                partial.segments > CIRCLE_SEGMENTS_MAX
            ) {
                throw new Error(
                    `${UPDATE_ERROR_PREFIX}: segments must be an integer in [${CIRCLE_SEGMENTS_MIN}, ${CIRCLE_SEGMENTS_MAX}] (got ${partial.segments})`,
                );
            }
        }
        // altitudeMode → absolute 切替時に center.altitude が必要
        const nextMode =
            partial.altitudeMode ?? currentNode.altitudeMode;
        const nextCenter = partial.center ?? currentNode.center;
        if (nextMode === "absolute" && nextCenter.altitude === undefined) {
            throw new Error(
                `${UPDATE_ERROR_PREFIX}: altitudeMode="absolute" requires center.altitude`,
            );
        }
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
            storedOptions.set(id, { ...options, center: { ...options.center } });
            buildCacheAndResolve(id, node);
            return node.getHandle();
        },
        update(id: string, partial: CircleUpdate): CircleHandle {
            if (disposed) {
                throw new Error("CircleManager has been disposed");
            }
            const oldNode = requireNode(id);
            const prev = storedOptions.get(id);
            if (!prev) {
                throw new Error(
                    `${UPDATE_ERROR_PREFIX}: stored options for "${id}" missing`,
                );
            }
            validatePartial(partial, oldNode);

            // segments / altitudeMode / style / label の変更は node 再構築が必要。
            const needsRebuild =
                (partial.segments !== undefined &&
                    partial.segments !== oldNode.segments) ||
                (partial.altitudeMode !== undefined &&
                    partial.altitudeMode !== oldNode.altitudeMode) ||
                partial.style !== undefined ||
                partial.label !== undefined;

            // マージ済み options を構築する。
            const merged: CircleOptions = {
                ...prev,
                center: { ...prev.center },
            };
            if (partial.center !== undefined) {
                merged.center = { ...partial.center };
            }
            if (partial.radius !== undefined) merged.radius = partial.radius;
            if (partial.segments !== undefined)
                merged.segments = partial.segments;
            if (partial.altitudeMode !== undefined)
                merged.altitudeMode = partial.altitudeMode;
            if (partial.label !== undefined) merged.label = partial.label;
            if (partial.style !== undefined)
                merged.style = { ...prev.style, ...partial.style };
            if (partial.enabled !== undefined) merged.enabled = partial.enabled;
            if (partial.pointEnabled !== undefined)
                merged.pointEnabled = partial.pointEnabled;
            if (partial.lineEnabled !== undefined)
                merged.lineEnabled = partial.lineEnabled;
            if (partial.wallEnabled !== undefined)
                merged.wallEnabled = partial.wallEnabled;
            if (partial.labelEnabled !== undefined)
                merged.labelEnabled = partial.labelEnabled;

            storedOptions.set(id, {
                ...merged,
                center: { ...merged.center },
            });

            if (needsRebuild) {
                // Tube/Ribbon の path 長やマテリアルが変わるため dispose → 再構築。
                oldNode.dispose();
                const newNode = createCircleNode(ctx.scene, id, merged);
                nodes.set(id, newNode);
                buildCacheAndResolve(id, newNode);
                return newNode.getHandle();
            }

            // 再構築不要なケース: setter 経由で差分適用。
            let geometryChanged = false;
            if (partial.center !== undefined) {
                oldNode.center = partial.center;
                geometryChanged = true;
            }
            if (partial.radius !== undefined) {
                oldNode.radius = partial.radius;
                geometryChanged = true;
            }
            if (partial.enabled !== undefined) {
                oldNode.setEnabledLogical(partial.enabled);
            }
            if (partial.pointEnabled !== undefined) {
                oldNode.setPointEnabledLogical(partial.pointEnabled);
            }
            if (partial.lineEnabled !== undefined) {
                oldNode.setLineEnabledLogical(partial.lineEnabled);
            }
            if (partial.wallEnabled !== undefined) {
                oldNode.setWallEnabledLogical(partial.wallEnabled);
            }
            if (partial.labelEnabled !== undefined) {
                oldNode.setLabelEnabledLogical(partial.labelEnabled);
            }

            // center / radius が変わった場合は ring XZ キャッシュを再構築する。
            if (geometryChanged) {
                buildCacheAndResolve(id, oldNode);
            }
            return oldNode.getHandle();
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
            caches.delete(id);
            storedOptions.delete(id);
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
            caches.clear();
            storedOptions.clear();
        },
    };
};
