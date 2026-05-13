/**
 * Boids フロッキングデモ (Issue #251)
 *
 * 高尾山山頂付近の矩形リージョン内で複数のアバターが
 * Boids（分離・整列・結合）ルールに従い自律的に歩き回るデモ。
 *
 * - Model API (`addModel` / `updateModel` / `playModelAnimation`) を使用
 * - Polygon API (`addPolygon`, `closed: true`) でリージョン境界を描画
 * - 地形追従 (`altitudeMode: "terrain"`, `gravity: true`)
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import {
    type BoidState,
    BOIDS_DEFAULTS,
    updateFlock,
    boidHeading,
} from "./boids";
import {
    DEFAULT_REGION,
    regionCorners,
    regionBounds,
    localToGeo,
    randomPositionInRegion,
    randomVelocity,
} from "./region";
import humanWalkGlbUrl from "../../../assets/human_walk.glb";

const DEMO_MOUNT_ID = "root";
const REGION_POLYGON_ID = "boids-region";
const WALK_ANIM = "rig-action";
const MODEL_SCALE = 25;
const DEFAULT_BOID_COUNT = 20;
const MAX_BOID_COUNT = 50;

const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

const boidModelId = (index: number): string => `boid-${index}`;

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) return;

    const camera = parseCameraStateFromUrl(location.href);
    const mapType = parseMapTypeFromUrl(location.href);
    const region = DEFAULT_REGION;

    const opts: JpmapTerrainOptions = {
        engine: resolveEngine(location.search),
        lat: camera?.lat ?? region.centerLat,
        lon: camera?.lon ?? region.centerLon,
        altitude: camera?.altitude ?? 800,
        azimuth: camera?.azimuth,
        tilt: camera?.tilt ?? 45,
        mapType: mapType ?? "standard",
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
    }

    // --- リージョン境界をポリゴンで描画 ---
    const corners = regionCorners(region);
    viewer.addPolygon(REGION_POLYGON_ID, {
        points: corners.map((c) => ({
            lat: c.lat,
            lon: c.lon,
            altitude: 650,
        })),
        altitudeMode: "absolute",
        closed: true,
        style: {
            lineColor: "#ff4444",
            lineWidth: 2,
            lineOpacity: 0.9,
            wallColor: "#ff2222",
            wallOpacity: 0.25,
        },
        verticalsEnabled: false,
        wallsEnabled: true,
    });

    // --- Boids 状態 ---
    // アバターの半径分だけ内側に移動範囲を狭める（壁にめり込まない）
    const rawBounds = regionBounds(region);
    const AVATAR_HALF_SIZE = 5;
    const bounds = {
        minX: rawBounds.minX + AVATAR_HALF_SIZE,
        maxX: rawBounds.maxX - AVATAR_HALF_SIZE,
        minY: rawBounds.minY + AVATAR_HALF_SIZE,
        maxY: rawBounds.maxY - AVATAR_HALF_SIZE,
    };
    const params = { ...BOIDS_DEFAULTS };
    let boidCount = DEFAULT_BOID_COUNT;
    let flock: BoidState[] = [];
    let paused = false;
    let lastTimestamp: number | null = null;
    const animationStarted = new Set<number>();

    /** 全モデルを破棄しランダム配置で再生成する（リスタート用） */
    const initFlock = (count: number): void => {
        const wasPaused = paused;
        paused = true;

        for (let i = 0; i < flock.length; i++) {
            try {
                viewer.removeModel(boidModelId(i));
            } catch {
                // 既に削除済みの場合無視
            }
        }
        animationStarted.clear();

        flock = [];
        for (let i = 0; i < count; i++) {
            const pos = randomPositionInRegion(region);
            const vel = randomVelocity(params.minSpeed + Math.random() * (params.maxSpeed - params.minSpeed));
            flock.push({ x: pos.x, y: pos.y, vx: vel.vx, vy: vel.vy });

            const geo = localToGeo(pos.x, pos.y, region);
            viewer.addModel(boidModelId(i), {
                url: humanWalkGlbUrl,
                lat: geo.lat,
                lon: geo.lon,
                altitudeMode: "terrain",
                altitude: 0,
                rotation: { y: boidHeading(flock[i]) },
                scaling: { x: MODEL_SCALE, y: MODEL_SCALE, z: MODEL_SCALE },
                gravity: true,
            });
        }
        lastTimestamp = null;
        paused = wasPaused;
    };

    /** 差分だけモデルを増減する（スライダー用） */
    const resizeFlock = (newCount: number): void => {
        const oldCount = flock.length;
        if (newCount === oldCount) return;

        if (newCount > oldCount) {
            // 不足分を追加
            for (let i = oldCount; i < newCount; i++) {
                const pos = randomPositionInRegion(region);
                const vel = randomVelocity(
                    params.minSpeed + Math.random() * (params.maxSpeed - params.minSpeed),
                );
                flock.push({ x: pos.x, y: pos.y, vx: vel.vx, vy: vel.vy });

                const geo = localToGeo(pos.x, pos.y, region);
                viewer.addModel(boidModelId(i), {
                    url: humanWalkGlbUrl,
                    lat: geo.lat,
                    lon: geo.lon,
                    altitudeMode: "terrain",
                    altitude: 0,
                    rotation: { y: boidHeading(flock[i]) },
                    scaling: { x: MODEL_SCALE, y: MODEL_SCALE, z: MODEL_SCALE },
                    gravity: true,
                });
            }
        } else {
            // 余分を末尾から削除
            for (let i = newCount; i < oldCount; i++) {
                try {
                    viewer.removeModel(boidModelId(i));
                } catch {
                    // 既に削除済みの場合無視
                }
                animationStarted.delete(i);
            }
            flock.length = newCount;
        }
    };

    initFlock(boidCount);

    // --- UI 要素の取得 ---
    const regionCenterDisplay = document.getElementById("region-center") as HTMLSpanElement | null;
    const boidCountDisplay = document.getElementById("boid-count-display") as HTMLSpanElement | null;
    const boidCountValue = document.getElementById("boid-count-value") as HTMLSpanElement | null;
    const boidCountSlider = document.getElementById("boid-count-slider") as HTMLInputElement | null;
    const togglePauseBtn = document.getElementById("toggle-pause") as HTMLButtonElement | null;
    const restartBtn = document.getElementById("restart-btn") as HTMLButtonElement | null;
    const flyToBtn = document.getElementById("fly-to-region") as HTMLButtonElement | null;

    const updateDisplay = (): void => {
        if (regionCenterDisplay) {
            regionCenterDisplay.textContent =
                `${region.centerLat.toFixed(4)}, ${region.centerLon.toFixed(4)}`;
        }
        if (boidCountDisplay) boidCountDisplay.textContent = `${boidCount}`;
        if (boidCountValue) boidCountValue.textContent = `${boidCount}`;
    };
    updateDisplay();

    // アバター数スライダー
    if (boidCountSlider) {
        boidCountSlider.min = "1";
        boidCountSlider.max = String(MAX_BOID_COUNT);
        boidCountSlider.value = String(boidCount);
        boidCountSlider.addEventListener("input", () => {
            const newCount = Number(boidCountSlider.value);
            if (newCount !== boidCount && newCount >= 1 && newCount <= MAX_BOID_COUNT) {
                boidCount = newCount;
                resizeFlock(boidCount);
                updateDisplay();
            }
        });
    }

    // Pause / Continue
    const updatePauseLabel = (): void => {
        if (togglePauseBtn) {
            togglePauseBtn.textContent = paused ? "▶ 再開" : "⏸ 一時停止";
        }
    };
    updatePauseLabel();

    if (togglePauseBtn) {
        togglePauseBtn.addEventListener("click", () => {
            paused = !paused;
            if (!paused) {
                lastTimestamp = null;
                // 再開時にアニメーションを再生
                for (let i = 0; i < flock.length; i++) {
                    if (animationStarted.has(i)) {
                        viewer.playModelAnimation(boidModelId(i), WALK_ANIM);
                    }
                }
            } else {
                // 一時停止時にアニメーションを停止
                for (let i = 0; i < flock.length; i++) {
                    if (animationStarted.has(i)) {
                        viewer.stopModelAnimation(boidModelId(i), WALK_ANIM);
                    }
                }
            }
            updatePauseLabel();
        });
    }

    // Restart
    if (restartBtn) {
        restartBtn.addEventListener("click", () => {
            paused = false;
            updatePauseLabel();
            initFlock(boidCount);
            updateDisplay();
        });
    }

    // リージョン中心へ移動
    if (flyToBtn) {
        flyToBtn.addEventListener("click", () => {
            viewer.lat = region.centerLat;
            viewer.lon = region.centerLon;
        });
    }

    // --- tick ループ ---
    let rafId = 0;
    const tick = (timestamp: number): void => {
        // 各モデルのロード完了チェック → アニメーション開始
        for (let i = 0; i < flock.length; i++) {
            if (!animationStarted.has(i)) {
                const handle = viewer.getModel(boidModelId(i));
                if (handle?.loaded) {
                    animationStarted.add(i);
                    if (!paused) {
                        viewer.playModelAnimation(boidModelId(i), WALK_ANIM);
                    }
                }
            }
        }

        if (!paused) {
            if (lastTimestamp !== null) {
                const dt = Math.min((timestamp - lastTimestamp) / 1000, 0.1);
                flock = updateFlock(flock, params, bounds, dt);

                for (let i = 0; i < flock.length; i++) {
                    const boid = flock[i];
                    const geo = localToGeo(boid.x, boid.y, region);
                    viewer.updateModel(boidModelId(i), {
                        lat: geo.lat,
                        lon: geo.lon,
                        altitudeMode: "terrain",
                        altitude: 0,
                        rotation: { y: boidHeading(boid) },
                        gravity: true,
                    });
                }
            }
            lastTimestamp = timestamp;
        }

        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    window.addEventListener("beforeunload", () => {
        cancelAnimationFrame(rafId);
    });
};

start().catch((err) => {
    console.error("[boids-demo] Failed to start:", err);
});
