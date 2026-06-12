/**
 * グローブ用モデルマネージャ (Issue #275 Phase 3 / Phase 4 P4-2)。
 *
 * 平面版（`modelManager`）に対する **並行構築** のグローブ実装。glb/gltf/obj/stl モデルを
 * lat/lon に接地し、**ローカル +Y を地心 up へ向けて「立たせる」**（`surfaceOrientationToRef`）。
 * 配置は ECEF（`geodeticToEcefToRef`）で `scene.pick` 非依存。平面版 `modelManager` は未改修で、
 * ローダー登録（`importLoaderForUrl`）のみ座標系非依存のため再利用する。
 *
 * P4-2 で公開 `ModelManager`（`addModel`/`updateModel`/`getModel`/...）相当へ拡張:
 * - in-place 更新（メッシュ再ロードなし）
 * - altitudeMode `terrain`/`absolute` と gravity（地表追従）
 * - per-axis scaling・フル Euler rotation（地心 up 起立に局所 pitch/roll を合成）
 * - animation の保持と play/stop
 */
import type { Scene } from "@babylonjs/core/scene";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { GLTFLoaderAnimationStartMode } from "@babylonjs/loaders/glTF/glTFFileLoader";

import { importLoaderForUrl } from "../modelManager";
import { surfaceOrientationToRef } from "./overlayPlacement";
import { DEG2RAD, geodeticToEcefToRef } from "./ecef";

/** 高度モード。`terrain`=地表からのオフセット / `absolute`=楕円体面からの絶対高度。 */
export type GlobeAltitudeMode = "terrain" | "absolute";

/** 3 軸ベクトル（各軸 optional）。 */
export interface GlobeVec3 {
    x?: number;
    y?: number;
    z?: number;
}

export interface GlobeModelOptions {
    /** モデルファイルの URL（glb/gltf/obj/stl）。 */
    url: string;
    /** 緯度 [deg]。 */
    lat: number;
    /** 経度 [deg]。 */
    lon: number;
    /**
     * 高度 [m]。
     * - `altitudeMode==="absolute"`: 楕円体面からの絶対高度。
     * - `altitudeMode==="terrain"`: 地表からのオフセット（default 0）。
     */
    altitude?: number;
    /** 高度モード。default `"terrain"`。 */
    altitudeMode?: GlobeAltitudeMode;
    /**
     * 回転 [deg]。`y` は方位（0=北, +=東回り）として地心 up 周りに適用し、
     * `x`/`z` は起立姿勢に対する局所 pitch/roll として合成する。default `{0,0,0}`。
     */
    rotation?: GlobeVec3;
    /** スケール倍率（per-axis）。default `{1,1,1}`。 */
    scaling?: GlobeVec3;
    /** default true。 */
    enabled?: boolean;
    /**
     * 地表追従（重力）。default true。
     * `altitudeMode==="terrain"` のときのみ有効（`absolute` 時は無視）。
     */
    gravity?: boolean;
}

/** `update` の部分更新型（`url` は変更不可）。 */
export type GlobeModelUpdate = Partial<Omit<GlobeModelOptions, "url">>;

/** `get` の戻り値（読み取り専用スナップショット）。アダプタが `ModelHandle` を組み立てる。 */
export interface GlobeModelState {
    url: string;
    lat: number;
    lon: number;
    altitude: number;
    altitudeMode: GlobeAltitudeMode;
    rotation: Required<GlobeVec3>;
    scaling: Required<GlobeVec3>;
    enabled: boolean;
    gravity: boolean;
    loaded: boolean;
    elevationResolved: boolean;
    animationNames: string[];
}

export interface GlobeModelManagerDeps {
    scene: Scene;
    /** 緯度経度の地形標高[m]（無ければ null）。`globeTileManager.terrainElevAt` を渡す。 */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
}

interface GlobeModelNode {
    id: string;
    url: string;
    lat: number;
    lon: number;
    altitude: number;
    altitudeMode: GlobeAltitudeMode;
    rotation: Required<GlobeVec3>;
    scaling: Required<GlobeVec3>;
    enabled: boolean;
    gravity: boolean;
    root: TransformNode;
    meshes: AbstractMesh[];
    animationGroups: AnimationGroup[];
    /** ロード完了フラグ（完了まで placeNode しない）。 */
    loaded: boolean;
    /** dispose/remove 済みフラグ（非同期ロード結果の破棄判定）。 */
    cancelled: boolean;
    /** 地表標高が解決済みなら true（absolute 時は常に true）。 */
    elevationResolved: boolean;
    /** 直近に取得できた地形標高[m]（null=未取得）。 */
    lastElev: number | null;
    /** 前フレームの可視状態キャッシュ（冗長な setEnabled を削減）。 */
    lastVisible: boolean | null;
}

export interface GlobeModelManager {
    add(opts: GlobeModelOptions): string;
    get(id: string): GlobeModelState | null;
    update(id: string, partial: GlobeModelUpdate): void;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    playAnimation(id: string, name?: string): void;
    stopAnimation(id: string, name?: string): void;
    /** 毎フレーム: ロード済みモデルを地形へ接地し地心 up へ向ける。 */
    tick(): void;
    dispose(): void;
}

const resolveVec3 = (
    v: GlobeVec3 | undefined,
    defaults: Required<GlobeVec3>,
): Required<GlobeVec3> => ({
    x: v?.x ?? defaults.x,
    y: v?.y ?? defaults.y,
    z: v?.z ?? defaults.z,
});

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
    const quat = new Quaternion(); // 起立姿勢スクラッチ
    const localQuat = new Quaternion(); // pitch/roll 合成スクラッチ

    /** ルートの可視状態を更新する（冗長な setEnabled を避ける）。 */
    const setVisible = (node: GlobeModelNode, visible: boolean): void => {
        if (node.lastVisible === visible) return;
        node.lastVisible = visible;
        node.root.setEnabled(visible);
    };

    /** 起立姿勢（地心 up + heading=rotation.y）に局所 pitch/roll(x,z) を合成して向きを与える。 */
    const applyOrientation = (node: GlobeModelNode): void => {
        if (!surfaceOrientationToRef(node.root.position, node.rotation.y, quat)) {
            return; // 極などの特異点では向き更新をスキップ
        }
        if (node.rotation.x !== 0 || node.rotation.z !== 0) {
            Quaternion.FromEulerAnglesToRef(
                node.rotation.x * DEG2RAD,
                0,
                node.rotation.z * DEG2RAD,
                localQuat,
            );
            // surface * local: モデル局所軸で tilt してから地表へ起立させる。
            quat.multiplyToRef(localQuat, quat);
        }
        if (!node.root.rotationQuaternion) {
            node.root.rotationQuaternion = new Quaternion();
        }
        node.root.rotationQuaternion.copyFrom(quat);
    };

    /** モデルを ECEF へ接地し、可視状態と向きを更新する。 */
    const placeNode = (node: GlobeModelNode): void => {
        if (node.altitudeMode === "absolute") {
            geodeticToEcefToRef(node.lat, node.lon, node.altitude, node.root.position);
            node.elevationResolved = true;
            setVisible(node, node.enabled);
            applyOrientation(node);
            return;
        }
        // terrain モード
        if (node.gravity) {
            const elev = terrainElevAt(node.lat, node.lon);
            if (elev === null) {
                // 平面版と同契約: 地表未解決のあいだは非表示にして原点/0m 表示のポップを防ぐ。
                node.elevationResolved = false;
                setVisible(node, false);
                return;
            }
            node.lastElev = elev;
            node.elevationResolved = true;
            geodeticToEcefToRef(node.lat, node.lon, elev + node.altitude, node.root.position);
        } else {
            geodeticToEcefToRef(node.lat, node.lon, node.altitude, node.root.position);
            node.elevationResolved = true;
        }
        setVisible(node, node.enabled);
        applyOrientation(node);
    };

    /**
     * 未ロード時の `elevationResolved` を planar(`modelManager`) と同契約で求める:
     * absolute / 非gravity-terrain は地形非依存で true、gravity-terrain は標高取得可否で判定。
     */
    const resolveUnloadedElev = (node: GlobeModelNode): boolean => {
        if (node.altitudeMode === "absolute") return true;
        if (node.gravity) return terrainElevAt(node.lat, node.lon) !== null;
        return true;
    };

    const loadModel = async (node: GlobeModelNode, url: string): Promise<void> => {
        try {
            await importLoaderForUrl(url);
            // animationStartMode: NONE でロードし自動再生を抑止する（planar と同方針）。
            // 再生タイミングは playAnimation() で明示制御する。
            const result = await ImportMeshAsync(url, scene, {
                pluginOptions: {
                    gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE },
                },
            });
            // glTF 以外（obj/stl）や既定変更に備え、ロード直後にも停止しておく。
            for (const ag of result.animationGroups) {
                ag.stop();
            }
            if (node.cancelled) {
                for (const ag of result.animationGroups) ag.dispose();
                for (const m of result.meshes) m.dispose();
                return;
            }
            node.meshes = result.meshes;
            node.animationGroups = result.animationGroups;
            // 最上位ノードのみ root の子にする（スキン階層の内部親子は触らない）。
            for (const m of result.meshes) {
                if (!m.parent) m.parent = node.root;
            }
            node.root.scaling.set(node.scaling.x, node.scaling.y, node.scaling.z);
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
        const node: GlobeModelNode = {
            id,
            url: opts.url,
            lat: opts.lat,
            lon: opts.lon,
            altitude: opts.altitude ?? 0,
            altitudeMode: opts.altitudeMode ?? "terrain",
            rotation: resolveVec3(opts.rotation, { x: 0, y: 0, z: 0 }),
            scaling: resolveVec3(opts.scaling, { x: 1, y: 1, z: 1 }),
            enabled: opts.enabled ?? true,
            gravity: opts.gravity ?? true,
            root,
            meshes: [],
            animationGroups: [],
            loaded: false,
            cancelled: false,
            elevationResolved: false,
            lastElev: null,
            lastVisible: null,
        };
        // ロード完了までは非表示（原点表示のチラつき防止）。
        root.setEnabled(false);
        // 未ロード時点の elevationResolved を planar と同契約で初期化する。
        node.elevationResolved = resolveUnloadedElev(node);
        nodes.set(id, node);
        void loadModel(node, opts.url);
        return id;
    };

    const buildState = (node: GlobeModelNode): GlobeModelState => ({
        url: node.url,
        lat: node.lat,
        lon: node.lon,
        altitude: node.altitude,
        altitudeMode: node.altitudeMode,
        rotation: { ...node.rotation },
        scaling: { ...node.scaling },
        enabled: node.enabled,
        gravity: node.gravity,
        loaded: node.loaded,
        elevationResolved: node.elevationResolved,
        animationNames: node.animationGroups.map((ag) => ag.name),
    });

    const get = (id: string): GlobeModelState | null => {
        const node = nodes.get(id);
        return node ? buildState(node) : null;
    };

    const update = (id: string, partial: GlobeModelUpdate): void => {
        if (disposed) throw new Error("GlobeModelManager.update: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobeModelManager.update: id "${id}" not found`);

        if (partial.lat !== undefined) node.lat = partial.lat;
        if (partial.lon !== undefined) node.lon = partial.lon;
        if (partial.altitude !== undefined) node.altitude = partial.altitude;
        if (partial.altitudeMode !== undefined) node.altitudeMode = partial.altitudeMode;
        if (partial.gravity !== undefined) node.gravity = partial.gravity;
        if (partial.rotation !== undefined) {
            node.rotation = resolveVec3(partial.rotation, node.rotation);
        }
        if (partial.scaling !== undefined) {
            node.scaling = resolveVec3(partial.scaling, node.scaling);
            if (node.loaded) {
                node.root.scaling.set(node.scaling.x, node.scaling.y, node.scaling.z);
            }
        }
        if (partial.enabled !== undefined) node.enabled = partial.enabled;

        if (node.loaded) {
            placeNode(node);
        } else {
            // 未ロード時も planar と同契約で elevationResolved を再計算する。
            node.elevationResolved = resolveUnloadedElev(node);
        }
    };

    const remove = (id: string): void => {
        const node = nodes.get(id);
        if (!node) {
            console.warn(`[globe-model] remove: id "${id}" not found`);
            return;
        }
        node.cancelled = true;
        for (const ag of node.animationGroups) {
            ag.stop();
            ag.dispose();
        }
        for (const m of node.meshes) m.dispose();
        node.root.dispose();
        nodes.delete(id);
    };

    const setEnabled = (id: string, enabled: boolean): void => {
        if (disposed) throw new Error("GlobeModelManager.setEnabled: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobeModelManager.setEnabled: id "${id}" not found`);
        node.enabled = enabled;
        if (node.loaded) {
            setVisible(node, enabled && node.elevationResolved);
        }
    };

    const list = (): readonly string[] => Array.from(nodes.keys());

    const playAnimation = (id: string, name?: string): void => {
        if (disposed) throw new Error("GlobeModelManager.playAnimation: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobeModelManager.playAnimation: id "${id}" not found`);
        if (!node.loaded) {
            console.warn(`[globe-model] playAnimation: model "${id}" is not loaded yet`);
            return;
        }
        if (name !== undefined) {
            const ag = node.animationGroups.find((g) => g.name === name);
            if (!ag) {
                console.warn(`[globe-model] playAnimation: animation "${name}" not found in model "${id}"`);
                return;
            }
            ag.play(true);
        } else {
            for (const ag of node.animationGroups) ag.play(true);
        }
    };

    const stopAnimation = (id: string, name?: string): void => {
        if (disposed) throw new Error("GlobeModelManager.stopAnimation: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobeModelManager.stopAnimation: id "${id}" not found`);
        if (!node.loaded) return;
        if (name !== undefined) {
            const ag = node.animationGroups.find((g) => g.name === name);
            if (ag) ag.stop();
        } else {
            for (const ag of node.animationGroups) ag.stop();
        }
    };

    const tick = (): void => {
        if (disposed) throw new Error("GlobeModelManager.tick: called after dispose");
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            if (!node.loaded) continue;
            placeNode(node);
        }
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return {
        add,
        get,
        update,
        remove,
        setEnabled,
        list,
        playAnimation,
        stopAnimation,
        tick,
        dispose,
    };
};
