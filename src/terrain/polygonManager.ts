/**
 * PolygonManager (Issue #170)。
 *
 * `JpmapTerrain.addPolygon / getPolygon / removePolygon / setPolygonEnabled / listPolygons`
 * から呼び出される。
 *
 * - 各 polygon を `OverlayContext` 共有のフレームループで毎フレーム位置更新する。
 * - `altitudeMode === "terrain"` のとき、1 点でも標高未解決なら polygon 全体を非表示にする。
 * - `altitudeMode === "absolute"` のとき、`altitude` を Y として使用する。
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
import { createPolygonNode, type PolygonNode } from "./polygon";
import {
    POLYGON_DEFAULTS,
    type PolygonHandle,
    type PolygonOptions,
    type PolygonPointOptions,
    type PolygonPointPartial,
    type PolygonUpdate,
} from "../lib/types";

const ERROR_PREFIX = "JpmapTerrain.addPolygon";

export interface PolygonManager {
    add(id: string, options: PolygonOptions): PolygonHandle;
    get(id: string): PolygonHandle | null;
    /**
     * 部分更新。`#170` では `JpmapTerrain` 公開 API として露出しない（#173 で公開）。
     * 内部実装としてのみ提供する。
     */
    update(id: string, partial: PolygonUpdate): PolygonHandle;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    setVerticalsEnabled(id: string, enabled: boolean): void;
    setLabelsEnabled(id: string, enabled: boolean): void;
    setWallsEnabled(id: string, enabled: boolean): void;
    /**
     * 指定 index に新しい頂点を挿入する (#173)。`index === points.length` で末尾追加。
     * 範囲外 / 緯度経度範囲外 / `absolute` モードでの altitude 未指定 は throw。
     */
    insertPoint(
        id: string,
        index: number,
        point: PolygonPointOptions,
    ): PolygonHandle;
    /** 指定 index の頂点を削除する (#173)。残り 2 点未満になる場合は throw。 */
    removePoint(id: string, index: number): PolygonHandle;
    /** 指定 index の頂点を部分更新する (#173)。 */
    updatePoint(
        id: string,
        index: number,
        partial: PolygonPointPartial,
    ): PolygonHandle;
    /** 全頂点を置き換える (#173)。`points.length < 2` は throw。 */
    replacePoints(
        id: string,
        points: readonly PolygonPointOptions[],
    ): PolygonHandle;
    list(): readonly string[];
    dispose(): void;
}

const validateOptions = (options: PolygonOptions): void => {
    if (!options.points || options.points.length < 2) {
        throw new Error(
            `${ERROR_PREFIX}: points must contain at least 2 entries (got ${
                options.points?.length ?? 0
            })`,
        );
    }
    const altitudeMode =
        options.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode;
    for (let i = 0; i < options.points.length; i++) {
        const p = options.points[i];
        assertLatLonInBounds(p.lat, p.lon, `${ERROR_PREFIX}[${i}]`);
        if (altitudeMode === "absolute" && p.altitude === undefined) {
            throw new Error(
                `${ERROR_PREFIX}: altitudeMode="absolute" requires altitude on every point (missing at index ${i})`,
            );
        }
    }
};

export const createPolygonManager = (ctx: OverlayContext): PolygonManager => {
    const nodes = new Map<string, PolygonNode>();
    let disposed = false;

    /**
     * 1 ポリゴンの 1 フレーム分更新を行い、全頂点が解決したかを返す。
     */
    const tickPolygon = (node: PolygonNode): void => {
        const worldPoints: Vector3[] = [];
        const groundYs: (number | null)[] = [];
        let allResolved = true;
        for (const pt of node.points) {
            const { wx, wz } = latLonToWorld(ctx, pt.lat, pt.lon);
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            let wy: number;
            if (node.altitudeMode === "absolute") {
                // validateOptions で undefined は弾いている前提。
                wy = pt.altitude ?? 0;
                // 垂線終端用の地表 Y。null のときは applyTransform 側で 0 フォールバック。
                groundYs.push(elev);
            } else {
                if (elev === null) {
                    allResolved = false;
                    break;
                }
                wy = elev + (pt.altitude ?? 0);
                groundYs.push(elev);
            }
            worldPoints.push(new Vector3(wx, wy, wz));
        }
        if (!allResolved) {
            node.setElevationResolved(false);
            return;
        }
        // 頂点列の重心を distScale 計算用に使う（点ごとに変えると球サイズがバラつくため統一）。
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const p of worldPoints) {
            cx += p.x;
            cy += p.y;
            cz += p.z;
        }
        const n = worldPoints.length;
        cx /= n;
        cy /= n;
        cz /= n;
        const scale = computeDistanceScale(ctx, cx, cy, cz);
        node.setElevationResolved(true);
        node.applyTransform(worldPoints, groundYs, scale);
    };

    const tickFrame = (): void => {
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            tickPolygon(node);
        }
    };

    const observer: Observer<Scene> | null =
        ctx.scene.onBeforeRenderObservable.add(tickFrame);

    const unsubscribeTerrain = ctx.tileManager.subscribeTerrainUpdated(() => {
        // tickFrame で次フレームに反映される。明示的な再評価は不要。
    });

    const requireNode = (id: string): PolygonNode => {
        const node = nodes.get(id);
        if (!node) {
            throw new Error(`Polygon id "${id}" not found`);
        }
        return node;
    };

    return {
        add(id: string, options: PolygonOptions): PolygonHandle {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            if (nodes.has(id)) {
                throw new Error(
                    `JpmapTerrain.addPolygon: id "${id}" already exists`,
                );
            }
            validateOptions(options);
            const node = createPolygonNode(ctx.scene, id, options);
            nodes.set(id, node);
            // 初回 tick を即時実行して、初期表示状態を整える。
            tickPolygon(node);
            return node.getHandle();
        },
        get(id: string): PolygonHandle | null {
            const node = nodes.get(id);
            return node ? node.getHandle() : null;
        },
        update(id: string, partial: PolygonUpdate): PolygonHandle {
            // #170 では公開しない。#173 で実装。
            // 引数は #173 実装時に使用するため、シグネチャ維持の目的で void で
            // 参照しておく（@typescript-eslint/no-unused-vars 対策）。
            void id;
            void partial;
            throw new Error(
                "PolygonManager.update is not implemented yet (Issue #173)",
            );
        },
        remove(id: string): void {
            const node = nodes.get(id);
            if (!node) {
                console.warn(
                    `[jpmap-terrain] removePolygon: id "${id}" not found`,
                );
                return;
            }
            node.dispose();
            nodes.delete(id);
        },
        setEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            node.setEnabledLogical(enabled);
        },
        setVerticalsEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            node.setVerticalsEnabledLogical(enabled);
        },
        setLabelsEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            node.setLabelsEnabledLogical(enabled);
        },
        setWallsEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            node.setWallsEnabledLogical(enabled);
        },
        insertPoint(
            id: string,
            index: number,
            point: PolygonPointOptions,
        ): PolygonHandle {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            // assertLatLonInBounds は addPolygon と同じ JAPAN_BOUNDS 検査で揃える。
            assertLatLonInBounds(
                point.lat,
                point.lon,
                `JpmapTerrain.insertPolygonPoint[${id}]`,
            );
            node.insertPoint(index, point);
            tickPolygon(node);
            return node.getHandle();
        },
        removePoint(id: string, index: number): PolygonHandle {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            node.removePoint(index);
            tickPolygon(node);
            return node.getHandle();
        },
        updatePoint(
            id: string,
            index: number,
            partial: PolygonPointPartial,
        ): PolygonHandle {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            // 緯度経度の partial がある場合は JAPAN_BOUNDS チェックを先行する。
            if (partial.lat !== undefined || partial.lon !== undefined) {
                const current = node.points[index];
                const lat = partial.lat ?? current?.lat;
                const lon = partial.lon ?? current?.lon;
                if (lat !== undefined && lon !== undefined) {
                    assertLatLonInBounds(
                        lat,
                        lon,
                        `JpmapTerrain.updatePolygonPoint[${id}][${index}]`,
                    );
                }
            }
            node.updatePoint(index, partial);
            tickPolygon(node);
            return node.getHandle();
        },
        replacePoints(
            id: string,
            points: readonly PolygonPointOptions[],
        ): PolygonHandle {
            if (disposed) {
                throw new Error("PolygonManager has been disposed");
            }
            const node = requireNode(id);
            if (!points || points.length < 2) {
                throw new Error(
                    `JpmapTerrain.replacePolygonPoints[${id}]: points must contain at least 2 entries (got ${
                        points?.length ?? 0
                    })`,
                );
            }
            for (let i = 0; i < points.length; i++) {
                assertLatLonInBounds(
                    points[i].lat,
                    points[i].lon,
                    `JpmapTerrain.replacePolygonPoints[${id}][${i}]`,
                );
            }
            node.replacePoints(points);
            tickPolygon(node);
            return node.getHandle();
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
