/**
 * #460 遠方ジオメトリ解像度の回帰テスト。
 *
 * 東京駅（注視点/center）から富士山方向（カメラ→山頂 ≈100km）を望む実機視点
 * （viewer.html `@35.680813,139.766423,345,254.18,81.79`）を faithful に再現し、
 * `selectGlobeTiles` が富士山帯へ割り当てる実タイル zoom と、そこから `adaptiveMeshSegments`
 * で決まるメッシュ実効解像度（1 頂点あたり地表距離）を検証する。
 *
 * 背景（#460）: 既定 segments=32 のままだと遠方の粗 zoom タイル（zoom≈10, 1辺≈32km）は
 * 1 頂点 ≈1km となり富士山級の独立峰が数頂点に潰れて稜線が失われる。距離適応 segments により
 * ロード済み DEM 詳細を活かし、遠方でも稜線相当の頂点密度を保つことを回帰として固定する。
 *
 * 注: 見た目（silhouette）の最終確認はビジュアル回帰 tests/elevationFarView.spec.ts で行う。
 */
import { describe, it, expect } from "@jest/globals";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ComputeLookAtFromYawPitchToRef } from "@babylonjs/core/Cameras/geospatialCamera";

import { geodeticToEcef } from "../src/terrain/geo/ecef";
import { tileEdgeMeters } from "../src/terrain/gsiTile";
import { selectGlobeTiles, type GlobeLodOptions } from "../src/terrain/geo/globeLod";
import { adaptiveMeshSegments } from "../src/terrain/geo/globeMesh";
import { GLOBE_SCENE_DEFAULTS } from "../src/scenes/globe";

const DEG2RAD = Math.PI / 180;

// 実機視点: GeospatialCamera 規約で @lat,lon=注視点(center), 第3項=radius[m], azimuth→yaw, tilt→pitch。
const CENTER_LAT = 35.680813; // 東京駅（丸の内）
const CENTER_LON = 139.766423;
const RADIUS_M = 345;
const YAW = 254.18 * DEG2RAD;
const PITCH = Math.min(81.79, 89) * DEG2RAD; // globe.ts: min(tilt, MAX_TILT_DEG=89)
const TOKYO_ELEV_M = 3;

// 富士山山頂（GLOBE_SCENE_DEFAULTS と同一）。
const FUJI_LAT = 35.3606;
const FUJI_LON = 138.7274;
const FUJI_SUMMIT_SPAN_M = 3000; // 山頂付近の急峻な稜線幅

const BASE_SEGMENTS = GLOBE_SCENE_DEFAULTS.segments; // 32
const GEOM_MAX_ZOOM = GLOBE_SCENE_DEFAULTS.geomMaxZoom; // 15

/** GeospatialCamera と同一手順で cameraEcef を求める。 */
function computeCameraEcef(centerEcef: Vector3): Vector3 {
    const lookAt = new Vector3();
    ComputeLookAtFromYawPitchToRef(YAW, PITCH, centerEcef, /*useRH*/ true, lookAt);
    return centerEcef.subtract(lookAt.scale(RADIUS_M)); // center - lookAt * radius
}

describe("#460 farViewGeomResolution", () => {
    const centerEcef = geodeticToEcef(CENTER_LAT, CENTER_LON, TOKYO_ELEV_M);
    const cameraEcef = computeCameraEcef(centerEcef);

    const opts: GlobeLodOptions = {
        cameraEcef,
        centerLat: CENTER_LAT,
        centerLon: CENTER_LON,
        minZoom: GLOBE_SCENE_DEFAULTS.minZoom, // 11
        maxZoom: GLOBE_SCENE_DEFAULTS.maxZoom, // 18
        viewportHeight: 1080,
        viewportWidth: 1920,
        verticalFov: 0.8,
        sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold, // 384
        maxTiles: GLOBE_SCENE_DEFAULTS.maxTiles, // 384
        rootSearchRadius: GLOBE_SCENE_DEFAULTS.rootSearchRadius,
        maxRootTiles: GLOBE_SCENE_DEFAULTS.maxRootTiles,
        horizonDotThreshold: GLOBE_SCENE_DEFAULTS.horizonDotThreshold,
        referenceAltitude: TOKYO_ELEV_M,
        rootZoomFloor: GLOBE_SCENE_DEFAULTS.rootZoomFloor,
        textureQualityFloorZoom: GLOBE_SCENE_DEFAULTS.textureQualityFloorZoom,
        // frustumPlanes は解像度（選択 zoom）に影響しないため省略（帯＋地平線カリングのみ）。
    };

    const tiles = selectGlobeTiles(opts);

    it("カメラ→富士山山頂の距離が想定範囲（約100km）にある", () => {
        const d = Vector3.Distance(cameraEcef, geodeticToEcef(FUJI_LAT, FUJI_LON, 3776));
        expect(d).toBeGreaterThan(90_000);
        expect(d).toBeLessThan(110_000);
    });

    it("遠方（富士山帯）は粗い zoom（<=10）が選ばれる（LOD の距離累進）", () => {
        const minZ = Math.min(...tiles.map((t) => t.zoom));
        // 距離累進 + distCapZoom により最粗 root は zoom=10 まで下がる。
        expect(minZ).toBeLessThanOrEqual(10);
        // 富士山帯（>=90km）に zoom<=10 のタイルが実在する。
        const farCoarse = tiles.filter((t) => t.zoom <= 10 && t.distance >= 90_000);
        expect(farCoarse.length).toBeGreaterThan(0);
    });

    it("距離適応 segments により遠方タイルの実効解像度が zoom12 相当（<=250m/頂点）に保たれる", () => {
        // 富士山帯の最粗タイル群それぞれについて、adaptiveMeshSegments 適用後の 1 頂点あたり
        // 地表距離が 250m 以下（=zoom12 相当）になり、既定 segments=32 の ~1km/頂点から改善する。
        const farCoarse = tiles.filter((t) => t.zoom <= 10 && t.distance >= 90_000);
        expect(farCoarse.length).toBeGreaterThan(0);
        for (const t of farCoarse) {
            const gz = Math.min(t.zoom, GEOM_MAX_ZOOM);
            const segs = adaptiveMeshSegments(t.tileSizeMeters, t.zoom, gz, BASE_SEGMENTS);
            const mPerVertex = t.tileSizeMeters / segs;
            const baseMPerVertex = t.tileSizeMeters / BASE_SEGMENTS;

            // 適応後は zoom12 相当（≈250m/頂点。緯度差で目標 250m を僅かに超える程度に収まる）。
            expect(mPerVertex).toBeLessThanOrEqual(300);
            // 既定 segments のままより明確に細かい（少なくとも 2 倍以上の頂点密度）。
            expect(segs).toBeGreaterThanOrEqual(BASE_SEGMENTS * 2);
            // 既定では ~1km/頂点だったことを確認（改善の前提）。
            expect(baseMPerVertex).toBeGreaterThan(500);

            // 富士山山頂急峻部（3km）を最低 10 頂点で表現できる（既定では約 3 頂点）。
            expect(FUJI_SUMMIT_SPAN_M / mPerVertex).toBeGreaterThanOrEqual(10);
        }
    });

    it("近景の細タイル（z16-18, geomZoom=15 共有）は既定 segments 据え置き", () => {
        const near = tiles.filter((t) => t.zoom >= 16);
        for (const t of near) {
            const gz = Math.min(t.zoom, GEOM_MAX_ZOOM);
            const segs = adaptiveMeshSegments(t.tileSizeMeters, t.zoom, gz, BASE_SEGMENTS);
            // 覆う DEM サンプル数 = 256/2^(zoom-gz) <= 32 のため既定据え置き（詳細を捏造しない）。
            expect(segs).toBe(BASE_SEGMENTS);
        }
        // 中景（z13-15）も 1 辺が小さく既定のまま（target<=base）であることの目安。
        const midZ13 = tileEdgeMeters(FUJI_LAT, 13);
        expect(adaptiveMeshSegments(midZ13, 13, 13, BASE_SEGMENTS)).toBe(BASE_SEGMENTS);
    });
});
