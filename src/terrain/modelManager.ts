/**
 * ModelManager (Issue #243)。
 *
 * `JpmapTerrain.addModel / getModel / updateModel / removeModel / setModelEnabled /
 *  listModels / playModelAnimation / stopModelAnimation`
 * から呼び出される。3Dモデルの ID 管理・非同期ロード・毎フレームの位置更新を担う。
 *
 * Marker / Circle / Polygon Manager と同パターンで実装する。
 */

import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// 3D モデルローダーは `addModel` 呼び出し時に拡張子に応じて動的ロードする。
// トップレベル import にすると @babylonjs/loaders が optional peer dependency でも
// パッケージ利用者が Model API を使わない場合に実行時エラーになるため。

import {
    assertLatLonInBounds,
    latLonToWorld,
    type OverlayContext,
} from "./overlayCoords";
import {
    MODEL_DEFAULTS,
    type AltitudeMode,
    type ModelHandle,
    type ModelOptions,
    type ModelUpdate,
    type ModelVector3,
} from "../lib/types";

export interface ModelManager {
    add(id: string, options: ModelOptions): ModelHandle;
    get(id: string): ModelHandle | null;
    update(id: string, partial: ModelUpdate): ModelHandle;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    playAnimation(id: string, name?: string): void;
    stopAnimation(id: string, name?: string): void;
    dispose(): void;
}

const ERROR_PREFIX = "JpmapTerrain.addModel";
const UPDATE_ERROR_PREFIX = "JpmapTerrain.updateModel";

interface ModelEntry {
    id: string;
    url: string;
    lat: number;
    lon: number;
    altitude: number;
    altitudeMode: AltitudeMode;
    rotation: Required<ModelVector3>;
    scaling: Required<ModelVector3>;
    enabled: boolean;
    gravity: boolean;
    loaded: boolean;
    elevationResolved: boolean;
    root: TransformNode;
    meshes: AbstractMesh[];
    animationGroups: AnimationGroup[];
    /** ロード中止用。dispose / remove 時に true にする */
    cancelled: boolean;
    /** 前フレームの可視状態キャッシュ（冗長な setEnabled 呼び出しを削減） */
    lastVisible: boolean | null;
}

const resolveVec3 = (
    v: ModelVector3 | undefined,
    defaults: Readonly<Required<ModelVector3>>,
): Required<ModelVector3> => ({
    x: v?.x ?? defaults.x,
    y: v?.y ?? defaults.y,
    z: v?.z ?? defaults.z,
});

const toHandle = (entry: ModelEntry): ModelHandle => ({
    id: entry.id,
    url: entry.url,
    lat: entry.lat,
    lon: entry.lon,
    altitude: entry.altitude,
    altitudeMode: entry.altitudeMode,
    rotation: { ...entry.rotation },
    scaling: { ...entry.scaling },
    enabled: entry.enabled,
    gravity: entry.gravity,
    loaded: entry.loaded,
    elevationResolved: entry.elevationResolved,
    animationNames: entry.animationGroups.map((ag) => ag.name),
});

const applyRotation = (root: TransformNode, rotation: Required<ModelVector3>): void => {
    root.rotation = new Vector3(
        (rotation.x * Math.PI) / 180,
        (rotation.y * Math.PI) / 180,
        (rotation.z * Math.PI) / 180,
    );
};

const applyScaling = (root: TransformNode, scaling: Required<ModelVector3>): void => {
    root.scaling = new Vector3(scaling.x, scaling.y, scaling.z);
};

/** サポートする 3D モデルフォーマットの拡張子一覧 */
const SUPPORTED_EXTENSIONS = [".glb", ".gltf", ".obj", ".stl"] as const;

/**
 * URL の拡張子から対応するローダーを動的 import する。
 * 未対応拡張子の場合は Error を throw する。
 */
export const importLoaderForUrl = async (url: string): Promise<void> => {
    // クエリ文字列・フラグメントを除去してから拡張子を取得
    const pathname = url.split("?")[0].split("#")[0];
    const dotIndex = pathname.lastIndexOf(".");
    const ext = dotIndex !== -1 ? pathname.substring(dotIndex).toLowerCase() : "";

    switch (ext) {
        case ".glb":
        case ".gltf":
            await import("@babylonjs/loaders/glTF");
            break;
        case ".obj":
            await import("@babylonjs/loaders/OBJ");
            break;
        case ".stl":
            await import("@babylonjs/loaders/STL");
            break;
        default:
            throw new Error(
                `${ERROR_PREFIX}: unsupported file format "${ext}". Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}`,
            );
    }
};

export const createModelManager = (ctx: OverlayContext): ModelManager => {
    const entries = new Map<string, ModelEntry>();
    let disposed = false;

    const applyTransform = (entry: ModelEntry): void => {
        const { wx, wz } = latLonToWorld(ctx, entry.lat, entry.lon);

        if (entry.altitudeMode === "absolute") {
            entry.root.position.set(wx, entry.altitude, wz);
            entry.elevationResolved = true;
            setMeshVisibility(entry, entry.enabled);
            return;
        }

        // terrain モード
        if (entry.gravity) {
            const elev = ctx.tileManager.queryElevationAtWorld(wx, wz);
            if (elev === null) {
                entry.elevationResolved = false;
                setMeshVisibility(entry, false);
                return;
            }
            entry.elevationResolved = true;
            entry.root.position.set(wx, elev + entry.altitude, wz);
        } else {
            entry.root.position.set(wx, entry.altitude, wz);
            entry.elevationResolved = true;
        }
        setMeshVisibility(entry, entry.enabled);
    };

    const setMeshVisibility = (entry: ModelEntry, visible: boolean): void => {
        if (entry.lastVisible === visible) return;
        entry.lastVisible = visible;
        for (const mesh of entry.meshes) {
            mesh.setEnabled(visible);
        }
    };

    const tickFrame = (): void => {
        if (entries.size === 0) return;
        for (const entry of entries.values()) {
            if (!entry.loaded) continue;
            applyTransform(entry);
        }
    };

    const observer: Observer<Scene> | null =
        ctx.scene.onBeforeRenderObservable.add(tickFrame);

    const unsubscribeTerrain = ctx.tileManager.subscribeTerrainUpdated(() => {
        // 標高更新時は次フレームの tickFrame で自動的に再評価される
    });

    const requireEntry = (id: string, prefix: string): ModelEntry => {
        const entry = entries.get(id);
        if (!entry) {
            throw new Error(`${prefix}: id "${id}" not found`);
        }
        return entry;
    };

    const loadModel = async (entry: ModelEntry): Promise<void> => {
        try {
            // 拡張子に応じたローダーを動的ロード（optional peer dependency のため遅延）
            await importLoaderForUrl(entry.url);
            // animationStartMode: NONE でロードし、アニメーション自動開始を抑制する。
            // 再生タイミングは playAnimation() で明示的に制御する。
            const result = await ImportMeshAsync(entry.url, ctx.scene, {
                pluginOptions: {
                    gltf: { animationStartMode: 0 },
                },
            });
            if (entry.cancelled) {
                // dispose / remove が先に呼ばれた場合はロード結果を破棄
                for (const mesh of result.meshes) {
                    mesh.dispose();
                }
                for (const ag of result.animationGroups) {
                    ag.dispose();
                }
                return;
            }
            entry.meshes = result.meshes;
            entry.animationGroups = result.animationGroups;

            // インポートされたメッシュ階層を root TransformNode の子にする。
            // glTF/GLB のスキンメッシュはボーン階層の親子関係に依存するため、
            // 親なしの最上位ノードのみを再配置する（内部ノードは触らない）。
            for (const mesh of result.meshes) {
                if (!mesh.parent) {
                    mesh.parent = entry.root;
                }
            }

            applyRotation(entry.root, entry.rotation);
            applyScaling(entry.root, entry.scaling);
            setMeshVisibility(entry, entry.enabled);
            applyTransform(entry);

            // loaded フラグはすべての初期化が完了してからセット
            entry.loaded = true;
        } catch (err) {
            if (!entry.cancelled) {
                console.error(
                    `[jpmap-terrain] Failed to load model "${entry.id}" from "${entry.url}":`,
                    err,
                );
            }
        }
    };

    return {
        add(id: string, options: ModelOptions): ModelHandle {
            if (disposed) {
                throw new Error("ModelManager has been disposed");
            }
            if (entries.has(id)) {
                throw new Error(
                    `${ERROR_PREFIX}: id "${id}" already exists`,
                );
            }
            if (!options.url) {
                throw new Error(`${ERROR_PREFIX}: url is required`);
            }
            assertLatLonInBounds(options.lat, options.lon, ERROR_PREFIX);

            const altitudeMode =
                options.altitudeMode ?? MODEL_DEFAULTS.altitudeMode;
            if (
                altitudeMode === "absolute" &&
                options.altitude === undefined
            ) {
                throw new Error(
                    `${ERROR_PREFIX}: altitudeMode="absolute" requires altitude`,
                );
            }

            const root = new TransformNode(`model-${id}`, ctx.scene);

            const entry: ModelEntry = {
                id,
                url: options.url,
                lat: options.lat,
                lon: options.lon,
                altitude: options.altitude ?? MODEL_DEFAULTS.altitude,
                altitudeMode,
                rotation: resolveVec3(options.rotation, MODEL_DEFAULTS.rotation),
                scaling: resolveVec3(options.scaling, MODEL_DEFAULTS.scaling),
                enabled: options.enabled ?? MODEL_DEFAULTS.enabled,
                gravity: options.gravity ?? MODEL_DEFAULTS.gravity,
                loaded: false,
                elevationResolved: altitudeMode === "absolute",
                root,
                meshes: [],
                animationGroups: [],
                cancelled: false,
                lastVisible: null,
            };

            entries.set(id, entry);

            // 非同期でモデルをロード
            void loadModel(entry);

            return toHandle(entry);
        },

        get(id: string): ModelHandle | null {
            const entry = entries.get(id);
            return entry ? toHandle(entry) : null;
        },

        update(id: string, partial: ModelUpdate): ModelHandle {
            if (disposed) {
                throw new Error("ModelManager has been disposed");
            }
            const entry = requireEntry(id, UPDATE_ERROR_PREFIX);

            if (partial.lat !== undefined || partial.lon !== undefined) {
                const newLat = partial.lat ?? entry.lat;
                const newLon = partial.lon ?? entry.lon;
                assertLatLonInBounds(newLat, newLon, UPDATE_ERROR_PREFIX);
                entry.lat = newLat;
                entry.lon = newLon;
            }

            if (partial.altitude !== undefined) {
                entry.altitude = partial.altitude;
            }

            if (partial.altitudeMode !== undefined) {
                // absolute モードへの切替時は、同じ update 呼び出しで altitude も明示指定を要求する。
                // entry.altitude は常に数値（MODEL_DEFAULTS.altitude = 0）なので、
                // 暗黙の 0 が absolute の海抜高度として使われることを防ぐ。
                if (
                    partial.altitudeMode === "absolute" &&
                    entry.altitudeMode !== "absolute" &&
                    partial.altitude === undefined
                ) {
                    throw new Error(
                        `${UPDATE_ERROR_PREFIX}: switching to altitudeMode="absolute" requires explicit altitude`,
                    );
                }
                entry.altitudeMode = partial.altitudeMode;
            }

            if (partial.rotation !== undefined) {
                entry.rotation = resolveVec3(partial.rotation, entry.rotation);
                if (entry.loaded) {
                    applyRotation(entry.root, entry.rotation);
                }
            }

            if (partial.scaling !== undefined) {
                entry.scaling = resolveVec3(partial.scaling, entry.scaling);
                if (entry.loaded) {
                    applyScaling(entry.root, entry.scaling);
                }
            }

            if (partial.enabled !== undefined) {
                entry.enabled = partial.enabled;
                if (entry.loaded) {
                    setMeshVisibility(entry, partial.enabled);
                }
            }

            if (partial.gravity !== undefined) {
                entry.gravity = partial.gravity;
            }

            if (entry.loaded) {
                applyTransform(entry);
            } else {
                // ロード完了前でも altitudeMode 切替で elevationResolved を正しく反映する
                if (entry.altitudeMode === "absolute") {
                    entry.elevationResolved = true;
                } else if (entry.gravity) {
                    const { wx, wz } = latLonToWorld(ctx, entry.lat, entry.lon);
                    entry.elevationResolved =
                        ctx.tileManager.queryElevationAtWorld(wx, wz) !== null;
                } else {
                    entry.elevationResolved = true;
                }
            }

            return toHandle(entry);
        },

        remove(id: string): void {
            const entry = entries.get(id);
            if (!entry) {
                console.warn(
                    `[jpmap-terrain] removeModel: id "${id}" not found`,
                );
                return;
            }
            entry.cancelled = true;
            for (const ag of entry.animationGroups) {
                ag.stop();
                ag.dispose();
            }
            for (const mesh of entry.meshes) {
                mesh.dispose();
            }
            entry.root.dispose();
            entries.delete(id);
        },

        setEnabled(id: string, enabled: boolean): void {
            if (disposed) {
                throw new Error("ModelManager has been disposed");
            }
            const entry = requireEntry(id, "JpmapTerrain.setModelEnabled");
            entry.enabled = enabled;
            if (entry.loaded) {
                setMeshVisibility(entry, enabled);
            }
        },

        list(): readonly string[] {
            return Array.from(entries.keys());
        },

        playAnimation(id: string, name?: string): void {
            if (disposed) {
                throw new Error("ModelManager has been disposed");
            }
            const entry = requireEntry(id, "JpmapTerrain.playModelAnimation");
            if (!entry.loaded) {
                console.warn(
                    `[jpmap-terrain] playModelAnimation: model "${id}" is not loaded yet`,
                );
                return;
            }
            if (name !== undefined) {
                const ag = entry.animationGroups.find((g) => g.name === name);
                if (!ag) {
                    console.warn(
                        `[jpmap-terrain] playModelAnimation: animation "${name}" not found in model "${id}"`,
                    );
                    return;
                }
                ag.play(true);
            } else {
                for (const ag of entry.animationGroups) {
                    ag.play(true);
                }
            }
        },

        stopAnimation(id: string, name?: string): void {
            if (disposed) {
                throw new Error("ModelManager has been disposed");
            }
            const entry = requireEntry(id, "JpmapTerrain.stopModelAnimation");
            if (!entry.loaded) return;
            if (name !== undefined) {
                const ag = entry.animationGroups.find((g) => g.name === name);
                if (ag) {
                    ag.stop();
                }
            } else {
                for (const ag of entry.animationGroups) {
                    ag.stop();
                }
            }
        },

        dispose(): void {
            if (disposed) return;
            disposed = true;
            if (observer) {
                ctx.scene.onBeforeRenderObservable.remove(observer);
            }
            unsubscribeTerrain();
            for (const entry of entries.values()) {
                entry.cancelled = true;
                for (const ag of entry.animationGroups) {
                    ag.stop();
                    ag.dispose();
                }
                for (const mesh of entry.meshes) {
                    mesh.dispose();
                }
                entry.root.dispose();
            }
            entries.clear();
        },
    };
};
