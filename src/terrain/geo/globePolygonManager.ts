/**
 * グローブ用ポリゴンマネージャ (Issue #275 Phase 3, polygon スライス)。
 *
 * 平面版（`polygonManager` + `polygon`）に対する **並行構築** のグローブ実装。頂点列を地形標高で
 * 接地し、ECEF アウトライン（線）と、地表 → 楕円体面（alt=0）へ地心方向に落とす「壁（カーテン）」
 * を描く。配置は `overlayPlacement.buildDrapedPolygonPaths`（ECEF + 地心 up）で、`scene.pick`
 * には依存しない。平面版 `polygonManager` には手を加えない。
 *
 * 本スライスのスコープはアウトライン＋壁。点マーカー／垂線／ラベル／辺ラベルの parity は後続。
 */
import type { Scene } from "@babylonjs/core/scene";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { buildDrapedPolygonPaths, type LatLonPoint } from "./overlayPlacement";

/** グローブポリゴンの既定値。 */
const GLOBE_POLYGON_DEFAULTS = {
    outlineColor: "#ffcc00",
    wallColor: "#ffcc00",
    wallOpacity: 0.25,
} as const;

export interface GlobePolygonOptions {
    /** 頂点列（最低 2 点）。 */
    points: readonly LatLonPoint[];
    /** 末尾と先頭を結んで輪を閉じる。default false。 */
    closed?: boolean;
    /** アウトライン色（hex）。 */
    outlineColor?: string;
    /** 壁色（hex）。 */
    wallColor?: string;
    /** 壁の不透明度 [0,1]。 */
    wallOpacity?: number;
    /** 壁（カーテン）の表示。default true。 */
    wallsEnabled?: boolean;
    /** default true。 */
    enabled?: boolean;
}

export interface GlobePolygonManagerDeps {
    scene: Scene;
    /** 緯度経度の地形標高[m]（無ければ null）。`globeTileManager.terrainElevAt` を渡す。 */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
}

interface GlobePolygonNode {
    id: string;
    points: readonly LatLonPoint[];
    closed: boolean;
    wallsEnabled: boolean;
    enabled: boolean;
    lineMesh: LinesMesh;
    wallMesh: Mesh;
    wallMat: StandardMaterial;
    /** 各頂点の直近に取得できた地形標高[m]（null=未取得）。前景未ロード時のフォールバック。 */
    lastElevs: (number | null)[];
}

export interface GlobePolygonManager {
    add(opts: GlobePolygonOptions): string;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    /** 毎フレーム: 地形標高へ再ドレープ（アウトライン・壁を更新）。 */
    update(): void;
    dispose(): void;
}

/** hex 文字列を Color3 に。非 hex（CSS color 等）は既定色へフォールバック。 */
const toColor3 = (hex: string, fallbackHex: string): Color3 => {
    try {
        return Color3.FromHexString(hex);
    } catch {
        return Color3.FromHexString(fallbackHex);
    }
};

/**
 * グローブ用ポリゴンマネージャを生成する。
 */
export const createGlobePolygonManager = (
    deps: GlobePolygonManagerDeps,
): GlobePolygonManager => {
    const { scene, terrainElevAt } = deps;
    const nodes = new Map<string, GlobePolygonNode>();
    let seq = 0;
    let disposed = false;

    /** 各頂点の標高を取得（null は直前値→0 フォールバック）し、ECEF パスを返す。 */
    const buildPaths = (node: GlobePolygonNode): { top: Vector3[]; bottom: Vector3[] } => {
        const elevs = node.points.map((p, i) => {
            const q = terrainElevAt(p.lat, p.lon);
            if (q !== null) node.lastElevs[i] = q;
            return node.lastElevs[i] ?? 0;
        });
        return buildDrapedPolygonPaths(node.points, elevs, node.closed);
    };

    const add = (opts: GlobePolygonOptions): string => {
        if (disposed) throw new Error("GlobePolygonManager.add: called after dispose");
        if (opts.points.length < 2) {
            throw new Error("GlobePolygonManager.add: points requires at least 2 vertices");
        }
        const id = `globe-polygon-${seq++}`;
        const closed = opts.closed ?? false;
        const wallsEnabled = opts.wallsEnabled ?? true;
        const enabled = opts.enabled ?? true;

        const node: GlobePolygonNode = {
            id,
            points: opts.points.map((p) => ({ lat: p.lat, lon: p.lon })),
            closed,
            wallsEnabled,
            enabled,
            // 後で代入（lineMesh/wallMesh は paths から生成）。
            lineMesh: undefined as unknown as LinesMesh,
            wallMesh: undefined as unknown as Mesh,
            wallMat: undefined as unknown as StandardMaterial,
            lastElevs: opts.points.map(() => null),
        };

        const { top, bottom } = buildPaths(node);

        // アウトライン: 地表ドレープした頂点を結ぶ線（点数固定 → instance で更新可能）。
        const lineMesh = CreateLines(`${id}-outline`, { points: top, updatable: true }, scene);
        lineMesh.color = toColor3(
            opts.outlineColor ?? GLOBE_POLYGON_DEFAULTS.outlineColor,
            GLOBE_POLYGON_DEFAULTS.outlineColor,
        );
        lineMesh.isPickable = false;
        // 地形と同じ既定レンダリンググループ(0)に置き、深度テストで地形と交差・遮蔽させる
        // （別グループ=1 だとグループ間で深度がクリアされ、常に地形の上に描かれて壁が地中へ
        // 潜らない。マーカーは「常に手前」が望ましいため 1 だが、ポリゴン壁は地形と交差させる）。

        // 壁（カーテン）: top（地表）と bottom（楕円体面）の 2 パスの Ribbon。両面表示。
        const wallMesh = CreateRibbon(
            `${id}-wall`,
            { pathArray: [top, bottom], updatable: true, sideOrientation: Mesh.DOUBLESIDE },
            scene,
        );
        const wallMat = new StandardMaterial(`${id}-wall-mat`, scene);
        wallMat.emissiveColor = toColor3(
            opts.wallColor ?? GLOBE_POLYGON_DEFAULTS.wallColor,
            GLOBE_POLYGON_DEFAULTS.wallColor,
        );
        wallMat.alpha = opts.wallOpacity ?? GLOBE_POLYGON_DEFAULTS.wallOpacity;
        wallMat.disableLighting = true;
        wallMat.backFaceCulling = false;
        wallMesh.material = wallMat;
        wallMesh.isPickable = false;
        // 壁も既定グループ(0)。半透明だが地形の深度に対してテストされ、地中部分は遮蔽される。

        node.lineMesh = lineMesh;
        node.wallMesh = wallMesh;
        node.wallMat = wallMat;

        lineMesh.setEnabled(enabled);
        wallMesh.setEnabled(enabled && wallsEnabled);
        nodes.set(id, node);
        return id;
    };

    const remove = (id: string): void => {
        const node = nodes.get(id);
        if (!node) {
            console.warn(`[globe-polygon] remove: id "${id}" not found`);
            return;
        }
        node.lineMesh.dispose();
        node.wallMesh.dispose();
        node.wallMat.dispose();
        nodes.delete(id);
    };

    const setEnabled = (id: string, enabled: boolean): void => {
        if (disposed) throw new Error("GlobePolygonManager.setEnabled: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobePolygonManager.setEnabled: id "${id}" not found`);
        node.enabled = enabled;
        node.lineMesh.setEnabled(enabled);
        node.wallMesh.setEnabled(enabled && node.wallsEnabled);
    };

    const update = (): void => {
        if (disposed) throw new Error("GlobePolygonManager.update: called after dispose");
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            if (!node.enabled) continue;
            const { top, bottom } = buildPaths(node);
            // instance 更新（点数は不変）。アウトラインと壁を再ドレープ。
            CreateLines(`${node.id}-outline`, { points: top, instance: node.lineMesh }, scene);
            if (node.wallsEnabled) {
                CreateRibbon(
                    `${node.id}-wall`,
                    { pathArray: [top, bottom], instance: node.wallMesh },
                    scene,
                );
            }
        }
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return { add, remove, setEnabled, update, dispose };
};
