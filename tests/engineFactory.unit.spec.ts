/**
 * @jest-environment jsdom
 */
/**
 * `createBabylonEngine` の WebGPU/WebGL2 フォールバック分岐テスト (T4 / Issue #118)
 *
 * - preferred="webgpu" かつ WebGPU 対応 → WebGPUEngine + initAsync 呼び出し
 * - preferred="webgpu" かつ WebGPU 非対応 → WebGL2 (`Engine`) にフォールバック
 * - preferred="webgl2" → 即時 WebGL2
 *
 * Babylon.js Engine 実装は jsdom で動かないためモック化する。
 */

import { jest } from "@jest/globals";

// --- モック実装 -------------------------------------------------------------
const webgpuConstructor = jest.fn();
const webgpuInitAsync = jest.fn(async () => undefined);
const engineConstructor = jest.fn();
let webgpuSupported = true;

class MockWebGPUEngine {
    initAsync = webgpuInitAsync;
    constructor(...args: unknown[]) {
        webgpuConstructor(...args);
    }
    static get IsSupportedAsync(): Promise<boolean> {
        return Promise.resolve(webgpuSupported);
    }
}

class MockEngine {
    constructor(...args: unknown[]) {
        engineConstructor(...args);
    }
}

jest.unstable_mockModule("@babylonjs/core/Engines/webgpuEngine", () => ({
    WebGPUEngine: MockWebGPUEngine,
}));

jest.unstable_mockModule("@babylonjs/core/Engines/engine", () => ({
    Engine: MockEngine,
}));

// WebGPU Extensions の dynamic import を中和
jest.unstable_mockModule("@babylonjs/core/Engines/WebGPU/Extensions/", () => ({}));

const { createBabylonEngine } = await import("../src/lib/internal/engineFactory");

describe("createBabylonEngine", () => {
    const canvas = (): HTMLCanvasElement => document.createElement("canvas");

    beforeEach(() => {
        webgpuConstructor.mockClear();
        webgpuInitAsync.mockClear();
        engineConstructor.mockClear();
        webgpuSupported = true;
    });

    it("preferred=webgpu かつ WebGPU 対応時は WebGPUEngine を返し initAsync を呼ぶ", async () => {
        const engine = await createBabylonEngine(canvas(), "webgpu");

        expect(engine).toBeInstanceOf(MockWebGPUEngine);
        expect(webgpuConstructor).toHaveBeenCalledTimes(1);
        expect(webgpuInitAsync).toHaveBeenCalledTimes(1);
        expect(engineConstructor).not.toHaveBeenCalled();
    });

    it("preferred=webgpu でも WebGPU 非対応時は Engine (WebGL2) にフォールバック", async () => {
        webgpuSupported = false;

        const engine = await createBabylonEngine(canvas(), "webgpu");

        expect(engine).toBeInstanceOf(MockEngine);
        expect(webgpuConstructor).not.toHaveBeenCalled();
        expect(webgpuInitAsync).not.toHaveBeenCalled();
        expect(engineConstructor).toHaveBeenCalledTimes(1);
    });

    it("preferred=webgl2 のときは Engine (WebGL2) を即時生成", async () => {
        const engine = await createBabylonEngine(canvas(), "webgl2");

        expect(engine).toBeInstanceOf(MockEngine);
        expect(webgpuConstructor).not.toHaveBeenCalled();
        expect(webgpuInitAsync).not.toHaveBeenCalled();
        expect(engineConstructor).toHaveBeenCalledTimes(1);
    });
});
