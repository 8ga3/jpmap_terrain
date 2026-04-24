import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Ray } from "@babylonjs/core/Culling/ray";
import { CreateSceneClass } from "../createScene";
import { clamp, toTileXY, tileEdgeMeters, JAPAN_BOUNDS } from "../terrain/gsiTile";
import { createControlPanel, snapScale, formatScale, showToast } from "../terrain/controlPanel";
import { createTileManager } from "../terrain/tileManager";
import { createSkybox } from "../terrain/skybox";
import { parseLatLonFromUrl, createUrlUpdater } from "../terrain/urlState";
import { resolveTiltCollision, TILT_MAX_RADIUS_INCREASE_RATIO } from "../terrain/cameraCollision";
import { computePoseForNewTarget } from "../terrain/cameraRetarget";

const TERRAIN_SUBDIVISIONS = 128;
const MAX_ZOOM = 18;
const MAX_ELEVATION_ZOOM = 17;
const MIN_ELEVATION_ZOOM = 10;
const HEIGHT_SCALE = 1.0;
// Quadtree 探索の最低ズーム。低すぎると傾斜視点時に地平線方向で極端な低解像度タイルが
// 採用され「多数 × 低解像度」状態になる一方、高すぎると最大チルト時に遠景タイルが root 候補
// から外れて表示されない。zoom 8（タイル辺 ≒ 128km）が遠方の山まで表示できる下限。
const MIN_ZOOM = 8;
// Quadtree root 探索範囲（minZoom タイル単位の ±N 格子）。
// 最大 tilt（beta ≈ 75°）の水平視野は遠クリッピング（400km）近くまで達するため、zoom8 で ±4
// （9×9、概ね ±512km カバー）を既定とする。視錐台外の root は AABB カリングで即除外される。
const ROOT_SEARCH_RADIUS = 4;

/** カメラ最小距離（メートル） */
const CAMERA_LOWER_RADIUS = 50;
/** カメラ最大距離（メートル） */
const CAMERA_UPPER_RADIUS = 75000;
/** 遠クリッピング面（メートル） */
const CAMERA_FAR_CLIP = 400000;

/** Phase 2（垂直移動）に切り替えるカメラ高度の閾値（メートル） */
const SKY_ZOOM_ALTITUDE_THRESHOLD = 1000;

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
        camera.lowerRadiusLimit = CAMERA_LOWER_RADIUS;
        camera.upperRadiusLimit = CAMERA_UPPER_RADIUS;
        camera.minZ = 1;
        camera.maxZ = CAMERA_FAR_CLIP;

        // チルト制限（地面から15° = beta上限 5π/12）
        camera.upperBetaLimit = Math.PI / 2 - Math.PI / 12;
        // beta=0（真下視点）はArcRotateCameraのジンバルロック・数値不安定を招くため最小値を設定
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

        // スカイボックス
        createSkybox(scene);

        // 初期位置（URLパラメータ優先、なければ東京駅付近）
        const urlLatLon = parseLatLonFromUrl(window.location.href);
        const initialLat = urlLatLon?.lat ?? 35.681236;
        const initialLon = urlLatLon?.lon ?? 139.767125;

        // URL 自動更新
        const updateUrl = createUrlUpdater(200);

        // UIパネル
        const ui = createControlPanel();

        let currentLat = initialLat;
        let currentLon = initialLon;

        // TileManager 生成
        const tileManager = createTileManager({
            scene,
            camera,
            zoom: MAX_ZOOM,
            subdivisions: TERRAIN_SUBDIVISIONS,
            heightScale: HEIGHT_SCALE,
            minZoom: MIN_ZOOM,
            maxElevationZoom: MAX_ELEVATION_ZOOM,
            minElevationZoom: MIN_ELEVATION_ZOOM,
            maxTiles: 160,
            cacheCapacity: 256,
            rootSearchRadius: ROOT_SEARCH_RADIUS,
        });

        let gridResidualX = 0;
        let gridResidualZ = 0;

        const refreshTerrain = async (): Promise<void> => {
            currentLat = clamp(
                currentLat,
                JAPAN_BOUNDS.minLat,
                JAPAN_BOUNDS.maxLat
            );
            currentLon = clamp(
                currentLon,
                JAPAN_BOUNDS.minLon,
                JAPAN_BOUNDS.maxLon
            );
            updateUrl(currentLat, currentLon);
            await tileManager.setCenter(currentLat, currentLon, 0);
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

            const oldLat = currentLat;
            const oldLon = currentLon;
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

            // target.y は retarget で地形高さに設定されている場合があるため保持する
            // （0 代入するとリリース時に上下ジャンプが発生する）
            camera.target.x = gridResidualX;
            camera.target.z = gridResidualZ;

            currentLat = newLat;
            currentLon = newLon;
            updateUrl(newLat, newLon);
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

        /** 現在のカメラ位置直下の地形高さから、衝突回避に必要な最小 radius を返す */
        let cachedMinRadius = CAMERA_LOWER_RADIUS;
        let prevAlpha = NaN;
        let prevBeta = NaN;
        let prevRadius = NaN;
        let prevTargetX = NaN;
        let prevTargetY = NaN;
        let prevTargetZ = NaN;

        const terrainMinRadius = (): number => {
            const { alpha, beta, radius } = camera;
            const { x: tx, y: ty, z: tz } = camera.target;
            if (
                alpha === prevAlpha &&
                beta === prevBeta &&
                radius === prevRadius &&
                tx === prevTargetX &&
                ty === prevTargetY &&
                tz === prevTargetZ
            ) {
                return cachedMinRadius;
            }
            prevAlpha = alpha;
            prevBeta = beta;
            prevRadius = radius;
            prevTargetX = tx;
            prevTargetY = ty;
            prevTargetZ = tz;

            const cosB = Math.cos(beta);
            if (Math.abs(cosB) < 1e-6) {
                cachedMinRadius = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                return cachedMinRadius;
            }
            const sinB = Math.sin(beta);
            const camX = tx + radius * sinB * Math.cos(alpha);
            const camY = ty + radius * cosB;
            const camZ = tz + radius * sinB * Math.sin(alpha);

            const ray = new Ray(
                new Vector3(camX, camY, camZ),
                Vector3.Down(),
                Math.max(camY + 1000, CAMERA_LOWER_RADIUS + 1000)
            );
            const pick = scene.pickWithRay(ray, (m) => m.name.startsWith("tile-ground-"));

            // レイキャストによる地形高さ
            let terrainY: number | null =
                pick?.hit && pick.pickedPoint ? pick.pickedPoint.y : null;

            // キャッシュ済み標高データから高精度な値を補完
            const cacheElev = tileManager.queryElevationAtWorld(camX, camZ);
            if (cacheElev !== null) {
                terrainY = terrainY !== null ? Math.max(terrainY, cacheElev) : cacheElev;
            }

            if (terrainY === null) {
                cachedMinRadius = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                return cachedMinRadius;
            }

            const minCamY = terrainY + CAMERA_LOWER_RADIUS;
            cachedMinRadius = (minCamY - ty) / cosB;
            return cachedMinRadius;
        };

        // ---------- カスタムマウスハンドラ ----------
        let pointerDown = false;
        let lastPointerX = 0;
        let lastPointerY = 0;
        let activePointerId = -1;
        let dragAnchor: { x: number; z: number } | null = null;
        let dragPlaneY = 0;

        /**
         * 新ターゲットに付け替え、カメラのワールド位置を保つよう alpha/beta/radius を再計算する。
         * `computePoseForNewTarget` が limit 逸脱や退化ケースなどで `apply` を返せない場合は何もせず、
         * 既存 target を維持する。なお、sin(beta)≈0 の特異点近傍では alpha を一意に再計算できなくても、
         * current alpha を保持したまま `apply` される場合がある。
         * @returns 付け替えを適用したら true
         */
        const retargetPreservingPose = (newTarget: {
            x: number;
            y: number;
            z: number;
        }): boolean => {
            const { alpha, beta, radius } = camera;
            const sinB = Math.sin(beta);
            const cosB = Math.cos(beta);
            const camPos = {
                x: camera.target.x + radius * sinB * Math.cos(alpha),
                y: camera.target.y + radius * cosB,
                z: camera.target.z + radius * sinB * Math.sin(alpha),
            };
            const result = computePoseForNewTarget(camPos, newTarget, alpha, {
                lowerBeta: camera.lowerBetaLimit ?? 0,
                upperBeta: camera.upperBetaLimit ?? Math.PI,
                lowerRadius: camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS,
                upperRadius: camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS,
            });
            if (result.action !== "apply") return false;
            camera.target.copyFromFloats(newTarget.x, newTarget.y, newTarget.z);
            camera.alpha = result.alpha;
            camera.beta = result.beta;
            camera.radius = result.radius;
            return true;
        };

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

            // Ctrl/Cmd 押下開始時: 画面中央の地形メッシュ交点を回転中心にする
            // （カメラのワールド位置は保持されるためジャンプは発生しない）
            if (e.ctrlKey || e.metaKey) {
                // 直前までの pan オフセットを lat/lon に反映してから target を差し替える
                commitPanOffset();
                const cx = canvas.clientWidth / 2;
                const cy = canvas.clientHeight / 2;
                const centerPick = scene.pick(cx, cy, (m) =>
                    m.name.startsWith("tile-ground-")
                );
                if (centerPick?.hit && centerPick.pickedPoint) {
                    const p = centerPick.pickedPoint;
                    if (retargetPreservingPose({ x: p.x, y: p.y, z: p.z })) {
                        // 新 target の xz を新たなグリッド残差基準として同期
                        gridResidualX = camera.target.x;
                        gridResidualZ = camera.target.z;
                    }
                }
            }

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
                const prevBeta = camera.beta;
                camera.beta -= dy * 0.003;
                camera.beta = clamp(
                    camera.beta,
                    camera.lowerBetaLimit ?? 0,
                    camera.upperBetaLimit ?? Math.PI
                );
                // チルト変更で地形に衝突するなら自動ズームアウトで回避
                const radiusBeforeTilt = camera.radius;
                const tiltResult = resolveTiltCollision(
                    camera.radius,
                    terrainMinRadius(),
                    camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS,
                    TILT_MAX_RADIUS_INCREASE_RATIO,
                );
                if (tiltResult.action === "revert") {
                    camera.beta = prevBeta;
                } else if (tiltResult.action === "zoomOut") {
                    camera.radius = tiltResult.radius;
                    // radius 変更でカメラ位置が移動するため再検証
                    // 新位置でまだ衝突するなら beta・radius 両方を復元
                    if (camera.radius < terrainMinRadius()) {
                        camera.beta = prevBeta;
                        camera.radius = radiusBeforeTilt;
                    }
                }
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

        /** カメラ→ターゲット方向のレイで地形メッシュとの交差距離を返す（ミス時は null） */
        const queryViewRayDistance = (): number | null => {
            const { alpha, beta, radius } = camera;
            const { x: tx, y: ty, z: tz } = camera.target;
            const sinB = Math.sin(beta);
            const cosB = Math.cos(beta);
            const camX = tx + radius * sinB * Math.cos(alpha);
            const camY = ty + radius * cosB;
            const camZ = tz + radius * sinB * Math.sin(alpha);

            const origin = new Vector3(camX, camY, camZ);

            // ターゲット直下の地形標高でレイ目標点を補正
            const terrainY = tileManager.queryElevationAtWorld(tx, tz);
            const aimY = terrainY !== null ? Math.max(ty, terrainY) : ty;
            const aim = new Vector3(tx, aimY, tz);

            const direction = aim.subtract(origin);
            const length = direction.length();
            if (length < 1e-6) return null;
            direction.scaleInPlace(1 / length);

            const ray = new Ray(origin, direction, length * 2);
            const pick = scene.pickWithRay(ray, (m) => m.name.startsWith("tile-ground-"));
            if (pick?.hit && pick.distance > 0) {
                return pick.distance;
            }
            return null;
        };

        /** レイキャスト距離の一定割合を1ステップとするホイールfactorを返す */
        const WHEEL_STEP = 0.05;
        const computeWheelFactor = (zoomIn: boolean): number => {
            const rayDist = queryViewRayDistance();
            const dist = rayDist ?? camera.radius;
            const delta = dist * WHEEL_STEP;
            return zoomIn
                ? (camera.radius - delta) / camera.radius
                : (camera.radius + delta) / camera.radius;
        };

        const zoomTowardPoint = (
            worldX: number,
            worldZ: number,
            factor: number
        ): void => {
            const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
            const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
            if (factor > 1 && camera.radius >= upper) return;
            if (factor < 1 && camera.radius <= lower) return;

            // 衝突制限を考慮した実効 lower を算出
            const effectiveLower = Math.max(lower, terrainMinRadius());
            const newRadius = clamp(camera.radius * factor, effectiveLower, upper);
            if (Math.abs(newRadius - camera.radius) < 0.01) return;

            // ズームイン操作なのに半径が増える場合はターゲット移動せず半径だけ補正
            if (factor < 1 && newRadius > camera.radius) {
                camera.radius = newRadius;
                commitPanOffset();
                return;
            }

            const actualFactor = newRadius / camera.radius;
            camera.target.x += (worldX - camera.target.x) * (1 - actualFactor);
            camera.target.z += (worldZ - camera.target.z) * (1 - actualFactor);
            camera.radius = newRadius;
            commitPanOffset();
        };

        /** メッシュまたは y=0 平面との交点を返す。空なら null */
        const pickOrPlane = (
            sx: number,
            sy: number
        ): { worldX: number; worldZ: number } | null => {
            // scene.pick() は内部で DPR スケーリングを行うため CSS 座標をそのまま渡す
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
            const dist2 = dx * dx + dz * dz;
            const threshold = camera.radius * 3;
            return dist2 < threshold * threshold;
        };

        canvas.addEventListener(
            "wheel",
            (e: WheelEvent) => {
                if (e.deltaY === 0) return;
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                const hit = pickOrPlane(e.clientX - rect.left, e.clientY - rect.top);
                if (hit && isPickNearTarget(hit)) {
                    const factor = computeWheelFactor(e.deltaY < 0);
                    zoomTowardPoint(hit.worldX, hit.worldZ, factor);
                } else {
                    // 空のホイール操作: カメラ高度ベースの2段階ズーム
                    const upper = camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS;
                    const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                    const zoomIn = e.deltaY < 0;
                    const factor = computeWheelFactor(zoomIn);
                    const cameraHeight = camera.radius * Math.cos(camera.beta);
                    const useVertical = zoomIn
                        ? cameraHeight <= SKY_ZOOM_ALTITUDE_THRESHOLD
                        : cameraHeight < SKY_ZOOM_ALTITUDE_THRESHOLD;

                    if (useVertical) {
                        // Phase 2: 垂直移動（カメラの緯度経度固定）
                        const effectiveLower2 = Math.max(lower, terrainMinRadius());
                        if (zoomIn && camera.radius <= effectiveLower2) return;
                        if (!zoomIn && camera.radius >= upper) return;
                        const sinB = Math.sin(camera.beta);
                        const camX = camera.target.x + camera.radius * sinB * Math.cos(camera.alpha);
                        const camZ = camera.target.z + camera.radius * sinB * Math.sin(camera.alpha);
                        const newRadius = clamp(camera.radius * factor, effectiveLower2, upper);
                        camera.target.x = camX - newRadius * sinB * Math.cos(camera.alpha);
                        camera.target.z = camZ - newRadius * sinB * Math.sin(camera.alpha);
                        camera.radius = newRadius;
                        commitPanOffset();
                    } else {
                        // Phase 1: ターゲットに向かってズーム
                        const effectiveLower1 = Math.max(lower, terrainMinRadius());
                        if (zoomIn && camera.radius <= effectiveLower1) return;
                        if (!zoomIn && camera.radius >= upper) return;
                        camera.radius = clamp(camera.radius * factor, effectiveLower1, upper);
                    }
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
                // 空のダブルクリック: ターゲットに向かってズーム
                const lower = camera.lowerRadiusLimit ?? CAMERA_LOWER_RADIUS;
                if (camera.radius <= lower) return;
                camera.radius = clamp(
                    camera.radius * 0.7,
                    lower,
                    camera.upperRadiusLimit ?? CAMERA_UPPER_RADIUS
                );
            }
        });

        // 方位磁針の回転同期
        const syncCompass = (): void => {
            const degrees = (camera.alpha * 180) / Math.PI + 90;
            ui.compass.style.transform = `rotate(${degrees}deg)`;
        };
        camera.onViewMatrixChangedObservable.add(syncCompass);

        // スケールバー更新
        const SCALE_BAR_BASE_PX = 100;
        let prevScaleText = "";
        const updateScaleBar = (): void => {
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const center = intersectPlane(cx, cy, 0);
            const offset = intersectPlane(cx + SCALE_BAR_BASE_PX, cy, 0);
            if (!center || !offset) return;
            const dx = offset.x - center.x;
            const dz = offset.z - center.z;
            const rawMeters = Math.sqrt(dx * dx + dz * dz);
            const metersPerPx = rawMeters / SCALE_BAR_BASE_PX;
            const snapped = snapScale(rawMeters);
            const barPx = Math.round(snapped / metersPerPx);
            const text = formatScale(snapped);
            if (text !== prevScaleText) {
                ui.scaleBar.label.textContent = text;
                prevScaleText = text;
            }
            ui.scaleBar.bar.style.width = `${barPx}px`;
        };
        camera.onViewMatrixChangedObservable.add(updateScaleBar);
        engine.onResizeObservable.add(updateScaleBar);
        updateScaleBar();

        // 方位磁針: 北向き・真下にスムーズアニメーション
        ui.compass.style.cursor = "pointer";
        const resetCompassView = (): void => {
            // カメラ光軸と地形メッシュの交点を新しい中心座標にする
            const cx = canvas.clientWidth / 2;
            const cy = canvas.clientHeight / 2;
            const centerHit = pickOrPlane(cx, cy);
            if (centerHit) {
                camera.target.x = centerHit.worldX;
                camera.target.z = centerHit.worldZ;
                commitPanOffset();
            }

            const targetAlpha = -Math.PI / 2; // 北向き
            const targetBeta = camera.lowerBetaLimit ?? 0.1; // ほぼ真下
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

        // 現在地を表示ボタン
        ui.locateMe.addEventListener("click", () => {
            if (!navigator.geolocation) {
                console.warn("Geolocation API is not supported by this browser.");
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lon = position.coords.longitude;
                    if (
                        lat < JAPAN_BOUNDS.minLat ||
                        lat > JAPAN_BOUNDS.maxLat ||
                        lon < JAPAN_BOUNDS.minLon ||
                        lon > JAPAN_BOUNDS.maxLon
                    ) {
                        showToast("現在地は対応エリア外のため、最も近い地点を表示します");
                    }
                    currentLat = lat;
                    currentLon = lon;
                    camera.target.x = 0;
                    camera.target.y = 0;
                    camera.target.z = 0;
                    gridResidualX = 0;
                    gridResidualZ = 0;
                    void refreshTerrain();
                },
                (error) => {
                    console.warn("Geolocation error:", error.message);
                },
            );
        });

        // 地図切替ボタン
        ui.mapToggle.addEventListener("click", () => {
            const next = tileManager.mapType === "std" ? "photo" : "std";
            tileManager.setMapType(next);
            ui.mapToggle.textContent = next === "std" ? "写真" : "標準";
            ui.mapToggle.setAttribute(
                "aria-label",
                next === "std"
                    ? "地図切替: 写真地図に変更"
                    : "地図切替: 標準地図に変更"
            );
        });

        // カメラ-地形衝突回避: 地面にめり込まないよう radius を補正してストップ
        const clampCameraAboveTerrain = (): void => {
            const minR = terrainMinRadius();
            if (camera.radius >= minR) return;
            camera.radius = minR;
        };
        scene.onBeforeRenderObservable.add(clampCameraAboveTerrain);

        // メッシュ標高更新時にキャッシュを無効化して即座に再チェック
        tileManager.onTerrainUpdated = () => {
            prevAlpha = NaN; // terrainMinRadius のキャッシュを無効化
        };

        // カメラ移動時の自動タイル更新
        tileManager.attachCamera();

        // 初回ロード
        await refreshTerrain();

        return scene;
    };
}

export default new DefaultScene();
