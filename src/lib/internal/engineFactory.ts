/**
 * Babylon.js Engine 生成
 *
 * 指定された描画モード ("webgpu" | "webgl2") に応じて適切な Engine を生成する。
 * WebGPU 非対応環境では自動的に WebGL2 にフォールバックする。
 *
 * - パッケージ利用側 (`JpmapTerrain.create`) と既存デモ (`src/index.ts`) の双方から
 *   同じロジックを参照できるように切り出している。
 * - vitest 環境では `@babylonjs/core/Engines/*` をモックして本ファイル全体を差し替える前提。
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

    /**
     * reverse-Z 深度バッファ（{@link enableReverseDepthBuffer}）を有効化するか。既定は `true`
     * （globe/viewer 等、既存デモの挙動を変えないため）。
     *
     * @remarks WebXR (`immersive-ar`/`immersive-vr`) セッション中、Babylon の `WebXRCamera` は
     * 自前の投影行列を計算せず、ブラウザ（デバイス）が `XRView.projectionMatrix` として渡す
     * 生の行列をそのままコピーする（`@babylonjs/core/XR/webXRCamera.js` の
     * `_updateFromXRSession` 参照）。この行列は reverse-Z 変換を考慮しない通常の
     * （forward-Z）投影行列であるため、`useReverseDepthBuffer=true`（reverse-Z 前提の深度
     * クリア値・深度比較関数・`zOffset`符号反転）と組み合わせると、深度テストの前提が
     * 一致しなくなる。実機（Meta Quest 3 / Androidスマホ）検証で、地形メッシュと側面壁の
     * オクルージョンが機種間で不安定になる不具合・Androidで基本プリミティブすら描画されない
     * 不具合が、`renderingGroupId`/`zOffset`/メッシュ統合等の深度回避策では解消できなかった
     * ことから、この不整合が根本原因である可能性が高いと判明した
     * （diorama デモ: `false` を指定する）。
     */
    reverseDepthBuffer?: boolean;
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
    const useReverseDepthBuffer = options?.reverseDepthBuffer !== false;

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
            if (useReverseDepthBuffer) enableReverseDepthBuffer(engine);
            return engine;
        }
    }
    const engine = new Engine(canvas, true, { useHighPrecisionMatrix });
    if (useReverseDepthBuffer) enableReverseDepthBuffer(engine);
    return engine;
}

/**
 * reverse-Z 深度バッファを有効化する。
 *
 * 低高度・水平チルト（地平線付近）では minZ:maxZ 比が極端（例: 1m : ~733km）になり、
 * 24bit 整数深度では遠景の深度分解能が枯渇して地形メッシュとスカイボックスが z-fighting し、
 * 地平線付近の地形が透けて見える。reverse-Z は投影行列レベルで near/far の深度分布を反転し、
 * 遠景の深度分解能を大幅に改善する。全メッシュ・全マテリアルへ自動適用されるため
 * マテリアル毎の設定漏れリスクがなく、追加シェーダーコストもほぼゼロ。
 * 右手系・ORTHOGRAPHIC(2D) の双方に Babylon 本体が対応済み。
 */
function enableReverseDepthBuffer(engine: AbstractEngine): void {
    engine.useReverseDepthBuffer = true;
}
