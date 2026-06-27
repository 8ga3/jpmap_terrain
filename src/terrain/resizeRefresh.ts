/**
 * リサイズに伴うタイル再描画ヘルパ
 *
 * Babylon.js の `engine.onResizeObservable` は canvas のリサイズで発火するが、
 * カメラのビュー行列は変化しないため `tileManager` 側の可視タイル更新
 * (`camera.onViewMatrixChangedObservable` 起点) が走らない。これにより、
 * ウィンドウ拡大時に新たに視野へ入った領域のタイルが取得・描画されない問題が発生する。
 *
 * 本ヘルパは engine のリサイズイベントを購読し、短い debounce を挟んだうえで
 * 与えられた `refresh` を呼ぶ。`tileManager.applyVisibleTiles` 側が差分更新
 * (不要解放＋新規ロード) のため、既存タイルは保持されちらつかない。
 *
 * Scene の dispose 時には Observer 解除と保留中タイマーのクリアを行い、
 * 破棄済みリソースへの参照やタイマーリークを防ぐ。
 */

import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

/** debounce のデフォルト値 (ms)。連続リサイズで refresh が頻発しない値。 */
export const DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS = 100;

export interface AttachResizeRefreshOptions {
    /** debounce 時間 (ms)。省略時は {@link DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS}。 */
    readonly debounceMs?: number;
}

export interface AttachResizeRefreshHandle {
    /** 購読解除と保留中タイマーのクリアを行う。複数回呼んでも安全。 */
    dispose(): void;
}

/**
 * `engine.onResizeObservable` を購読し、debounce 付きで `refresh` を呼ぶ。
 * `scene.onDisposeObservable` で自動的に dispose も登録する。
 *
 * @param engine 対象の Babylon.js Engine
 * @param scene 対象の Scene。dispose 検知に利用する。
 * @param refresh リサイズ後に呼びたい処理 (通常は `refreshTerrain`)。
 * @param options debounce 時間など。
 * @returns 手動 dispose 用のハンドル。
 */
export function attachResizeRefresh(
    engine: Pick<AbstractEngine, "onResizeObservable">,
    scene: Pick<Scene, "onDisposeObservable">,
    refresh: () => void | Promise<void>,
    options?: AttachResizeRefreshOptions,
): AttachResizeRefreshHandle {
    const debounceMs = options?.debounceMs ?? DEFAULT_RESIZE_REFRESH_DEBOUNCE_MS;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const observer: Observer<AbstractEngine> | null = engine.onResizeObservable.add(
        () => {
            if (disposed) return;
            if (timer !== null) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = null;
                if (disposed) return;
                void refresh();
            }, debounceMs);
        },
    );

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (observer) {
            engine.onResizeObservable.remove(observer);
        }
    };

    scene.onDisposeObservable.add(() => {
        dispose();
    });

    return { dispose };
}
