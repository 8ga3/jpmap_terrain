/**
 * jpmap-terrain パッケージエントリ
 *
 * 公開 API は spec/package.md §3 に従う。
 * - クラス本体: `./lib/jpmapTerrain`
 * - 公開型: `./lib/types`
 * - WebXR 汎用ユーティリティ（セッション対応判定・コントローラー入力変換）: `./lib/webxr/`
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
    ModelVector3,
    ModelOptions,
    ModelUpdate,
    ModelHandle,
} from "./lib/types";
export {
    CIRCLE_DEFAULTS,
    CIRCLE_SEGMENTS_MIN,
    CIRCLE_SEGMENTS_MAX,
    CIRCLE_RADIUS_MAX_M,
    MODEL_DEFAULTS,
} from "./lib/types";
export {
    isWebXrSessionSupported,
    DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS,
} from "./lib/webxr/webXrSessionSupport";
export {
    applyStickDeadzone,
    applyDPadGate,
    computePanMetersFromStick,
    computeHeadingRadFromHorizontal,
    rotateHorizontalUnitVector,
    computePanAxesFromDirectionalInput,
    normalizeAngleRad,
    angleDeltaRad,
    snapHeadingRad,
    computeRotationRadFromStick,
    computeHorizontalDisplacement,
    isInsideDeadZone,
    computeZoomFactorFromStick,
    clampViewScaleM,
    computeHeightMetersFromTriggers,
    clampHeightOffsetM,
    DEFAULT_STICK_DEADZONE,
    DEFAULT_MIN_VIEW_SCALE_FOR_PAN_SPEED_M,
    DEFAULT_PAN_SPEED_PER_SEC,
    DEFAULT_HEADING_SNAP_STEP_RAD,
    DEFAULT_HEADING_SNAP_HYSTERESIS_RAD,
    DEFAULT_DEAD_ZONE_HYSTERESIS_M,
    DEFAULT_ZOOM_RATE_PER_SEC,
    DEFAULT_VIEW_SCALE_MIN_M,
    DEFAULT_VIEW_SCALE_MAX_M,
    DEFAULT_ROTATION_SPEED_RAD_PER_SEC,
    DEFAULT_HEIGHT_SPEED_M_PER_SEC,
    DEFAULT_HEIGHT_OFFSET_MIN_M,
    DEFAULT_HEIGHT_OFFSET_MAX_M,
} from "./lib/webxr/webXrStickInput";
export type { StickAxes, HorizontalUnitVector, PanFromStickOptions } from "./lib/webxr/webXrStickInput";
