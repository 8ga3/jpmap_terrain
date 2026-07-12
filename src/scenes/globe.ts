/**
 * グローブ地形シーン。
 *
 * ECEF 楕円体 + Large World Rendering の floating origin で構築したグローブ地形シーン。
 * `GeospatialCamera` を中核に、`geo/globeTileManager` で動的 LOD タイルを描画し、
 * 注視点を地形表面へ追従させる。
 *
 * 「座標系・メッシュ生成・カメラ基盤・配置・LOD」の地形エンジン（注視点ズーム・
 * seat-on-terrain・地心距離 LOD）。
 * picking 非依存パン（左ドラッグ / WASD）・カメラ地形衝突・seat の対地クリアランス
 * フェードを追加。zoom-to-cursor（カーソル位置へ寄るズーム）は seat との鉛直結合で揺れていたため、
 * ズーム中は seat を一時停止し目標点を scene.pick 非依存で固定して実装。
 * URL 等価性はデモ（`demos/geospatial/index.ts`）側で実装。
 */
// GeospatialCamera のポインタ操作（pan/zoom）は内部で scene.pick / createPickingRay を使い、これらは
// Ray の副作用モジュールに依存する（未 import だと初回クリックで "Ray needs to be imported before ..."
// が throw される）。他モジュールの初期化が Ray 依存 API をパッチ適用前に触る順序を避けるため、
// 他の import より前でこの副作用を登録する。ライブラリ利用側（各デモ）が個別に import しなくても動く。
import "@babylonjs/core/Culling/ray";

import { Scene } from "@babylonjs/core/scene";
import { Vector2, Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import {
    GeospatialCamera,
    ComputeLookAtFromYawPitchToRef,
    ComputeYawPitchFromLookAtToRef,
} from "@babylonjs/core/Cameras/geospatialCamera";
import { GeospatialClippingBehavior } from "@babylonjs/core/Behaviors/Cameras/geospatialClippingBehavior";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Wgs84Ellipsoid } from "@babylonjs/core/Maths/math.geospatial.functions";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";

import { WORLD_TEXTURE_MAX_ZOOM, type MapType } from "../terrain/gsiTile";
import { TERRAIN_CLICK_DRAG_THRESHOLD_PX, POLYGON_POINT_DRAG_THRESHOLD_PX } from "../lib/types";
import type { ViewMode } from "../lib/types";
import { clampZoomLevel, radiusToZoomLevel, zoomLevelToRadius } from "../terrain/urlState";
import { DEG2RAD, geodeticToEcef, geodeticToEcefToRef, ecefToGeodetic, type Geodetic } from "../terrain/geo/ecef";
import {
    cameraTangentBasisToRef,
    panCenterOnSphereToRef,
    polePanSpeedMultiplier,
    stepGroundClearanceRadius,
    rayEllipsoidNearHitToRef,
    resolveTerrainClickElevationToRef,
    resolveRecalcCenterSource,
} from "../terrain/geo/cameraMapping";
import { createGlobeTileManager, type GlobeTileManager, type GlobeTileSyncStats } from "../terrain/geo/globeTileManager";
import { viewForwardFromFrustumPlanesToRef } from "../terrain/geo/globeLod";
import type { FrustumPlane } from "../terrain/visibleTiles";
import { createGlobeMarkerManager, type GlobeMarkerManager } from "../terrain/geo/globeMarkerManager";
import {
    createGlobePolygonManager,
    type GlobePolygonManager,
    type GlobePolygonPickablePoint,
} from "../terrain/geo/globePolygonManager";
import { createGlobeCircleManager, type GlobeCircleManager } from "../terrain/geo/globeCircleManager";
import { createGlobeModelManager, type GlobeModelManager } from "../terrain/geo/globeModelManager";
import { OVERLAY_REF_DISTANCE_M } from "../terrain/geo/overlayPlacement";
import { computeSpaceFactor } from "../terrain/skybox";

/** グローブシーンの既定パラメータ（富士山周辺）。 */
export const GLOBE_SCENE_DEFAULTS = {
    lat: 35.3606,
    lon: 138.7274,
    /** root（最低）ズーム。 */
    minZoom: 11,
    /** 最高ズーム（分割上限）。テクスチャ（std/photo）は z18 まで対応。 */
    maxZoom: 18,
    /** ジオメトリ（標高）の最高ズーム。GSI DEM(dem5a/5b) は z15 まで。 */
    geomMaxZoom: 15,
    /** カメラ中心（地表）からの距離 [m]。 */
    radius: 60000,
    /** 方位[deg]（0=北, +=東回り）→ yaw。 */
    azimuth: 0,
    /** チルト[deg]（0=直下, 90=水平）→ pitch。 */
    tilt: 60,
    /**
     * SSE 採用しきい値 [px]。小さいほど近〜中景でレベルダウン距離が遠くなり高解像度を維持する
     * （#456）。従来 512(256*2.0) は近中景のレベルダウンが早く体感解像度が低かったため 384(256*1.5)
     * へ引き下げた。遠景（120km〜）は距離累進（SSE_FALLOFF_RATE）と maxTiles 予算が頭打ちにするため
     * 引き下げてもタイル数はほぼ増えず、余剰解像度は近中景へ回る（計測: tilt=60 でも far-field は
     * maxTiles 未達）。320(256*1.25) までは下げず 384 に留めるのは、384 未満だと帯の前方 reach 余白
     * （`globeLod.ts` の fFar）が sse 依存で縮み、高チルト時に地平線側 root 帯へ連続被覆の穴が生じる
     * ため（#335 連続被覆の不変条件）。
     */
    sseThreshold: 256 * 1.5,
    /**
     * 同時保持タイル数の上限。 の視錐台フルカバー（前景〜地平線、横は水平 FOV 台形）を高 DPI
     * （3x≒render 3240px）かつ高チルトでも欠けなく収めるため拡大（実測最悪 ~329 枚 < 384）。
     * 通常（1080p・中チルト）は ~40〜130 枚で、本値は安全上限として滅多に到達しない。
     */
    maxTiles: 384,
    /** root 帯の横半幅／後方マージン（±N 格子）。 */
    rootSearchRadius: 2,
    /** root（traverse シード）数の予算（上限）。視錐台フルカバーの帯を収めるため maxTiles と同等に。 */
    maxRootTiles: 384,
    /** 地平線カリングの内積しきい値。 */
    horizonDotThreshold: 0.1,
    /**
     * root の最粗 zoom（高度/距離適応ルートレベルの下限）。高高度・遠景では SSE
     * 最適 zoom がこの値まで下がり、少数の粗タイルで広域（地平線・全球）を被覆する。地理院タイルは
     * テクスチャ（std/seamlessphoto）が z0〜、標高（dem_png）が z1〜実データを供給するため、全球
     * 視点で z2〜z4 の少数タイル（例: 高度 12,000km で 8 枚）で地図をマッピングできる。z2 を下限とする
     * （z5 だと全球で z5 を ~200 枚並べ非効率＝予算逼迫）。低〜中高度は距離適応＋distCapZoom が
     * finer を選ぶため通常視点に影響しない（floor は超高高度でのみ作用）。no-data 域はフラット建築＋
     * 背景スフィアが受け持つ。
     */
    rootZoomFloor: 2,
    /**
     * 距離適応 root zoom がこれより粗くならないようにする下限（`rootZoomFloor` とは別枠、
     * 全球モードには適用されない。`globeLod.ts` の `GlobeLodOptions.textureQualityFloorZoom`
     * 参照）。地理院タイルは `WORLD_TEXTURE_MAX_ZOOM`（=8）を境にソース画像の解像度が大きく
     * 変わるため、低〜中高度・高チルトで地平線付近を見る際にこの境界を跨いだ混在（見た目の
     * 破綻）を避ける（#463 フォローアップ）。予算逼迫時は前景優先で地平線側の被覆が狭まる形で
     * 吸収される。
     */
    textureQualityFloorZoom: WORLD_TEXTURE_MAX_ZOOM + 1,
    /** タイルあたりの分割数（頂点は (seg+1)^2）。 */
    segments: 32,
    /** LOD 再評価の間隔（フレーム）。 */
    syncIntervalFrames: 15,
} as const;

/** seat-on-terrain の追従残差 lerp 係数（LOD 切替時の段差緩和）。 */
const SEAT_LERP = 0.5;

/**
 * seat-on-terrain（注視点の地形追従）を効かせるカメラ対地クリアランス[m]の範囲。
 * カメラが地形から十分高い位置にあるときは追従させない（高高度のパンで地形の起伏に沿って
 * カメラ高度がばたつくのを防ぐ）。`FULL` 以下で完全追従、`ZERO` 以上で追従停止、その間は線形に
 * フェード（しきい値で急に切り替えるとズーム時に段差が出るため）。
 */
const SEAT_FULL_CLEARANCE = 3000;
const SEAT_ZERO_CLEARANCE = 10000;

/**
 * zoom-to-cursor のズーム中に seat-on-terrain を一時停止する判定パラメータ。
 * ネイティブのズーム（ホイール入力＋慣性減衰）と seat（center 高度の地形追従）が鉛直方向で
 * 引っ張り合い揺れるため、ズームが落ち着くまで seat を止める。
 * - `ZOOM_PAUSE_IDLE_MS`: 最後のホイール入力からこの時間が経過するまでは「ズーム中」とみなす。
 * - `ZOOM_SETTLE_RATIO`: フレーム間の radius 変化がこの相対値を超える間は（慣性減衰中）「ズーム中」。
 *   ホイール idle かつ radius が settle した時点で seat を滑らかに復帰させる。
 */
const ZOOM_PAUSE_IDLE_MS = 200;
const ZOOM_SETTLE_RATIO = 1e-4;

/** 1 秒あたりの WASD パン距離 = radius（高度相当）× この係数。高度比例で自然な速度。 */
const PAN_RATE_PER_SEC = 0.6;

/** カメラ地形衝突: 地表からの最小クリアランス[m]（URL altitude 下限と整合）。 */
const MIN_GROUND_CLEARANCE = 50;

/**
 * カメラ地形衝突の radius 補正をスムーズに行うための補間係数。
 * 従来は必要な radius をアニメーション無しで直接代入していたため、パンでカメラ高度が急落した
 * フレームに radius が一段で跳ね（カメラ位置が一瞬飛ぶ）、さらに一度増えた radius が戻らず
 * カメラがアバターから離れていった。押し出しは PUSH、制約が解けたときの復帰は RELAX で
 * それぞれ滑らかに補間し、単調増加を避ける。
 * - `PUSH`: 衝突回避のため radius を増やす際の 1 フレーム補間率（速め）。
 * - `RELAX`: 衝突が解消し追加分を戻す際の 1 フレーム補間率（ゆっくり）。
 */
const GROUND_CLEARANCE_PUSH_LERP = 0.3;
const GROUND_CLEARANCE_RELAX_LERP = 0.1;

/**
 * 外部（setAltitude / setView / ホイールズーム等）による radius 直接上書きの検知しきい値（相対）。
 * enforceGroundClearance が最後に書いた radius との差がこの相対値を超えたら「外部上書き」とみなし、
 * 地形衝突の追加分(clearanceBoost)を破棄して現在の radius を新たな素の値として再基準化する。
 * 我々自身が書いた値はフレーム間で厳密一致するため、通常フレームでは誤検知しない。
 */
const EXTERNAL_RADIUS_EPS = 1e-6;

/** WASD パン対象キー。 */
const PAN_KEYS = new Set(["w", "a", "s", "d"]);

/** 低高度（地表付近）の背景色（青空）。`scene.clearColor` の初期値と一致。 */
const DAY_SKY_COLOR = new Color3(0.75, 0.86, 0.95);
/** 高高度（宇宙空間）の背景色（黒）。 の高度連動暗化の到達点。 */
const SPACE_SKY_COLOR = new Color3(0, 0, 0);

/**
 * 最大チルト[deg]（pitch 上限,  UX ガード）。完全水平（90°=地平線真正面）では
 * 可視域がほぼ全て遠距離になり、距離適応ルートレベルでも被覆が退化しやすい。実用上の上限で
 * クランプし、ほぼ水平までは許しつつ完全水平の退化を抑止する。
 */
const MAX_TILT_DEG = 89;

/**
 * 地形クリックピック・ズームターゲット計算（resolveTerrainClickElevationToRef）で想定する
 * 地形標高の上限 [m]。国内最高峰（富士山 3776m）に安全マージンを加えた値。レイマーチングの
 * 手前側（探索開始点）を決めるため、実際の地表がこれを超えると貫通検出できない側に倒れる。
 */
const TERRAIN_CLICK_MAX_ELEV_M = 5000;

/**
 * 同上。粗い探索の目標ステップ間隔 [m]。地形標高データの水平解像度（geomMaxZoom=z15、
 * 256px タイルで日本付近は 1px あたり約4〜5m）に対する安全マージン。これより粗いと、
 * 幅の狭い稜線をステップが飛び越えて検出漏れし、山を貫通し得る。
 */
const TERRAIN_CLICK_STEP_DISTANCE_M = 5;

/** 同上。探索区間が短い場合でも確保する最低ステップ数。 */
const TERRAIN_CLICK_MIN_COARSE_STEPS = 20;

/** 同上。探索区間が長大でも計算量を頭打ちにするステップ数上限。 */
const TERRAIN_CLICK_MAX_COARSE_STEPS = 300;

/** 同上。粗い探索で見つけた区間を絞り込む二分探索の反復数。 */
const TERRAIN_CLICK_REFINE_ITERATIONS = 6;

/**
 * ズーム中の毎フレーム向き補正で、レイマーチングの地表検出が稜線境界付近でちらついて失敗した
 * フレームでも、直近に採用した実在の地表点を再利用してよい最大経過時間 [ms]。山岳地帯を水平
 * チルトでズームすると true/false が数フレーム断続的に切り替わり、補正が停止する間にネイティブ
 * ズームのフレーム結合誤差が蓄積して終了間際にスナップする。数フレーム相当（60fps で ~6 フレーム）
 * の間は直近の成功点で補正を継続し、それを超えて失敗が続く場合は保持を破棄して補正を止める
 * （古い点の再利用でカメラが的外れな向きへ寄るのを防ぐ）。
 */
const RECALC_CENTER_HOLD_MS = 100;

/**
 * 地球楕円体スフィア（背景＋地平線リファレンス）を海面より沈める量 [m]。
 * 地形（標高>=0）との z-fighting はスフィアの深度書き込み無効化（disableDepthWrite, 後述）で
 * 原理的に解消する。
 *
 * 沈め量は、常時表示ベースレイヤ（z2 タイル）のメッシュが真球面から内側へたるむ量
 * （96 分割で最大 ~430m）より十分深くする。さもないと高高度・水平チルトの地平線（limb）で、
 * ベースのテクスチャ面より外側に背景球が張り出して縁が青く透ける。1500m はそのたるみ量に対する
 * 安全マージンで、地平線をベース（テクスチャ）が覆い、背景球はその背面（極域・宇宙側の背景）に退く。
 * R≈6378km に対し 1500m は ~0.02% で、地平線の見かけ位置への影響は無視できる。
 */
const EARTH_SPHERE_SINK_M = 1500;

/**
 * 背景スフィアのレンダリンググループ。地形・地物と同じ既定グループ(0)に置きつつ、
 * スフィアのマテリアルを **深度書き込み無効（disableDepthWrite）** にすることで、地形/オーバーレイ
 * の深度セマンティクス（ポリゴン/サークルは地形と深度共有して交差、マーカーは group 1 で手前）を
 * 一切変えずに z-fighting を回避する。スフィアは深度を書かない純粋な背景として描画され、地形が
 * 存在する画素では地形の深度に負けて隠れ、地形が無い画素（no-data/視界の穴）だけ塗られる。
 */
const RG_BACKGROUND = 0;

export interface GlobeSceneInitOptions {
    /** 初期注視点の緯度 [deg]。 */
    lat?: number;
    /** 初期注視点の経度 [deg]。 */
    lon?: number;
    /** root（最低）ズーム。 */
    minZoom?: number;
    /** カメラ距離 [m]（高度相当）。 */
    radius?: number;
    /** 初期方位 [deg]。 */
    azimuth?: number;
    /** 初期チルト [deg]。 */
    tilt?: number;
    /** 地図種別。 */
    mapType?: MapType;
    /** クロスレベル標高スナップを有効化するか（既定 true）。 */
    snapEnabled?: boolean;
    /**
     * ユーザーによるマップのパン操作（左ドラッグ / WASD キーボード）を有効にするか（既定 true）。
     * `false` の場合は組み込みのドラッグパン・WASD パンを無効化する（回転・ズームは有効のまま）。
     * カメラを外部（例: アバター追従）から駆動するデモで、組み込みパンとの競合を避けるために使う。
     */
    enablePan?: boolean;
    /**
     * WASD キーボードによるマップのパン操作を有効にするか（既定 true）。
     * `false` の場合は WASD パンのみ無効化する（左ドラッグパン・回転・ズームは有効のまま）。
     * WASD を独自操作に使うデモ（avatar-controller など）で組み込み WASD パンとの競合を避けるために使う。
     */
    enableKeyboardPan?: boolean;
    /** 同期統計のコールバック（情報表示・テスト用）。 */
    onSyncStats?: (stats: GlobeSceneSyncInfo) => void;
    /**
     * 初期視点モード。`"2d"` で Web メルカトル相当のトップダウン正射表示
     * （高度なし・物理なし・skymap なし・日照なし・オーバーレイ縮退）。既定 `"3d"`。
     */
    viewMode?: ViewMode;
    /**
     * 2D 時の初期ズームレベル（Google Maps 互換）。指定時は `camera.radius` へ変換する。
     * 3D 時は無視する。
     */
    zoomLevel?: number;
    /** `viewMode` が実際に変化した際に呼ばれるコールバック。 */
    onViewModeChange?: (viewMode: ViewMode) => void;
}

/** 同期統計 + カメラ状態。 */
export interface GlobeSceneSyncInfo extends GlobeTileSyncStats {
    /** 注視点の緯度 [deg]。 */
    latDeg: number;
    /** 注視点の経度 [deg]。 */
    lonDeg: number;
    /** カメラ距離 [m]。 */
    radius: number;
    /** yaw [rad]。 */
    yaw: number;
    /** pitch [rad]。 */
    pitch: number;
}

/**
 * 地形クリックイベント（globe 版）。`scene.pick` 非依存で求めた緯度経度・標高・ECEF 交点を持つ。
 * 公開 `TerrainClickEvent`（lib/types）と構造互換で、アダプタ（globeSceneController）が橋渡しする。
 */
export interface GlobeTerrainClickEvent {
    /** クリック地点の緯度 [deg]。 */
    lat: number;
    /** クリック地点の経度 [deg]。 */
    lon: number;
    /** クリック地点の標高 [m]（地形標高。取得不可時は楕円体高）。 */
    altitude: number;
    /** 真の ECEF 交点 [m]（floating origin のレンダリング座標ではない）。 */
    world: { x: number; y: number; z: number };
    /** 元の `PointerEvent`。 */
    pointerEvent: PointerEvent;
}

export type GlobeTerrainClickListener = (event: GlobeTerrainClickEvent) => void;

/**
 * ポリゴン頂点ポインタイベント（globe 版）。公開 `PolygonPointPointerEvent`（lib/types）と
 * 構造互換で、アダプタ（globeSceneController）が橋渡しする。
 */
export interface GlobePolygonPointEvent {
    /** 対象ポリゴンの id。 */
    polygonId: string;
    /** 対象頂点の index（0-based）。 */
    index: number;
    /** 元の `PointerEvent`。 */
    pointerEvent: PointerEvent;
}

/**
 * ポリゴン頂点ドラッグイベント（globe 版）。公開 `PolygonPointDragEvent` と構造互換。
 * 各幾何量は floating origin 非依存に真の ECEF レイ × 楕円体/垂直線で求める。
 */
export interface GlobePolygonPointDragEvent extends GlobePolygonPointEvent {
    /** カーソル位置の地形交点の緯度（ヒットなし null）。 */
    lat: number | null;
    /** カーソル位置の地形交点の経度（ヒットなし null）。 */
    lon: number | null;
    /** カーソル位置の地表標高 [m]（ヒットなし null）。 */
    groundAltitude: number | null;
    /** ドラッグ開始時の頂点高度を保つ面とカーソルレイの交点の緯度（得られない場合 null）。 */
    planeLat: number | null;
    /** 同経度（得られない場合 null）。 */
    planeLon: number | null;
    /** 頂点の鉛直線とカーソルレイ最近接点の標高 [m]（得られない場合 null）。 */
    pointerAltitude: number | null;
}

export type GlobePolygonPointListener = (
    event: GlobePolygonPointEvent | null,
) => void;
export type GlobePolygonPointClickListener = (
    event: GlobePolygonPointEvent,
) => void;
export type GlobePolygonPointDragListener = (
    event: GlobePolygonPointDragEvent,
) => void;

export interface GlobeSceneController {
    scene: Scene;
    camera: GeospatialCamera;
    tileManager: GlobeTileManager;
    /** グローブ用マーカー。接地・地心 up ポール・カメラ正対ラベル。 */
    markerManager: GlobeMarkerManager;
    /** グローブ用ポリゴン。接地アウトライン・地心 up カーテン壁。 */
    polygonManager: GlobePolygonManager;
    /** グローブ用サークル。中心+半径の円を閉ポリゴンとして描画。 */
    circleManager: GlobeCircleManager;
    /** グローブ用モデル。glb/gltf を接地し地心 up へ起立。 */
    modelManager: GlobeModelManager;
    /** 太陽光（指向性ライト）。時刻連動の太陽方向駆動に用いる。 */
    sunLight: DirectionalLight;
    /** 環境光（半球ライト）。強度は時刻に依らず一定（昼夜の境界は指向性ライトの幾何で表現）。 */
    hemiLight: HemisphericLight;
    /** 太陽メッシュ（発光球）。時刻連動で太陽方向に配置・表示する。 */
    sunMesh: Mesh;
    /**
     * 時刻連動の背景（skybox）基調色。`scene.clearColor` は毎フレーム
     * この色から `SPACE_SKY_COLOR`（宇宙黒）へ高度連動で lerp して決まる。
     * 太陽位置に応じた更新は controller（globeSceneController）が `deriveSkyColor` で行う。
     */
    skyBaseColor: Color3;
    /**
     * 地形クリック購読（pick 非依存・floating origin 対応）。クリック地点の緯度経度・標高を
     * リスナーへ通知する。戻り値で購読解除する。
     */
    subscribeTerrainClick: (listener: GlobeTerrainClickListener) => () => void;
    /** ポリゴン頂点 hover 購読（pick 非依存）。hover 開始/切替でイベント、解除で null。 */
    subscribePolygonPointHover: (
        listener: GlobePolygonPointListener,
    ) => () => void;
    /** ポリゴン頂点 click 購読（pick 非依存）。 */
    subscribePolygonPointClick: (
        listener: GlobePolygonPointClickListener,
    ) => () => void;
    /** ポリゴン頂点ドラッグ開始購読（pick 非依存）。 */
    subscribePolygonPointDragStart: (
        listener: GlobePolygonPointDragListener,
    ) => () => void;
    /** ポリゴン頂点ドラッグ中購読（pick 非依存）。 */
    subscribePolygonPointDrag: (
        listener: GlobePolygonPointDragListener,
    ) => () => void;
    /** ポリゴン頂点ドラッグ終了購読（pick 非依存）。 */
    subscribePolygonPointDragEnd: (
        listener: GlobePolygonPointDragListener,
    ) => () => void;
    /** 現在の視点モード ("3d" | "2d") を返す。 */
    getViewMode: () => ViewMode;
    /** 視点モードを切り替える。実変化時のみ `onViewModeChange` を発火する。 */
    setViewMode: (mode: ViewMode) => void;
    /**
     * 2D 時のみ現在のズームレベル（Google Maps 互換）を返す。3D 時は undefined。
     */
    getZoomLevel: () => number | undefined;
    /**
     * 外部カメラ（flight FollowCamera 等）の真の視錐台6平面＋ECEF位置を次回 syncTiles に
     * 反映する（#463）。null 指定で通常カメラ（GeospatialCamera）算出へ復帰する。
     */
    setExternalFrustum: (planes: FrustumPlane[] | null, cameraEcef: Vector3 | null) => void;
    dispose: () => void;
}

/**
 * グローブ地形シーンを生成する。
 */
export class GlobeScene {
    async createScene(
        engine: AbstractEngine,
        canvas: HTMLCanvasElement,
        options: GlobeSceneInitOptions = {},
    ): Promise<Scene> {
        const { scene } = this.createSceneWithController(engine, canvas, options);
        return scene;
    }

    /**
     * シーンとコントローラ（dispose 等）を返す。デモ・テストから内部へアクセスする用途。
     */
    createSceneWithController(
        engine: AbstractEngine,
        canvas: HTMLCanvasElement,
        options: GlobeSceneInitOptions = {},
    ): GlobeSceneController {
        const lat = options.lat ?? GLOBE_SCENE_DEFAULTS.lat;
        const lon = options.lon ?? GLOBE_SCENE_DEFAULTS.lon;
        const minZoom = options.minZoom ?? GLOBE_SCENE_DEFAULTS.minZoom;
        const radius = options.radius ?? GLOBE_SCENE_DEFAULTS.radius;
        const azimuth = options.azimuth ?? GLOBE_SCENE_DEFAULTS.azimuth;
        const tilt = options.tilt ?? GLOBE_SCENE_DEFAULTS.tilt;
        const mapType: MapType = options.mapType ?? "std";
        const snapEnabled = options.snapEnabled ?? true;
        // ユーザーパン（左ドラッグ / WASD）を有効にするか。外部からカメラを駆動する
        // デモ（アバター追従など）では false にして組み込みパンとの競合を避ける。
        const panEnabled = options.enablePan !== false;
        // WASD キーボードパンの個別ゲート。ドラッグパンは有効のまま WASD だけ無効化したい
        // デモ（avatar-controller）のために enablePan とは別に制御する。
        const keyboardPanEnabled = options.enableKeyboardPan !== false;

        // Large World Rendering: 真の ECEF（百万 m オーダー）でも精度を保つため floating origin を有効化。
        // これだけでは不十分で、行列を float64 にする high precision matrix を **engine 側**で
        // 有効化する必要がある（engineFactory が globe シーン生成時に
        // useHighPrecisionMatrix を渡す）。両方揃って初めてジッターのない large world になる。
        const scene = new Scene(engine, { useFloatingOrigin: true });
        scene.clearColor = new Color4(0.75, 0.86, 0.95, 1);
        // EcefFromLatLonAltToRef は常に右手系 ECEF（X→経度0, Y→東経90°, Z→北極）を出力し、
        // GeospatialCamera も scene.useRightHandedSystem を前提に視点を組む。既定の左手系の
        // ままだと右手系データを鏡像で見るため東西が反転する。右手系に揃える。
        scene.useRightHandedSystem = true;

        // GeospatialCamera: world 原点中心の球体惑星を周回する。
        const camera = new GeospatialCamera("globe-camera", scene, {
            planetRadius: Wgs84Ellipsoid.semiMajorAxis,
        });

        // 初期注視点（地表上の lat/lon）を真の ECEF として center に設定する。
        const centerEcef = geodeticToEcef(lat, lon, 0);
        camera.center = centerEcef;
        camera.radius = radius;
        // 既存 UI の azimuth/tilt[deg] を yaw/pitch[rad] にマッピングして初期化。
        // 完全水平の退化を避けるため pitch 上限を MAX_TILT_DEG にクランプする（UX ガード）。
        // GeospatialCamera 組み込みの limits.pitchMax がドラッグ操作にも適用される。
        camera.limits.pitchMax = MAX_TILT_DEG * DEG2RAD;
        camera.yaw = azimuth * DEG2RAD;
        camera.pitch = Math.min(tilt, MAX_TILT_DEG) * DEG2RAD;

        // near/far の自動調整（高度に応じた depth 精度最適化）。
        camera.addBehavior(new GeospatialClippingBehavior());
        camera.attachControl(true);

        // 2本指タッチジェスチャは独自実装（ひねり=yaw / 平行移動=pan / 近接時=tilt。後述の
        // pointer handler）に置き換えるため、GeospatialCamera 組み込みの multi-touch パン
        // （= 2本指ドラッグでの tilt 回転）を無効化する。ピンチによるズームは温存する（pinchZoom）。
        for (const name of Object.keys(camera.inputs.attached)) {
            const input = camera.inputs.attached[name] as unknown as {
                multiTouchPanning?: boolean;
                multiTouchPanAndZoom?: boolean;
            };
            if (typeof input.multiTouchPanning === "boolean") {
                input.multiTouchPanning = false;
                input.multiTouchPanAndZoom = false;
            }
        }

        // zoom-to-cursor（カーソル下の地点へ寄るズーム）を有効化する。ネイティブ実装は
        // ホイール毎に scene.pick でカーソル下の点を取り直すが、floating origin 下では
        // レンダリング座標と真の ECEF メッシュ位置がずれてピックが毎回ブレ、ズームが揺れる。
        // そこで後段で handleZoom を差し替え、目標点を scene.pick 非依存の「真の ECEF カメラ位置
        // からのレイ × 地表楕円体（WGS84 + centerElevation）」の幾何交点で固定する。加えてズーム中
        // （ホイール〜慣性減衰）は seat-on-terrain を一時停止し、鉛直方向の引っ張り合い（揺れの主因）を断つ。
        camera.movement.zoomToCursor = true;

        // GeospatialCamera 内部の scene.pick を無効化しつつ、ズーム後の向き補正は温存する（揺れ修正）。
        // ネイティブカメラは複数箇所で scene.pick / PickWithRay を使う:
        //   1) startDrag（左ドラッグの開始でドラッグ平面を作る）
        //   2) handleZoom（カーソル下の点を取り直しズーム目標にする）
        //   3) _recalculateCenter の pickAlongVector（ズーム/パン後に center を地表へ再スナップし、
        //      かつ lookAt（ワールド注視方向）から yaw/pitch を**再計算**して向きを保つ）
        // floating origin 下では 1)2) のピックが真の ECEF メッシュ位置とずれてブレるため無効化する。
        // 一方 3) はズーム時の「揺れ補正」の要である: zoomToPoint は yaw/pitch を数値的に据え置いた
        // まま center を動かすため、center のローカル ENU フレームが回転し、特に真下チルトでは同じ
        // yaw が別方位を指して南北東西に振れる（フレーム結合誤差）。_recalculateCenter はズーム確定時に
        // lookAt から yaw/pitch を引き直してこの誤差を打ち消す。したがって 3) は**無効化してはならない**。
        // そこで pickPredicate=false で 1)2) 系の PickWithRay を不活性化しつつ、3) が使う
        // pickAlongVector のみを floating-origin 非依存の幾何交点（真の ECEF カメラ位置 × WGS84 楕円体）に
        // 差し替え、scene.pick に頼らず向き補正を機能させる（前回 pickPredicate=false だけでは
        // pickAlongVector が null を返し補正が止まって揺れが残っていた）。
        camera.movement.pickPredicate = () => false;

        // ---- picking 非依存パン（左ドラッグ / WASD） ----
        // 既定の pan（左ドラッグ/キーボード）は scene.pick でグローブをヒットしてドラッグ平面を
        // 作るが、useFloatingOrigin 下ではレンダリング座標と真の ECEF メッシュ位置がずれて
        // ピックが外れ機能しない。floating origin（の精度要件）を維持するため、
        // camera.center を地表接線方向へ動かす独自パンを実装する。
        const pressed = new Set<string>();
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
        // 押下状態のリセット。フォーカス喪失/タブ切替中は keyup が届かず押下が残り続け、
        // 復帰後に意図せずパンし続けるのを防ぐ（blur / 非表示で全解除）。
        const clearPressed = (): void => pressed.clear();
        const onVisibilityChange = (): void => {
            if (document.hidden) pressed.clear();
        };
        // keydown/keyup は canvas に付ける（グローバルなキー入力の横取りを避ける）。canvas が
        // フォーカス可能でない/未フォーカスだとキーを拾えないため、tabIndex を確保し pointerdown
        // 時にフォーカスする（呼び出し側の設定に依存せずシーン単体でも WASD が機能する）。
        if (canvas.tabIndex < 0) canvas.tabIndex = 0;
        canvas.addEventListener("keydown", onKeyDown);
        canvas.addEventListener("keyup", onKeyUp);
        canvas.addEventListener("blur", clearPressed);
        window.addEventListener("blur", clearPressed);
        document.addEventListener("visibilitychange", onVisibilityChange);

        // 左ドラッグ状態。
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        // アクティブなタッチポインタの現在位置（clientX/Y）。2本指ジェスチャ（ピンチ/ひねり/平行移動）
        // と、2本指以上の間のシングルタッチパン抑止に使う。キー = pointerId。
        const touchPoints = new Map<number, { x: number; y: number }>();
        // 2本指ジェスチャのモード。最初の2本指 move 時に指の間隔で確定し、指を離す（2本未満に
        // なる）まで維持する。途中で間隔がしきい値を跨いでもモードを切り替えない（誤切替防止）。
        let twoFingerMode: "tilt" | "panRotate" | null = null;
        // ---- ポリゴン頂点インタラクション状態 ----
        // パン handler（onPointerDown/Move）から参照するため早期に宣言する。実体の購読 API・
        // 幾何ピック・ドラッグハンドラはカメラ/レイ補助関数（後述）の後で定義・遅延登録する。
        let polygonPointGesture: {
            pointerId: number;
            polygonId: string;
            index: number;
            startClientX: number;
            startClientY: number;
            dragging: boolean;
            /** ドラッグ開始時の頂点 ECEF 位置（複製。manager の top[] は毎フレーム更新されるため）。 */
            startWorld: Vector3;
            /** ドラッグ開始時の頂点測地高度 [m]（水平面交点の基準）。 */
            startAltMeters: number;
        } | null = null;
        const onPointerDown = (e: PointerEvent): void => {
            canvas.focus(); // WASD のためにフォーカスを確保（右/左/中ボタンいずれでも）
            if (e.pointerType === "touch") {
                touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
                // 2本指以上はマルチタッチジェスチャ（ピンチ/ひねり/平行移動）。進行中の独自シングル
                // タッチパンを打ち切り、以降は 2本指ハンドラに委ねる。
                if (touchPoints.size >= 2) {
                    dragging = false;
                    return;
                }
            }
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            canvas.setPointerCapture?.(e.pointerId);
        };
        const endDrag = (): void => {
            dragging = false;
        };
        // touchPoints の先頭要素（残り1本指の現在位置）を返す。
        const firstTouchPoint = (): { x: number; y: number } | undefined => {
            const it = touchPoints.values().next();
            return it.done ? undefined : it.value;
        };
        const onPointerUp = (e: PointerEvent): void => {
            if (e.pointerType === "touch") {
                touchPoints.delete(e.pointerId);
                if (touchPoints.size < 2) twoFingerMode = null;
                // 2本→1本: 残った指は接地済みで pointerdown が来ないため、ここで
                // シングルタッチパンを残指の現在位置から継続できるよう再初期化する
                // （しないと全指を離すまでパン不可になる）。
                if (touchPoints.size === 1) {
                    const remaining = firstTouchPoint();
                    if (remaining) {
                        dragging = true;
                        lastX = remaining.x;
                        lastY = remaining.y;
                    }
                    return;
                }
            }
            if (e.button === 0) endDrag();
        };
        const onPointerCancel = (e: PointerEvent): void => {
            if (e.pointerType === "touch") {
                touchPoints.delete(e.pointerId);
                if (touchPoints.size < 2) twoFingerMode = null;
                // onPointerUp と同契約: 2本→1本になったら残指でパンを継続する。
                if (touchPoints.size === 1) {
                    const remaining = firstTouchPoint();
                    if (remaining) {
                        dragging = true;
                        lastX = remaining.x;
                        lastY = remaining.y;
                    }
                    return;
                }
            }
            endDrag();
        };
        // パン用の再利用バッファ（毎フレーム/毎 move 呼び出しでの割当を避ける）。
        const dragRight = new Vector3();
        const dragFwd = new Vector3();
        const dragLookAt = new Vector3();
        const tangent = new Vector3();
        const panned = new Vector3();

        /**
         * 画面上の (dx, dy) [px] 分だけ「マップを掴んで引く」パンを行う（center を地表接線方向へ移動）。
         * シングルタッチ／マウスドラッグと、2本指の平行移動の双方から共用する。
         */
        const panByPixels = (dx: number, dy: number): void => {
            if (dx === 0 && dy === 0) return;
            // カメラ→center 方向(lookAt)から地表接線の右・前方向を作る。
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                dragLookAt,
            );
            if (!cameraTangentBasisToRef(camera.center, dragLookAt, dragRight, dragFwd)) {
                return; // 真下視点の特異点
            }
            // 注視点距離での地表 m/px（掴んだ点がほぼカーソル追従する縮尺）。
            const fovHeightM = 2 * camera.radius * Math.tan(camera.fov / 2);
            const mpp = fovHeightM / Math.max(1, canvas.clientHeight);
            // マップを掴んで引く挙動: 右ドラッグ→center 西（content 右へ）、下ドラッグ→center 北（前方）。
            tangent.copyFrom(dragRight).scaleInPlace(-dx * mpp);
            tangent.addInPlace(dragFwd.scaleInPlace(dy * mpp));
            // 極付近の高速回転を抑える。極では東西の一定メートル移動が経度の巨大変化に対応する。
            tangent.scaleInPlace(polePanSpeedMultiplier(camera.center, camera.radius));
            camera.center = panCenterOnSphereToRef(camera.center, tangent, panned);
        };

        // ---- 2本指ジェスチャ（タッチ）パラメータ ----
        // 指の間隔がこの値[px]未満なら「近い」とみなしチルト、以上なら移動＋回転に切り替える。
        const TWO_FINGER_TILT_SPREAD_PX = 160;
        // 重心の縦移動[px] → pitch[rad] 係数（チルト感度）。
        const TWO_FINGER_TILT_SENS = 0.005;
        // 指の「ひねり」角[rad] → yaw[rad] 係数（回転感度）。
        const TWO_FINGER_YAW_SENS = 1.0;
        const MIN_PITCH_RAD = 0;
        const MAX_PITCH_RAD = MAX_TILT_DEG * DEG2RAD;

        /**
         * 2本指タッチの 1 ステップ分のジェスチャを適用する。
         * - 指の間隔が近い（< TWO_FINGER_TILT_SPREAD_PX）: 重心の縦移動でチルト（pitch）。
         * - 指の間隔が離れている: 重心移動で平行移動（pan）＋ 指のひねりで方位回転（yaw）。
         * ピンチ（間隔変化）によるズームは GeospatialCamera 側が別途処理する。
         */
        const handleTwoFingerMove = (
            movedId: number,
            prev: { x: number; y: number },
            now: { x: number; y: number },
        ): void => {
            let other: { x: number; y: number } | undefined;
            for (const [id, p] of touchPoints) {
                if (id !== movedId) {
                    other = p;
                    break;
                }
            }
            if (!other) return;

            // 指のひねり角の差分（前フレーム→現フレーム）。
            const angPrev = Math.atan2(prev.y - other.y, prev.x - other.x);
            const angNow = Math.atan2(now.y - other.y, now.x - other.x);
            let dAng = angNow - angPrev;
            if (dAng > Math.PI) dAng -= 2 * Math.PI;
            else if (dAng < -Math.PI) dAng += 2 * Math.PI;

            // 現在の指の間隔。
            const spread = Math.hypot(now.x - other.x, now.y - other.y);

            // モードは最初の2本指 move 時に確定し、指を離すまで維持（しきい値の跨ぎで切替えない）。
            if (twoFingerMode === null) {
                twoFingerMode = spread < TWO_FINGER_TILT_SPREAD_PX ? "tilt" : "panRotate";
            }

            // 2本指の重心移動（前フレーム→現フレーム）。動いたのは movedId の指のみ。
            const dCx = (now.x - prev.x) / 2;
            const dCy = (now.y - prev.y) / 2;

            if (twoFingerMode === "tilt") {
                // チルト。上方向ドラッグ（dCy<0）でチルトアップ（pitch 増）。limits 範囲にクランプ。
                const next = camera.pitch - dCy * TWO_FINGER_TILT_SENS;
                camera.pitch = Math.min(MAX_PITCH_RAD, Math.max(MIN_PITCH_RAD, next));
            } else {
                // 平行移動 ＋ 回転（ひねり）。
                if (panEnabled) panByPixels(dCx, dCy);
                if (dAng !== 0) camera.yaw = camera.yaw - dAng * TWO_FINGER_YAW_SENS;
            }
        };

        const onPointerMove = (e: PointerEvent): void => {
            // ポリゴン頂点ジェスチャ進行中はパンしない。ドラッグ処理は専用 handler が行う。
            if (
                polygonPointGesture &&
                polygonPointGesture.pointerId === e.pointerId
            ) {
                return;
            }
            // タッチの位置追跡を更新し、2本指以上なら 2本指ハンドラへ委譲（シングルパンはしない）。
            if (e.pointerType === "touch" && touchPoints.has(e.pointerId)) {
                const prev = touchPoints.get(e.pointerId)!;
                const now = { x: e.clientX, y: e.clientY };
                touchPoints.set(e.pointerId, now);
                if (touchPoints.size >= 2) {
                    handleTwoFingerMove(e.pointerId, prev, now);
                    return;
                }
            }
            if (!dragging) return;
            if (!panEnabled) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            panByPixels(dx, dy);
        };
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", onPointerCancel);
        canvas.addEventListener("pointermove", onPointerMove);

        /**
         * 押下中の WASD に応じて center を **カメラの向き（前/右）基準** で高度比例移動する。
         * 視点を回転（yaw 変更）すると前方向も追従し、左ドラッグパンと一貫した操作になる
         * （北固定ではなく「画面で奥が W」）。真下視点では前後左右が定義できないためスキップ。
         */
        const applyKeyboardPan = (): void => {
            if (!panEnabled || !keyboardPanEnabled) return;
            if (pressed.size === 0) return;
            let fwd = 0;
            let side = 0;
            if (pressed.has("w")) fwd += 1;
            if (pressed.has("s")) fwd -= 1;
            if (pressed.has("d")) side += 1;
            if (pressed.has("a")) side -= 1;
            if (fwd === 0 && side === 0) return;
            // カメラ→center 方向(lookAt)から地表接線の右・前を作り、視点回転に追従させる。
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                dragLookAt,
            );
            if (!cameraTangentBasisToRef(camera.center, dragLookAt, dragRight, dragFwd)) {
                return; // 真下視点の特異点
            }

            const dtSec = Math.min(0.05, engine.getDeltaTime() / 1000);
            const step = camera.radius * PAN_RATE_PER_SEC * dtSec;
            tangent.copyFrom(dragFwd).scaleInPlace(fwd);
            tangent.addInPlace(dragRight.scaleInPlace(side));
            if (tangent.lengthSquared() < 1e-12) return;
            tangent.normalize().scaleInPlace(step);
            // 極付近の高速回転を抑える。左ドラッグパンと同一の減速を WASD にも適用する。
            tangent.scaleInPlace(polePanSpeedMultiplier(camera.center, camera.radius));
            camera.center = panCenterOnSphereToRef(camera.center, tangent, panned);
        };

        // ライト: 地表の up（地心法線）を基準に環境光 + 斜め方向の指向性ライト。
        const up = centerEcef.clone().normalize();
        const hemi = new HemisphericLight("globe-hemi", up, scene);
        hemi.intensity = 0.55;
        hemi.groundColor = new Color3(0.3, 0.32, 0.3);
        const ref = Math.abs(up.y) < 0.99 ? Vector3.Up() : Vector3.Right();
        const east = Vector3.Cross(ref, up).normalize();
        const sunDir = up.scale(-0.85).add(east.scale(0.5)).normalize();
        const sun = new DirectionalLight("globe-sun", sunDir, scene);
        sun.intensity = 0.7;

        // ---- 地球楕円体スフィア（背景 / 地平線リファレンス） ----
        // DEM no-data（海上など）でタイルメッシュが生成されない領域や、距離適応 root の外側で
        // 視界が「宇宙へ抜ける穴」になるのを防ぎ、地平線を可視化する WGS84 楕円体のソリッド球。
        // floating origin 下でもタイルメッシュと同じ真の ECEF 系なので、地球中心（原点）に静止
        // 配置すればよい。極（ECEF Z 軸）方向のみ semiMinorAxis で扁平させ、海面より僅かに沈める。
        const earthSink = EARTH_SPHERE_SINK_M;
        const earth = CreateSphere("globe-earth", { diameter: 2, segments: 128 }, scene);
        // 単位球（半径 1）を楕円体半径へスケール。ECEF の極は Z 軸なので Z のみ扁平。
        earth.scaling.set(
            Wgs84Ellipsoid.semiMajorAxis - earthSink,
            Wgs84Ellipsoid.semiMajorAxis - earthSink,
            Wgs84Ellipsoid.semiMinorAxis - earthSink,
        );
        earth.isPickable = false;
        earth.renderingGroupId = RG_BACKGROUND;
        const earthMat = new StandardMaterial("globe-earth-mat", scene);
        earthMat.diffuseColor = new Color3(0.16, 0.26, 0.36); // 海の濃い青
        earthMat.specularColor = new Color3(0.02, 0.02, 0.02);
        earthMat.emissiveColor = new Color3(0.03, 0.05, 0.08); // 夜側でも輪郭が出る程度
        earthMat.backFaceCulling = true;
        // 深度書き込みを無効化して純粋な背景にする（地形/オーバーレイの深度を一切汚さない）。
        // スフィアは深度テストはするが書かないため、地形が存在する画素では地形に負けて隠れ、
        // 地形が無い画素だけ塗られる。両者が深度を書き合わないので z-fighting が起きず、描画順に
        // 依存しない。海面より僅かに沈めた earthSink は、深度等値での取り合いを避ける保険。
        earthMat.disableDepthWrite = true;
        earth.material = earthMat;

        // ---- 太陽メッシュ遮蔽用の深度オンリー楕円体 ----
        // 背景球・ベースレイヤは深度を書かない（disableDepthWrite, 上記 / globeTileManager）ため、
        // 広域ズームでは地球が深度バッファへ寄与せず、太陽メッシュ（後段）が地球の裏側にあっても深度
        // テストで隠れない。そこで「色を書かず深度のみ書く」ソリッド楕円体を地球と同位置に重ね、太陽を
        // 地球シルエットで画素単位に遮蔽する（地球の縁(limb)で太陽ディスクが滑らかに欠ける）。
        // 色を書かない（disableColorWrite）ので見た目は不変。太陽メッシュと同じく地形と同一グループ
        // （RG_BACKGROUND）に置くことが重要で、これにより低高度では実際の地形タイル（深度を書く LOD）が
        // 太陽を遮蔽し、太陽が地面の手前へ突き抜けて見えるのを防ぐ。広域ズームでは地形タイルが深度を
        // 書かない（ベースレイヤ）ため、このオクルーダが地球シルエットを供給する。
        // オクルーダ深度が背景球・ベースレイヤ（同じ半径・深度非書き込み）と等深度で争い、広域ズームの
        // 低い深度精度で z-fighting（背景の青球がチラつく）するのを防ぐため、zOffset でオクルーダの
        // 深度をわずかに奥へバイアスする。これにより背景球/ベースレイヤが常に手前に描かれて勝つ（チラつき
        // 解消）一方、はるか遠方（far クリップ手前）の太陽より十分手前に留まるため遮蔽は維持される。
        // RG_BACKGROUND 内では不透明メッシュはマテリアルの uniqueId 昇順で描画される（Babylon
        // PainterSortCompare）。この occluder のマテリアルを太陽メッシュより先に生成することで occluder が
        // 先に深度を書き、続く太陽が深度テストで正しく遮蔽される。
        const sunOccluder = CreateSphere(
            "globe-sun-occluder",
            { diameter: 2, segments: 128 },
            scene,
        );
        sunOccluder.scaling.copyFrom(earth.scaling);
        sunOccluder.isPickable = false;
        sunOccluder.renderingGroupId = RG_BACKGROUND;
        const sunOccluderMat = new StandardMaterial("globe-sun-occluder-mat", scene);
        sunOccluderMat.disableLighting = true;
        sunOccluderMat.backFaceCulling = true;
        // 色は一切書かず深度のみ書く（不可視のオクルーダ）。depthWrite は既定で有効。
        sunOccluderMat.disableColorWrite = true;
        // 等深度の背景球/ベースレイヤより確実に「奥」に居させ z-fighting を避ける（上記コメント参照）。
        sunOccluderMat.zOffset = 8;
        sunOccluder.material = sunOccluderMat;

        // 太陽メッシュ。発光する球を planar 同様に infiniteDistance で配置する。
        // infiniteDistance 有効時、Babylon は毎フレーム mesh.position にカメラのワールド位置を
        // 加算してワールド位置を決める（transformNode: position + cameraWorldPosition）。
        // よって mesh.position に太陽方向ベクトル×距離を設定すれば、floating origin の
        // 座標リベースに影響されずカメラ相対で常に太陽方向の空へ描画される。地球による遮蔽は上記
        // occluder の深度で画素単位に処理する。時刻連動の位置/スケール/表示は globeSceneController。
        // occluder と同じ RG_BACKGROUND に置き、マテリアルは occluder より後に生成する（描画順を保証）。
        // 太陽は地形と同一グループの共有深度で描かれるため、occluder（地球シルエット）と実際の地形タイル
        // （深度を書く LOD）の双方に画素単位で遮蔽される。マーカー等（group 1）は太陽より後に描かれるので
        // 常に太陽の手前に表示される。
        const sunMesh = CreateSphere(
            "globe-sun-mesh",
            { diameter: 1, segments: 12 },
            scene,
        );
        const sunMeshMat = new StandardMaterial("globe-sun-mesh-mat", scene);
        sunMeshMat.emissiveColor = new Color3(1, 0.95, 0.8);
        sunMeshMat.disableLighting = true;
        sunMesh.material = sunMeshMat;
        sunMesh.isPickable = false;
        sunMesh.infiniteDistance = true;
        sunMesh.renderingGroupId = RG_BACKGROUND;
        // infiniteDistance 利用時はフラスタムカリングの取りこぼしを避けて常時アクティブ化する。
        sunMesh.alwaysSelectAsActiveMesh = true;
        sunMesh.setEnabled(false);

        // ---- 地形タイルマネージャ ----
        const tileManager = createGlobeTileManager({
            scene,
            mapType,
            minZoom,
            geomMaxZoom: GLOBE_SCENE_DEFAULTS.geomMaxZoom,
            segments: GLOBE_SCENE_DEFAULTS.segments,
            snapEnabled,
        });

        // ---- グローブマーカー ----
        const markerManager = createGlobeMarkerManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });
        // ---- グローブポリゴン ----
        const polygonManager = createGlobePolygonManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });
        // ---- グローブサークル ----
        const circleManager = createGlobeCircleManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });
        // ---- グローブモデル ----
        const modelManager = createGlobeModelManager({
            scene,
            terrainElevAt: (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
        });

        const lookAt = new Vector3();
        const cameraEcef = new Vector3();
        const seatCenter = new Vector3();
        const seatLerp = new Vector3();
        // SSE 距離評価の基準標高（中心付近の地形標高）。前 sync の値を次 sync で使う。
        let centerElevation = 0;
        // 外部カメラ（flight FollowCamera 等）から供給された真の視錐台6平面＋ECEFカメラ位置（#463）。
        // 非 null の間、通常カメラ（GeospatialCamera）から算出する frustum/cameraEcef の代わりに使う
        // （外部カメラは camera.yaw/pitch と実際の向きが一致しないため、GeospatialCamera 由来では
        //  正しい frustum を作れない）。`attachTileCamera` / 未指定復帰で null に戻す。
        let externalFrustumOverride: { planes: FrustumPlane[]; cameraEcef: Vector3 } | null = null;
        // setExternalFrustum で受け取る Vector3/frustumPlanes の永続コピー先（呼び出し側が
        // スクラッチバッファを再利用して渡してきても、ここで即座にコピーすれば安全に保持できる。
        // 呼び出し側のアロケーション回避を許すための設計、レビュー指摘）。cameraEcefPos のみ
        // コピーし planes は参照保持のままだと、呼び出し側がフレーム間で同一配列/要素を再利用・
        // 上書きする実装の場合、syncTiles 実行前に内容が変わって誤った視錐台でカリングされ得る
        // ため、planes も同様にコピーして一貫性を取る（レビュー指摘）。
        const externalFrustumCameraEcef = new Vector3();
        const externalFrustumPlanesBuffer: FrustumPlane[] = Array.from({ length: 6 }, () => ({
            normal: { x: 0, y: 0, z: 0 },
            d: 0,
        }));
        // 外部 frustum（Follow mode）から導出する視線 forward の永続コピー先（毎フレームの
        // Vector3 アロケーションを避ける。#475）。
        const externalViewForward = new Vector3();

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
            // lookAt は本関数で都度再計算する一時バッファなので scaleInPlace で割り当てを避ける。
            cameraEcef
                .copyFrom(camera.center)
                .subtractInPlace(lookAt.scaleInPlace(camera.radius));
            return cameraEcef;
        };

        // frustum平面算出用の使い回しバッファ（毎フレーム呼ばれるため確保を避ける）。
        // view/合成後 transform は別バッファに分ける（multiplyToRef の dest が operand と
        // エイリアスすると実装依存で壊れ得るため、平面版 `tileManager.ts` と同様に分離する）。
        const frustumViewOnly = Matrix.Identity();
        const frustumTransform = Matrix.Identity();
        const frustumRawPlanes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
        // 戻り値バッファ（syncTiles 呼び出し内で同期的に消費されるのみで、フレームを越えて
        // 保持されないため in-place 更新で安全に再利用できる）。毎フレームの map() による
        // 配列＋オブジェクト再生成を避ける。
        const frustumPlanesResult: FrustumPlane[] = Array.from({ length: 6 }, () => ({
            normal: { x: 0, y: 0, z: 0 },
            d: 0,
        }));
        /**
         * GeospatialCamera の実 view/projection から真の視錐台6平面を求める（#463）。
         * 結果は **camera 相対**（原点 = cameraEcef、回転のみ）で返す（`globeLod.ts` の
         * `GlobeLodOptions.frustumPlanes` 契約）。ECEF 原点基準（eye=真のカメラ位置 ~6.4e6m）の
         * view 行列をそのまま使うと、view*proj 合成やそこからの平面抽出を Babylon の Float32 演算が
         * 行う際に巨大並進が桁落ちし、実際に画面内の遠方地物（例: 50km 先の富士山）を「視錐台外」と
         * 誤判定する（回帰確認済み: #457 elevationFarView.spec.ts で検出）。
         * yaw/pitch から view 行列を独自に再構築する手も検討したが、GeospatialCamera 実体の
         * 向き（up ベクトルの補正等）と厳密には一致せず、境界付近のタイルで実レンダリングと不一致が
         * 生じた（デバッグで実測）。そこで **実 view 行列**（`camera.getViewMatrix()`、回転は
         * 巨大並進と無関係に正確）から並進行だけを 0 にする（回転はそのまま真の値を使う）。
         */
        const computeCameraFrustumPlanes = (): FrustumPlane[] | undefined => {
            if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) return undefined;
            frustumViewOnly.copyFrom(camera.getViewMatrix());
            frustumViewOnly.setRowFromFloats(3, 0, 0, 0, 1);
            frustumViewOnly.multiplyToRef(camera.getProjectionMatrix(), frustumTransform);
            Frustum.GetPlanesToRef(frustumTransform, frustumRawPlanes);
            for (let i = 0; i < 6; i++) {
                const p = frustumRawPlanes[i];
                const out = frustumPlanesResult[i];
                out.normal.x = p.normal.x;
                out.normal.y = p.normal.y;
                out.normal.z = p.normal.z;
                out.d = p.d;
            }
            return frustumPlanesResult;
        };

        // ---- zoom-to-cursor の目標点を scene.pick 非依存で求める差し替え ----
        // ネイティブ handleZoom は毎ホイールで scene.pick(pointerX,pointerY) して
        // computedPerFrameZoomPickPoint を更新するが、floating origin 下では点がブレてズームが
        // 揺れる。ここでは真の ECEF カメラ位置からカーソル方向のレイを飛ばし、resolveTerrainClickElevationToRef
        // で実際の地形標高データに基づく地表交点（レイマーチング）を目標点として求める
        // （computeTerrainClick と同じロジック。注視点付近の代表標高 centerElevation 1点だけを
        // 高さに採用する解析的な楕円体交差では、カーソルが山の斜面を指していてもその山を無視して
        // ズーム先が山の奥に貫通してしまうため使わない）。
        // 探索の基準となる標高 0 面自体は**球ではなく楕円体**（WGS84）で解くのが重要: 球
        // （半径 = center.length()）近似だとカメラがズームで動くたびに半径が変化し、かつ楕円体
        // との差でカーソル下の地点がフレーム毎にずれて揺れる。楕円体面は視点に依らない固定面
        // なので、同じカーソル画素のレイは常に同一の地点へ収束し、ズーム中もカーソル下の画素が
        // 固定される。ホイール毎にのみ取り直し、慣性減衰中（新規ホイールなし）は handleZoom が
        // 呼ばれず目標固定。新しいホイールで新カーソル位置へ更新。併せて最後のホイール入力時刻を
        // 記録し、observer 側の seat 一時停止判定に使う。
        const movement = camera.movement;
        const zoomTarget = new Vector3();
        const zoomGeo: Geodetic = { latDeg: 0, lonDeg: 0, altMeters: 0 };
        const ellipsoidSemiMajor = Wgs84Ellipsoid.semiMajorAxis;
        const ellipsoidSemiMinor = Wgs84Ellipsoid.semiMinorAxis;
        // 二重精度カーソルレイ用バッファ。
        const rayFwd = new Vector3();
        const rayRight = new Vector3();
        const rayUpTerm = new Vector3();
        const cursorDir = new Vector3();
        const cursorOrigin = new Vector3();
        let lastWheelTimeMs = Number.NEGATIVE_INFINITY;

        // カーソル下方向の単位レイを**二重精度**で構築する（揺れの精度要因）。
        // scene.createPickingRayToRef は near/far の 2 点を逆ビュー射影で復元し差分して方向を得るが、
        // floating origin 下でも getViewMatrix が返すのは真の ECEF（並進 ~6.4e6）の行列で、しかも
        // Babylon の Matrix は Float32Array。巨大並進を含む行列で復元した 2 つの近接点の差分は桁落ち
        // （catastrophic cancellation）し、方向が約 1〜4° もずれ、かつカメラ位置の変化に応じて
        // フレーム毎に揺らぐ。これがズーム目標点をブレさせる精度要因。そこで行列を介さず、yaw/pitch
        // から forward を、camera.upVector から up/right を二重精度で求め、画素 NDC オフセットと
        // 垂直 FOV・アスペクトから解析的にレイ方向を構築する（中心画素は厳密に forward に一致）。
        const computeRayDirForPixelToRef = (
            pxCss: number,
            pyCss: number,
            ref: Vector3,
        ): Vector3 => {
            // 注意: computeCameraEcef は共有 lookAt バッファを radius 倍して破壊するため専用バッファに計算する。
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                rayFwd,
            );
            // right = normalize(cross(forward, up))。up は camera.upVector（いずれも二重精度）。
            // 通常 forward ⊥ upVector（_setOrientation が直交化、真下視でも up を水平へ退避）なので
            // cross はゼロにならないが、万一平行/反平行になった場合は right が 0 ベクトルとなり
            // normalize が NaN を生む。NaN がカーソルレイ・ズーム目標点へ伝播するのを防ぐため、
            // 退化時は中心画素方向（forward）へフォールバックする。
            Vector3.CrossToRef(rayFwd, camera.upVector, rayRight);
            if (rayRight.lengthSquared() < 1e-12) {
                return ref.copyFrom(rayFwd).normalize();
            }
            rayRight.normalize();
            // scene.pointerX/Y は CSS ピクセル、getRenderWidth/Height はバックバッファ解像度。
            // Retina 等 devicePixelRatio>1 では両者がずれるため、Babylon の picking と同様に
            // pointer を hardwareScalingLevel で割ってバックバッファ座標へ揃える（これを怠ると
            // カーソル位置が縦横とも半分にずれてズーム先が合わない）。
            const hsl = engine.getHardwareScalingLevel();
            const w = engine.getRenderWidth();
            const h = engine.getRenderHeight();
            const ndcx = (pxCss / hsl / w) * 2 - 1;
            const ndcy = 1 - (pyCss / hsl / h) * 2;
            const tanY = Math.tan(camera.fov / 2);
            const tanX = tanY * (w / h);
            ref.copyFrom(rayFwd)
                .addInPlace(rayRight.scaleInPlace(ndcx * tanX))
                .addInPlace(rayUpTerm.copyFrom(camera.upVector).scaleInPlace(ndcy * tanY))
                .normalize();
            return ref;
        };

        // ピッキング用レイ（原点 + 単位方向）をカメラモードに応じて構築する。
        // - perspective(3D): 原点 = カメラ ECEF、方向 = 画素ごとに発散（中心から放射）。
        // - orthographic(2D): 平行投影。方向 = forward（中心画素方向）固定で、原点をカメラ平面上で
        //   画素オフセット分ずらす。これを怠ると 2D で画面中心以外の頂点が正しくピックできない
        //   （単一原点 + 発散方向の透視レイは ortho では中心以外の点を外す） (2D 編集)。
        const computePickRayToRef = (
            pxCss: number,
            pyCss: number,
            originRef: Vector3,
            dirRef: Vector3,
        ): void => {
            if (camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) {
                originRef.copyFrom(computeCameraEcef());
                computeRayDirForPixelToRef(pxCss, pyCss, dirRef);
                return;
            }
            // forward（中心画素方向）= カメラ→center。ortho では全画素で共通。
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                rayFwd,
            );
            dirRef.copyFrom(rayFwd).normalize();
            originRef.copyFrom(computeCameraEcef());
            Vector3.CrossToRef(rayFwd, camera.upVector, rayRight);
            if (rayRight.lengthSquared() < 1e-12) return; // 退化時は中心原点で代替
            rayRight.normalize();
            const hsl = engine.getHardwareScalingLevel();
            const w = engine.getRenderWidth();
            const h = engine.getRenderHeight();
            if (w <= 0 || h <= 0) return;
            const ndcx = (pxCss / hsl / w) * 2 - 1;
            const ndcy = 1 - (pyCss / hsl / h) * 2;
            // ortho フラスタム半寸（applyOrthoFrustum と同式）。原点をこの平面上で動かす。
            const halfH = camera.radius * Math.tan(camera.fov / 2);
            const halfW = halfH * (w / h);
            originRef
                .addInPlace(rayRight.scaleInPlace(ndcx * halfW))
                .addInPlace(
                    rayUpTerm.copyFrom(camera.upVector).scaleInPlace(ndcy * halfH),
                );
        };

        // ズーム（zoom-to-cursor）は現在のポインタ位置（scene.pointerX/Y）のレイを使う。
        // 2D(ORTHOGRAPHIC) では平行投影のため、原点を画素オフセット分ずらし方向を forward 固定に
        // する必要がある（透視レイ方向 + 単一原点では中心以外でズーム先がずれる）。click ピックと
        // 同じ computePickRayToRef でモードに応じた origin+dir を構築する (2D zoom-to-cursor)。

        movement.handleZoom = (zoomDelta: number): void => {
            if (zoomDelta === 0) return;
            lastWheelTimeMs = performance.now();
            // ネイティブ同様に蓄積（per-frame の zoomDeltaCurrentFrame へ変換される）。
            movement.zoomAccumulatedPixels += zoomDelta;
            // カーソル位置のレイ（原点 + 単位方向）。createPickingRay の Float32 桁落ちを避け、
            // ortho では平行投影として正しい原点オフセットを得るため computePickRayToRef を使う。
            computePickRayToRef(scene.pointerX, scene.pointerY, cursorOrigin, cursorDir);
            // 注視点付近の代表標高（centerElevation）1点の楕円体面だけでは、カーソルが山の
            // 斜面を指していてもその山を無視してズーム先が山の奥に貫通する。レイマーチングで
            // カーソル方向の実際の地表交点を求める（computeTerrainClick と同じロジック）。
            const hit = resolveTerrainClickElevationToRef(
                cursorOrigin,
                cursorDir,
                ellipsoidSemiMajor,
                ellipsoidSemiMinor,
                (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
                TERRAIN_CLICK_MAX_ELEV_M,
                TERRAIN_CLICK_STEP_DISTANCE_M,
                TERRAIN_CLICK_MIN_COARSE_STEPS,
                TERRAIN_CLICK_MAX_COARSE_STEPS,
                TERRAIN_CLICK_REFINE_ITERATIONS,
                zoomTarget,
                zoomGeo,
            );
            // 空を指している、または地表（山）を検出できない → 注視点方向（lookAt）ズームに
            // フォールバック。
            movement.computedPerFrameZoomPickPoint = hit ? zoomTarget : undefined;
        };

        // ---- _recalculateCenter 用の center 再取得を scene.pick 非依存にする差し替え ----
        // ネイティブ _recalculateCenter はズーム/パン確定時に pickAlongVector(lookAt) で center を
        // 地表へ再スナップし、その新 center に対して lookAt（ワールド注視方向）から yaw/pitch を
        // 引き直す。これがズームのフレーム結合誤差（真下チルトでの南北東西の振れ）を打ち消す肝。
        // しかし pickAlongVector は scene.pick（PickWithRay）に依存し、floating origin 下や海面上で
        // ヒットせず null を返すと補正が止まり揺れが残る。そこで真の ECEF カメラ位置から lookAt 方向へ
        // レイマーチングで実地表交点を求める（computeTerrainClick と同じ resolveTerrainClickElevationToRef）。
        // 単一の代表標高（centerElevation）面との解析的交差では、水平に近いチルトで山を貫通した
        // 結果カメラが地球の反対側の遠方点を center に採用してしまい、パン/チルトで center が
        // 超遠方へ暴走する不具合があった。返り値は _recalculateCenter が参照する pickedPoint のみを
        // 持つ PickingInfo 互換オブジェクト。ズーム中は zoomToPoint ラップ経由で毎フレーム呼ばれる
        // ため、PickingInfo / pickedPoint は事前確保して使い回し、フレーム毎の割り当て・GC ジッタを
        // 避ける。
        const recalcPickedPoint = new Vector3();
        const recalcGeo: Geodetic = { latDeg: 0, lonDeg: 0, altMeters: 0 };
        const recalcPickInfo = new PickingInfo();
        recalcPickInfo.pickedPoint = recalcPickedPoint;
        movement.pickAlongVector = (vector: Vector3): PickingInfo | null => {
            const camEcef = computeCameraEcef(); // 真の ECEF カメラ位置
            const hit = resolveTerrainClickElevationToRef(
                camEcef,
                vector,
                ellipsoidSemiMajor,
                ellipsoidSemiMinor,
                (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
                TERRAIN_CLICK_MAX_ELEV_M,
                TERRAIN_CLICK_STEP_DISTANCE_M,
                TERRAIN_CLICK_MIN_COARSE_STEPS,
                TERRAIN_CLICK_MAX_COARSE_STEPS,
                TERRAIN_CLICK_REFINE_ITERATIONS,
                recalcPickedPoint,
                recalcGeo,
            );
            if (!hit) return null;
            recalcPickInfo.hit = true;
            recalcPickInfo.pickedPoint = recalcPickedPoint;
            return recalcPickInfo;
        };

        // ---- ズーム終了時のスナップ（急な移動）を防ぐ毎フレーム向き補正 ----
        // ネイティブはズーム中、毎フレーム _applyZoom→zoomToPoint で center を動かしつつ yaw/pitch を
        // 数値的に据え置く（center のローカル ENU フレームが回転＝フレーム結合誤差を蓄積）。向き補正を
        // 担う _recalculateCenter は「移動が止まったフレーム」に一度だけ発火するため、蓄積誤差がズーム
        // 確定時に一括補正され、画面が急に動いて止まる（スナップ）。そこで zoomToPoint をラップし、各
        // ズームフレーム直後に同等の補正を毎フレーム実行して連続化する。ズーム中は滑らかなまま終了時の
        // スナップが解消する。zoomToPoint はズーム時のみ呼ばれるためパン等へは影響しない。
        //
        // 補正は Babylon 非公開 API の camera._recalculateCenter を直接呼ばず、公開 API のみで等価実装する
        // （非公開 API はライブラリ更新で消失/改名するとクラッシュするため）。内訳:
        //   - 現在の yaw/pitch から世界 lookAt 方向（カメラ前方）を求める（ComputeLookAtFromYawPitchToRef）。
        //   - その方向で center を地表楕円体へ再スナップ（movement.pickAlongVector は上で幾何交点に差し替え済み）。
        //   - 世界 lookAt を保つ yaw/pitch を新 center で引き直す（ComputeYawPitchFromLookAtToRef は公開エクスポート）。
        //   - 公開セッタ center→yaw→pitch→radius の順で反映（最終状態は _setOrientation 等価。カメラ位置は
        //     ほぼ不変＝カーソル下の画素が固定される）。
        // これによりネイティブ _recalculateCenter（_checkInputs から毎フレーム呼ばれ、確定時のみ発火）は
        // 残るが、本補正で既に整っているため実質 no-op となり整合する。
        //
        // ちらつき対策: 山岳地帯を水平に近いチルトでズームすると、lookAt レイが稜線をわずかに超えて
        // 空を指す状態（pickAlongVector が null＝地表未検出）と山を捉える状態が数フレームにわたり
        // 断続的に切り替わる。失敗フレームでは補正が停止し、その間ネイティブズームのフレーム結合誤差が
        // 無補正で蓄積 → 次に成功したフレームで一括補正され、ズーム終了間際に画面が急に動く。そこで
        // 同一ズームジェスチャ内で直近に採用した実在の地表点を短時間だけ保持し、失敗フレームでは
        // それを再利用して補正を連続させる（遠方の仮想点は捏造しない＝水平チルトでの暴走は再発させない）。
        const recalcLookAt = new Vector3();
        const recalcCenterToOrigin = new Vector3();
        const recalcYawPitch = new Vector2();
        // 直近に採用した center（実在の地表点）と、その採用時刻。ズームジェスチャ間で古い点を
        // 持ち越さないよう、保持時刻が古くなれば resolveRecalcCenterSource が破棄する。
        const recalcLastValidCenter = new Vector3();
        let recalcLastValidTimeMs = Number.NEGATIVE_INFINITY;
        let recalcHasLastValid = false;
        // カメラ地形衝突で radius に上乗せしている追加分[m]（enforceGroundClearance が更新）。
        // isZoomActive はこの追加分を除いた「素の radius」変化のみをズーム判定に使い、
        // enforceGroundClearance は「camera.radius - clearanceBoost」を素の radius とみなして補間する。
        let clearanceBoost = 0;
        // enforceGroundClearance が最後に camera.radius へ書き込んだ値。次フレームでこれと実際の
        // camera.radius を比較し、外部（setAltitude / setView / ホイールズーム等、経路を問わず）が
        // radius を直接上書きしていれば追加分(clearanceBoost)を破棄して現在値を新たな素の radius と
        // みなす（同期ズレによる意図しない radius 収束を防ぐ）。
        let lastAppliedRadius = camera.radius;
        const recalculateCenterPublic = (): void => {
            ComputeLookAtFromYawPitchToRef(
                camera.yaw,
                camera.pitch,
                camera.center,
                scene.useRightHandedSystem,
                recalcLookAt,
                movement.calculateUpVectorFromPointToRef,
            );
            const nowMs = performance.now();
            const picked = movement.pickAlongVector(recalcLookAt);
            const source = resolveRecalcCenterSource(
                !!picked?.pickedPoint,
                recalcHasLastValid,
                nowMs - recalcLastValidTimeMs,
                RECALC_CENTER_HOLD_MS,
            );
            // 補正に使う center。今フレーム成功なら pick 結果、失敗でも保持が新しければ直近の実在点を
            // 再利用、いずれも無ければ補正しない。
            let centerForRecalc: Vector3;
            if (source === "current" && picked?.pickedPoint) {
                centerForRecalc = picked.pickedPoint;
            } else if (source === "held") {
                centerForRecalc = recalcLastValidCenter;
            } else {
                return;
            }
            // 地球の裏側の center を採らないよう、center→原点方向が lookAt とおおむね一致する場合のみ更新。
            recalcCenterToOrigin.copyFrom(centerForRecalc).negateInPlace().normalize();
            if (Vector3.Dot(recalcLookAt, recalcCenterToOrigin) <= 0) return;
            const newRadius = Vector3.Distance(computeCameraEcef(), centerForRecalc);
            if (newRadius <= 1e-6) return;
            ComputeYawPitchFromLookAtToRef(
                recalcLookAt,
                centerForRecalc,
                scene.useRightHandedSystem,
                camera.yaw,
                recalcYawPitch,
                movement.calculateUpVectorFromPointToRef,
            );
            // center→yaw→pitch→radius の順で公開セッタへ反映（各セッタが _setOrientation を呼び、
            // 最終呼び出しが (newYaw, newPitch, newRadius, newCenter) 等価になる）。
            camera.center = centerForRecalc;
            camera.yaw = recalcYawPitch.x;
            camera.pitch = recalcYawPitch.y;
            camera.radius = newRadius;
            // radius をここで直接上書きする。この外部上書きは次フレーム先頭の再基準化ロジック
            // （lastAppliedRadius との比較）が検知して clearanceBoost を破棄するため、ここでの
            // 明示リセットは不要（全経路を単一の仕組みで扱う）。
            // 今フレーム成功した実在点のみを保持点として更新する（Dot ガード等を通過して実際に
            // 採用できた点だけを次の失敗フレームの再利用対象にする）。
            if (source === "current") {
                recalcLastValidCenter.copyFrom(centerForRecalc);
                recalcLastValidTimeMs = nowMs;
                recalcHasLastValid = true;
            }
        };
        const origZoomToPoint = camera.zoomToPoint.bind(camera);
        camera.zoomToPoint = (targetPoint, distance): void => {
            origZoomToPoint(targetPoint, distance);
            recalculateCenterPublic();
        };

        // ---- 地形クリック通知（pick 非依存・floating origin 対応） ----
        // 平面版（撤去済み）は scene.pick で地形メッシュをヒットするが、floating origin 下では
        // レンダリング座標と真の ECEF メッシュ位置がずれてピックがブレる。そこでズーム/パンと同じく
        // 真の ECEF カメラ位置からカーソル方向のレイに沿って、実際の地形標高データに基づく地表交点を
        // レイマーチングで求める（resolveTerrainClickElevationToRef）。ドラッグ（パン/回転）は
        // しきい値で除外する。
        const terrainClickListeners: GlobeTerrainClickListener[] = [];
        let clickStart: {
            pointerId: number;
            x: number;
            y: number;
            modifier: boolean;
        } | null = null;
        const clickRayDir = new Vector3();
        const clickOrigin = new Vector3();
        const clickHitElev = new Vector3();
        const clickGeo: Geodetic = { latDeg: 0, lonDeg: 0, altMeters: 0 };

        /**
         * カーソル方向のレイ × 地形表面の交点から緯度経度・標高を求める。空（ミス）は null。
         * レイマーチングで手前の山を検出するため（resolveTerrainClickElevationToRef 参照）、
         * 山岳地帯でクリックしても山を貫通して奥に着地しない。
         */
        const computeTerrainClick = (e: PointerEvent): GlobeTerrainClickEvent | null => {
            const rect = canvas.getBoundingClientRect();
            const pxCss = e.clientX - rect.left;
            const pyCss = e.clientY - rect.top;
            // 2D ortho では平行レイ（原点を画素オフセット）でないと中心以外で交点がずれる。
            computePickRayToRef(pxCss, pyCss, clickOrigin, clickRayDir);
            const hit = resolveTerrainClickElevationToRef(
                clickOrigin,
                clickRayDir,
                ellipsoidSemiMajor,
                ellipsoidSemiMinor,
                (latDeg, lonDeg) => tileManager.terrainElevAt(latDeg, lonDeg),
                TERRAIN_CLICK_MAX_ELEV_M,
                TERRAIN_CLICK_STEP_DISTANCE_M,
                TERRAIN_CLICK_MIN_COARSE_STEPS,
                TERRAIN_CLICK_MAX_COARSE_STEPS,
                TERRAIN_CLICK_REFINE_ITERATIONS,
                clickHitElev,
                clickGeo,
            );
            if (!hit) return null; // 空（地球外）を指している、または地表（山）を検出できない
            return {
                lat: clickGeo.latDeg,
                lon: clickGeo.lonDeg,
                altitude: clickGeo.altMeters,
                // world は採用した真の ECEF 交点（floating origin のレンダリング座標ではない）。
                world: { x: clickHitElev.x, y: clickHitElev.y, z: clickHitElev.z },
                pointerEvent: e,
            };
        };

        const onClickPointerDown = (e: PointerEvent): void => {
            if (e.button !== 0) return;
            clickStart = {
                pointerId: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                modifier: e.ctrlKey || e.metaKey,
            };
        };
        const cancelClick = (e: PointerEvent): void => {
            if (clickStart && clickStart.pointerId === e.pointerId) clickStart = null;
        };
        const onClickPointerUp = (e: PointerEvent): void => {
            const start = clickStart;
            clickStart = null;
            if (!start || start.pointerId !== e.pointerId) return;
            // Ctrl/Cmd 併用はカメラ操作扱い（平面版と同じ）。pointerup 時点の修飾キーも確認する。
            if (start.modifier || e.ctrlKey || e.metaKey) return;
            if (terrainClickListeners.length === 0) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (
                Math.abs(dx) > TERRAIN_CLICK_DRAG_THRESHOLD_PX ||
                Math.abs(dy) > TERRAIN_CLICK_DRAG_THRESHOLD_PX
            ) {
                return; // ドラッグ（パン/回転）はクリックとみなさない
            }
            const event = computeTerrainClick(e);
            if (!event) return;
            // iterate 中の add/remove 安全のため slice
            for (const listener of terrainClickListeners.slice()) {
                try {
                    listener(event);
                } catch (err) {
                    console.error("[globe] terrain click listener threw:", err);
                }
            }
        };
        // terrain-click のポインタハンドラは購読者がいる間だけ canvas に登録する
        // （購読ゼロ時に余計なグローバルなポインタ処理を行わない・他のポインタ処理との
        //   意図しない干渉を避ける）。
        let clickHandlersAttached = false;
        const attachClickHandlers = (): void => {
            if (clickHandlersAttached) return;
            canvas.addEventListener("pointerdown", onClickPointerDown);
            canvas.addEventListener("pointerup", onClickPointerUp);
            canvas.addEventListener("pointercancel", cancelClick);
            canvas.addEventListener("lostpointercapture", cancelClick);
            clickHandlersAttached = true;
        };
        const detachClickHandlers = (): void => {
            if (!clickHandlersAttached) return;
            canvas.removeEventListener("pointerdown", onClickPointerDown);
            canvas.removeEventListener("pointerup", onClickPointerUp);
            canvas.removeEventListener("pointercancel", cancelClick);
            canvas.removeEventListener("lostpointercapture", cancelClick);
            clickStart = null;
            clickHandlersAttached = false;
        };

        const subscribeTerrainClick = (
            listener: GlobeTerrainClickListener,
        ): (() => void) => {
            terrainClickListeners.push(listener);
            attachClickHandlers();
            return () => {
                const i = terrainClickListeners.indexOf(listener);
                if (i >= 0) terrainClickListeners.splice(i, 1);
                if (terrainClickListeners.length === 0) detachClickHandlers();
            };
        };

        // ---- ポリゴン頂点インタラクション（pick 非依存・floating origin 対応） ----
        // 平面版（撤去済み）は scene.pick で頂点メッシュをヒットするが、floating origin 下では
        // レンダリング座標がずれてピックがブレうる。そこで terrain-click と同じく、真の ECEF カメラ
        // 位置からカーソル方向のレイを作り、各頂点 ECEF（globePolygonManager.getPickablePoints）との
        // 幾何関係（レイ最近接距離 ≤ 点スフィア半径）でヒット判定する。ドラッグ中の幾何量も
        // 真の ECEF レイ × 楕円体/鉛直線で求める。
        const polygonPointHoverListeners: GlobePolygonPointListener[] = [];
        const polygonPointClickListeners: GlobePolygonPointClickListener[] = [];
        const polygonPointDragStartListeners: GlobePolygonPointDragListener[] = [];
        const polygonPointDragListeners: GlobePolygonPointDragListener[] = [];
        const polygonPointDragEndListeners: GlobePolygonPointDragListener[] = [];
        let polygonPointHoverState: { polygonId: string; index: number } | null =
            null;

        const hasPolygonPointGestureListeners = (): boolean =>
            polygonPointClickListeners.length > 0 ||
            polygonPointDragStartListeners.length > 0 ||
            polygonPointDragListeners.length > 0 ||
            polygonPointDragEndListeners.length > 0;
        const hasAnyPolygonPointListener = (): boolean =>
            polygonPointHoverListeners.length > 0 ||
            hasPolygonPointGestureListeners();

        // ピック/幾何計算用の再利用バッファ（毎 move での割り当てを避ける）。
        const ppOrigin = new Vector3();
        const ppRayDir = new Vector3();
        const ppEllipHit = new Vector3();
        const ppUp = new Vector3();
        const ppScratch = new Vector3();
        const ppClosest = new Vector3();
        // getPickablePoints の書き込み先（要素を再利用して毎 move の割り当てを避ける）。
        const ppPickBuffer: GlobePolygonPickablePoint[] = [];

        /**
         * カーソル下の頂点を幾何ピックする（最も手前の点）。floating origin 非依存。
         * 地球の裏側に隠れた点は楕円体近交点距離との比較で除外する。
         */
        const pickPolygonPoint = (
            pxCss: number,
            pyCss: number,
            outWorld?: Vector3,
        ): { polygonId: string; index: number } | null => {
            const count = polygonManager.getPickablePoints(ppPickBuffer);
            if (count === 0) return null;
            computePickRayToRef(pxCss, pyCss, ppOrigin, ppRayDir);
            // 楕円体（海面）近交点までの距離。これより十分奥の点は裏側として除外する。
            let tEllip = Number.POSITIVE_INFINITY;
            if (
                rayEllipsoidNearHitToRef(
                    ppOrigin,
                    ppRayDir,
                    ellipsoidSemiMajor,
                    ellipsoidSemiMajor,
                    ellipsoidSemiMinor,
                    ppEllipHit,
                )
            ) {
                tEllip = Vector3.Distance(ppOrigin, ppEllipHit);
            }
            let bestPolygonId: string | null = null;
            let bestIndex = -1;
            let bestX = 0;
            let bestY = 0;
            let bestZ = 0;
            let bestT = Number.POSITIVE_INFINITY;
            for (let i = 0; i < count; i++) {
                const p = ppPickBuffer[i];
                const vx = p.x - ppOrigin.x;
                const vy = p.y - ppOrigin.y;
                const vz = p.z - ppOrigin.z;
                const t = vx * ppRayDir.x + vy * ppRayDir.y + vz * ppRayDir.z;
                if (t <= 0) continue; // カメラ背後
                if (t > tEllip + p.radius) continue; // 地球裏側に隠れている
                const perp2 = vx * vx + vy * vy + vz * vz - t * t;
                if (perp2 > p.radius * p.radius) continue; // レイがスフィアを外れている
                if (t < bestT) {
                    bestT = t;
                    bestPolygonId = p.polygonId;
                    bestIndex = p.index;
                    bestX = p.x;
                    bestY = p.y;
                    bestZ = p.z;
                }
            }
            // world 座標はドラッグ開始時のみ必要。hover/click では outWorld を渡さず
            // 割り当てをゼロにする。要求時のみ呼び出し側の Vector3 へ書き込む。
            if (bestPolygonId === null) return null;
            if (outWorld) outWorld.set(bestX, bestY, bestZ);
            return {
                polygonId: bestPolygonId,
                index: bestIndex,
            };
        };

        /** カーソルレイ × 地形楕円体の交点（terrain-click と同方針）。 */
        const computeDragGroundHit = (
            pxCss: number,
            pyCss: number,
        ): { lat: number | null; lon: number | null; groundAltitude: number | null } => {
            computePickRayToRef(pxCss, pyCss, ppOrigin, ppRayDir);
            if (
                !rayEllipsoidNearHitToRef(
                    ppOrigin,
                    ppRayDir,
                    ellipsoidSemiMajor,
                    ellipsoidSemiMajor,
                    ellipsoidSemiMinor,
                    ppEllipHit,
                )
            ) {
                return { lat: null, lon: null, groundAltitude: null };
            }
            const geo = ecefToGeodetic(ppEllipHit);
            const elev = tileManager.terrainElevAt(geo.latDeg, geo.lonDeg);
            if (elev !== null && Number.isFinite(elev)) {
                // 補正交点（地形標高ぶん持ち上げた楕円体面）が得られた場合のみ、
                // その lat/lon と groundAltitude=elev を採用し両者を一貫させる。
                // computeTerrainClick と同じく、補正に失敗したら海面交点へフォールバックする。
                if (
                    rayEllipsoidNearHitToRef(
                        ppOrigin,
                        ppRayDir,
                        ellipsoidSemiMajor + elev,
                        ellipsoidSemiMajor + elev,
                        ellipsoidSemiMinor + elev,
                        ppScratch,
                    )
                ) {
                    const corrected = ecefToGeodetic(ppScratch);
                    return {
                        lat: corrected.latDeg,
                        lon: corrected.lonDeg,
                        groundAltitude: elev,
                    };
                }
            }
            return { lat: geo.latDeg, lon: geo.lonDeg, groundAltitude: geo.altMeters };
        };

        /**
         * カーソルレイ × 「ドラッグ開始時の頂点高度を保つ楕円体面」の交点。平面版の水平面交点に相当。
         */
        const computeDragPlaneHit = (
            pxCss: number,
            pyCss: number,
            startAltMeters: number,
        ): { planeLat: number | null; planeLon: number | null } => {
            computePickRayToRef(pxCss, pyCss, ppOrigin, ppRayDir);
            const eqr = ellipsoidSemiMajor + startAltMeters;
            const pol = ellipsoidSemiMinor + startAltMeters;
            if (
                !rayEllipsoidNearHitToRef(ppOrigin, ppRayDir, eqr, eqr, pol, ppScratch)
            ) {
                return { planeLat: null, planeLon: null };
            }
            const geo = ecefToGeodetic(ppScratch);
            return { planeLat: geo.latDeg, planeLon: geo.lonDeg };
        };

        /**
         * 頂点の測地鉛直線（地心 up 方向）とカーソルレイの最近接点の測地高度。平面版の
         * 鉛直線最近接に相当。カメラがほぼ鉛直線方向を向くと退化し null。
         */
        const computeDragVerticalHit = (
            pxCss: number,
            pyCss: number,
            startWorld: Vector3,
        ): number | null => {
            computePickRayToRef(pxCss, pyCss, ppOrigin, ppRayDir);
            const startGeo = ecefToGeodetic(startWorld);
            // 測地 up = ecef(alt+1) - ecef(alt) を正規化（楕円体法線。地心方向と微差）。
            geodeticToEcefToRef(
                startGeo.latDeg,
                startGeo.lonDeg,
                startGeo.altMeters + 1,
                ppUp,
            );
            ppUp.subtractInPlace(startWorld);
            const upLen = ppUp.length();
            if (upLen < 1e-9) return null;
            ppUp.scaleInPlace(1 / upLen);
            // 二直線（鉛直線 d1=ppUp、レイ d2=ppRayDir、いずれも単位）の最近接点。
            const b = Vector3.Dot(ppUp, ppRayDir);
            const denom = 1 - b * b;
            if (Math.abs(denom) < 1e-6) return null;
            const wx = startWorld.x - ppOrigin.x;
            const wy = startWorld.y - ppOrigin.y;
            const wz = startWorld.z - ppOrigin.z;
            const d = ppUp.x * wx + ppUp.y * wy + ppUp.z * wz; // d1·w0
            const eDot = ppRayDir.x * wx + ppRayDir.y * wy + ppRayDir.z * wz; // d2·w0
            const s = (b * eDot - d) / denom;
            ppClosest
                .copyFrom(startWorld)
                .addInPlace(ppScratch.copyFrom(ppUp).scaleInPlace(s));
            return ecefToGeodetic(ppClosest).altMeters;
        };

        const dispatchPolygonHover = (
            event: GlobePolygonPointEvent | null,
        ): void => {
            for (const l of polygonPointHoverListeners.slice()) {
                try {
                    l(event);
                } catch (err) {
                    console.error("[globe] polygon point hover listener threw:", err);
                }
            }
        };
        const dispatchPolygonPoint = (
            listeners: GlobePolygonPointClickListener[],
            event: GlobePolygonPointEvent,
            label: string,
        ): void => {
            for (const l of listeners.slice()) {
                try {
                    l(event);
                } catch (err) {
                    console.error(`[globe] ${label} listener threw:`, err);
                }
            }
        };
        const dispatchPolygonDrag = (
            listeners: GlobePolygonPointDragListener[],
            event: GlobePolygonPointDragEvent,
            label: string,
        ): void => {
            for (const l of listeners.slice()) {
                try {
                    l(event);
                } catch (err) {
                    console.error(`[globe] ${label} listener threw:`, err);
                }
            }
        };

        const buildPolygonDragEvent = (
            gesture: NonNullable<typeof polygonPointGesture>,
            e: PointerEvent,
        ): GlobePolygonPointDragEvent => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const ground = computeDragGroundHit(sx, sy);
            const plane = computeDragPlaneHit(sx, sy, gesture.startAltMeters);
            const pointerAltitude = computeDragVerticalHit(
                sx,
                sy,
                gesture.startWorld,
            );
            return {
                polygonId: gesture.polygonId,
                index: gesture.index,
                pointerEvent: e,
                ...ground,
                ...plane,
                pointerAltitude,
            };
        };

        const onPolygonPointerDown = (e: PointerEvent): void => {
            if (e.button !== 0) return;
            if (!hasPolygonPointGestureListeners()) return;
            if (e.ctrlKey || e.metaKey) return;
            const rect = canvas.getBoundingClientRect();
            const startWorld = new Vector3();
            const hit = pickPolygonPoint(
                e.clientX - rect.left,
                e.clientY - rect.top,
                startWorld,
            );
            if (!hit) return;
            const startGeo = ecefToGeodetic(startWorld);
            polygonPointGesture = {
                pointerId: e.pointerId,
                polygonId: hit.polygonId,
                index: hit.index,
                startClientX: e.clientX,
                startClientY: e.clientY,
                dragging: false,
                startWorld,
                startAltMeters: startGeo.altMeters,
            };
            canvas.setPointerCapture?.(e.pointerId);
            // パン handler はこの pointerdown で既に dragging=true / pointer capture を
            // 設定済み（登録順が先）。頂点ジェスチャ中はパンを完全に無効化する。これにより
            // 万一ジェスチャが途中で解除されてもカメラがパンしない（ドラッグ競合対策）。
            dragging = false;
            // terrain-click 抑制（登録順非依存）: 進行中の terrain クリック開始判定を破棄する。
            clickStart = null;
            // 後続リスナー（同一 canvas の terrain-click 等）への配送も止める。
            e.stopImmediatePropagation();
        };
        const onPolygonPointerMove = (e: PointerEvent): void => {
            const gesture = polygonPointGesture;
            if (gesture && gesture.pointerId === e.pointerId) {
                if (!gesture.dragging) {
                    const dx = e.clientX - gesture.startClientX;
                    const dy = e.clientY - gesture.startClientY;
                    if (
                        Math.abs(dx) >= POLYGON_POINT_DRAG_THRESHOLD_PX ||
                        Math.abs(dy) >= POLYGON_POINT_DRAG_THRESHOLD_PX
                    ) {
                        gesture.dragging = true;
                        dispatchPolygonDrag(
                            polygonPointDragStartListeners,
                            buildPolygonDragEvent(gesture, e),
                            "onPolygonPointDragStart",
                        );
                    }
                }
                if (gesture.dragging) {
                    dispatchPolygonDrag(
                        polygonPointDragListeners,
                        buildPolygonDragEvent(gesture, e),
                        "onPolygonPointDrag",
                    );
                }
                return;
            }
            // hover 検出（パン/ジェスチャ中でなく、hover リスナーがある場合）。
            if (dragging || polygonPointHoverListeners.length === 0) return;
            const rect = canvas.getBoundingClientRect();
            const hit = pickPolygonPoint(e.clientX - rect.left, e.clientY - rect.top);
            if (hit) {
                if (
                    !polygonPointHoverState ||
                    polygonPointHoverState.polygonId !== hit.polygonId ||
                    polygonPointHoverState.index !== hit.index
                ) {
                    polygonPointHoverState = {
                        polygonId: hit.polygonId,
                        index: hit.index,
                    };
                    canvas.style.cursor = "pointer";
                    dispatchPolygonHover({
                        polygonId: hit.polygonId,
                        index: hit.index,
                        pointerEvent: e,
                    });
                }
            } else if (polygonPointHoverState !== null) {
                polygonPointHoverState = null;
                canvas.style.cursor = "";
                dispatchPolygonHover(null);
            }
        };
        const onPolygonPointerUp = (e: PointerEvent): void => {
            const gesture = polygonPointGesture;
            if (!gesture || gesture.pointerId !== e.pointerId) return;
            polygonPointGesture = null;
            canvas.releasePointerCapture?.(e.pointerId);
            if (gesture.dragging) {
                dispatchPolygonDrag(
                    polygonPointDragEndListeners,
                    buildPolygonDragEvent(gesture, e),
                    "onPolygonPointDragEnd",
                );
                return;
            }
            // 未ドラッグ: 修飾キーはカメラ操作扱い。pointerup 位置が同一頂点上のときのみ click。
            if (e.ctrlKey || e.metaKey) return;
            const rect = canvas.getBoundingClientRect();
            const picked = pickPolygonPoint(
                e.clientX - rect.left,
                e.clientY - rect.top,
            );
            if (
                picked &&
                picked.polygonId === gesture.polygonId &&
                picked.index === gesture.index
            ) {
                dispatchPolygonPoint(
                    polygonPointClickListeners,
                    {
                        polygonId: gesture.polygonId,
                        index: gesture.index,
                        pointerEvent: e,
                    },
                    "onPolygonPointClick",
                );
            }
        };
        const onPolygonPointerCancel = (e: PointerEvent): void => {
            const gesture = polygonPointGesture;
            if (!gesture || gesture.pointerId !== e.pointerId) return;
            polygonPointGesture = null;
            // lostpointercapture は「既に capture を失った」通知でもあり、その場合に
            // releasePointerCapture を呼ぶとブラウザによっては例外になる。capture 保持を
            // 確認してから release する。
            if (canvas.hasPointerCapture?.(e.pointerId)) {
                canvas.releasePointerCapture?.(e.pointerId);
            }
            // planar (resetPointerState) と同契約: ドラッグ中に pointercancel /
            // lostpointercapture で中断された場合も dragEnd を通知する。これにより
            // デモ側の状態（altitudeDragStart クリア・rAF flush 等）が取りこぼされない。
            if (gesture.dragging) {
                dispatchPolygonDrag(
                    polygonPointDragEndListeners,
                    buildPolygonDragEvent(gesture, e),
                    "onPolygonPointDragEnd",
                );
            }
        };

        // ポリゴン頂点 handler は購読者がいる間だけ canvas に登録する（terrain-click と同方針）。
        let polygonPointHandlersAttached = false;
        const attachPolygonPointHandlers = (): void => {
            if (polygonPointHandlersAttached) return;
            canvas.addEventListener("pointerdown", onPolygonPointerDown);
            canvas.addEventListener("pointermove", onPolygonPointerMove);
            canvas.addEventListener("pointerup", onPolygonPointerUp);
            canvas.addEventListener("pointercancel", onPolygonPointerCancel);
            // setPointerCapture を使うため、ブラウザ都合の capture 喪失でも確実に
            // ジェスチャをリセットする（planar と同様に pointercancel と両方で reset）。
            // pointerup は releasePointerCapture 前に gesture を null 化するため、
            // ここでの lostpointercapture では二重に dragEnd が発火しない。
            canvas.addEventListener("lostpointercapture", onPolygonPointerCancel);
            polygonPointHandlersAttached = true;
        };
        const detachPolygonPointHandlers = (): void => {
            if (!polygonPointHandlersAttached) return;
            canvas.removeEventListener("pointerdown", onPolygonPointerDown);
            canvas.removeEventListener("pointermove", onPolygonPointerMove);
            canvas.removeEventListener("pointerup", onPolygonPointerUp);
            canvas.removeEventListener("pointercancel", onPolygonPointerCancel);
            canvas.removeEventListener("lostpointercapture", onPolygonPointerCancel);
            polygonPointGesture = null;
            if (polygonPointHoverState !== null) {
                polygonPointHoverState = null;
                canvas.style.cursor = "";
            }
            polygonPointHandlersAttached = false;
        };
        const makePolygonPointSubscribe =
            <T>(listeners: T[]) =>
            (listener: T): (() => void) => {
                listeners.push(listener);
                attachPolygonPointHandlers();
                return () => {
                    const i = listeners.indexOf(listener);
                    if (i >= 0) listeners.splice(i, 1);
                    if (!hasAnyPolygonPointListener()) detachPolygonPointHandlers();
                };
            };
        const subscribePolygonPointHover = (
            listener: GlobePolygonPointListener,
        ): (() => void) => {
            polygonPointHoverListeners.push(listener);
            attachPolygonPointHandlers();
            return () => {
                const i = polygonPointHoverListeners.indexOf(listener);
                if (i >= 0) polygonPointHoverListeners.splice(i, 1);
                // 最後の hover リスナー解除時は、click/drag リスナーが残って handler が
                // 付いたままでも hover 検出が止まりカーソルが pointer のまま残り得る。
                // planar (subscribePolygonPointHover) と同様に明示的にクリアする。
                if (polygonPointHoverListeners.length === 0 && polygonPointHoverState !== null) {
                    polygonPointHoverState = null;
                    canvas.style.cursor = "";
                }
                if (!hasAnyPolygonPointListener()) detachPolygonPointHandlers();
            };
        };
        const subscribePolygonPointClick = makePolygonPointSubscribe(
            polygonPointClickListeners,
        );
        const subscribePolygonPointDragStart = makePolygonPointSubscribe(
            polygonPointDragStartListeners,
        );
        const subscribePolygonPointDrag = makePolygonPointSubscribe(
            polygonPointDragListeners,
        );
        const subscribePolygonPointDragEnd = makePolygonPointSubscribe(
            polygonPointDragEndListeners,
        );


        // ズーム中（ホイール入力〜慣性減衰）か否かを判定する。ホイールが idle かつ radius が
        // フレーム間で settle したら「ズーム終了」とみなし seat を復帰させる。
        // 地形衝突補正（clearanceBoost）や自動スクロール由来の radius 変動を「ズーム操作中」と
        // 誤判定しないよう、追加分を除いた素の radius でのみ settle を評価する。移動操作中に
        // ユーザーがホイール操作をしなければ素の radius は変わらないため、ズーム扱いにならない。
        let prevNaturalRadius = camera.radius - clearanceBoost;
        const isZoomActive = (): boolean => {
            const naturalRadius = camera.radius - clearanceBoost;
            const radiusDelta = Math.abs(naturalRadius - prevNaturalRadius);
            const settling =
                radiusDelta > ZOOM_SETTLE_RATIO * Math.max(1, naturalRadius);
            prevNaturalRadius = naturalRadius;
            return performance.now() - lastWheelTimeMs < ZOOM_PAUSE_IDLE_MS || settling;
        };

        const syncTiles = (): void => {
            const override = externalFrustumOverride;
            // Follow mode（外部 frustum）では center=機体直下地表・実カメラは水平前方視のため、
            // center 由来の tilt では前方到達距離が過小になり地平線側が未種付けの穴になる（#475）。
            // 外部 frustum から実視線 forward を導出して LOD の前方到達距離補正に渡す。通常カメラ
            // （override なし）は center が真の注視点なので補正不要＝渡さない（後方互換）。
            let viewForward: Vector3 | undefined;
            if (override && viewForwardFromFrustumPlanesToRef(override.planes, externalViewForward)) {
                viewForward = externalViewForward;
            }
            const stats = tileManager.sync({
                cameraEcef: override ? override.cameraEcef : computeCameraEcef(),
                centerEcef: camera.center,
                maxZoom: GLOBE_SCENE_DEFAULTS.maxZoom,
                viewportHeight: engine.getRenderHeight(),
                viewportWidth: engine.getRenderWidth(),
                verticalFov: camera.fov,
                sseThreshold: GLOBE_SCENE_DEFAULTS.sseThreshold,
                maxTiles: GLOBE_SCENE_DEFAULTS.maxTiles,
                rootSearchRadius: GLOBE_SCENE_DEFAULTS.rootSearchRadius,
                maxRootTiles: GLOBE_SCENE_DEFAULTS.maxRootTiles,
                horizonDotThreshold: GLOBE_SCENE_DEFAULTS.horizonDotThreshold,
                referenceAltitude: centerElevation,
                rootZoomFloor: GLOBE_SCENE_DEFAULTS.rootZoomFloor,
                frustumPlanes: override ? override.planes : computeCameraFrustumPlanes(),
                // 登録済みモデル（avatar等）は注視点と無関係な地点にいる場合があるため、視錐台の
                // 外でも最粗rootを確保し terrainElevAt/接地が機能するよう保険をかける（#463）。
                // syncTiles は onBeforeRenderObservable から毎フレーム呼ばれるため、
                // map().filter().map() の中間配列生成を避け for ループで直接詰める
                // （レビュー指摘）。
                pinnedPoints: (() => {
                    const points: { lat: number; lon: number }[] = [];
                    for (const id of modelManager.list()) {
                        const s = modelManager.get(id);
                        if (s !== null) points.push({ lat: s.lat, lon: s.lon });
                    }
                    return points;
                })(),
                textureQualityFloorZoom: GLOBE_SCENE_DEFAULTS.textureQualityFloorZoom,
                viewForward,
                // ズーム速度に関わらず実ビルドのフレーム集中によるガタつきを避けるため、
                // globe バックエンドは常にキュー分散モードで同期する（#501）。実ビルドの消化は
                // 毎フレーム呼ぶ drainBuildQueue() が担う（syncTiles 自体は間引き実行のまま）。
                continuous: true,
            });
            if (options.onSyncStats) {
                const geo = ecefToGeodetic(camera.center);
                options.onSyncStats({
                    ...stats,
                    latDeg: geo.latDeg,
                    lonDeg: geo.lonDeg,
                    radius: camera.radius,
                    yaw: camera.yaw,
                    pitch: camera.pitch,
                });
            }
        };

        // 注視点を地形表面へ追従させる（地表付近でカメラが地形下へ潜るのを防ぐ）。毎フレーム実行。
        // 追従強度はカメラの対地クリアランスでフェードし、十分高い位置では追従しない（高高度の
        // パンで地形の起伏に沿ってカメラ高度がばたつくのを防ぐ）。zoom-to-cursorは
        // center を毎フレーム動かすため、ズーム中（`zoomActive`）は seat を一時停止して鉛直方向の
        // 引っ張り合い（揺れの主因）を断つ。ズームが落ち着くと seat の lerp で滑らかに復帰する。
        // camAltMeters はカメラの楕円体高度（observer で 1 回だけ計算した値を共有）。
        const seatCenterOnTerrain = (camAltMeters: number, zoomActive: boolean): void => {
            const g = ecefToGeodetic(camera.center);
            const elev = tileManager.terrainElevAt(g.latDeg, g.lonDeg);
            if (elev === null) return;
            centerElevation = elev; // SSE 距離評価の基準標高（追従の有無に関わらず最新化）
            if (zoomActive) return; // ズーム中は seat を止める（鉛直の引っ張り合いを断つ）
            // カメラの対地クリアランスで追従強度をフェード（FULL 以下で完全追従、ZERO 以上で停止）。
            const clearance = camAltMeters - elev;
            const seatFactor = Math.max(
                0,
                Math.min(
                    1,
                    (SEAT_ZERO_CLEARANCE - clearance) / (SEAT_ZERO_CLEARANCE - SEAT_FULL_CLEARANCE),
                ),
            );
            if (seatFactor <= 0) return; // 十分高い → 地形に追従せず高度一定でパン
            geodeticToEcefToRef(g.latDeg, g.lonDeg, elev, seatCenter);
            // 同 lat/lon のまま高度だけ地形標高へ。残差を lerp で滑らかに（高度依存で強度を絞る）。
            // 毎フレーム呼ばれるため、LerpToRef で再利用バッファに書き割り当てを避ける。
            Vector3.LerpToRef(camera.center, seatCenter, SEAT_LERP * seatFactor, seatLerp);
            camera.center = seatLerp;
        };

        // カメラ地形衝突: カメラ位置が地形 + 最小クリアランスより低くなったら radius を増やして
        // 潜り込みを防ぐ。seat は注視点を地表へ載せるだけでカメラ自身の潜りは防がないため、
        // 近接ズーム/低高度パンの保険として明示実装する（PoC は seat による実用回避のみ）。
        // camEcef / camGeo / lookAt は observer で 1 回だけ計算したものを共有する
        // （seat → 衝突で computeCameraEcef / ecefToGeodetic を二重実行しないため）。
        const enforceGroundClearance = (camEcef: Vector3, camGeo: Geodetic): void => {
            // 外部（setAltitude / setView / ホイールズーム等、経路を問わず）が radius を直接
            // 上書きしていれば、地形衝突の追加分を破棄して現在の radius を新たな素の値として
            // 再基準化する。これをしないと stepGroundClearanceRadius が誤った naturalRadius
            // （= 現在 radius − 旧 clearanceBoost）を基準にし、ユーザー設定 radius が旧ベース値へ
            // 意図せず収束する等の挙動を招く。
            if (
                Math.abs(camera.radius - lastAppliedRadius) >
                EXTERNAL_RADIUS_EPS * Math.max(1, camera.radius)
            ) {
                clearanceBoost = 0;
            }
            const terrain = tileManager.terrainElevAt(camGeo.latDeg, camGeo.lonDeg);
            if (terrain === null) {
                // radius を変えないので次フレームの誤検知を避けるため基準値を現在値に同期する。
                lastAppliedRadius = camera.radius;
                return;
            }
            // radius あたりのカメラ高度増加率 = カメラ地心 up・(center→camera 単位方向)。
            // center→camera 単位方向は -lookAt/|lookAt|。computeCameraEcef は lookAt を
            // radius 倍にスケール済み（|lookAt|=radius）なので、内積を |camEcef|·radius で割って
            // 単位ベクトル同士の内積へ正規化する。
            const denom = Math.max(1, camEcef.length()) * Math.max(1, camera.radius);
            const dAltPerRadius =
                -(camEcef.x * lookAt.x + camEcef.y * lookAt.y + camEcef.z * lookAt.z) / denom;
            // 追加分(clearanceBoost)を除いた素の radius/高度を基準にスムーズ補間で 1 フレーム進める。
            // これにより radius がアニメーション無しで一段に跳ねず、障害が解消すれば追加分が戻る
            // （単調増加を避ける）。
            const stepped = stepGroundClearanceRadius(
                camera.radius,
                clearanceBoost,
                camGeo.altMeters,
                terrain,
                MIN_GROUND_CLEARANCE,
                dAltPerRadius,
                GROUND_CLEARANCE_PUSH_LERP,
                GROUND_CLEARANCE_RELAX_LERP,
            );
            camera.radius = stepped.radius;
            clearanceBoost = stepped.boost;
            lastAppliedRadius = camera.radius;
        };

        // ---- 視点モード 2D/3D ----
        // GeospatialCamera を ORTHOGRAPHIC + pitch=0（トップダウン）へ切替え、Web メルカトル相当の
        // 2D 正射表示にする。タイルは同一 tileManager 共有のため自動成立する（globeTileManager 無改変）。
        // 3D パスは不変（2D 限定の分岐を追加するのみ）。
        const initialViewMode: ViewMode = options.viewMode ?? "3d";
        let currentViewMode: ViewMode = initialViewMode;
        // 3D 復帰時に戻す pitch[rad]（2D 切替直前を保存）。初期 pitch（tilt 由来）を既定とする。
        let savedPitch = camera.pitch;

        // 2D の正射フラスタムを radius・アスペクトから設定する（撤去済み平面版と同式）。
        // perspective でターゲット平面に映る範囲 = radius * tan(fov/2) と一致させる。
        const applyOrthoFrustum = (): void => {
            const w = engine.getRenderWidth();
            const h = engine.getRenderHeight();
            if (w <= 0 || h <= 0) return;
            const aspect = w / h;
            const halfH = camera.radius * Math.tan(camera.fov / 2);
            const halfW = halfH * aspect;
            camera.orthoTop = halfH;
            camera.orthoBottom = -halfH;
            camera.orthoLeft = -halfW;
            camera.orthoRight = halfW;
        };

        const setOverlayFlatten = (flat: boolean): void => {
            markerManager.setFlatten(flat);
            polygonManager.setFlatten(flat);
            circleManager.setFlatten(flat);
        };

        // viewMode 切替直後に 1 回だけオーバーレイを現在カメラで再アンカーする。これをしないと、
        // setOverlayFlatten で flat フラグだけが先に変わり、実際の位置・スケール再計算は次フレームの
        // 毎フレーム update まで遅延するため、切替直後の 1 フレームだけ「ポールは消えたのにアイコンは
        // 先端位置のまま」等の不整合（チラつき）が出る。毎フレームループと同じ camEcef/flatScale
        // を用いて同期する。
        const reanchorOverlaysForViewMode = (mode: ViewMode): void => {
            const camEcef = computeCameraEcef();
            const flatScale =
                mode === "2d" ? camera.radius / OVERLAY_REF_DISTANCE_M : undefined;
            markerManager.update(camEcef);
            polygonManager.update(camEcef, flatScale);
            circleManager.update(camEcef, flatScale);
        };

        const applyViewModeInternal = (
            next: ViewMode,
            opts?: { silent?: boolean; force?: boolean },
        ): void => {
            if (next === currentViewMode && !opts?.force) return;
            if (next === "2d") {
                // 3D→2D の初回のみ現在 pitch を保存（force 再適用で 0 を保存しないようガード）。
                if (currentViewMode === "3d") savedPitch = camera.pitch;
                // GeospatialCamera は pitch を limits.pitchMin(≈ε) でクランプし、looking-straight-down
                // を内部で安定化（yaw は保持）。論理 tilt=0 のトップダウンとして扱う。
                camera.pitch = 0;
                camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
                applyOrthoFrustum();
                setOverlayFlatten(true);
                // 2D は skymap 無し。3D 分岐の宇宙黒への高度連動 lerp を行わないため、
                // 背景を一定の昼空色へ固定する（3D 復帰時は次フレームの clearColor ループが上書き）。
                scene.clearColor.set(DAY_SKY_COLOR.r, DAY_SKY_COLOR.g, DAY_SKY_COLOR.b, 1);
            } else {
                camera.mode = Camera.PERSPECTIVE_CAMERA;
                camera.pitch = savedPitch;
                setOverlayFlatten(false);
            }
            currentViewMode = next;
            // setOverlayFlatten 直後に 1 回だけ再アンカーし、切替フレームの不整合を防ぐ。
            reanchorOverlaysForViewMode(next);
            if (!opts?.silent) options.onViewModeChange?.(next);
        };

        const getZoomLevel = (): number | undefined => {
            // 2D のみズームレベルを公開する（3D は radius=高度で zoomLevel 概念を持たない）。
            if (currentViewMode !== "2d") return undefined;
            const h = engine.getRenderHeight();
            if (h <= 0) return undefined;
            const g = ecefToGeodetic(camera.center);
            return clampZoomLevel(
                radiusToZoomLevel(camera.radius, h, g.latDeg, camera.fov),
            );
        };

        // render ループは開始しない。DefaultScene と同じく、シーン生成と render ループ管理の
        // 責務を分離し、ループ開始は呼び出し側（デモ / 将来の JpmapTerrain 等）に委ねる
        // （二重起動・上書きを防ぐ）。本シーンのタイル同期は onBeforeRenderObservable で動く。
        //
        // 初回同期は構築中ではなく onBeforeRender（= 呼び出し側がループ開始した後）に遅延する。
        // 構築中に同期実行すると、呼び出し側の onSyncStats が「createSceneWithController の
        // 戻り値から代入される controller」をまだ初期化前に参照し TDZ エラーになるため。
        // frame=0 の最初のフレームで即同期し、以降は syncIntervalFrames ごとに再評価する。
        let frame = 0;
        // 時刻連動の背景基調色。controller が deriveSkyColor で更新する。
        // 初期値は昼空色（dateTime 反映前のフォールバック）。
        const skyBaseColor = DAY_SKY_COLOR.clone();
        const observer = scene.onBeforeRenderObservable.add(() => {
            applyKeyboardPan();
            // 2D（トップダウン正射）: 毎フレーム pitch=0 を再代入してチルト操作を無効化し、
            // radius/リサイズに追従して ortho フラスタムを更新する。
            if (currentViewMode === "2d") {
                camera.pitch = 0;
                applyOrthoFrustum();
            }
            // カメラ ECEF と測地座標・lookAt を 1 フレーム 1 回だけ計算し、seat と衝突で共有する
            // （ComputeLookAtFromYawPitchToRef と測地変換の二重実行を避ける）。seat は center を
            // わずかに動かすため衝突はその直前のスナップショットを使うが、毎フレーム補正のため実用上問題ない。
            const camEcef = computeCameraEcef(); // lookAt バッファも更新される
            const camGeo = ecefToGeodetic(camEcef);
            if (currentViewMode === "3d") {
                // 高度連動の背景暗化（高高度ほど宇宙の黒へ）。。
                // 真の測地高度 altMeters を用い、約 12km から暗化開始・75km でほぼ黒に収束させる。
                const spaceFactor = computeSpaceFactor(camGeo.altMeters);
                // 毎フレーム Color3 を新規生成しないよう、各チャンネルを直接 lerp して set する。
                // 基調色は時刻連動の skyBaseColor（昼=青/夜=紺/日の出入り=茜）。
                scene.clearColor.set(
                    skyBaseColor.r + (SPACE_SKY_COLOR.r - skyBaseColor.r) * spaceFactor,
                    skyBaseColor.g + (SPACE_SKY_COLOR.g - skyBaseColor.g) * spaceFactor,
                    skyBaseColor.b + (SPACE_SKY_COLOR.b - skyBaseColor.b) * spaceFactor,
                    1,
                );
                // ズーム中（ホイール〜慣性減衰）は seat を止め、鉛直の引っ張り合いによる揺れを防ぐ。
                seatCenterOnTerrain(camGeo.altMeters, isZoomActive());
                enforceGroundClearance(camEcef, camGeo);
            } else {
                // 2D: 宇宙黒 lerp / seat / 対地クリアランスはスキップ（高度・物理・日照表現なし）。
                // SSE 評価の基準標高 centerElevation のみ最新化し、タイル LOD を正しく保つ。
                const g = ecefToGeodetic(camera.center);
                const elev = tileManager.terrainElevAt(g.latDeg, g.lonDeg);
                if (elev !== null) centerElevation = elev;
            }
            // マーカーの接地・距離スケール更新（フレーム共有の camEcef を渡す）。
            markerManager.update(camEcef);
            // 2D 正射では、頂点高度やパンに依らず画面上サイズを一定に保つため、距離由来ではなく
            // radius 比例の固定スケールをポリゴン/サークルへ渡す（ortho フラスタムと相殺してマーカー
            // 同等になる）。3D（undefined）は従来の距離由来スケールを使う。
            const flatScale =
                currentViewMode === "2d"
                    ? camera.radius / OVERLAY_REF_DISTANCE_M
                    : undefined;
            // ポリゴンの地形再ドレープ（アウトライン・壁）と距離スケール更新（点/ラベル配置）。
            polygonManager.update(camEcef, flatScale);
            // サークルの地形再ドレープと距離スケール更新（点/ラベル配置）。
            circleManager.update(camEcef, flatScale);
            // モデルの接地・起立更新。
            modelManager.tick();
            if (frame % GLOBE_SCENE_DEFAULTS.syncIntervalFrames === 0) syncTiles();
            // 実ビルド（Mesh/Geometry/Texture 生成）を複数フレームへ分散するため、syncTiles の
            // 間引き周期とは独立して毎フレーム消化する（#501）。キューが空なら早期 return で
            // コストはごく小さい。
            tileManager.drainBuildQueue();
            frame++;
        });

        // 初期視点モードを反映する。silent で初期 listener は発火させない。
        // "3d" は既定の perspective + pitch のままなので force 適用は 2d のみで足りる。
        if (initialViewMode === "2d") {
            applyViewModeInternal("2d", { silent: true, force: true });
            // URL 等から zoomLevel 指定があれば radius へ変換する。
            if (options.zoomLevel !== undefined) {
                const h = engine.getRenderHeight();
                if (h > 0) {
                    const g = ecefToGeodetic(camera.center);
                    camera.radius = zoomLevelToRadius(
                        options.zoomLevel,
                        h,
                        g.latDeg,
                        camera.fov,
                    );
                    // radius 変更後に ortho フラスタムとオーバーレイ再アンカーをやり直し、
                    // 初期化直後（最初の描画フレーム前）に古い radius のまま 1 フレーム不整合に
                    // なるのを防ぐ（applyViewModeInternal は radius 更新前に一度走っているため）。
                    applyOrthoFrustum();
                    reanchorOverlaysForViewMode("2d");
                }
            }
        }

        const dispose = (): void => {
            // render ループは呼び出し側の所有なので停止しない（呼び出し側が停止する）。
            scene.onBeforeRenderObservable.remove(observer);
            canvas.removeEventListener("keydown", onKeyDown);
            canvas.removeEventListener("keyup", onKeyUp);
            canvas.removeEventListener("blur", clearPressed);
            window.removeEventListener("blur", clearPressed);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", onPointerCancel);
            canvas.removeEventListener("pointermove", onPointerMove);
            detachClickHandlers();
            terrainClickListeners.length = 0;
            detachPolygonPointHandlers();
            polygonPointHoverListeners.length = 0;
            polygonPointClickListeners.length = 0;
            polygonPointDragStartListeners.length = 0;
            polygonPointDragListeners.length = 0;
            polygonPointDragEndListeners.length = 0;
            markerManager.dispose();
            polygonManager.dispose();
            circleManager.dispose();
            modelManager.dispose();
            tileManager.dispose();
            scene.dispose();
        };

        return {
            scene,
            camera,
            tileManager,
            markerManager,
            polygonManager,
            circleManager,
            modelManager,
            sunLight: sun,
            hemiLight: hemi,
            sunMesh,
            skyBaseColor,
            subscribeTerrainClick,
            subscribePolygonPointHover,
            subscribePolygonPointClick,
            subscribePolygonPointDragStart,
            subscribePolygonPointDrag,
            subscribePolygonPointDragEnd,
            getViewMode: () => currentViewMode,
            setViewMode: (mode: ViewMode) => applyViewModeInternal(mode),
            getZoomLevel,
            // 外部カメラ（flight FollowCamera 等）の真の視錐台6平面＋ECEF位置を次回 syncTiles に
            // 反映する（#463）。null 指定で通常カメラ（GeospatialCamera）算出へ復帰する。
            // 契約は「6平面」なので枚数を検証し、6平面かつ ECEF 位置が揃うときのみ override を
            // 有効化する。6平面以外（空配列・不完全な配列）だと selectGlobeTiles 側で視錐台
            // カリングが暗黙に無効化される／部分平面で誤判定するため、その場合は override を解除する。
            setExternalFrustum: (planes: FrustumPlane[] | null, cameraEcefPos: Vector3 | null) => {
                if (planes && planes.length === 6 && cameraEcefPos) {
                    // 呼び出し側のスクラッチ（配列/Vector3）を直接保持せず、永続バッファへ即座に
                    // コピーする（呼び出し側が同じ参照を次回呼び出しで書き換えても安全）。
                    externalFrustumCameraEcef.copyFrom(cameraEcefPos);
                    for (let i = 0; i < 6; i++) {
                        const src = planes[i];
                        const dst = externalFrustumPlanesBuffer[i];
                        dst.normal.x = src.normal.x;
                        dst.normal.y = src.normal.y;
                        dst.normal.z = src.normal.z;
                        dst.d = src.d;
                    }
                    externalFrustumOverride = {
                        planes: externalFrustumPlanesBuffer,
                        cameraEcef: externalFrustumCameraEcef,
                    };
                } else {
                    externalFrustumOverride = null;
                }
            },
            dispose,
        };
    }
}
