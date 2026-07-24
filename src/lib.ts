/**
 * jpmap-terrain パッケージエントリ
 *
 * 公開 API は spec/terrain-api.md §3 / spec/diorama-api.md §5 に従う。
 * - クラス本体: `./lib/jpmapTerrain` / `./lib/jpmapDiorama`
 * - 公開型: `./lib/types`
 */

export { JpmapTerrain } from "./lib/jpmapTerrain";
export { JpmapDiorama } from "./lib/jpmapDiorama";
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
    ModelVector3,
    ModelOptions,
    ModelUpdate,
    ModelHandle,
    DioramaCenter,
    DioramaTileMode,
    DioramaArState,
    JpmapDioramaOptions,
    JpmapDioramaViewChangeEvent,
    JpmapDioramaViewChangeListener,
    DioramaTileModeChangeListener,
    DioramaArStateChangeListener,
} from "./lib/types";
export {
    CIRCLE_DEFAULTS,
    CIRCLE_SEGMENTS_MIN,
    CIRCLE_SEGMENTS_MAX,
    CIRCLE_RADIUS_MAX_M,
    MODEL_DEFAULTS,
} from "./lib/types";
