/**
 * Babylon.js Engine 生成 (T4 / Issue #118)
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

/**
 * Babylon.js Engine を生成する。
 * `preferred="webgpu"` でも WebGPU 非対応環境では WebGL2 (`Engine`) にフォールバック。
 */
export async function createBabylonEngine(
    canvas: HTMLCanvasElement,
    preferred: EngineType,
): Promise<AbstractEngine> {
    if (preferred === "webgpu") {
        const supported = await WebGPUEngine.IsSupportedAsync;
        if (supported) {
            await import("@babylonjs/core/Engines/WebGPU/Extensions/");
            const engine = new WebGPUEngine(canvas, {
                adaptToDeviceRatio: true,
                antialias: true,
            });
            await engine.initAsync();
            return engine;
        }
    }
    return new Engine(canvas, true);
}
