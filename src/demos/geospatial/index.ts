/**
 * Geospatial PoC エントリ (Issue #321 / 親 #275)
 *
 * Babylon.js 9.x の Geospatial 機能（`GeospatialCamera` + ECEF 楕円体グローブ +
 * Large World Rendering の floating origin）を最小構成で実機検証する **スタンドアロン** PoC。
 *
 * 重要: これは全面リライト着手前のフィージビリティ確認であり、既存の平面ワールド
 * スタック（`JpmapTerrain` / `scenes/default.ts` / `tileManager` / `visibleTiles` 等）には
 * 一切依存・改修しない。流用するのは標高タイル取得 (`gsiTile.loadElevationTile`) と
 * GSI 座標ヘルパのみ。
 *
 * 第2反復: カメラ位置に応じた **動的 LOD（地心距離ベース SSE quadtree）** による
 * タイルのロード/アンロードを `globeLod.selectGlobeTiles` で検証する。
 *
 * URL クエリ:
 * - `?engine=webgpu|webgl|webgl2`（既定: 自動。webgl/webgl2 は webgl2 に正規化）
 * - `?lat=&lon=&zoom=&radius=`（既定: 富士山周辺 / center zoom 11 / radius 60000m）
 */
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import {
    GeospatialCamera,
    ComputeLookAtFromYawPitchToRef,
} from "@babylonjs/core/Cameras/geospatialCamera";
import { GeospatialClippingBehavior } from "@babylonjs/core/Behaviors/Cameras/geospatialClippingBehavior";
import {
    Wgs84Ellipsoid,
    EcefFromLatLonAltToRef,
} from "@babylonjs/core/Maths/math.geospatial.functions";
import type { ILatLonAltLike } from "@babylonjs/core/Maths/math.geospatial";

import { createBabylonEngine } from "../../lib/internal/engineFactory";
import type { EngineType } from "../../lib/types";
import {
    loadElevationTile,
    tileEdgeMeters,
    textureUrl,
    TILE_SIZE,
    type MapType,
} from "../../terrain/gsiTile";
import { selectGlobeTiles, tileKey, type GlobeTile } from "./globeLod";

const DEMO_MOUNT_ID = "root";

/** PoC の既定表示・LOD パラメータ（富士山周辺）。 */
const DEFAULTS = {
    lat: 35.3606,
    lon: 138.7274,
    /** root（最低）ズーム。 */
    minZoom: 11,
    /** 最高ズーム（分割上限）。 */
    maxZoom: 16,
    /** カメラ中心（地表）からの距離 [m]。 */
    radius: 60000,
    /** SSE 採用しきい値 [px]。 */
    sseThreshold: 256 * 2.5,
    /** 同時保持タイル数の上限。 */
    maxTiles: 140,
    /** root 探索半径（±N 格子）。 */
    rootSearchRadius: 2,
    /** 地平線カリングの内積しきい値。 */
    horizonDotThreshold: 0.1,
    /** タイルあたりの分割数（頂点は (seg+1)^2）。 */
    segments: 32,
    /** LOD 再評価の間隔（フレーム）。 */
    syncIntervalFrames: 15,
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
 *
 * LOD 境界の T 字クラック対策として、タイル周縁から地心方向へ垂らす **スカート**
 * （垂直フランジ）を付与する。隣接タイルの LOD を知らずに隙間を隠せる方式で、
 * Cesium / Google Earth 等のグローブ地形レンダラーで標準的に使われる。
 */
const buildTileMesh = (
    scene: Scene,
    zoom: number,
    tx: number,
    ty: number,
    elevation: Float32Array,
    segments: number,
    mapType: MapType,
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
    const positions: number[] = [];
    const uvs: number[] = [];
    const ecef = new Vector3();
    const gridIndex = (row: number, col: number): number => row * vertsPerSide + col;

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

            // アンカー相対（小さな値）で格納する。
            positions.push(ecef.x - anchor.x, ecef.y - anchor.y, ecef.z - anchor.z);

            // UV: col→u（西→東）。地理院タイル画像は row=0（pyF=0）が北端。
            // Babylon の既定 Texture は invertY=true で、v=1 が画像上端（=北）、
            // v=0 が下端（=南）に対応する。よって北端頂点(row=0)は v=1 にする必要があり、
            // v = 1 - row/segments とする（row/segments だと per-tile で南北が反転する）。
            uvs.push(col / segments, 1 - row / segments);
        }
    }

    // 地表メッシュのインデックス（2 三角形 / セル）。法線はこの地表面のみで計算する
    // （スカート壁を含めるとエッジ頂点の法線が壁に引っ張られ、境界が暗い帯になる）。
    const surfaceIndices: number[] = [];
    for (let row = 0; row < segments; row++) {
        for (let col = 0; col < segments; col++) {
            const a = gridIndex(row, col);
            const b = a + 1;
            const c = a + vertsPerSide;
            const d = c + 1;
            // 巻き順は法線が外向き（地心と反対）になる向き。表面が外を向く。
            surfaceIndices.push(a, b, c, b, d, c);
        }
    }

    // ---- スカート: 周縁頂点を地心方向へ押し下げた壁を追加して T 字クラックを隠す ----
    // 深さはタイル辺長に比例（LOD 段差を吸収する程度）。粗タイルほど深く、上限あり。
    const skirtDepth = Math.min(1500, Math.max(150, tileEdgeMeters(center.lat, zoom) * 0.05));
    const down = anchor.clone().normalize().scaleInPlace(-skirtDepth); // 地心方向（タイル内ほぼ一定）
    const skirtOf = new Map<number, number>();
    const addSkirtVertex = (gi: number): number => {
        const existing = skirtOf.get(gi);
        if (existing !== undefined) return existing;
        const base = gi * 3;
        const si = positions.length / 3;
        positions.push(
            positions[base] + down.x,
            positions[base + 1] + down.y,
            positions[base + 2] + down.z,
        );
        // スカート頂点の UV は元の周縁頂点と同じ（辺のテクセルを縦に引き延ばす）。
        uvs.push(uvs[gi * 2], uvs[gi * 2 + 1]);
        skirtOf.set(gi, si);
        return si;
    };
    // 連続する 2 周縁頂点とそのスカート頂点で壁（2 三角形）を張る。
    // 壁の表裏（外周のどちら向きが外か）を厳密に決めず両面分の三角形を出すことで、
    // backFaceCulling=true でもスカートが常に見えるようにする（隙間隠しを確実にする）。
    const wallIndices: number[] = [];
    const addWall = (gA: number, gB: number): void => {
        const sA = addSkirtVertex(gA);
        const sB = addSkirtVertex(gB);
        wallIndices.push(gA, gB, sA, gB, sB, sA); // 表
        wallIndices.push(gA, sA, gB, gB, sA, sB); // 裏（両面化）
    };
    for (let i = 0; i < segments; i++) {
        addWall(gridIndex(0, i), gridIndex(0, i + 1)); // 上辺
        addWall(gridIndex(segments, i), gridIndex(segments, i + 1)); // 下辺
        addWall(gridIndex(i, 0), gridIndex(i + 1, 0)); // 左辺
        addWall(gridIndex(i, segments), gridIndex(i + 1, segments)); // 右辺
    }

    // 法線は地表面のみで計算（スカート壁を除外）。スカート頂点の法線は元の周縁頂点に
    // 揃え、壁が地表と同じ陰影になるようにする（暗い帯を防ぐ）。
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, surfaceIndices, normals);
    for (const [gi, si] of skirtOf) {
        normals[si * 3] = normals[gi * 3];
        normals[si * 3 + 1] = normals[gi * 3 + 1];
        normals[si * 3 + 2] = normals[gi * 3 + 2];
    }

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = surfaceIndices.concat(wallIndices);
    vertexData.normals = normals;
    vertexData.uvs = uvs;

    const mesh = new Mesh(`tile-${tileKey(zoom, tx, ty)}`, scene);
    vertexData.applyToMesh(mesh);
    mesh.position.copyFrom(anchor);

    // 地理院タイル画像を diffuseTexture として適用（同一 z/x/y）。地形の陰影は
    // ライティングで残しつつ、テクスチャで地図表現にする。タイルごとに専有し、
    // アンロード時に mesh.dispose(_, true) でテクスチャごと破棄する。
    const mat = new StandardMaterial(`tile-mat-${tileKey(zoom, tx, ty)}`, scene);
    const tex = new Texture(textureUrl(mapType, zoom, tx, ty), scene);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    mat.diffuseTexture = tex;
    mat.specularColor = new Color3(0.02, 0.02, 0.02);
    // 巻き順を外向きに揃えたので片面描画（backFaceCulling=true）で正しく表が見える。
    // スカート壁は両面分の三角形を出しているため culling 下でも見える。
    mat.backFaceCulling = true;
    mesh.material = mat;
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
    const minZoom = Math.round(resolveNumber(search, "zoom", DEFAULTS.minZoom));
    const radius = resolveNumber(search, "radius", DEFAULTS.radius);
    const mapType: MapType =
        new URLSearchParams(search).get("map") === "photo" ? "photo" : "std";

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    // キーボード入力（WASD/矢印）は scene.onKeyboardObservable 経由で、canvas が
    // フォーカスを持つ必要がある。tabIndex を付与し、ポインタ操作時にフォーカスを当てる
    // （pointer/wheel はフォーカス不要だがキーボードは必須）。
    canvas.tabIndex = 0;
    canvas.style.outline = "none";
    canvas.addEventListener("pointerdown", () => canvas.focus());
    mount.appendChild(canvas);
    canvas.focus();

    const engine = await createBabylonEngine(canvas, resolveEngine(search) ?? "webgpu");

    // Large World Rendering: 真の ECEF（百万 m オーダー）でも精度を保つため floating origin を有効化。
    const scene = new Scene(engine, { useFloatingOrigin: true });
    scene.clearColor = new Color4(0.75, 0.86, 0.95, 1);
    // EcefFromLatLonAltToRef は常に右手系 ECEF（X→経度0, Y→東経90°, Z→北極）を出力し、
    // GeospatialCamera も scene.useRightHandedSystem を前提に視点を組む。既定の左手系の
    // ままだと右手系データを鏡像で見るため東西が反転する。右手系に揃える。
    scene.useRightHandedSystem = true;

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
    camera.attachControl(true);

    // ---- WASD パン（picking に依存しない独自実装） ----
    // 既定の pan（キーボード/左ドラッグ）は scene.pick でグローブをヒットしてドラッグ平面を
    // 作るが、useFloatingOrigin 下ではレンダリング座標と真の ECEF メッシュ位置がずれ、
    // ピックが外れて pan が機能しない。floating origin（#275 の精度要件）を維持するため、
    // camera.center を地理的接線（北/東）方向へ高度比例で移動させる独自パンを実装する。
    const pressed = new Set<string>();
    const PAN_KEYS = new Set(["w", "a", "s", "d"]);
    const onKeyDown = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        if (PAN_KEYS.has(k)) {
            pressed.add(k);
            e.preventDefault();
        }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        pressed.delete(e.key.toLowerCase());
    };
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);

    /** 1 秒あたりのパン距離 = radius（高度相当）× この係数。高度に比例した自然な速度。 */
    const PAN_RATE_PER_SEC = 0.6;
    const POLE = new Vector3(0, 0, 1); // ECEF 北極軸（EcefFromLatLonAltToRef 規約）
    const eastV = new Vector3();
    const northV = new Vector3();
    const tangent = new Vector3();

    const applyPan = (): void => {
        if (pressed.size === 0) return;
        const c = camera.center;
        const r = c.length();
        if (r < 1) return;
        const upV = c.scale(1 / r);
        // 地心 up と北極軸から東/北の接線基底を作る。
        Vector3.CrossToRef(POLE, upV, eastV);
        if (eastV.lengthSquared() < 1e-12) eastV.copyFromFloats(1, 0, 0);
        eastV.normalize();
        Vector3.CrossToRef(upV, eastV, northV); // 北
        northV.normalize();

        let fwd = 0;
        let side = 0;
        if (pressed.has("w")) fwd += 1;
        if (pressed.has("s")) fwd -= 1;
        if (pressed.has("d")) side += 1;
        if (pressed.has("a")) side -= 1;
        if (fwd === 0 && side === 0) return;

        const dtSec = Math.min(0.05, engine.getDeltaTime() / 1000);
        const step = camera.radius * PAN_RATE_PER_SEC * dtSec;
        tangent.copyFromFloats(0, 0, 0);
        tangent.addInPlace(northV.scale(fwd)).addInPlace(eastV.scale(side));
        tangent.normalize().scaleInPlace(step);

        // center を接線方向へ移動し、地心距離 r を保つように再正規化して球面上に戻す。
        const moved = c.add(tangent);
        moved.normalize().scaleInPlace(r);
        camera.center = moved;
    };

    // ライト: 地表の up（地心法線）を基準に環境光 + 斜め方向の指向性ライト。
    const up = centerEcef.clone().normalize();
    const hemi = new HemisphericLight("hemi", up, scene);
    hemi.intensity = 0.55;
    hemi.groundColor = new Color3(0.3, 0.32, 0.3);
    const ref = Math.abs(up.y) < 0.99 ? Vector3.Up() : Vector3.Right();
    const east = Vector3.Cross(ref, up).normalize();
    const sunDir = up.scale(-0.85).add(east.scale(0.5)).normalize();
    const sun = new DirectionalLight("sun", sunDir, scene);
    sun.intensity = 0.7;

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    // ---- 動的 LOD: カメラ ECEF を算出し、地心距離ベース SSE quadtree でタイルを選択 ----
    const loaded = new Map<string, Mesh>();
    const loading = new Set<string>();
    const lookAt = new Vector3();
    const cameraEcef = new Vector3();

    /** GeospatialCamera の center/yaw/pitch/radius から真の ECEF 位置を復元する。 */
    const computeCameraEcef = (): Vector3 => {
        ComputeLookAtFromYawPitchToRef(
            camera.yaw,
            camera.pitch,
            camera.center,
            scene.useRightHandedSystem,
            lookAt,
        );
        // lookAt はカメラ→center 方向。カメラ位置 = center - lookAt * radius。
        cameraEcef.copyFrom(camera.center).subtractInPlace(lookAt.scale(camera.radius));
        return cameraEcef;
    };

    // 直近の LOD 選択キー集合（取得完了時に「まだ必要か」を判定するために参照する）。
    let desiredKeys = new Set<string>();

    const loadTile = (t: GlobeTile): void => {
        const key = tileKey(t.zoom, t.x, t.y);
        if (loaded.has(key) || loading.has(key)) return;
        loading.add(key);
        loadElevationTile(t.zoom, t.x, t.y)
            .then((elev) => {
                loading.delete(key);
                // 取得完了までにアンロード対象になっていなければメッシュ化する。
                if (!desiredKeys.has(key)) return;
                const mesh = buildTileMesh(scene, t.zoom, t.x, t.y, elev, DEFAULTS.segments, mapType);
                loaded.set(key, mesh);
            })
            .catch((e) => {
                loading.delete(key);
                console.warn(`[geospatial-poc] tile ${key} failed:`, e);
            });
    };

    const syncTiles = (): void => {
        const tiles = selectGlobeTiles({
            cameraEcef: computeCameraEcef(),
            centerLat: lat,
            centerLon: lon,
            minZoom,
            maxZoom: DEFAULTS.maxZoom,
            viewportHeight: engine.getRenderHeight(),
            verticalFov: camera.fov,
            sseThreshold: DEFAULTS.sseThreshold,
            maxTiles: DEFAULTS.maxTiles,
            rootSearchRadius: DEFAULTS.rootSearchRadius,
            horizonDotThreshold: DEFAULTS.horizonDotThreshold,
        });
        desiredKeys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));

        // 不要になったタイルを破棄。
        for (const [key, mesh] of loaded) {
            if (!desiredKeys.has(key)) {
                mesh.dispose(false, true); // マテリアル・テクスチャごと破棄
                loaded.delete(key);
            }
        }
        // 新規タイルをロード。
        for (const t of tiles) loadTile(t);

        // 統計表示。
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const t of tiles) {
            if (t.zoom < minZ) minZ = t.zoom;
            if (t.zoom > maxZ) maxZ = t.zoom;
        }
        updateInfo(
            `Geospatial PoC (#321) — 動的 LOD\n` +
                `ドラッグ=回転 / ホイール=ズーム / WASD=パン\n` +
                `engine: ${engine.constructor.name} / floatingOrigin: ${scene.floatingOriginMode}\n` +
                `fps: ${engine.getFps().toFixed(0)} / radius: ${(camera.radius / 1000).toFixed(1)}km\n` +
                `LOD zoom: ${Number.isFinite(minZ) ? `${minZ}–${maxZ}` : "-"} / ` +
                `selected: ${tiles.length} / loaded: ${loaded.size} / loading: ${loading.size}`,
        );
    };

    // 初回 + フレーム間引きで LOD を再評価する。
    syncTiles();
    let frame = 0;
    scene.onBeforeRenderObservable.add(() => {
        applyPan();
        frame++;
        if (frame % DEFAULTS.syncIntervalFrames === 0) syncTiles();
    });

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
