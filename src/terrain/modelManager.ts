/**
 * ModelManager の公開契約 interface とローダー解決ユーティリティ (Issue #243 / #414)。
 *
 * `JpmapTerrain.addModel / getModel / updateModel / removeModel / setModelEnabled /
 *  listModels / playModelAnimation / stopModelAnimation`
 * から利用される 3D モデル操作の境界型。globe 単一バックエンド（#414）では
 * `globeSceneController` のアダプタがこの契約を実装する。
 * `importLoaderForUrl` は座標系非依存のため globe 実装（`globeModelManager`）から再利用する。
 */

import type {
    ModelHandle,
    ModelOptions,
    ModelUpdate,
} from "../lib/types";

export interface ModelManager {
    add(id: string, options: ModelOptions): ModelHandle;
    get(id: string): ModelHandle | null;
    update(id: string, partial: ModelUpdate): ModelHandle;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    /**
     * アニメーション再生。
     * `name` 省略時は全アニメーションを同時再生する。
     * 同一ボーンを対象とする複数アニメーションを同時再生した場合、
     * 最後に評価されるアニメーションがボーン変換値を上書きするため
     * 意図しない結果になることがある。特定のアニメーションのみ
     * 再生したい場合は `name` を指定すること。
     */
    playAnimation(id: string, name?: string): void;
    stopAnimation(id: string, name?: string): void;
    dispose(): void;
}

const ERROR_PREFIX = "JpmapTerrain.addModel";

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
