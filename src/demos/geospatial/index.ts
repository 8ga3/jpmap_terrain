/**
 * Geospatial PoC エントリ (Issue #321 / 親 #275)
 *
 * Babylon.js 9.x の Geospatial 機能（`GeospatialCamera` + ECEF 楕円体グローブ +
 * Large World Rendering の floating origin）を最小構成で実機検証する **スタンドアロン** PoC。
 *
 * 重要: これは全面リライト着手前のフィージビリティ確認であり、既存の平面ワールド
 * スタック（`JpmapTerrain` / `scenes/default.ts` / `tileManager` 等）には一切依存・改修しない。
 * 流用するのは標高タイル取得 (`gsiTile.loadElevationTile`) のみ。
 *
 * 検証する判断材料:
 * - floating origin 下でのタイル精度（ジッタの有無）
 * - lat/lon/標高 → ECEF の頂点生成コストと既存取得層の流用度
 * - GeospatialCamera 入力でのパン/回転/ズームの操作感
 *
 * URL クエリ:
 * - `?engine=webgpu|webgl|webgl2`（既定: 自動。webgl/webgl2 は webgl2 に正規化）
 * - `?lat=&lon=&zoom=&radius=`（既定: 富士山周辺 / zoom 13 / radius 12000m）
 */
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";
import { GeospatialClippingBehavior } from "@babylonjs/core/Behaviors/Cameras/geospatialClippingBehavior";
import {
    Wgs84Ellipsoid,
    EcefFromLatLonAltToRef,
} from "@babylonjs/core/Maths/math.geospatial.functions";
import type { ILatLonAltLike } from "@babylonjs/core/Maths/math.geospatial";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import { loadElevationTile, toTileXY, TILE_SIZE } from "../../terrain/gsiTile";

const DEMO_MOUNT_ID = "root";

/** PoC の既定表示パラメータ（富士山周辺）。 */
const DEFAULTS = {
    lat: 35.3606,
    lon: 138.7274,
    zoom: 13,
    /** カメラ中心（地表）からの距離 [m]。 */
    radius: 20000,
    /** 中心タイルの周囲に何タイル読み込むか（片側）。3 → 7x7。 */
    ring: 3,
    /** タイルあたりの分割数（頂点は (seg+1)^2）。256px を間引いてグリッド化する。 */
    segments: 48,
} as const;

/** `?engine=` を解決する（viewer デモと同じ正規化）。 */
const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/** `?key=` を数値として解決する（未指定 / NaN は fallback）。 */
const resolveNumber = (search: string, key: string, fallback: number): number => {
    const raw = new URLSearchParams(search).get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
};

const DEG2RAD = Math.PI / 180;

/** XYZ タイルのグローバルピクセル座標 → 緯度経度[deg]（Web メルカトル逆変換）。 */
const pixelToLatLon = (
    globalPx: number,
    globalPy: number,
    totalPixels: number,
): { lat: number; lon: number } => {
    const lon = (globalPx / totalPixels) * 360 - 180;
    const ny = globalPy / totalPixels;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180) / Math.PI;
    return { lat, lon };
};

/**
 * 1 タイルぶんの標高データから ECEF 曲面メッシュを生成する。
 *
 * floating origin 下での Float32 頂点バッファ精度を担保するため、頂点はタイル中心の
 * ECEF アンカーからの **相対座標**（タイル内なので数百 m オーダー）で格納し、真の
 * ECEF（大きな値）は `mesh.position`（double 精度の world matrix 経由）に載せる。
 */
const buildTileMesh = (
    scene: Scene,
    zoom: number,
    tx: number,
    ty: number,
    elevation: Float32Array,
    segments: number,
): Mesh => {
    const totalPixels = TILE_SIZE * 2 ** zoom;
    const latLonAlt: ILatLonAltLike = { lat: 0, lon: 0, alt: 0 };

    // タイル中心をアンカー ECEF とする。
    const center = pixelToLatLon(
        tx * TILE_SIZE + TILE_SIZE / 2,
        ty * TILE_SIZE + TILE_SIZE / 2,
        totalPixels,
    );
    latLonAlt.lat = center.lat * DEG2RAD;
    latLonAlt.lon = center.lon * DEG2RAD;
    latLonAlt.alt = 0;
    const anchor = new Vector3();
    EcefFromLatLonAltToRef(latLonAlt, Wgs84Ellipsoid, anchor);

    const vertsPerSide = segments + 1;
    const positions = new Float32Array(vertsPerSide * vertsPerSide * 3);
    const ecef = new Vector3();

    for (let row = 0; row < vertsPerSide; row++) {
        for (let col = 0; col < vertsPerSide; col++) {
            // タイル内ピクセル位置（0..TILE_SIZE）。最終頂点は端 (255) にクランプ。
            const pxF = (col / segments) * TILE_SIZE;
            const pyF = (row / segments) * TILE_SIZE;
            const sx = Math.min(TILE_SIZE - 1, Math.round(pxF));
            const sy = Math.min(TILE_SIZE - 1, Math.round(pyF));
            let elev = elevation[sy * TILE_SIZE + sx];
            if (!Number.isFinite(elev)) elev = 0;

            const { lat, lon } = pixelToLatLon(
                tx * TILE_SIZE + pxF,
                ty * TILE_SIZE + pyF,
                totalPixels,
            );
            latLonAlt.lat = lat * DEG2RAD;
            latLonAlt.lon = lon * DEG2RAD;
            latLonAlt.alt = elev;
            EcefFromLatLonAltToRef(latLonAlt, Wgs84Ellipsoid, ecef);

            const vi = (row * vertsPerSide + col) * 3;
            // アンカー相対（小さな値）で格納する。
            positions[vi] = ecef.x - anchor.x;
            positions[vi + 1] = ecef.y - anchor.y;
            positions[vi + 2] = ecef.z - anchor.z;
        }
    }

    // インデックス（2 三角形 / セル）。
    const indices: number[] = [];
    for (let row = 0; row < segments; row++) {
        for (let col = 0; col < segments; col++) {
            const a = row * vertsPerSide + col;
            const b = a + 1;
            const c = a + vertsPerSide;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;

    const mesh = new Mesh(`tile-${zoom}-${tx}-${ty}`, scene);
    vertexData.applyToMesh(mesh);
    mesh.position.copyFrom(anchor);
    return mesh;
};

const updateInfo = (text: string): void => {
    const el = document.getElementById("poc-info");
    if (el) el.textContent = text;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);

    const search = location.search;
    const lat = resolveNumber(search, "lat", DEFAULTS.lat);
    const lon = resolveNumber(search, "lon", DEFAULTS.lon);
    const zoom = Math.round(resolveNumber(search, "zoom", DEFAULTS.zoom));
    const radius = resolveNumber(search, "radius", DEFAULTS.radius);

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    mount.appendChild(canvas);

    const engine = await createBabylonEngine(canvas, resolveEngine(search) ?? "webgpu");

    // Large World Rendering: 真の ECEF（百万 m オーダー）でも精度を保つため floating origin を有効化。
    const scene = new Scene(engine, { useFloatingOrigin: true });
    scene.clearColor = new Color4(0.75, 0.86, 0.95, 1);

    // GeospatialCamera: world 原点中心の球体惑星を周回する。
    const camera = new GeospatialCamera("geo-camera", scene, {
        planetRadius: Wgs84Ellipsoid.semiMajorAxis,
    });

    // 初期注視点（地表上の lat/lon）を真の ECEF として center に設定する。
    const centerEcef = new Vector3();
    EcefFromLatLonAltToRef(
        { lat: lat * DEG2RAD, lon: lon * DEG2RAD, alt: 0 },
        Wgs84Ellipsoid,
        centerEcef,
    );
    camera.center = centerEcef;
    camera.radius = radius;
    camera.yaw = 0; // 北向き
    camera.pitch = 1.05; // 0=直下, π/2=水平。斜め見下ろしの俯瞰。

    // near/far の自動調整（高度に応じた depth 精度最適化）。
    camera.addBehavior(new GeospatialClippingBehavior());

    // GeospatialCamera はコンストラクタで既定入力（pointers/wheel/keyboard）を備える。
    // 追加登録は不要で、attachControl だけ行う。
    camera.attachControl(true);

    // ライト: 地表の up（地心法線）を基準に環境光 + 斜め方向の指向性ライト。
    const up = centerEcef.clone().normalize();
    const hemi = new HemisphericLight("hemi", up, scene);
    hemi.intensity = 0.55;
    hemi.groundColor = new Color3(0.3, 0.32, 0.3);
    // up に直交する接線（東方向相当）を作り、太陽を斜め上から当てて起伏の陰影を出す。
    const ref = Math.abs(up.y) < 0.99 ? Vector3.Up() : Vector3.Right();
    const east = Vector3.Cross(ref, up).normalize();
    const sunDir = up.scale(-0.85).add(east.scale(0.5)).normalize();
    const sun = new DirectionalLight("sun", sunDir, scene);
    sun.intensity = 0.7;

    const material = new StandardMaterial("terrain-mat", scene);
    material.diffuseColor = new Color3(0.55, 0.62, 0.5);
    material.specularColor = new Color3(0.05, 0.05, 0.05);
    // メッシュの巻き順（法線の向き）に依存せず両面を正しく陰影付けする。
    material.backFaceCulling = false;
    material.twoSidedLighting = true;

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    // 中心タイルとその周囲（ring）の標高タイルを取得して曲面メッシュ化する。
    const { x: cx, y: cy } = toTileXY(lat, lon, zoom);
    const ring = DEFAULTS.ring;
    const coords: { x: number; y: number }[] = [];
    for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
            coords.push({ x: cx + dx, y: cy + dy });
        }
    }

    let loaded = 0;
    let failed = 0;
    await Promise.all(
        coords.map(async ({ x, y }) => {
            try {
                const elev = await loadElevationTile(zoom, x, y);
                const mesh = buildTileMesh(scene, zoom, x, y, elev, DEFAULTS.segments);
                mesh.material = material;
                loaded++;
            } catch (e) {
                failed++;
                console.warn(`[geospatial-poc] tile z${zoom}/${x}/${y} failed:`, e);
            }
            updateInfo(
                `Geospatial PoC (#321)\n` +
                    `ドラッグ=回転 / ホイール=ズーム / WASD=パン\n` +
                    `engine: ${engine.constructor.name} / floatingOrigin: ${scene.floatingOriginMode}\n` +
                    `center: ${lat.toFixed(4)}, ${lon.toFixed(4)} (zoom ${zoom})\n` +
                    `tiles: ${loaded}/${coords.length} 読み込み${failed ? ` (失敗 ${failed})` : ""}`,
            );
        }),
    );

    // デバッグ用に内部状態を露出（公開 API ではない）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { scene: Scene }).scene = scene;
        (window as unknown as { camera: GeospatialCamera }).camera = camera;
    }
};

if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[geospatial-poc] failed to start:", err);
        updateInfo(`Geospatial PoC (#321)\n起動に失敗しました: ${String(err)}`);
    });
}
