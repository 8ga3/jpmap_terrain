import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { CreateSceneClass } from "../createScene";
import { clamp } from "../terrain/gsiTile";
import { createControlPanel } from "../terrain/controlPanel";
import { createTileManager } from "../terrain/tileManager";

const TERRAIN_SUBDIVISIONS = 128;
const ELEVATION_ZOOM = 14;
const HEIGHT_SCALE = 1.0;

const JAPAN_BOUNDS = { minLat: 20, maxLat: 46, minLon: 122, maxLon: 154 };

export class DefaultScene implements CreateSceneClass {
    createScene = async (
        engine: AbstractEngine,
        canvas: HTMLCanvasElement
    ): Promise<Scene> => {
        const scene = new Scene(engine);
        scene.clearColor.set(0.75, 0.86, 0.95, 1);

        // カメラ
        const camera = new ArcRotateCamera(
            "terrain-camera",
            -Math.PI / 2,
            Math.PI / 3,
            4000,
            Vector3.Zero(),
            scene
        );
        camera.lowerRadiusLimit = 250;
        camera.upperRadiusLimit = 40000;
        camera.maxZ = 100000;
        camera.wheelDeltaPercentage = 0.02;
        camera.panningSensibility = 1500;
        camera.attachControl(canvas, true);

        // ライト
        const light = new HemisphericLight(
            "sky-light",
            new Vector3(0, 1, 0),
            scene
        );
        light.intensity = 1.0;

        // 初期位置（東京駅付近）
        const initialLat = 35.681236;
        const initialLon = 139.767125;

        // UIパネル
        const ui = createControlPanel(initialLat, initialLon, {
            alpha: camera.alpha,
            beta: camera.beta,
            radius: camera.radius,
        });

        // TileManager 生成
        const tileManager = createTileManager({
            scene,
            camera,
            zoom: ELEVATION_ZOOM,
            subdivisions: TERRAIN_SUBDIVISIONS,
            heightScale: HEIGHT_SCALE,
        });

        tileManager.onStatusChange = (status: string) => {
            ui.status.textContent = status;
        };

        const refreshTerrain = async (): Promise<void> => {
            const lat = clamp(
                Number(ui.latInput.value),
                JAPAN_BOUNDS.minLat,
                JAPAN_BOUNDS.maxLat
            );
            const lon = clamp(
                Number(ui.lonInput.value),
                JAPAN_BOUNDS.minLon,
                JAPAN_BOUNDS.maxLon
            );
            const altOff = Number(ui.altitudeInput.value) || 0;

            ui.latInput.value = lat.toFixed(6);
            ui.lonInput.value = lon.toFixed(6);

            await tileManager.setCenter(lat, lon, altOff);
        };

        // カメラ ↔ UI 同期
        const applyCameraFromUI = (): void => {
            camera.alpha = Number(ui.cameraAlphaInput.value);
            camera.beta = Number(ui.cameraBetaInput.value);
            camera.radius = Number(ui.cameraRadiusInput.value);
        };
        let prevAlpha = camera.alpha;
        let prevBeta = camera.beta;
        let prevRadius = camera.radius;
        const syncUIFromCamera = (): void => {
            if (
                camera.alpha === prevAlpha &&
                camera.beta === prevBeta &&
                camera.radius === prevRadius
            ) {
                return;
            }
            prevAlpha = camera.alpha;
            prevBeta = camera.beta;
            prevRadius = camera.radius;
            ui.cameraAlphaInput.value = String(camera.alpha);
            ui.cameraBetaInput.value = String(camera.beta);
            ui.cameraRadiusInput.value = String(camera.radius);
        };

        // イベント接続
        ui.updateButton.addEventListener("click", () => void refreshTerrain());
        ui.latInput.addEventListener("change", () => void refreshTerrain());
        ui.lonInput.addEventListener("change", () => void refreshTerrain());
        ui.altitudeInput.addEventListener(
            "change",
            () => void refreshTerrain()
        );

        ui.cameraAlphaInput.addEventListener("input", applyCameraFromUI);
        ui.cameraBetaInput.addEventListener("input", applyCameraFromUI);
        ui.cameraRadiusInput.addEventListener("input", applyCameraFromUI);

        camera.onViewMatrixChangedObservable.add(syncUIFromCamera);

        // カメラ移動時の自動タイル更新
        tileManager.attachCamera();

        // 初回ロード
        await refreshTerrain();

        return scene;
    };
}

export default new DefaultScene();
