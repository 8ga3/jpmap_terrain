/**
 * jpmap-terrain パッケージエントリ
 *
 * 公開 API は spec/package.md §3 に従う。
 * - クラス本体: `./lib/jpmapTerrain`
 * - 公開型: `./lib/types`
 */

export { JpmapTerrain } from "./lib/jpmapTerrain";
export type {
    CameraChangeEvent,
    CameraChangeListener,
    EngineType,
    FlyToOptions,
    JpmapTerrainOptions,
    MapType,
    MapTypeChangeListener,
    MarkerHandle,
    MarkerIconOptions,
    MarkerLineOptions,
    MarkerOptions,
    MarkerTextOptions,
    MarkerUpdate,
    AltitudeMode,
    PolygonPointOptions,
    PolygonPointPartial,
    PolygonStyleOptions,
    PolygonOptions,
    PolygonUpdate,
    PolygonHandle,
    TerrainClickEvent,
    TerrainClickListener,
} from "./lib/types";
