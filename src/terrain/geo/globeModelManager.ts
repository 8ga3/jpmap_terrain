/**
 * グローブ用モデルマネージャ (Issue #275 Phase 3, model スライス)。
 *
 * 平面版（`modelManager`）に対する **並行構築** のグローブ実装。glb/gltf モデルを lat/lon に接地し、
 * **ローカル +Y を地心 up へ向けて「立たせる」**（`overlayPlacement.surfaceOrientationToRef`）。
 * 配置は ECEF（`groundPlacementToRef`）で `scene.pick` 非依存。平面版 `modelManager` は未改修で、
 * ローダー登録（`importLoaderForUrl`）のみ座標系非依存のため再利用する。
 */
import type { Scene } from "@babylonjs/core/scene";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";

import { importLoaderForUrl } from "../modelManager";
import { groundPlacementToRef, surfaceOrientationToRef } from "./overlayPlacement";

export interface GlobeModelOptions {
    /** モデルファイルの URL（glb/gltf）。 */
    url: string;
    /** 緯度 [deg]。 */
    lat: number;
    /** 経度 [deg]。 */
    lon: number;
    /** 地表からの高さオフセット [m]（default 0）。 */
    altitudeOffsetMeters?: number;
    /** 方位 [deg]（0=北, +=東回り。モデルのローカル +Z が向く方向）。default 0。 */
    headingDeg?: number;
    /** 一様スケール（default 1）。 */
    scale?: number;
    /** default true。 */
    enabled?: boolean;
}

export interface GlobeModelManagerDeps {
    scene: Scene;
    /** 緯度経度の地形標高[m]（無ければ null）。`globeTileManager.terrainElevAt` を渡す。 */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
}

interface GlobeModelNode {
    id: string;
    lat: number;
    lon: number;
    altitudeOffsetMeters: number;
    headingDeg: number;
    scale: number;
    enabled: boolean;
    root: TransformNode;
    meshes: AbstractMesh[];
    /** ロード完了フラグ（完了まで placeNode しない）。 */
    loaded: boolean;
    /** dispose/remove 済みフラグ（非同期ロード結果の破棄判定）。 */
    cancelled: boolean;
    /** 直近に取得できた地形標高[m]（null=未取得）。前景未ロード時のフォールバック。 */
    lastElev: number | null;
}

export interface GlobeModelManager {
    add(opts: GlobeModelOptions): string;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    /** 毎フレーム: ロード済みモデルを地形へ接地し地心 up へ向ける。 */
    update(): void;
    dispose(): void;
}

/**
 * グローブ用モデルマネージャを生成する。
 */
export const createGlobeModelManager = (
    deps: GlobeModelManagerDeps,
): GlobeModelManager => {
    const { scene, terrainElevAt } = deps;
    const nodes = new Map<string, GlobeModelNode>();
    let seq = 0;
    let disposed = false;
    const quat = new Quaternion(); // 向き計算スクラッチ
    const upScratch = new Vector3(); // groundPlacementToRef の up 受け（未使用だが要引数）

    /** モデルを地形へ接地（標高 null は直前値→0）し、地心 up へ向ける。 */
    const placeNode = (node: GlobeModelNode): void => {
        const elevOrNull = terrainElevAt(node.lat, node.lon);
        if (elevOrNull !== null) node.lastElev = elevOrNull;
        const elev = (node.lastElev ?? 0) + node.altitudeOffsetMeters;
        // root.position（真の ECEF）へ接地。向きは root.position から地心 up を算出して決める。
        groundPlacementToRef(node.lat, node.lon, elev, node.root.position, upScratch);
        if (surfaceOrientationToRef(node.root.position, node.headingDeg, quat)) {
            if (!node.root.rotationQuaternion) node.root.rotationQuaternion = new Quaternion();
            node.root.rotationQuaternion.copyFrom(quat);
        }
    };

    const loadModel = async (node: GlobeModelNode, url: string): Promise<void> => {
        try {
            await importLoaderForUrl(url);
            const result = await ImportMeshAsync(url, scene);
            // 本マネージャはアニメーション制御 API を持たないため、AnimationGroup はロード直後に
            // 停止・破棄してリークを防ぐ（平面版 modelManager は remove/dispose 時に破棄）。
            for (const ag of result.animationGroups) {
                ag.stop();
                ag.dispose();
            }
            if (node.cancelled) {
                for (const m of result.meshes) m.dispose();
                return;
            }
            node.meshes = result.meshes;
            // 最上位ノードのみ root の子にする（スキン階層の内部親子は触らない）。
            for (const m of result.meshes) {
                if (!m.parent) m.parent = node.root;
            }
            node.root.scaling.setAll(node.scale);
            node.root.setEnabled(node.enabled);
            node.loaded = true;
            placeNode(node); // 初期配置（原点表示のチラつき防止）
        } catch (err) {
            if (!node.cancelled) {
                console.error(`[globe-model] failed to load "${node.id}" from "${url}":`, err);
            }
        }
    };

    const add = (opts: GlobeModelOptions): string => {
        if (disposed) throw new Error("GlobeModelManager.add: called after dispose");
        const id = `globe-model-${seq++}`;
        const root = new TransformNode(`${id}-root`, scene);
        root.rotationQuaternion = new Quaternion();
        const enabled = opts.enabled ?? true;
        root.setEnabled(enabled);
        const node: GlobeModelNode = {
            id,
            lat: opts.lat,
            lon: opts.lon,
            altitudeOffsetMeters: opts.altitudeOffsetMeters ?? 0,
            headingDeg: opts.headingDeg ?? 0,
            scale: opts.scale ?? 1,
            enabled,
            root,
            meshes: [],
            loaded: false,
            cancelled: false,
            lastElev: null,
        };
        nodes.set(id, node);
        void loadModel(node, opts.url);
        return id;
    };

    const remove = (id: string): void => {
        const node = nodes.get(id);
        if (!node) {
            console.warn(`[globe-model] remove: id "${id}" not found`);
            return;
        }
        node.cancelled = true;
        for (const m of node.meshes) m.dispose();
        node.root.dispose();
        nodes.delete(id);
    };

    const setEnabled = (id: string, enabled: boolean): void => {
        if (disposed) throw new Error("GlobeModelManager.setEnabled: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobeModelManager.setEnabled: id "${id}" not found`);
        node.enabled = enabled;
        node.root.setEnabled(enabled);
    };

    const update = (): void => {
        if (disposed) throw new Error("GlobeModelManager.update: called after dispose");
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            if (!node.enabled || !node.loaded) continue;
            placeNode(node);
        }
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return { add, remove, setEnabled, update, dispose };
};
