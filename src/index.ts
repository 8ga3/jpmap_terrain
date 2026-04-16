import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { getSceneModule } from "./createScene";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

export const babylonInit = async (): Promise<void> => {
    const createSceneModule = getSceneModule();
    const engineType =
        new URLSearchParams(location.search).get("engine") ?? "webgl";
    // Execute the pretasks, if defined
    await Promise.all(createSceneModule.preTasks || []);
    // Get the canvas element
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    // Generate the BABYLON 3D engine
    let engine: AbstractEngine;
    if (engineType === "webgpu") {
        const webGPUSupported = await WebGPUEngine.IsSupportedAsync;
        if (webGPUSupported) {
            // You can decide which WebGPU extensions to load when creating the engine. I am loading all of them
            await import("@babylonjs/core/Engines/WebGPU/Extensions/");
            const webgpu = engine = new WebGPUEngine(canvas, {
                adaptToDeviceRatio: true,
                antialias: true,
            });
            await webgpu.initAsync();
            engine = webgpu;
        } else {
            engine = new Engine(canvas, true);
        }
    } else {
        engine = new Engine(canvas, true);
    }

    // Create the scene
    const scene = await createSceneModule.createScene(engine, canvas);

    // Expose scene only in development/test builds for debugging and Playwright tests.
    // This assignment is guarded by a NODE_ENV check so production-targeted builds
    // can omit it when that condition is compiled away by the bundler/minifier.
    if (process.env.NODE_ENV !== "production") {
        (window as any).scene = scene;
    }

    // Register a render loop to repeatedly render the scene
    engine.runRenderLoop(function () {
        scene.render();
    });

    // Watch for browser/canvas resize events
    window.addEventListener("resize", function () {
        engine.resize();
    });
};

babylonInit().then(() => {
    // scene started rendering, everything is initialized
});
