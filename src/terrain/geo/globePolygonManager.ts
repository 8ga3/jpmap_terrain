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
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreateRibbon } from "@babylonjs/core/Meshes/Builders/ribbonBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import {
    drapedPolygonPathLength,
    writeDrapedPolygonPathsToRef,
    type LatLonPoint,
} from "./overlayPlacement";

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
    /**
     * 指定すると top（アウトライン／壁の上端）を地形標高ではなく **この楕円体高度[m] 固定** で
     * 描く（壁は alt=0 までのカーテン）。山などに隠れないよう高く浮かせたいときに使う。
     * 未指定なら地形標高でドレープする。
     */
    topAltitudeMeters?: number;
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
    /** top を固定する楕円体高度[m]（undefined なら地形ドレープ）。 */
    topAltitudeMeters?: number;
    wallsEnabled: boolean;
    enabled: boolean;
    lineMesh: LinesMesh;
    wallMesh: Mesh;
    wallMat: StandardMaterial;
    /** 各頂点の直近に取得できた地形標高[m]（null=未取得）。前景未ロード時のフォールバック。 */
    lastElevs: (number | null)[];
    /** 毎フレーム再利用するパスバッファ（割り当て回避）。top=上端 / bottom=楕円体面。 */
    top: Vector3[];
    bottom: Vector3[];
    /** top 各頂点の標高[m]の再利用バッファ。 */
    elevs: number[];
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

    /** top の各頂点標高を決め（固定高度 or 地形ドレープ）、node.top/bottom を in-place 更新する。 */
    const buildPaths = (node: GlobePolygonNode): void => {
        if (node.topAltitudeMeters != null) {
            // 固定高度: 地形に依らず一定（山に隠れないよう浮かせる）。
            for (let i = 0; i < node.elevs.length; i++) node.elevs[i] = node.topAltitudeMeters;
        } else {
            // 地形ドレープ: null（前景タイル未ロード）は頂点ごとに直前値→0 フォールバック。
            for (let i = 0; i < node.points.length; i++) {
                const p = node.points[i];
                const q = terrainElevAt(p.lat, p.lon);
                if (q !== null) node.lastElevs[i] = q;
                node.elevs[i] = node.lastElevs[i] ?? 0;
            }
        }
        writeDrapedPolygonPathsToRef(node.points, node.elevs, node.closed, node.top, node.bottom);
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

        const pathLen = drapedPolygonPathLength(opts.points.length, closed);
        const node: GlobePolygonNode = {
            id,
            points: opts.points.map((p) => ({ lat: p.lat, lon: p.lon })),
            closed,
            topAltitudeMeters: opts.topAltitudeMeters,
            wallsEnabled,
            enabled,
            // 後で代入（lineMesh/wallMesh は paths から生成）。
            lineMesh: undefined as unknown as LinesMesh,
            wallMesh: undefined as unknown as Mesh,
            wallMat: undefined as unknown as StandardMaterial,
            lastElevs: opts.points.map(() => null),
            top: Array.from({ length: pathLen }, () => new Vector3()),
            bottom: Array.from({ length: pathLen }, () => new Vector3()),
            elevs: opts.points.map(() => 0),
        };

        buildPaths(node); // node.top / node.bottom を初期化

        // アウトライン: 地表ドレープした頂点を結ぶ線（点数固定 → instance で更新可能）。
        const lineMesh = CreateLines(`${id}-outline`, { points: node.top, updatable: true }, scene);
        lineMesh.color = toColor3(
            opts.outlineColor ?? GLOBE_POLYGON_DEFAULTS.outlineColor,
            GLOBE_POLYGON_DEFAULTS.outlineColor,
        );
        lineMesh.isPickable = false;
        // 地形と同じレンダリンググループ(0)に置き、深度テストで地形と交差・遮蔽させる（別グループ=1
        // だとグループ間で深度がクリアされ常に地形の上に描かれて壁が地中へ潜らない。マーカーは
        // 「常に手前」が望ましいため 1 だが、ポリゴン壁は地形と交差させる）。既定値に依存せず明示する。
        lineMesh.renderingGroupId = 0;

        // 壁（カーテン）: top（地表）と bottom（楕円体面）の 2 パスの Ribbon。両面表示。
        const wallMesh = CreateRibbon(
            `${id}-wall`,
            { pathArray: [node.top, node.bottom], updatable: true, sideOrientation: Mesh.DOUBLESIDE },
            scene,
        );
        const wallMat = new StandardMaterial(`${id}-wall-mat`, scene);
        wallMat.emissiveColor = toColor3(
            opts.wallColor ?? GLOBE_POLYGON_DEFAULTS.wallColor,
            GLOBE_POLYGON_DEFAULTS.wallColor,
        );
        wallMat.alpha = opts.wallOpacity ?? GLOBE_POLYGON_DEFAULTS.wallOpacity;
        // 半透明（alpha<1）では深度プリパスを有効化して z-fight / ブレンド順の乱れを防ぐ
        // （平面版 polygon/circle と同様）。
        if (wallMat.alpha < 1) wallMat.needDepthPrePass = true;
        wallMat.disableLighting = true;
        wallMat.backFaceCulling = false;
        wallMesh.material = wallMat;
        wallMesh.isPickable = false;
        // 壁も同グループ(0)に明示。半透明だが地形の深度に対してテストされ地中部分は遮蔽される。
        wallMesh.renderingGroupId = 0;

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
            buildPaths(node); // node.top / node.bottom を in-place 更新
            // instance 更新（点数は不変）。アウトラインと壁を再ドレープ。
            CreateLines(`${node.id}-outline`, { points: node.top, instance: node.lineMesh }, scene);
            if (node.wallsEnabled) {
                CreateRibbon(
                    `${node.id}-wall`,
                    { pathArray: [node.top, node.bottom], instance: node.wallMesh },
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
