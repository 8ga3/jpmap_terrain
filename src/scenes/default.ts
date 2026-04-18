import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { CreateSceneClass } from "../createScene";
import {
    TILE_SIZE,
    clamp,
    toTileXY,
    tileEdgeMeters,
    loadElevationTile,
    stdTextureUrl,
} from "../terrain/gsiTile";
import { createControlPanel } from "../terrain/controlPanel";

const TERRAIN_SUBDIVISIONS = 128;
const ELEVATION_ZOOM = 14;
const HEIGHT_SCALE = 1.0;

const JAPAN_BOUNDS = { minLat: 20, maxLat: 46, minLon: 122, maxLon: 154 };

/** 頂点Y座標を標高値で更新し、中心標高を返す */
const applyElevation = (
    positions: Float32Array,
    elevations: Float32Array,
    altitudeOffset: number
): number => {
    let centerElev = 0;
    const cols = TERRAIN_SUBDIVISIONS + 1;
    for (let row = 0; row <= TERRAIN_SUBDIVISIONS; row++) {
        for (let col = 0; col <= TERRAIN_SUBDIVISIONS; col++) {
            const u = col / TERRAIN_SUBDIVISIONS;
            const v = row / TERRAIN_SUBDIVISIONS;
            const sx = Math.min(
                TILE_SIZE - 1,
                Math.round(u * (TILE_SIZE - 1))
            );
            const sy = Math.min(
                TILE_SIZE - 1,
                Math.round(v * (TILE_SIZE - 1))
            );
            const elev = elevations[sy * TILE_SIZE + sx];
            if (
                row === TERRAIN_SUBDIVISIONS / 2 &&
                col === TERRAIN_SUBDIVISIONS / 2
            ) {
                centerElev = elev;
            }
            positions[(row * cols + col) * 3 + 1] =
                (elev + altitudeOffset) * HEIGHT_SCALE;
        }
    }
    return centerElev;
};

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
        const initialTileSize = tileEdgeMeters(initialLat, ELEVATION_ZOOM);

        // 地形メッシュ
        const ground = CreateGround(
            "terrain-ground",
            {
                width: initialTileSize,
                height: initialTileSize,
                subdivisions: TERRAIN_SUBDIVISIONS,
                updatable: true,
            },
            scene
        );
        const groundMat = new StandardMaterial("terrain-mat", scene);
        groundMat.specularColor = Color3.Black();
        ground.material = groundMat;

        // UIパネル
        const ui = createControlPanel(initialLat, initialLon, {
            alpha: camera.alpha,
            beta: camera.beta,
            radius: camera.radius,
        });

        // 状態
        let requestId = 0;

        const refreshTerrain = async (): Promise<void> => {
            const rid = ++requestId;
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

            const tile = toTileXY(lat, lon, ELEVATION_ZOOM);
            ui.status.textContent = `読込中 z${ELEVATION_ZOOM}/${tile.x}/${tile.y}`;

            try {
                const elev = await loadElevationTile(
                    ELEVATION_ZOOM,
                    tile.x,
                    tile.y
                );
                if (rid !== requestId) return; // 古いリクエスト破棄

                const pos = ground.getVerticesData(VertexBuffer.PositionKind);
                const idx = ground.getIndices();
                if (!pos || !idx)
                    throw new Error("Ground mesh data unavailable");

                const typed =
                    pos instanceof Float32Array
                        ? pos
                        : new Float32Array(pos);
                const centerElev = applyElevation(typed, elev, altOff);

                ground.updateVerticesData(VertexBuffer.PositionKind, typed);
                const normals = new Float32Array(typed.length);
                VertexData.ComputeNormals(typed, idx, normals);
                ground.updateVerticesData(VertexBuffer.NormalKind, normals);

                // タイルサイズ補正
                const curSize = tileEdgeMeters(lat, ELEVATION_ZOOM);
                ground.scaling.x = curSize / initialTileSize;
                ground.scaling.z = curSize / initialTileSize;

                // テクスチャ
                if (groundMat.diffuseTexture) {
                    groundMat.diffuseTexture.dispose();
                }
                groundMat.diffuseTexture = new Texture(
                    stdTextureUrl(ELEVATION_ZOOM, tile.x, tile.y),
                    scene,
                    true,
                    false,
                    Texture.TRILINEAR_SAMPLINGMODE
                );

                camera.setTarget(
                    new Vector3(
                        0,
                        (centerElev + altOff) * HEIGHT_SCALE,
                        0
                    )
                );
                ui.status.textContent = `表示中 z${ELEVATION_ZOOM}/${tile.x}/${tile.y}`;
            } catch (e) {
                if (rid !== requestId) return;
                ui.status.textContent = `読込エラー: ${String(e)}`;
            }
        };

        // カメラ ↔ UI 同期
        const applyCameraFromUI = (): void => {
            camera.alpha = Number(ui.cameraAlphaInput.value);
            camera.beta = Number(ui.cameraBetaInput.value);
            camera.radius = Number(ui.cameraRadiusInput.value);
        };
        const syncUIFromCamera = (): void => {
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

        scene.onBeforeRenderObservable.add(syncUIFromCamera);

        // 初回ロード
        await refreshTerrain();

        return scene;
    };
}

export default new DefaultScene();
