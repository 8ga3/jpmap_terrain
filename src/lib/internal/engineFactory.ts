/**
 * Babylon.js Engine 生成
 *
 * 指定された描画モード ("webgpu" | "webgl2") に応じて適切な Engine を生成する。
 * WebGPU 非対応環境では自動的に WebGL2 にフォールバックする。
 *
 * - パッケージ利用側 (`JpmapTerrain.create`) と既存デモ (`src/index.ts`) の双方から
 *   同じロジックを参照できるように切り出している。
 * - jest 環境では `@babylonjs/core/Engines/*` をモックして本ファイル全体を差し替える前提。
 */

import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import type { EngineType } from "../types";

/** `createBabylonEngine` の追加オプション。 */
export interface CreateBabylonEngineOptions {
    /**
     * 高精度行列（float64）を有効化するか（globe / large world 用）。
     *
     * globe は真の ECEF（~6.4e6 m）でメッシュを配置するため、行列が既定の Float32 だと
     * floating origin リベース時に ~0.76m へ量子化されてジッターが出る。Babylon は
     * `useHighPrecisionMatrix` を **最初に生成された Engine** で有効化すると、追跡済みの
     * 全行列（floating origin の一時行列を含む）を float64 へ移行する
     * （`PerformanceConfigurator.SetMatrixPrecision`）。scene 側の `useFloatingOrigin` だけでは
     * 不十分で、engine 側の本オプションが必須（@babylonjs/core abstractEngine の仕様）。
     */
    highPrecisionMatrix?: boolean;
}

/**
 * 一度 high precision を要求したら以後も維持するためのラッチ。
 *
 * 行列精度は `PerformanceConfigurator` のグローバル状態で、Engine 生成のたびに
 * `SetMatrixPrecision(!!useHighPrecisionMatrix)` が呼ばれる。globe Engine の後に
 * 既定（float32）の Engine を生成すると float32 へ巻き戻り、以後生成される行列が
 * 精度不足になる。globe（PIP 等の二次 Viewer 含む）で一貫して float64 を保つため、
 * 一度 true になったら以後の Engine 生成でも true を渡す。
 */
let highPrecisionMatrixLatched = false;

/**
 * Babylon.js Engine を生成する。
 * `preferred="webgpu"` でも WebGPU 非対応環境では WebGL2 (`Engine`) にフォールバック。
 */
export async function createBabylonEngine(
    canvas: HTMLCanvasElement,
    preferred: EngineType,
    options?: CreateBabylonEngineOptions,
): Promise<AbstractEngine> {
    if (options?.highPrecisionMatrix) {
        highPrecisionMatrixLatched = true;
    }
    const useHighPrecisionMatrix = highPrecisionMatrixLatched;

    if (preferred === "webgpu") {
        const supported = await WebGPUEngine.IsSupportedAsync;
        if (supported) {
            await import("@babylonjs/core/Engines/WebGPU/Extensions/");
            const engine = new WebGPUEngine(canvas, {
                adaptToDeviceRatio: true,
                antialias: true,
                useHighPrecisionMatrix,
            });
            await engine.initAsync();
            return engine;
        }
    }
    return new Engine(canvas, true, { useHighPrecisionMatrix });
}
