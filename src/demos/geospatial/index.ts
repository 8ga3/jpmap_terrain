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
    toTileXY,
    TILE_SIZE,
    type MapType,
} from "../../terrain/gsiTile";
import { selectGlobeTiles, tileKey, type GlobeTile } from "./globeLod";
import { ecefToGeodetic, uiToYawPitch, yawPitchToUi, toAtPath } from "./geoMapping";
import { selectCoarseEdges, snapEdgeElevation, type CoarseEdge } from "./crossLevel";

const DEMO_MOUNT_ID = "root";

/** PoC の既定表示・LOD パラメータ（富士山周辺）。 */
const DEFAULTS = {
    lat: 35.3606,
    lon: 138.7274,
    /** root（最低）ズーム。 */
    minZoom: 11,
    /** 最高ズーム（分割上限）。テクスチャ（std/photo）は z18 まで対応。 */
    maxZoom: 18,
    /** ジオメトリ（標高）の最高ズーム。GSI DEM(dem5a/5b) は z15 まで。
     *  z16-18 は z15 祖先の標高をサブサンプルして使う（テクスチャのみ高解像度）。 */
    geomMaxZoom: 15,
    /** カメラ中心（地表）からの距離 [m]。 */
    radius: 60000,
    /** 方位[deg]（0=北, +=東回り）→ yaw。 */
    azimuth: 0,
    /** チルト[deg]（0=直下, 90=水平）→ pitch。 */
    tilt: 60,
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
/** 標高ラスタ（TILE_SIZE 角）をローカルピクセル座標で bilinear サンプル（無効値は 0）。 */
const sampleElevBilinear = (elev: Float32Array, px: number, py: number): number => {
    const cx = Math.max(0, Math.min(TILE_SIZE - 1, px));
    const cy = Math.max(0, Math.min(TILE_SIZE - 1, py));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
    const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
    const fx = cx - x0;
    const fy = cy - y0;
    const g = (x: number, y: number): number => {
        const v = elev[y * TILE_SIZE + x];
        return Number.isFinite(v) ? v : 0;
    };
    const a = g(x0, y0) * (1 - fx) + g(x1, y0) * fx;
    const b = g(x0, y1) * (1 - fx) + g(x1, y1) * fx;
    return a * (1 - fy) + b * fy;
};

const buildTileMesh = (
    scene: Scene,
    zoom: number,
    tx: number,
    ty: number,
    // ジオメトリ用標高タイル（DEM 上限 z15 まで。z16-18 タイルは z15 祖先を使う）。
    geomElev: Float32Array,
    geomZoom: number,
    geomX: number,
    geomY: number,
    segments: number,
    mapType: MapType,
    edges: readonly CoarseEdge[],
): Mesh => {
    // この描画タイル(zoom)の 1 ピクセルが geom タイルの 1/geomScale ピクセルに対応。
    const geomScale = 2 ** (zoom - geomZoom);
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
            // タイル内ピクセル位置（0..TILE_SIZE）。
            const pxF = (col / segments) * TILE_SIZE;
            const pyF = (row / segments) * TILE_SIZE;
            // この頂点のグローバルピクセル(zoom)→ geom タイルのローカルピクセルへ写像し、
            // geom 標高（z16-18 は z15 祖先）を bilinear サンプル。
            const glx = (tx * TILE_SIZE + pxF) / geomScale - geomX * TILE_SIZE;
            const gly = (ty * TILE_SIZE + pyF) / geomScale - geomY * TILE_SIZE;
            let elev = sampleElevBilinear(geomElev, glx, gly);
            // クロスレベル: 境界辺なら粗タイル表面へ標高をスナップ（陰影シーム解消、z<=15 のみ）。
            const snapped = snapEdgeElevation(edges, row, col, segments, tx, ty, pxF, pyF);
            if (snapped !== null) elev = snapped;

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
    const azimuth = resolveNumber(search, "azimuth", DEFAULTS.azimuth);
    const tilt = resolveNumber(search, "tilt", DEFAULTS.tilt);
    const mapType: MapType =
        new URLSearchParams(search).get("map") === "photo" ? "photo" : "std";
    // クロスレベル標高スナップの有効/無効（?snap=off で比較用に無効化）。
    const snapEnabled = new URLSearchParams(search).get("snap") !== "off";

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
    // 既存 UI の azimuth/tilt[deg] を yaw/pitch[rad] にマッピングして初期化。
    const initYP = uiToYawPitch(azimuth, tilt);
    camera.yaw = initYP.yaw;
    camera.pitch = initYP.pitch;

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

    // ---- 左ドラッグパン（picking 非依存） ----
    // 既定の左ドラッグパンは scene.pick 依存で floating origin 下では no-op のため、
    // WASD と同様に camera.center を地表接線へ動かす独自実装で「マップを掴む」操作を提供する。
    // ドラッグのピクセル移動量を、注視点距離での地表 m/px に換算してパン量とする。
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const dragLookAt = new Vector3();
    const dragUp = new Vector3();
    const dragRight = new Vector3();
    const dragFwd = new Vector3();
    canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
    });
    const endDrag = (): void => {
        dragging = false;
    };
    canvas.addEventListener("pointerup", (e) => {
        if (e.button === 0) endDrag();
    });
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (dx === 0 && dy === 0) return;

        const c = camera.center;
        const r = c.length();
        if (r < 1) return;
        c.scaleToRef(1 / r, dragUp); // 地心 up
        // カメラ→center 方向（lookAt）から地表接線の右・前方向を作る。
        ComputeLookAtFromYawPitchToRef(
            camera.yaw,
            camera.pitch,
            c,
            scene.useRightHandedSystem,
            dragLookAt,
        );
        Vector3.CrossToRef(dragLookAt, dragUp, dragRight);
        if (dragRight.lengthSquared() < 1e-12) return; // 真下視点の特異点
        dragRight.normalize();
        Vector3.CrossToRef(dragUp, dragRight, dragFwd); // 地表に沿ったカメラ前方
        dragFwd.normalize();

        // 注視点距離での地表 m/px（掴んだ点がほぼカーソル追従する縮尺）。
        const fovHeightM = 2 * camera.radius * Math.tan(camera.fov / 2);
        const mpp = fovHeightM / Math.max(1, canvas.clientHeight);
        // マップを掴んで引く挙動: 掴んだ地点がカーソルに追従する向き。
        // 右ドラッグ→center 西（content 右へ）、下ドラッグ→center 前方=北（content 下へ）。
        const move = dragRight.scale(-dx * mpp).addInPlace(dragFwd.scale(dy * mpp));
        const moved = c.add(move);
        moved.normalize().scaleInPlace(r);
        camera.center = moved;
    });

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
    // クロスレベルスナップのため、ビルド後も標高配列を保持する（隣接細タイルが参照）。
    const elevCache = new Map<string, Float32Array>();
    const failed = new Set<string>();
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

    // 描画タイル(zoom 最大18) → ジオメトリ用標高タイル(最大 geomMaxZoom=15)の対応。
    const geomCoordOf = (t: GlobeTile): { gz: number; gx: number; gy: number } => {
        const gz = Math.min(t.zoom, DEFAULTS.geomMaxZoom);
        const d = t.zoom - gz;
        return { gz, gx: t.x >> d, gy: t.y >> d };
    };

    /**
     * 緯度経度の地形標高[m]を、読み込み済みの「最も詳細な」geom タイルから bilinear 取得。
     * z15→minZoom を探索し最初に見つかったものを使う（無ければ null）。
     * 遠景では粗い標高で中心を地形へ持ち上げ、近づくほど精細化してブートストラップする
     * （高標高地で中心を海面のままにするとカメラが地形下へ潜るのを防ぐ）。
     */
    const terrainElevAt = (latDeg: number, lonDeg: number): number | null => {
        const latRad = latDeg * DEG2RAD;
        for (let gz = DEFAULTS.geomMaxZoom; gz >= minZoom; gz--) {
            const { x, y } = toTileXY(latDeg, lonDeg, gz);
            const e = elevCache.get(tileKey(gz, x, y));
            if (!e) continue;
            const total = TILE_SIZE * 2 ** gz;
            const gpx = ((lonDeg + 180) / 360) * total;
            const gpy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * total;
            return sampleElevBilinear(e, gpx - x * TILE_SIZE, gpy - y * TILE_SIZE);
        }
        return null;
    };
    const seatCenter = new Vector3();
    // SSE 距離評価の基準標高（中心付近の地形標高）。前 sync の値を次 sync で使う。
    let centerElevation = 0;

    // 標高取得（geom タイル単位）はキャッシュに溜めるだけ。z16-18 は z15 を共有しデデュプされる。
    const loadTile = (t: GlobeTile): void => {
        const { gz, gx, gy } = geomCoordOf(t);
        const gk = tileKey(gz, gx, gy);
        if (elevCache.has(gk) || loading.has(gk) || failed.has(gk)) return;
        loading.add(gk);
        loadElevationTile(gz, gx, gy)
            .then((elev) => {
                loading.delete(gk);
                elevCache.set(gk, elev);
            })
            .catch((e) => {
                loading.delete(gk);
                failed.add(gk);
                console.warn(`[geospatial-poc] geom tile ${gk} failed:`, e);
            });
    };

    /**
     * 建築パス: geom 標高が揃った desired タイルをメッシュ化する。
     * - ジオメトリは geom タイル(<=z15)からサブサンプル。テクスチャは描画 zoom(<=z18)。
     * - クロスレベルスナップは zoom<=geomMaxZoom の境界でのみ適用（z16-18 は z15 を共有し連続）。
     */
    const buildReadyTiles = (tiles: readonly GlobeTile[]): void => {
        for (const t of tiles) {
            const k = tileKey(t.zoom, t.x, t.y);
            if (loaded.has(k)) continue;
            const { gz, gx, gy } = geomCoordOf(t);
            const geomElev = elevCache.get(tileKey(gz, gx, gy));
            if (!geomElev) continue; // geom 標高が未ロード（または no-data 失敗）

            let edges: readonly CoarseEdge[] = [];
            if (snapEnabled && t.zoom <= DEFAULTS.geomMaxZoom) {
                const r = selectCoarseEdges(
                    t,
                    (kk) => desiredKeys.has(kk),
                    (kk) => elevCache.get(kk),
                    (kk) => failed.has(kk),
                    minZoom,
                );
                if (r.pending) continue; // 粗隣接の標高待ち
                edges = r.edges;
            }
            const mesh = buildTileMesh(
                scene, t.zoom, t.x, t.y, geomElev, gz, gx, gy, DEFAULTS.segments, mapType, edges,
            );
            loaded.set(k, mesh);
        }
    };

    const syncTiles = (): void => {
        // root 探索はカメラの現在の注視点(center)を追従する（パン後もカメラ直下を選択）。
        const camGeo = ecefToGeodetic(camera.center);
        const tiles = selectGlobeTiles({
            cameraEcef: computeCameraEcef(),
            centerLat: camGeo.latDeg,
            centerLon: camGeo.lonDeg,
            minZoom,
            maxZoom: DEFAULTS.maxZoom,
            viewportHeight: engine.getRenderHeight(),
            verticalFov: camera.fov,
            sseThreshold: DEFAULTS.sseThreshold,
            maxTiles: DEFAULTS.maxTiles,
            rootSearchRadius: DEFAULTS.rootSearchRadius,
            horizonDotThreshold: DEFAULTS.horizonDotThreshold,
            referenceAltitude: centerElevation,
        });
        desiredKeys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));
        // 必要な geom 標高タイルのキー集合（z16-18 は z15 祖先を共有）。
        const neededGeom = new Set(tiles.map((t) => {
            const { gz, gx, gy } = geomCoordOf(t);
            return tileKey(gz, gx, gy);
        }));

        // 不要になったメッシュを破棄。
        for (const [key, mesh] of loaded) {
            if (!desiredKeys.has(key)) {
                mesh.dispose(false, true); // マテリアル・テクスチャごと破棄
                loaded.delete(key);
            }
        }
        // 不要になった geom 標高キャッシュを破棄（必要 geom キー集合で判定）。
        for (const key of elevCache.keys()) {
            if (!neededGeom.has(key)) elevCache.delete(key);
        }
        // 新規タイルをロードし、標高が揃ったものを（クロスレベルスナップ付きで）建築。
        for (const t of tiles) loadTile(t);
        buildReadyTiles(tiles);

        // 統計表示。
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const t of tiles) {
            if (t.zoom < minZ) minZ = t.zoom;
            if (t.zoom > maxZ) maxZ = t.zoom;
        }

        // ---- カメラ状態 ⇄ 既存 UI/URL のマッピングを実演 ----
        // GeospatialCamera(yaw/pitch/radius/center) から既存 UI 表現(azimuth/tilt/altitude/lat,lon)を逆算。
        const { azimuthDeg, tiltDeg } = yawPitchToUi(camera.yaw, camera.pitch);
        const geo = ecefToGeodetic(camera.center); // center(ECEF) → 測地 lat/lon
        const atPath = toAtPath(geo.latDeg, geo.lonDeg, camera.radius, azimuthDeg, tiltDeg);
        // 既存と同じ共有 URL 形式を hash に反映（往復可能であることの実証）。
        history.replaceState(null, "", `#${atPath}`);

        updateInfo(
            `Geospatial PoC (#321) — 動的 LOD + UI/URL マッピング\n` +
                `左ドラッグ=パン / 右ドラッグ=回転 / ホイール=ズーム / WASD=パン\n` +
                `engine: ${engine.constructor.name} / floatingOrigin: ${scene.floatingOriginMode}\n` +
                `fps: ${engine.getFps().toFixed(0)}\n` +
                `lat,lon: ${geo.latDeg.toFixed(4)}, ${geo.lonDeg.toFixed(4)}\n` +
                `azimuth: ${azimuthDeg.toFixed(1)}° / tilt: ${tiltDeg.toFixed(1)}° / ` +
                `altitude: ${Math.round(camera.radius)}m\n` +
                `LOD zoom: ${Number.isFinite(minZ) ? `${minZ}–${maxZ}` : "-"} / ` +
                `selected: ${tiles.length} / loaded: ${loaded.size} / loading: ${loading.size}`,
        );
    };

    // 初回 + フレーム間引きで LOD を再評価する。
    // orbit 中心を地形表面へ追従させる（高標高地でカメラが地形下へ潜るのを防ぐ）。
    // 毎フレーム実行する。syncTiles（15 フレーム毎）でのみ補正すると、zoom-to-cursor が
    // 毎フレーム中心を水平移動させる一方で高度補正が間引かれ、斜面でガタつくため。
    const seatCenterOnTerrain = (): void => {
        // ズーム中は seat を止める。wheel zoom(zoom-to-cursor)は毎フレーム「カーソル下の
        // メッシュをピックした点」へ中心を 3D で寄せており、それ自体が地形追従している。
        // ここでラスタ標高(terrainElevAt)へ寄せると、メッシュ pick 点とラスタ標高の食い違いで
        // 毎フレーム引っ張り合い、揺れの原因になる。ズーム中は zoom 側に任せる。
        if (camera.movement.computedPerFrameZoomPickPoint) return;
        const g = ecefToGeodetic(camera.center);
        const elev = terrainElevAt(g.latDeg, g.lonDeg);
        if (elev === null) return;
        centerElevation = elev; // SSE 距離評価の基準標高
        EcefFromLatLonAltToRef(
            { lat: g.latDeg * DEG2RAD, lon: g.lonDeg * DEG2RAD, alt: elev },
            Wgs84Ellipsoid,
            seatCenter,
        );
        // 同 lat/lon のまま高度だけ地形標高へ。残差を lerp で滑らかに（LOD 切替時の段差緩和）。
        camera.center = Vector3.Lerp(camera.center, seatCenter, 0.5);
    };

    syncTiles();
    let frame = 0;
    scene.onBeforeRenderObservable.add(() => {
        applyPan();
        seatCenterOnTerrain();
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
