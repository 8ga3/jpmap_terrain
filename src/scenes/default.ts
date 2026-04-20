import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import "@babylonjs/core/Culling/ray";
import { CreateSceneClass } from "../createScene";
import { clamp, toTileXY, tileEdgeMeters, JAPAN_BOUNDS } from "../terrain/gsiTile";
import { createControlPanel } from "../terrain/controlPanel";
import { createTileManager } from "../terrain/tileManager";

const TERRAIN_SUBDIVISIONS = 128;
const MAX_ZOOM = 18;
const MAX_ELEVATION_ZOOM = 17;
const HEIGHT_SCALE = 1.0;
const MIN_ZOOM = 8;

/** 1度の緯度あたりのメートル数（概算） */
const METERS_PER_DEGREE_LAT = 111320;

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
        camera.minZ = 10;
        camera.maxZ = 100000;

        // チルト制限（地面から20° = beta上限 7π/18）
        camera.upperBetaLimit = Math.PI / 2 - Math.PI / 9;
        camera.lowerBetaLimit = 0.1;

        // デフォルト入力をすべて無効化（カスタムハンドラで制御）
        camera.inputs.removeByType("ArcRotateCameraPointersInput");
        camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
        camera.inputs.removeByType("ArcRotateCameraMouseWheelInput");
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
        const ui = createControlPanel(initialLat, initialLon);

        // TileManager 生成
        const tileManager = createTileManager({
            scene,
            camera,
            zoom: MAX_ZOOM,
            subdivisions: TERRAIN_SUBDIVISIONS,
            heightScale: HEIGHT_SCALE,
            minZoom: MIN_ZOOM,
            maxElevationZoom: MAX_ELEVATION_ZOOM,
            maxTiles: 160,
            cacheCapacity: 256,
        });

        let currentAltitudeOffset = 0;
        let gridResidualX = 0;
        let gridResidualZ = 0;

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
            ui.latInput.value = lat.toFixed(6);
            ui.lonInput.value = lon.toFixed(6);
            await tileManager.setCenter(lat, lon, currentAltitudeOffset);
        };

        // ---------- カメラターゲットオフセット → 緯度経度変換 ----------
        const commitPanOffset = (): void => {
            const tx = camera.target.x;
            const tz = camera.target.z;
            if (tx === 0 && tz === 0) return;

            // 新規オフセット = 全体 - 既知のグリッド残差
            const newOffsetX = tx - gridResidualX;
            const newOffsetZ = tz - gridResidualZ;
            if (Math.abs(newOffsetX) < 0.01 && Math.abs(newOffsetZ) < 0.01) {
                return;
            }

            const oldLat = Number(ui.latInput.value);
            const oldLon = Number(ui.lonInput.value);
            const metersPerDegreeLon =
                METERS_PER_DEGREE_LAT *
                Math.cos((oldLat * Math.PI) / 180);

            const newLat = clamp(
                oldLat + newOffsetZ / METERS_PER_DEGREE_LAT,
                JAPAN_BOUNDS.minLat,
                JAPAN_BOUNDS.maxLat
            );
            const newLon = clamp(
                oldLon + newOffsetX / metersPerDegreeLon,
                JAPAN_BOUNDS.minLon,
                JAPAN_BOUNDS.maxLon
            );

            const oldTile = toTileXY(oldLat, oldLon, MAX_ZOOM);
            const newTile = toTileXY(newLat, newLon, MAX_ZOOM);
            const tileSize = tileEdgeMeters(newLat, MAX_ZOOM);
            const gridShiftX = (newTile.x - oldTile.x) * tileSize;
            const gridShiftZ = -((newTile.y - oldTile.y) * tileSize);

            // 残差更新: 旧残差 + 新規オフセット - グリッドシフト
            gridResidualX = gridResidualX + newOffsetX - gridShiftX;
            gridResidualZ = gridResidualZ + newOffsetZ - gridShiftZ;

            camera.target.x = gridResidualX;
            camera.target.y = 0;
            camera.target.z = gridResidualZ;

            ui.latInput.value = newLat.toFixed(6);
            ui.lonInput.value = newLon.toFixed(6);
            void refreshTerrain();
        };

        // ---------- レイ-平面交差ユーティリティ ----------
        const intersectPlane = (
            screenX: number,
            screenY: number,
            planeY: number
        ): { x: number; z: number } | null => {
            const renderW = engine.getRenderWidth();
            const renderH = engine.getRenderHeight();
            const scaleX = renderW / canvas.clientWidth;
            const scaleY = renderH / canvas.clientHeight;
            const view = camera.getViewMatrix();
            const proj = camera.getProjectionMatrix();
            const identity = Matrix.Identity();
            const near = Vector3.Unproject(
                new Vector3(screenX * scaleX, screenY * scaleY, 0),
                renderW, renderH, identity, view, proj
            );
            const far = Vector3.Unproject(
                new Vector3(screenX * scaleX, screenY * scaleY, 1),
                renderW, renderH, identity, view, proj
            );
            const dirY = far.y - near.y;
            if (Math.abs(dirY) < 1e-6) return null;
            const t = (planeY - near.y) / dirY;
            if (t <= 0) return null;
            return {
                x: near.x + (far.x - near.x) * t,
                z: near.z + (far.z - near.z) * t,
            };
        };

        // ---------- カスタムマウスハンドラ ----------
        let pointerDown = false;
        let lastPointerX = 0;
        let lastPointerY = 0;
        let activePointerId = -1;
        let dragAnchor: { x: number; z: number } | null = null;
        let dragPlaneY = 0;

        canvas.addEventListener("contextmenu", (e) => e.preventDefault());

        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            pointerDown = true;
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
            activePointerId = e.pointerId;
            canvas.setPointerCapture(e.pointerId);

            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const pick = scene.pick(sx, sy);
            dragPlaneY =
                pick?.hit && pick.pickedPoint ? pick.pickedPoint.y : 0;
            dragAnchor = intersectPlane(sx, sy, dragPlaneY);
        });

        canvas.addEventListener("pointermove", (e: PointerEvent) => {
            if (!pointerDown || e.pointerId !== activePointerId) return;

            if (e.ctrlKey || e.metaKey) {
                // Ctrl/Cmd + ドラッグ: 水平=パン(alpha)、垂直=チルト(beta)
                const dx = e.clientX - lastPointerX;
                const dy = e.clientY - lastPointerY;
                lastPointerX = e.clientX;
                lastPointerY = e.clientY;
                camera.alpha -= dx * 0.003;
                camera.beta -= dy * 0.003;
                camera.beta = clamp(
                    camera.beta,
                    camera.lowerBetaLimit ?? 0,
                    camera.upperBetaLimit ?? Math.PI
                );
            } else if (dragAnchor) {
                // 通常ドラッグ: 逐次差分でパン（毎フレームanchor更新）
                const rect = canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const current = intersectPlane(sx, sy, dragPlaneY);
                if (current) {
                    camera.target.x += dragAnchor.x - current.x;
                    camera.target.z += dragAnchor.z - current.z;
                    dragAnchor = intersectPlane(sx, sy, dragPlaneY);
                }
            }
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
        });

        canvas.addEventListener("pointerup", (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            pointerDown = false;
            canvas.releasePointerCapture(e.pointerId);
            commitPanOffset();
        });

        const resetPointerState = (): void => {
            pointerDown = false;
            activePointerId = -1;
            dragAnchor = null;
            commitPanOffset();
        };

        canvas.addEventListener("pointercancel", resetPointerState);
        canvas.addEventListener("lostpointercapture", resetPointerState);

        // ホイール / ダブルクリック: ポインタ方向にズーム
        const zoomTowardPoint = (
            worldX: number,
            worldZ: number,
            factor: number
        ): void => {
            const upper = camera.upperRadiusLimit ?? 40000;
            const lower = camera.lowerRadiusLimit ?? 250;
            if (factor > 1 && camera.radius >= upper) return;
            if (factor < 1 && camera.radius <= lower) return;

            camera.target.x += (worldX - camera.target.x) * (1 - factor);
            camera.target.z += (worldZ - camera.target.z) * (1 - factor);
            camera.radius *= factor;
            camera.radius = clamp(camera.radius, lower, upper);
            commitPanOffset();
        };

        /** メッシュまたは y=0 平面との交点を返す。空なら null */
        const pickOrPlane = (
            sx: number,
            sy: number
        ): { worldX: number; worldZ: number } | null => {
            const pick = scene.pick(sx, sy);
            if (pick?.hit && pick.pickedPoint) {
                return {
                    worldX: pick.pickedPoint.x,
                    worldZ: pick.pickedPoint.z,
                };
            }
            const plane = intersectPlane(sx, sy, 0);
            return plane ? { worldX: plane.x, worldZ: plane.z } : null;
        };

        /** ピック結果がカメラターゲットから近いかどうか */
        const isPickNearTarget = (
            hit: { worldX: number; worldZ: number }
        ): boolean => {
            const dx = hit.worldX - camera.target.x;
            const dz = hit.worldZ - camera.target.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            return dist < camera.radius * 3;
        };

        canvas.addEventListener(
            "wheel",
            (e: WheelEvent) => {
                if (e.deltaY === 0) return;
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                const hit = pickOrPlane(e.clientX - rect.left, e.clientY - rect.top);
                if (hit && isPickNearTarget(hit)) {
                    const factor = e.deltaY < 0 ? 0.95 : 1 / 0.95;
                    zoomTowardPoint(hit.worldX, hit.worldZ, factor);
                } else {
                    const delta = e.deltaY > 0 ? -50 : 50;
                    currentAltitudeOffset = clamp(
                        currentAltitudeOffset + delta,
                        -2000,
                        8000
                    );
                    void refreshTerrain();
                }
            },
            { passive: false }
        );

        canvas.addEventListener("dblclick", (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            const hit = pickOrPlane(e.clientX - rect.left, e.clientY - rect.top);
            if (hit && isPickNearTarget(hit)) {
                zoomTowardPoint(hit.worldX, hit.worldZ, 0.7);
            } else {
                currentAltitudeOffset = clamp(
                    currentAltitudeOffset + 100,
                    -2000,
                    8000
                );
                void refreshTerrain();
            }
        });

        // 方位磁針の回転同期
        const syncCompass = (): void => {
            const degrees = (camera.alpha * 180) / Math.PI + 90;
            ui.compass.style.transform = `rotate(${degrees}deg)`;
        };
        camera.onViewMatrixChangedObservable.add(syncCompass);

        // 方位磁針: 北向き・真下にスムーズアニメーション
        ui.compass.style.cursor = "pointer";
        const resetCompassView = (): void => {
            const targetAlpha = -Math.PI / 2; // 北向き
            const targetBeta = 0.1;           // ほぼ真下
            const duration = 400;             // ms
            const startAlpha = camera.alpha;
            const startBeta = camera.beta;
            const startTime = performance.now();

            const animate = (now: number): void => {
                const elapsed = now - startTime;
                const t = Math.min(elapsed / duration, 1);
                // ease-out cubic
                const ease = 1 - Math.pow(1 - t, 3);
                camera.alpha = startAlpha + (targetAlpha - startAlpha) * ease;
                camera.beta = startBeta + (targetBeta - startBeta) * ease;
                if (t < 1) {
                    requestAnimationFrame(animate);
                }
            };
            requestAnimationFrame(animate);
        };
        ui.compass.addEventListener("click", resetCompassView);
        ui.compass.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                resetCompassView();
            }
        });

        // ズームボタン: 画面中央に向かってズーム
        const zoomFromCenter = (factor: number): void => {
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const hit = pickOrPlane(cx, cy);
            if (hit && isPickNearTarget(hit)) {
                zoomTowardPoint(hit.worldX, hit.worldZ, factor);
            }
        };
        ui.zoomIn.addEventListener("click", () => zoomFromCenter(0.7));
        ui.zoomOut.addEventListener("click", () => zoomFromCenter(1 / 0.7));

        // イベント接続
        const resetAndRefresh = (): void => {
            camera.target.x = 0;
            camera.target.y = 0;
            camera.target.z = 0;
            gridResidualX = 0;
            gridResidualZ = 0;
            void refreshTerrain();
        };
        ui.updateButton.addEventListener("click", resetAndRefresh);
        ui.latInput.addEventListener("change", resetAndRefresh);
        ui.lonInput.addEventListener("change", resetAndRefresh);

        // カメラ移動時の自動タイル更新
        tileManager.attachCamera();

        // 初回ロード
        await refreshTerrain();

        return scene;
    };
}

export default new DefaultScene();
