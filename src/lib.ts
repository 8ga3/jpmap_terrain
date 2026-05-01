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
    ViewMode,
    ViewModeChangeListener,
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
    PolygonPointPointerEvent,
    PolygonPointDragEvent,
    PolygonPointHoverListener,
    PolygonPointClickListener,
    PolygonPointDragListener,
    CircleCenterOptions,
    CircleStyleOptions,
    CircleOptions,
    CircleUpdate,
    CircleHandle,
} from "./lib/types";
export {
    CIRCLE_DEFAULTS,
    CIRCLE_SEGMENTS_MIN,
    CIRCLE_SEGMENTS_MAX,
    CIRCLE_RADIUS_MAX_M,
} from "./lib/types";
