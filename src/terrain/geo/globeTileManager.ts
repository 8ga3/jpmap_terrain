/**
 * グローブ地形タイルのライフサイクル管理。
 *
 * 平面版 `src/terrain/tileManager.ts` のグローブ（ECEF）相当。`globeLod` で可視タイルを
 * 選択し、`globeMesh` のジオメトリ + 地理院タイル画像テクスチャから Babylon `Mesh` を
 * 組み立て、不要になったメッシュ・標高キャッシュを破棄する。floating origin 下での
 * メモリ/ライフサイクルを担う。データ取得層（`gsiTile.loadElevationTile` /
 * `textureUrl`）は温存して流用する。
 *
 * 標高 z15／テクスチャ z18 のデカップリング:
 * - ジオメトリは geom タイル（<= geomMaxZoom=z15）からサブサンプル。
 * - テクスチャは描画 zoom（<= maxZoom=z18）。
 * - z16-18 は z15 祖先の標高を共有し、geom キャッシュ上でデデュプされる。
 */
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { FrustumPlane } from "../visibleTiles";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import {
    loadElevationTile,
    textureUrl,
    toTileXY,
    tileCenterLatLon,
    TILE_SIZE,
    isAllNaN,
    isInvalidElev,
    fillInvalidPixels,
    TileFetchError,
    type MapType,
} from "../gsiTile";
import { stitchTileEdges, type StitchNeighbors } from "../tileStitching";
import { ecefToGeodetic } from "./ecef";
import { latLonToPixel, totalPixelsForZoom } from "./mapping";
import { selectGlobeTiles, tileKey, type GlobeTile } from "./globeLod";
import { selectCoarseEdges, type CoarseEdge } from "./crossLevel";
import {
    buildGlobeTileMeshData,
    adaptiveMeshSegments,
    type GlobeTileMeshData,
} from "./globeMesh";
import { sampleElevBilinear } from "./elevSample";

/** タイルマテリアルの鏡面反射（地形なので弱め）。 */
const TILE_SPECULAR = new Color3(0.02, 0.02, 0.02);

/**
 * 海面（標高 0m）フラット標高の共有バッファ。海上など DEM が no-data で確定失敗した
 * タイルは、これを使って平坦メッシュとして建築し、GSI テクスチャ（海・海岸の画像）を描画する。
 * これがないと no-data タイルはメッシュ未生成のままで、背景スフィアの単色が見えるだけになる
 * （相模湾などで「タイルが欠ける」症状）。読み取り専用で共有（建築側で値を書き換えない）。
 */
const FLAT_SEA_ELEV = new Float32Array(TILE_SIZE * TILE_SIZE);

/**
 * 常時表示の粗いベースレイヤの zoom。全球を 4^zoom 枚の固定タイルで覆う
 * （z2=16枚）。地理院タイルは std/seamlessphoto が z0〜供給されるため z2 をマッピングできる。
 * ズームアップ／回転で地平線の縁へ新規に回転インするタイルは、自身も全祖先も未ロードのため
 * LOD シームレス機構（pendingRelease / 祖先カバー）では橋渡しできず、テクスチャ到着まで背景球
 * （青）が一瞬透ける。この粗タイル集合を恒久背景として常時描画し、露出を防ぐ。
 */
const BASE_LAYER_ZOOM = 2;

/**
 * geom 標高タイルが全 DEM レイヤー 404 のとき、何段階まで粗ズーム DEM へフォールバックして
 * 切り出すか。DEM5 非整備領域では dem_png の最大 zoom=14 を超える z15 geom が 404 に
 * なるため、最低 1 段（z15→z14）で十分だが、深い欠落にも耐えるよう数段許す。失敗時のみ発動。
 */
const GEOM_ELEV_FALLBACK_DEPTH = 4;

/**
 * ベースレイヤ 1 タイルあたりの分割数。マネージャ既定（globe 32）より細かくする。
 * z2 タイルは 90° 角を張るため、分割が粗いとメッシュ（三角形弦）が真球面から大きく内側へたるみ
 * （32 分割で最大 ~3840m）、地平線（limb）でタイルが背景球より内側に退いて青球が縁から透ける。
 * 96 分割でたるみを ~430m まで抑え、地平線をベースのテクスチャ面で覆う（背景球露出を防ぐ）。
 * 全球 16 枚・一度きりの生成なので頂点数増（~150k）は常時保持でも軽微。
 */
const BASE_LAYER_SEGMENTS = 96;

/**
 * ベースレイヤのテクスチャ到着前の塗り色（海色）。背景球と同系色にして、初回ロード前の
 * 白フラッシュや青球露出を避ける。テクスチャ到着後は地理院タイル画像へ差し替わる。
 */
const BASE_LAYER_OCEAN = new Color3(0.16, 0.26, 0.36);

/**
 * ベースレイヤのテクスチャ到着後の diffuseColor（白）。StandardMaterial は diffuseTexture に
 * diffuseColor を乗算するため、暫定の海色（BASE_LAYER_OCEAN）のままだと地図画像が暗く青く
 * ティントされる。テクスチャ設定時に白へ戻し、LOD タイル（diffuseColor 既定=白）と同じ発色にする。
 */
const BASE_LAYER_TEXTURE_TINT = new Color3(1, 1, 1);

/**
 * ベースレイヤに低ズーム世界地図テクスチャ（GSI std/photo の z2, 緑主体の世界地図スタイル）を
 * 適用する最小カメラ高度[m]。これ未満（低〜中高度）は海色（BASE_LAYER_OCEAN）のままにする。
 * 低高度・高チルトで地平線際を見ると、grazing で LOD メッシュが投影されない画素に常時表示の
 * base が透け、緑の世界地図が日本詳細地図（白＋等高線）と混在して破綻する（#465）。base の
 * 役割は「背景球（濃紺）の露出防止」の充填であり、低ズーム世界地図の絵を見せることは低〜中高度
 * では不要（可視域は LOD が覆う）。高高度（全球表示）でのみ地図を適用する。しきい値は globeLod の
 * 全球モード境界（`GLOBAL_VIEW_EARTH_ANG_RADIUS`≒高度 1,200km）に揃える。
 */
const BASE_MAP_MIN_ALT_M = 1_200_000;

/**
 * 標高が視覚的に意味を持つとみなす、固定 minZoom 判定の代替として使うカメラ距離上限 [m]。
 * `globeLod` の SSE 距離累進（`SSE_FALLOFF_RATE`）により、低高度から遠方（例: 東京駅〜富士山
 * 間 ≈100km）を注視すると root zoom が minZoom を下回ることがあるが、この距離帯は実 DEM が
 * あれば地形表現が重要（#457）。東京駅（丸の内）〜富士山山頂の実距離は約100.5km あり、
 * これを確実に含むよう 150km（100.5km に対し十分な安全マージンを確保した値）を選んでいる。
 * 全球視点（`GLOBAL_VIEW_EARTH_ANG_RADIUS` 相当、高度 ≳1,200km で発生する distance）には
 * 影響しないよう、全球距離とは一桁近く離れた値に設定する。
 * 注: この閾値は東京〜富士山ケースに限らず、「zoom<minZoom かつ distance≤150km」に該当する
 * 全タイル（中高度からの広域見渡し視点等）に一様適用される。
 */
const ELEVATION_RELEVANT_MAX_DISTANCE_M = 150_000;

/** 標高タイル取得失敗時の再試行バックオフ初期値 [ms]。 */
const FAILED_RETRY_BASE_MS = 5_000;
/** 同・上限 [ms]（no-data タイルを叩き続けないための頭打ち）。 */
const FAILED_RETRY_MAX_MS = 5 * 60_000;

/** attempts 回失敗したタイルの次回再試行までのバックオフ [ms]（指数・上限付き）。 */
const retryBackoffMs = (attempts: number): number =>
    Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_BASE_MS * 2 ** (attempts - 1));

/**
 * LOD 遷移中に残した旧タイルを強制解放するまでのタイムアウト [ms]（平面版と同値）。
 * 新タイルのテクスチャ/標高が揃わずカバー判定が成立しない場合の安全網。短すぎると遷移途中で
 * 背景球が見え、長すぎると古い LOD のタイルが残ってちらつく。
 */
const PENDING_RELEASE_TIMEOUT_MS = 5_000;

/**
 * LOD シームレス遷移（pendingRelease / hiddenChild / カバー判定）で祖先タイルを探索する際の
 * 最下限 zoom。manager の `minZoom`（標高が視覚的に意味を持つ下限。グローブ既定 11）とは別概念で、
 * selectGlobeTiles は `rootZoomFloor`(既定 2) まで粗いタイルを返すため、祖先探索を `minZoom` で
 * 打ち切ると zoom 11 未満の LOD 遷移で祖先が一切見つからず、旧タイルが即破棄されて背景球が
 * ちらつく。四分木の全祖先を対象にするため floor は 0 とする（探索回数は最大でも zoom 段数）。
 */
const SEAMLESS_FLOOR_ZOOM = 0;


export interface GlobeTileManagerOptions {
    /** タイルメッシュを生成するシーン。 */
    scene: Scene;
    /** 地図種別（std / photo）。 */
    mapType: MapType;
    /** 最低ズーム（root）。 */
    minZoom: number;
    /** ジオメトリ（標高）の最高ズーム。GSI DEM は z15 まで。 */
    geomMaxZoom: number;
    /** タイルあたりの分割数。 */
    segments: number;
    /** クロスレベル標高スナップを有効化するか。 */
    snapEnabled: boolean;
}

/** 1 回の LOD 同期で必要なカメラ・ビュー状態。 */
export interface GlobeTileSyncParams {
    /** カメラの真の ECEF 位置。 */
    cameraEcef: Vector3;
    /** root 探索中心の注視点 ECEF（カメラ center）。 */
    centerEcef: Vector3;
    /** 最高ズーム（テクスチャ）。 */
    maxZoom: number;
    /** ビューポート高さ [px]。 */
    viewportHeight: number;
    /** ビューポート幅 [px]（水平 FOV＝横方向被覆の算出に使用）。 */
    viewportWidth: number;
    /** 垂直 FOV [rad]。 */
    verticalFov: number;
    /** SSE 採用しきい値 [px]。 */
    sseThreshold: number;
    /** 同時保持タイル数の上限。 */
    maxTiles: number;
    /** root 帯の横半幅／後方マージン（±N 格子）。 */
    rootSearchRadius: number;
    /** root 帯に張る minZoom タイル数の予算（上限）。 */
    maxRootTiles: number;
    /** 地平線カリングの内積しきい値。 */
    horizonDotThreshold: number;
    /** SSE 距離評価の基準標高 [m]（中心付近の地形標高）。 */
    referenceAltitude: number;
    /** 遠景 root の最粗 zoom（距離適応ルートレベルの下限）。省略時 minZoom。 */
    rootZoomFloor?: number;
    /**
     * カメラの真の視錐台6平面。**camera 相対**（原点 = `cameraEcef`、回転のみ・並進なし）で
     * 定義すること（`globeLod.ts` の `GlobeLodOptions.frustumPlanes` 参照。ECEF 原点基準で渡すと
     * Float32 行列の桁落ちで誤カリングする）。指定時、視錐台外タイルの探索を打ち切る（#463）。
     * 省略時は従来通り帯モデル＋地平線カリングのみで判定する。
     */
    frustumPlanes?: readonly FrustumPlane[];
    /**
     * 視錐台に関わらず必ず最粗root(minZoom)を確保したい地点（`globeLod.ts` の
     * `GlobeLodOptions.pinnedPoints` 参照。centerEcef自体は暗黙に対象）。省略時は空。
     */
    pinnedPoints?: readonly { lat: number; lon: number }[];
    /**
     * 距離適応 root zoom がこれより粗くならないようにする下限（`globeLod.ts` の
     * `GlobeLodOptions.textureQualityFloorZoom` 参照）。省略時は無効。
     */
    textureQualityFloorZoom?: number;
    /**
     * 実カメラ視線 forward（ECEF 向きベクトル。`globeLod.ts` の `GlobeLodOptions.viewForward`
     * 参照）。Follow mode で center と実視線が乖離する経路の前方到達距離補正に使う。省略時は無効。
     */
    viewForward?: Vector3;
    /**
     * ズームループ等、カメラを毎フレーム連続的に動かし続けるシナリオ向けのフラグ（#501）。
     * `true` の場合、新規/変化タイルの実ビルド（Mesh/Geometry/Texture 生成）を即座に行わず
     * `pendingBuilds` へ積む。呼び出し側は `drainBuildQueue` を毎フレーム呼んでキューを消化する
     * こと。省略時（既定）は従来通り `sync` 呼び出し内で同期的に全件ビルドする。
     */
    continuous?: boolean;
}

/** 同期結果の統計。 */
export interface GlobeTileSyncStats {
    /** 選択された可視タイル。 */
    selected: readonly GlobeTile[];
    /** 選択タイルの最小 zoom（選択なしは null）。 */
    minZoom: number | null;
    /** 選択タイルの最大 zoom（選択なしは null）。 */
    maxZoom: number | null;
    /** 現在ロード済みのメッシュ数（loaded Map のみ。画面に残る pendingRelease は含まない）。 */
    loadedCount: number;
    /**
     * LOD 遷移中に画面へ残している pendingRelease タイル数（loaded には含まれないが
     * シーン上に描画され得るメッシュ）。loadedCount と区別して公開する。
     */
    pendingCount: number;
    /** ロード中の標高タイル数。 */
    loadingCount: number;
}

/**
 * LOD 遷移中に画面へ残す旧タイル（平面版の PendingReleaseTile 相当）。
 * 新タイルが描画可能になるまで表示を維持し、カバー完了 or タイムアウトで解放する。
 */
interface PendingTile {
    /** 表示を維持する旧メッシュ。 */
    mesh: Mesh;
    /** 旧タイルの zoom/x/y（祖先・子孫判定に使う）。 */
    zoom: number;
    x: number;
    y: number;
    /** 強制解放用タイマーID。 */
    timerId: ReturnType<typeof setTimeout>;
}

export interface GlobeTileManager {
    /** カメラ状態に応じて可視タイルを再選択し、ロード/ビルド判定/破棄する。 */
    sync: (params: GlobeTileSyncParams) => GlobeTileSyncStats;
    /**
     * `sync` に `continuous: true` を渡した際に積まれるビルドキューを高々数件だけ消化する
     * （#501）。`sync` とは独立に**毎フレーム**呼ぶことを想定しており、ズーム速度上昇時に発生
     * する大量 LOD 切替の実ビルド（Mesh/Geometry/Texture 生成）を複数フレームへ分散し、
     * 1 フレームへの処理集中によるガタつきを防ぐ。キューが空なら何もしないため、
     * `continuous` を使わない既存デモで毎フレーム呼んでもコストはごく小さい。
     */
    drainBuildQueue: () => void;
    /**
     * 緯度経度の地形標高[m]を、ロード済みの最も詳細な geom タイルから bilinear 取得。
     * geomMaxZoom→minZoom を探索し最初に見つかったものを使う（無ければ null）。
     */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
    /**
     * 地形が idle（安定）かを返す。テスト用（ビジュアル回帰の安定待ち）。
     * 初回 sync 済み かつ 標高ロード中タイルが無い（loadingCount===0）かつ
     * LOD 遷移で残している pendingRelease が無い（pendingCount===0）かつ
     * 現在の希望タイル(desiredKeys)がすべてロード済み＆テクスチャ適用済み（readyMeshes）のとき true。
     * 平面版 `tileManager.isIdle` 相当の安定判定を globe で提供する。
     */
    isIdle: () => boolean;
    /** 現在の地図種別（"std"/"photo"）。 */
    getMapType: () => MapType;
    /**
     * 地図種別を実行時に切り替える。
     * 現在ロード済みの LOD タイル・LOD 遷移中の pendingRelease タイル・常時表示ベースレイヤの
     * 各メッシュのテクスチャを新しい mapType の URL で差し替える（新テクスチャ onLoad で適用し
     * 旧テクスチャを破棄）。以降に sync が新規生成するタイルも新 mapType の URL を参照する。
     * 同値なら no-op。
     */
    setMapType: (mapType: MapType) => void;
    /** 全メッシュ・キャッシュを破棄する。 */
    dispose: () => void;
}

/**
 * グローブ地形タイルマネージャを生成する。
 */
export const createGlobeTileManager = (
    opts: GlobeTileManagerOptions,
): GlobeTileManager => {
    const { scene, minZoom, geomMaxZoom, segments, snapEnabled } = opts;
    // terrainElevAt の距離ゲート基準かつ buildReadyTiles の elevRelevantGeom 追加基準となる gz。
    // これ未満の gz（遠景で minZoom を下回る距離適応タイル）だけを距離ゲートの対象にする。
    // minZoom > geomMaxZoom（例: ?zoom=18）では最も細かい実タイルが gz=geomMaxZoom になるため、
    // min(minZoom, geomMaxZoom) を基準にして geomMaxZoom を無条件採用する（seat-on-terrain 維持）。
    // 両所で同じ基準を参照して条件のドリフトを防ぐ。
    const gateBelowGz = Math.min(minZoom, geomMaxZoom);
    // 地図種別は実行時に切替可能。buildTile / buildBaseLayer のテクスチャ URL は
    // この可変値を参照するため、以降の新規タイルは切替後の mapType を使う。
    let currentMapType: MapType = opts.mapType;

    const loaded = new Map<string, Mesh>();
    // 常時表示の粗いベースレイヤのメッシュ（key="z/x/y"）。LOD の loaded とは別管理で
    // sync の選択/解放対象に含めず、マネージャ生存中ずっと保持する（新規回転インタイルの背景）。
    const baseLoaded = new Map<string, Mesh>();
    // #465: base タイルのロード済みテクスチャ（key="z/x/y"）。高度に応じて地図適用/海色を
    // 切り替えるため保持する。適用は wantBaseMap()（カメラ高度依存）で判定する。
    const baseTex = new Map<string, Texture>();
    // 直近カメラ高度[m]。初回 sync 前は Infinity（＝高高度扱いで従来どおり base 地図を適用）。
    let lastCamAltMeters = Number.POSITIVE_INFINITY;
    // 現在 base に地図テクスチャを適用中か（トグル差分検出用）。
    let baseMapApplied = true;
    /** カメラ高度に基づき base へ地図テクスチャを適用すべきか（未満は海色充填）。 */
    const wantBaseMap = (): boolean => lastCamAltMeters >= BASE_MAP_MIN_ALT_M;
    // 各ロード済みタイルがどのクロスレベル coarse-edge 集合で建築されたかの署名。
    // LOD 再評価で隣接関係（同 zoom 隣接 ⇄ 粗タイル隣接）が変わると署名が変化し、
    // ジオメトリを再構築してスナップを更新する（境界の陰影シームを残さないため）。
    const builtEdgeSig = new Map<string, string>();
    const loading = new Set<string>();
    // クロスレベルスナップのため、ビルド後も標高配列を保持する（隣接細タイルが参照）。
    const elevCache = new Map<string, Float32Array>();
    // 元データが all-NaN（湖面・no-data 領域全面）だった geom タイルキーの集合。
    // 取得直後は隣接が未ロードでシードが無いため穴埋めできない。隣接の補間結果が揃い次第
    // `refineAllNaNTiles` で同 zoom 隣接からシードして反復補間する。解決したらこの集合から外す。
    const allNanGeom = new Set<string>();
    // #459: gz<minZoom（遠景で距離適応 root zoom が minZoom を下回ったタイル）のうち、
    // buildReadyTiles が「標高が視覚的に意味を持つ」（カメラ距離 <=
    // ELEVATION_RELEVANT_MAX_DISTANCE_M）と判定した geom タイルキーの集合。terrainElevAt は
    // gz<minZoom の標高を、この集合に載るものだけ採用する（全球視点の超粗タイルで誤った
    // 標高を返さないための距離ゲート。距離が離れて無意味になれば buildReadyTiles で外す）。
    const elevRelevantGeom = new Set<string>();
    // all-NaN タイルの粗ズーム祖先 DEM から得た代表標高（湖面標高近似）のキャッシュ。
    // 視界が全面水面で同 zoom に有効タイルが一切無い場合（大きな湖を z15 で接写等）、
    // 同 zoom 縫い合わせも視界内代表標高レスキューも効かない。粗ズーム祖先タイルは
    // 湖岸（陸地）を含むため、その有効ピクセル平均を湖面標高として平坦化に用いる。
    const coarseSeed = new Map<string, number>(); // geomKey → 代表標高[m]
    const coarseSeedPending = new Set<string>(); // 粗ズーム取得中の geomKey
    const coarseSeedDone = new Set<string>(); // 粗ズーム取得を試行完了した geomKey（成否問わず）
    // 粗ズームタイル取得結果のメモ（coarseKey `z/x/y` → 標高配列 or null）。
    // 同一湖の複数 all-NaN タイルが同じ粗タイルを参照するため取得を重複させない。
    const coarseTileMemo = new Map<string, Promise<Float32Array | null>>();
    // 直近に得られた有効な代表標高[m]（視界内有効タイル平均または粗ズーム祖先標高）。
    // 大きな湖へ陸地から接近して全面水面になった瞬間でも、直前まで見えていた湖岸標高を
    // 暫定代表として保持し、未解決 all-NaN タイルを生 NaN(=0m クレーター) ではなく湖面相当で
    // 平坦化するために用いる（粗ズーム取得が完了するまでの同期フォールバック）。
    let lastRepElev: number | undefined;
    // 直近 sync の referenceAltitude（カメラ中心地表標高）。代表標高の最終フォールバック。
    let lastReferenceAltitude = 0;
    // 取得失敗した geom タイルのバックオフ状態（キー → 再試行可能時刻[ms] と試行回数）。
    // `loadElevationTile` は no-data(404) と一時的なネットワーク障害の双方で throw し、
    // 投げられたエラーから両者を区別できない。失敗を永続化すると一時障害でも地形が恒久
    // 欠落するため、指数バックオフで再試行する（no-data は再試行しても成功しないが、上限間隔で
    // 抑制される）。
    const failedRetryAt = new Map<string, { retryAt: number; attempts: number }>();
    // sync ごとにまとめてログするための、新たに取得失敗した geom タイルキー。
    // GSI 側に標高データが無い箇所（no-data/404）は珍しくなく、per-tile 警告だとログが
    // 溢れるため、sync 時に 1 行へ間引いて出力する。
    const newlyFailed: string[] = [];
    // 直近の LOD 選択キー集合（取得完了時に「まだ必要か」を判定するために参照する）。
    let desiredKeys = new Set<string>();

    // --- ビルド予算キュー（#501対策） ---
    // `buildReadyTiles` は「判定（sig比較・穴埋め・縫合入力の準備）」と「実ビルド（Mesh/Geometry/
    // Texture生成）」を分離する。判定は毎 sync（`syncIntervalFrames` 毎）で全 tiles に対して行うが
    // 軽量。実ビルドは重い（GPU リソース生成を伴う）ため、`drainBuildQueue` で 1 回の呼び出しあたり
    // `TILE_BUILD_TIME_BUDGET_MS` の実測時間予算内だけ処理し、残りは次回以降の呼び出しへ持ち越す。
    // `globe.ts` はこれを毎フレーム呼ぶことで、ズーム速度上昇時に発生する大量 LOD 切替を
    // 複数フレームへ分散し、1 フレームに同期処理が集中してガタつくのを防ぐ（#501）。
    interface BuildJob {
        tile: GlobeTile;
        /** 縫合・暫定平坦化まで適用済みの、建築に使う最終標高配列。 */
        geomElev: Float32Array;
        segs: number;
        edges: readonly CoarseEdge[];
        sig: string;
    }
    /** 実ビルド待ちのジョブ（key="z/x/y" → job）。同キー再登録は最新の判定結果で上書きする。 */
    const pendingBuilds = new Map<string, BuildJob>();
    /** `drainBuildQueue` 1 回あたりの目標処理時間予算[ms]。フレーム予算(60fps=約16.6ms)の
     * 一部のみを割り当て、他の描画・更新処理の余地を残す。 */
    const TILE_BUILD_TIME_BUDGET_MS = 4;
    /** 予算内でも際限なく処理し続けないための安全上限件数（極端に軽いタイルが大量にある場合の保険）。 */
    const TILE_BUILDS_MAX_PER_DRAIN = 16;

    // --- geom 標高ロード同時実行数制限（#501対策） ---
    // 平面版 tileManager.ts の loadTilesInQueue（DEFAULT_MAX_CONCURRENT）と同じ問題が globe 版にもある:
    // 連続カメラ移動で多数の新規タイルが一度に desired になると、それらの標高フェッチ完了
    // （デコード・レイヤー合成・穴埋め = decodeGsiElevation / fillHolesFromCoarseDem /
    // fillInvalidPixels）がほぼ同時に揃い、1 フレームに集中してガタつく。地理院タイルが実配信
    // されている領域（日本近海）は複数レイヤー合成＋穴埋めが走り重いため、この集中が特に
    // 顕著に現れる（非対応領域は 404 で即フォールバックし軽いため目立たない）。continuous
    // モード時のみ、平面版と同じ発想で同時フェッチ数を制限し、完了タイミングを分散させる。
    interface GeomLoadQueueEntry {
        gz: number;
        gx: number;
        gy: number;
        gk: string;
    }
    /** 同時実行中の geom 標高ロード数。 */
    let activeGeomLoads = 0;
    /** 同時実行数の上限を超えた継続モードのロード要求を待たせる FIFO キュー。 */
    const geomLoadQueue: GeomLoadQueueEntry[] = [];
    /** geom 標高ロードの同時実行数上限（continuous モードのみ適用）。 */
    const GEOM_LOAD_MAX_CONCURRENT = 4;

    // --- LOD シームレス遷移（平面版同等） ---
    // LOD 切替で不要になった旧タイルを即破棄せず、新タイルが描画可能になるまで画面に残す。
    // これにより zoom-in/out の遷移中にタイルが欠けて背景球が見える/ちらつくのを防ぐ。
    const pendingRelease = new Map<string, PendingTile>();
    // pendingRelease の子孫候補を高速に引くための祖先インデックス（祖先キー → pending キー集合）。
    const pendingAncestorIndex = new Map<string, Set<string>>();
    // 祖先タイルが pendingRelease 中のため、テクスチャが揃っても非表示で待機している子タイルキー。
    // 4枚（=旧粗タイル領域）が揃ったタイミングで一斉に表示して旧タイルを解放する（原子的スワップ）。
    const hiddenChildTiles = new Set<string>();
    // テクスチャ（onLoad/onError）到達で「描画可能」になったメッシュ集合。
    // mesh.isEnabled() とは独立に持つ（hiddenChild は描画可能だが非表示のため）。
    const readyMeshes = new Set<Mesh>();
    // 現在の可視タイルの全祖先キー集合（isAreaCovered / hasZoomRelation の枝刈り用）。
    let visibleAncestorKeys = new Set<string>();
    // 現在の可視タイルの最大 zoom（zoom-in カバー判定の targetZoom）。
    let currentMaxZoom = minZoom;
    // 初回 sync が実行されたか（isIdle が sync 前に誤って true を返さないためのガード）。
    let syncedAtLeastOnce = false;

    /** 描画タイル(zoom 最大18) → ジオメトリ用標高タイル(最大 geomMaxZoom=15)の対応。 */
    const geomCoordOf = (t: GlobeTile): { gz: number; gx: number; gy: number } => {
        const gz = Math.min(t.zoom, geomMaxZoom);
        const d = t.zoom - gz;
        return { gz, gx: t.x >> d, gy: t.y >> d };
    };


    /**
     * 粗ズーム親 DEM から geom タイル (gz,gx,gy) 領域を最近傍で TILE_SIZE 角に切り出す（globe 版）。
     * 平面版 `tileManager.extractSubTileElevation` と同等。切り出した raster は (gz,gx,gy) タイル
     * の地理範囲を表すため、`buildGlobeTileMeshData` から実 geom タイルと同一に扱える。
     */
    const extractSubTileElev = (
        parent: Float32Array,
        parentZoom: number,
        gz: number,
        gx: number,
        gy: number,
    ): Float32Array => {
        const diff = gz - parentZoom;
        const scale = 1 << diff;
        const subX = gx - ((gx >> diff) << diff);
        const subY = gy - ((gy >> diff) << diff);
        const out = new Float32Array(TILE_SIZE * TILE_SIZE);
        const subSize = TILE_SIZE / scale;
        const originX = subX * subSize;
        const originY = subY * subSize;
        for (let y = 0; y < TILE_SIZE; y++) {
            const sy = Math.min(
                TILE_SIZE - 1,
                Math.round(originY + (y / (TILE_SIZE - 1)) * (subSize - 1)),
            );
            for (let x = 0; x < TILE_SIZE; x++) {
                const sx = Math.min(
                    TILE_SIZE - 1,
                    Math.round(originX + (x / (TILE_SIZE - 1)) * (subSize - 1)),
                );
                out[y * TILE_SIZE + x] = parent[sy * TILE_SIZE + sx];
            }
        }
        return out;
    };

    // 粗ズーム親 DEM の in-flight フェッチを (cz/x/y) 単位で共有する。DEM5 非整備領域を広く表示すると
    // 404 フォールバックが多発し、同一親（例: z14 の 1 枚）を参照する 4 枚の子 geom タイルが同時に
    // フォールバックして同一リクエストが重複し得る。in-flight Promise を共有して重複フェッチを抑える
    // （PR レビュー）。settle 後はエントリを削除し、後続の再試行は新規取得に倒す（一時障害
    // 解消後の再取得を阻害しない）。
    const coarseParentInFlight = new Map<string, Promise<Float32Array>>();
    const loadCoarseParent = (cz: number, px: number, py: number): Promise<Float32Array> => {
        const key = `${cz}/${px}/${py}`;
        let p = coarseParentInFlight.get(key);
        if (!p) {
            p = loadElevationTile(cz, px, py);
            coarseParentInFlight.set(key, p);
            void p.catch(() => {}).finally(() => coarseParentInFlight.delete(key));
        }
        return p;
    };

    /**
     * geom タイル標高を取得する。geom zoom の `loadElevationTile` が決定的な 404（全レイヤー未配信）で
     * reject した場合（DEM5 非整備かつ dem_png の最大 zoom=14 を超える z15 山岳地帯など）に限り、平面版
     * `tileManager` と同様に粗ズーム DEM へ段階フォールバックし、該当領域を切り出して返す。粗ズームも
     * 全て失敗した場合は元の reject を再 throw する。
     *
     * 一時的な取得失敗（タイムアウト/ネットワーク障害など、`TileFetchError.status` が 404 でないもの）は
     * 粗ズームへ倒さず再 throw する。これにより `loadTile` のバックオフ再取得が働き、一時障害の解消後に
     * 高 zoom の高詳細標高へ復帰できる（粗ズームの低詳細に固定されるのを防ぐ）。
     *
     * 404 フォールバックが無いと globe は geom zoom 単一しか試さず、失敗時に標高ロード失敗 → 暫定平坦化
     * （代表標高 /0m）へ倒れ、本来の地形が「ずっと下（≒0m）」へ落ちて見える。
     */
    const loadGeomElevation = async (
        gz: number,
        gx: number,
        gy: number,
    ): Promise<Float32Array> => {
        try {
            return await loadElevationTile(gz, gx, gy);
        } catch (err) {
            // 決定的な 404（未配信）のみ粗ズームへフォールバックする。一時障害は再 throw してバックオフに委ねる。
            if (!(err instanceof TileFetchError) || err.status !== 404) throw err;
            const floor = Math.max(0, gz - GEOM_ELEV_FALLBACK_DEPTH);
            for (let cz = gz - 1; cz >= floor; cz--) {
                const d = gz - cz;
                try {
                    // 親 (cz, gx>>d, gy>>d) は同一親を共有する子タイル間で in-flight 共有して重複取得を抑える。
                    const parent = await loadCoarseParent(cz, gx >> d, gy >> d);
                    return extractSubTileElev(parent, cz, gz, gx, gy);
                } catch (e) {
                    // 404（未配信）のみさらに 1 段粗く再試行。一時障害（タイムアウト/ネットワーク/5xx 等）は
                    // 握りつぶさず再 throw し、バックオフ再取得に委ねる（誤って平坦化に倒さない）。
                    if (e instanceof TileFetchError && e.status === 404) continue;
                    throw e;
                }
            }
            throw err;
        }
    };

    const terrainElevAt = (latDeg: number, lonDeg: number): number | null => {
        // 探索は geomMaxZoom（細）から粗へ下り、elevCache に実在する最も細かい gz を採用する。
        // gz >= gateBelowGz は従来どおり常に採用。gz < gateBelowGz（遠景で距離適応 root zoom が minZoom
        // を下回ったタイル）は、buildReadyTiles が距離 <= ELEVATION_RELEVANT_MAX_DISTANCE_M と判定し
        // elevRelevantGeom に記録したものだけ採用する（#459: 東京駅→富士山 約100.5km/zoom=10 の
        // ような近〜中距離で標高を返しつつ、全球視点の超粗タイルで誤った標高を返さない）。
        // 通常時（近景で elevRelevantGeom が空）は gz<gateBelowGz を探索しても必ず skip されるため、
        // 下限を gateBelowGz に切り上げて毎フレーム呼び出しの無駄な toTileXY/tileKey を避ける。
        // #459 の遠景タイルが登録されている間だけ 0 まで探索する。
        const searchFloor = elevRelevantGeom.size > 0 ? 0 : gateBelowGz;
        for (let gz = geomMaxZoom; gz >= searchFloor; gz--) {
            const { x, y } = toTileXY(latDeg, lonDeg, gz);
            const gk = tileKey(gz, x, y);
            if (gz < gateBelowGz && !elevRelevantGeom.has(gk)) continue;
            // 未解決 all-NaN（湖面・no-data）タイルは生 NaN を保持しており bilinear が 0m を返す。
            // これを採用すると湖上で centerElevation→0→referenceAltitude→0 と循環して暫定代表標高
            // まで 0m へ崩れる（湖中央 0m クレーターの一因）。未解決の間はこの zoom を飛ばし、
            // より粗い zoom（無ければ null）へ委ねて直前の有効な centerElevation を維持させる。
            if (allNanGeom.has(gk)) continue;
            const e = elevCache.get(gk);
            if (!e) continue;
            const total = totalPixelsForZoom(gz);
            const { px, py } = latLonToPixel(latDeg, lonDeg, total);
            return sampleElevBilinear(e, px - x * TILE_SIZE, py - y * TILE_SIZE);
        }
        return null;
    };

    /**
     * geom タイル 1 件分の標高フェッチを開始する（旧 `loadTile` 本体）。完了/失敗のいずれでも
     * `activeGeomLoads` を解放し、待機キューがあれば次のロードを起動する。
     */
    const startGeomLoad = (gz: number, gx: number, gy: number, gk: string): void => {
        activeGeomLoads++;
        loadGeomElevation(gz, gx, gy)
            .then((elev) => {
                // dispose() や sync() で loading から外された後の遅延 resolve は無視する
                // （不要・dispose 済みマネージャの状態を書き戻さない）。
                if (!loading.has(gk)) return;
                loading.delete(gk);
                // 穴埋め（平面版 / 相当）。
                // - 部分欠測（一部 NaN）: 自タイル内の有効ピクセルから BFS で内部の穴を即補間。
                // - all-NaN（全面 no-data: 大きな湖など）: 自タイルにシードが無いため即補間できない。
                //   `allNanGeom` に記録し、隣接の補間結果が揃い次第 `refineAllNaNTiles` で補間する。
                //   それまでは生 NaN のまま格納するが、確定前に建築要求が来た場合は `buildReadyTiles`
                //   が暫定代表標高（粗ズーム祖先 ?? 隣接接線 ?? 直近代表標高）で平坦建築するため、
                //   0m クレーター（海面）には倒さない（確定後に署名差分で再建築）。
                if (isAllNaN(elev)) {
                    allNanGeom.add(gk);
                } else {
                    fillInvalidPixels(elev, TILE_SIZE, TILE_SIZE);
                    allNanGeom.delete(gk);
                }
                elevCache.set(gk, elev);
                failedRetryAt.delete(gk); // 回復したのでバックオフ状態を解消
            })
            .catch(() => {
                // 取得失敗（no-data/404 と一時的なネットワーク障害を区別できない）。
                // 指数バックオフで再試行できるよう次回再試行時刻を記録する。遅延 reject はゲート。
                if (!loading.has(gk)) return;
                loading.delete(gk);
                const attempts = (failedRetryAt.get(gk)?.attempts ?? 0) + 1;
                failedRetryAt.set(gk, {
                    attempts,
                    retryAt: Date.now() + retryBackoffMs(attempts),
                });
                // per-tile では警告せず、sync 時にまとめて間引いて出力する。
                newlyFailed.push(gk);
            })
            .finally(() => {
                activeGeomLoads--;
                pumpGeomLoadQueue();
            });
    };

    /** continuous モードの待機キューから、同時実行数に空きがある分だけ geom ロードを開始する。 */
    const pumpGeomLoadQueue = (): void => {
        while (activeGeomLoads < GEOM_LOAD_MAX_CONCURRENT) {
            const next = geomLoadQueue.shift();
            if (!next) return;
            // 待機中に他経路（loading クリア・dispose・sync の視界外プルーン）で不要化した
            // エントリはロードを起動せず破棄する。
            if (!loading.has(next.gk)) continue;
            startGeomLoad(next.gz, next.gx, next.gy, next.gk);
        }
    };

    /**
     * 標高取得（geom タイル単位）はキャッシュに溜めるだけ。z16-18 は z15 を共有しデデュプ。
     *
     * `continuous`（#501）時は同時フェッチ数を `GEOM_LOAD_MAX_CONCURRENT` に制限する。連続カメラ
     * 移動では多数の新規タイルが一度に desired になり得るが、無制限に同時フェッチすると
     * デコード・穴埋め処理の完了が同一フレームに集中してガタつく（平面版 tileManager.ts の
     * loadTilesInQueue と同種の対策）。超過分は `geomLoadQueue` に積み、空きが出次第起動する。
     */
    const loadTile = (t: GlobeTile, continuous: boolean): void => {
        const { gz, gx, gy } = geomCoordOf(t);
        const gk = tileKey(gz, gx, gy);
        if (elevCache.has(gk) || loading.has(gk)) return;
        // 過去に失敗していてもバックオフ経過後は再試行する（一時障害からの回復）。
        const prevFail = failedRetryAt.get(gk);
        if (prevFail !== undefined && Date.now() < prevFail.retryAt) return;
        loading.add(gk);
        if (continuous && activeGeomLoads >= GEOM_LOAD_MAX_CONCURRENT) {
            geomLoadQueue.push({ gz, gx, gy, gk });
            return;
        }
        startGeomLoad(gz, gx, gy, gk);
    };

    /** geom タイル全面を単一標高 v[m] で埋めた Float32Array を生成する（湖面平坦化用）。 */
    const flatElevArray = (v: number): Float32Array =>
        new Float32Array(TILE_SIZE * TILE_SIZE).fill(Number.isFinite(v) ? v : 0);

    /** 標高タイルの 1 辺（256px 列/行）の有効ピクセル平均[m]。全 NaN なら undefined。 */
    const tileEdgeMean = (
        e: Float32Array,
        edge: "top" | "bottom" | "left" | "right",
    ): number | undefined => {
        let sum = 0;
        let cnt = 0;
        for (let i = 0; i < TILE_SIZE; i++) {
            const idx =
                edge === "top"
                    ? i
                    : edge === "bottom"
                      ? (TILE_SIZE - 1) * TILE_SIZE + i
                      : edge === "left"
                        ? i * TILE_SIZE
                        : i * TILE_SIZE + (TILE_SIZE - 1);
            const v = e[idx];
            if (!isInvalidElev(v)) {
                sum += v;
                cnt++;
            }
        }
        return cnt > 0 ? sum / cnt : undefined;
    };

    /**
     * geom タイル (gz,gx,gy) が「取得失敗(404)」「全面 no-data」等で実標高を持たない場合に、
     * 上下左右の隣接タイルの「接する辺」の有効標高平均から代表標高[m] を推定する。
     * これにより 0m 平坦（海面）に倒さず、隣接タイルの接線と段差なく連続した高さで平坦化できる。
     * GSI は湖面など水域の z15 タイルを 404 で配信しないことがあり（本栖湖 15/28998/12927 等）、
     * その場合この近傍代表標高（湖岸/湖面 ≒ 湖面標高）で穴を埋める。隣接が一切無効なら undefined。
     */
    const neighborRepElev = (gz: number, gx: number, gy: number): number | undefined => {
        const facing: readonly [number, number, "top" | "bottom" | "left" | "right"][] = [
            [0, -1, "bottom"], // 上隣の下辺がこのタイルの上辺に接する
            [0, 1, "top"],
            [-1, 0, "right"],
            [1, 0, "left"],
        ];
        let sum = 0;
        let cnt = 0;
        for (const [dx, dy, edge] of facing) {
            const nk = tileKey(gz, gx + dx, gy + dy);
            if (allNanGeom.has(nk)) continue; // 未解決 all-NaN（水面）隣接は代表標高源にしない
            const e = elevCache.get(nk);
            if (!e) continue;
            const m = tileEdgeMean(e, edge);
            if (m !== undefined) {
                sum += m;
                cnt++;
            }
        }
        return cnt > 0 ? sum / cnt : undefined;
    };

    /** クロスレベル coarse-edge 集合の署名（順不同で同一なら同値）。 */
    const edgeSignature = (edges: readonly CoarseEdge[]): string =>
        edges
            .map((e) => `${e.edge}:${e.coarseX}/${e.coarseY}/${e.scale}`)
            .sort()
            .join("|");

    /** メッシュへ頂点データを適用する（新規・再構築 共通）。 */
    const applyGeometry = (mesh: Mesh, data: GlobeTileMeshData): void => {
        const vertexData = new VertexData();
        vertexData.positions = data.positions;
        vertexData.indices = data.indices;
        vertexData.normals = data.normals;
        vertexData.uvs = data.uvs;
        vertexData.applyToMesh(mesh);
        mesh.position.copyFrom(data.anchor);
    };

    // ===== LOD シームレス遷移ヘルパ（平面版 tileManager.ts の同名関数を移植） =====

    /** タイルキー `"z/x/y"` を数値へ分解する。 */
    const parseKey = (key: string): { zoom: number; x: number; y: number } => {
        const [z, x, y] = key.split("/");
        return { zoom: Number(z), x: Number(x), y: Number(y) };
    };

    /**
     * メッシュのテクスチャが描画可能（onLoad/onError 到達済み）か。
     * mesh.isEnabled() とは独立に判定する（hiddenChild は描画可能だが非表示のため）。
     */
    const isMeshTextureReady = (mesh: Mesh): boolean => readyMeshes.has(mesh);

    /** メッシュを破棄し、付随する状態（readyMeshes / builtEdgeSig）も片付ける。 */
    const disposeMesh = (key: string, mesh: Mesh): void => {
        readyMeshes.delete(mesh);
        mesh.dispose(false, true); // マテリアル・テクスチャごと破棄
        builtEdgeSig.delete(key);
    };

    /** pendingRelease に登録し、祖先インデックスも更新する。 */
    const addPendingRelease = (key: string, entry: PendingTile): void => {
        pendingRelease.set(key, entry);
        for (let az = entry.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
            const diff = entry.zoom - az;
            const ak = tileKey(az, entry.x >> diff, entry.y >> diff);
            let s = pendingAncestorIndex.get(ak);
            if (!s) {
                s = new Set();
                pendingAncestorIndex.set(ak, s);
            }
            s.add(key);
        }
    };

    /** pendingRelease から削除し、祖先インデックスも更新する。 */
    const removePendingRelease = (key: string): PendingTile | undefined => {
        const entry = pendingRelease.get(key);
        if (!entry) return undefined;
        pendingRelease.delete(key);
        for (let az = entry.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
            const diff = entry.zoom - az;
            const ak = tileKey(az, entry.x >> diff, entry.y >> diff);
            const s = pendingAncestorIndex.get(ak);
            if (s) {
                s.delete(key);
                if (s.size === 0) pendingAncestorIndex.delete(ak);
            }
        }
        return entry;
    };

    /** pendingRelease から単一タイルを解放する（メッシュを破棄）。 */
    const releasePendingTile = (key: string): void => {
        const pending = pendingRelease.get(key);
        if (!pending) return;
        clearTimeout(pending.timerId);
        // 強制解放時は、待機中の子孫タイルを hiddenChildTiles から外して表示可能にする。
        // テクスチャ未 ready のメッシュは onLoad 側で表示されるため、ここでは ready のもののみ表示。
        const toRemove: string[] = [];
        for (const dk of hiddenChildTiles) {
            const c = parseKey(dk);
            if (c.zoom <= pending.zoom) continue;
            const diff = c.zoom - pending.zoom;
            if ((c.x >> diff) === pending.x && (c.y >> diff) === pending.y) {
                toRemove.push(dk);
            }
        }
        for (const dk of toRemove) {
            hiddenChildTiles.delete(dk);
            const mesh = loaded.get(dk);
            if (mesh && isMeshTextureReady(mesh)) mesh.setEnabled(true);
        }
        disposeMesh(key, pending.mesh);
        removePendingRelease(key);
    };

    /**
     * 指定矩形領域が loaded タイルで完全カバーされているか再帰的に判定する（平面版 isAreaCovered）。
     * - loaded に存在しテクスチャ ready → カバー済み
     * - loaded に存在するが未 ready → 未カバー（描画穴防止）
     * - desiredKeys に存在するが loaded に無い → 未カバー
     * - desiredKeys に無く targetZoom 到達 → frustum 外でカバー不要
     * - 可視タイルの祖先でなければカバー不要
     */
    const isAreaCovered = (
        areaZoom: number,
        ax: number,
        ay: number,
        targetZoom: number,
    ): boolean => {
        const areaKey = tileKey(areaZoom, ax, ay);
        const mesh = loaded.get(areaKey);
        if (mesh) return isMeshTextureReady(mesh);
        if (desiredKeys.has(areaKey)) return false;
        if (areaZoom >= targetZoom) return true;
        if (!visibleAncestorKeys.has(areaKey)) return true;
        const cz = areaZoom + 1;
        return (
            isAreaCovered(cz, ax * 2, ay * 2, targetZoom) &&
            isAreaCovered(cz, ax * 2 + 1, ay * 2, targetZoom) &&
            isAreaCovered(cz, ax * 2, ay * 2 + 1, targetZoom) &&
            isAreaCovered(cz, ax * 2 + 1, ay * 2 + 1, targetZoom)
        );
    };

    /** 指定矩形領域内の hiddenChildTiles を一斉に表示状態にする（平面版 enableDescendants）。 */
    const enableDescendants = (areaZoom: number, ax: number, ay: number): void => {
        const toRemove: string[] = [];
        for (const dk of hiddenChildTiles) {
            const c = parseKey(dk);
            if (c.zoom < areaZoom) continue;
            const diff = c.zoom - areaZoom;
            if ((c.x >> diff) === ax && (c.y >> diff) === ay) {
                toRemove.push(dk);
            }
        }
        for (const dk of toRemove) {
            hiddenChildTiles.delete(dk);
            const mesh = loaded.get(dk);
            if (mesh && isMeshTextureReady(mesh)) mesh.setEnabled(true);
        }
    };

    /**
     * 新タイルが描画可能になったとき、カバーされた旧 pending タイルを解放する（平面版同等）。
     * Case 1 (zoom-in): 旧粗タイル領域が子孫新タイルで完全カバー → 子孫一斉表示 + 親解放。
     * Case 2 (zoom-out): 旧細タイルの祖先タイルが ready → 即解放。
     * Case 3 (同 zoom): 同キーが ready → 解放。
     * `loadedCoord` 指定時は関連 pending のみ判定（高速化）。未指定時は全 pending。
     */
    const checkAndReleaseCoveredTiles = (loadedCoord?: {
        zoom: number;
        x: number;
        y: number;
    }): void => {
        let candidateKeys: Iterable<string>;
        if (loadedCoord) {
            const cands = new Set<string>();
            cands.add(tileKey(loadedCoord.zoom, loadedCoord.x, loadedCoord.y));
            for (let az = loadedCoord.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = loadedCoord.zoom - az;
                const ak = tileKey(az, loadedCoord.x >> diff, loadedCoord.y >> diff);
                if (pendingRelease.has(ak)) cands.add(ak);
            }
            const descendants = pendingAncestorIndex.get(
                tileKey(loadedCoord.zoom, loadedCoord.x, loadedCoord.y),
            );
            if (descendants) for (const dk of descendants) cands.add(dk);
            candidateKeys = cands;
        } else {
            candidateKeys = Array.from(pendingRelease.keys());
        }

        for (const key of candidateKeys) {
            const pending = pendingRelease.get(key);
            if (!pending) continue;
            const { zoom: pz, x: px, y: py } = pending;

            // Case 1: 旧粗タイル領域が子孫新タイルで完全カバー（zoom-in）。
            if (pz < currentMaxZoom && visibleAncestorKeys.has(key)) {
                if (isAreaCovered(pz, px, py, currentMaxZoom)) {
                    enableDescendants(pz + 1, px * 2, py * 2);
                    enableDescendants(pz + 1, px * 2 + 1, py * 2);
                    enableDescendants(pz + 1, px * 2, py * 2 + 1);
                    enableDescendants(pz + 1, px * 2 + 1, py * 2 + 1);
                    releasePendingTile(key);
                    continue;
                }
            }

            // Case 2: 旧細タイルが ready な祖先タイルでカバー（zoom-out, 多段対応）。
            let ancestorFound = false;
            for (let az = pz - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = pz - az;
                const am = loaded.get(tileKey(az, px >> diff, py >> diff));
                if (am && isMeshTextureReady(am)) {
                    ancestorFound = true;
                    break;
                }
            }
            if (ancestorFound) {
                releasePendingTile(key);
                continue;
            }

            // Case 3: 同 zoom の新タイルが同キーで ready なら不要。
            const same = loaded.get(key);
            if (same && isMeshTextureReady(same)) releasePendingTile(key);
        }
    };

    /** 表示タイルキー `"z/x/y"` → 共有する geom 標高タイルキー（z16-18 は z15 祖先を共有）。 */
    const geomKeyOfDisplay = (key: string): string => {
        const { zoom, x, y } = parseKey(key);
        const gz = Math.min(zoom, geomMaxZoom);
        const d = zoom - gz;
        return tileKey(gz, x >> d, y >> d);
    };

    /**
     * 元データが all-NaN（全面 no-data）だった geom タイルを穴埋めする（平面版相当）。
     *
     * 大きな湖（本栖湖・諏訪湖など）では、対象タイルだけでなく同 zoom 隣接タイルも all-NaN になり、
     * さらに LOD により隣接が粗 zoom で描画されると同 zoom 隣接自体が存在せず、同 zoom 縫い合わせ
     * では中心タイルにシードが届かず標高が 0m（海面）へ沈む。これを防ぐ:
     *
     * 1. 波状反復: 同 zoom 隣接（`stitchTileEdges`）からシードが得られたタイルを `fillInvalidPixels`
     *    で補間し `elevCache` を更新する。解決済みタイルが次の反復で隣接のシード源になり、湖岸から
     *    中心へリング状に補間が前進する。1 sync 内で収束するよう内部反復する。
     * 2. レスキュー（粗ズーム祖先 DEM）: 反復後も残った all-NaN タイルは、粗ズーム祖先 DEM タイル
     *    （湖岸＝陸地を含むため湖面標高の近似が得られる）の有効ピクセル平均を非同期取得し、その
     *    代表標高で平坦化する。最優先。誤って早期確定しないよう、同 zoom 隣接が in-flight
     *    （`loading`）の間はそのタイルの確定を見送る。
     *    - 粗ズーム祖先にも有効標高が無い（真の no-data: 外洋等）場合は、視界内の有効タイルがあれば
     *      その代表標高で、無ければ海面 0m（外洋として妥当）で確定する。
     * 3. 解決/レスキューしたタイルを共有する建築済み表示タイルの署名を無効化し再建築させる。
     *
     * なお、確定前（粗ズーム取得待ち）の all-NaN タイルは `buildReadyTiles` で生 NaN を 0m
     * （海面クレーター）として描画せず、暫定代表標高（粗ズーム祖先 ?? 隣接接線 ?? 直近代表標高）で
     * 平坦建築する。`refineAllNaNTiles` が正確な湖面標高で確定し次第、署名差分で再建築される。
     */
    // 粗ズーム祖先タイルの取得デルタ候補（gz から何段階粗いタイルを試すか）。
    // 大きな湖ほど粗くしないと祖先タイルも全面水面（all-NaN）になるため複数段試す。
    const COARSE_SEED_DELTAS: ReadonlyArray<number> = [4, 6, 8, 10];
    /** 粗ズームタイルを取得（in-flight 重複排除のみメモ化）。all-NaN や取得失敗は null。 */
    const loadCoarseTile = (cz: number, cx: number, cy: number): Promise<Float32Array | null> => {
        const ck = tileKey(cz, cx, cy);
        let p = coarseTileMemo.get(ck);
        if (!p) {
            p = loadElevationTile(cz, cx, cy)
                .then((e) => (isAllNaN(e) ? null : e))
                .catch(() => null);
            coarseTileMemo.set(ck, p);
            // メモは「同一粗タイルへの同時並行取得の重複排除」が目的。確定後も Promise
            // （256x256 の Float32Array を保持）を残すと、多数の湖/外洋を巡るとメモリが単調
            // 増加する。settle 後にエントリを削除して上限を設けない（レビュー指摘）。
            void p.finally(() => {
                if (coarseTileMemo.get(ck) === p) coarseTileMemo.delete(ck);
            });
        }
        return p;
    };
    /**
     * all-NaN タイル `gk` の代表標高を粗ズーム祖先 DEM から非同期取得し `coarseSeed` に格納する。
     * 取得後の適用（平坦化）は次 sync の `refineAllNaNTiles` が担う（連続 sync ループ前提）。
     */
    const requestCoarseSeed = (gk: string): void => {
        if (coarseSeed.has(gk) || coarseSeedPending.has(gk)) return;
        const { zoom: gz, x: gx, y: gy } = parseKey(gk);
        const { lat, lon } = tileCenterLatLon(gx, gy, gz);
        coarseSeedPending.add(gk);
        void (async () => {
            try {
                for (const d of COARSE_SEED_DELTAS) {
                    const cz = gz - d;
                    if (cz < 0) continue;
                    const { x: cx, y: cy } = toTileXY(lat, lon, cz);
                    const data = await loadCoarseTile(cz, cx, cy);
                    if (!data) continue;
                    let sum = 0;
                    let n = 0;
                    for (let i = 0; i < data.length; i++) {
                        const v = data[i];
                        if (!isInvalidElev(v)) { sum += v; n++; }
                    }
                    // 取得完了までに当該 geom タイルが prune（eviction/dispose）または解決済み
                    // （allNanGeom から除外）になっている場合は書き込まない。さもないと dispose/prune
                    // 後に coarseSeed が再増加（リーク）・不要な seed が残る（レビュー指摘）。
                    if (n > 0) {
                        if (allNanGeom.has(gk) && elevCache.has(gk)) coarseSeed.set(gk, sum / n);
                        return;
                    }
                }
                // 全粗ズームで有効標高無し（真の no-data: 外洋等）。0m(海面)のままが妥当。
            } finally {
                coarseSeedPending.delete(gk);
                // done フラグも、まだ未解決(allNanGeom)かつキャッシュに在るタイルにのみ立てる。
                // prune/解決済みのタイルで完了フラグだけ復活させない（レビュー指摘）。
                if (allNanGeom.has(gk) && elevCache.has(gk)) coarseSeedDone.add(gk);
            }
        })();
    };
    const ALL_NAN_REFINE_MAX_ITER = 8;
    const allNanNeighborOffsets: ReadonlyArray<[number, number, keyof StitchNeighbors]> = [
        [0, -1, "top"], [0, 1, "bottom"], [-1, 0, "left"], [1, 0, "right"],
        [-1, -1, "topLeft"], [1, -1, "topRight"], [-1, 1, "bottomLeft"], [1, 1, "bottomRight"],
    ];
    const refineAllNaNTiles = (): void => {
        if (allNanGeom.size === 0) return;
        const dirty = new Set<string>(); // 再建築が必要になった geom キー

        // --- Step 1: 同 zoom 隣接からのシード補間を波状に反復 ---
        const tryStitch = (gk: string): boolean => {
            const target = elevCache.get(gk);
            if (!target) {
                allNanGeom.delete(gk); // 退避済み（視界外）。再ロード時に再評価。
                return false;
            }
            const { zoom: gz, x: gx, y: gy } = parseKey(gk);
            const neighbors: StitchNeighbors = {};
            let hasNeighbor = false;
            for (const [dx, dy, dir] of allNanNeighborOffsets) {
                const nKey = tileKey(gz, gx + dx, gy + dy);
                const nElev = elevCache.get(nKey);
                if (!nElev) continue;
                neighbors[dir] = nElev;
                // 未解決 all-NaN 隣接（全 NaN）はシードにならない（stitch では nanMean で
                // 自然に除外される）ため、コピー要否の判定では有効隣接として数えない。
                if (!allNanGeom.has(nKey)) hasNeighbor = true;
            }
            // シード源となる隣接が一つも無ければ stitch しても all-NaN のまま。
            // 大きな湖で all-NaN タイルが多い場合の無駄な 256x256 コピーを避ける（レビュー指摘）。
            if (!hasNeighbor) return false;
            const copy = Float32Array.from(target);
            stitchTileEdges(copy, neighbors, TILE_SIZE);
            if (isAllNaN(copy)) return false; // まだシード無し。
            fillInvalidPixels(copy, TILE_SIZE, TILE_SIZE);
            elevCache.set(gk, copy);
            allNanGeom.delete(gk);
            dirty.add(gk);
            return true;
        };
        for (let iter = 0; iter < ALL_NAN_REFINE_MAX_ITER; iter++) {
            let progressed = 0;
            for (const gk of [...allNanGeom]) {
                if (tryStitch(gk)) progressed++;
            }
            if (allNanGeom.size === 0 || progressed === 0) break;
        }

        // --- Step 2: レスキュー（到達不能な残存 all-NaN タイルを代表標高で平坦化） ---
        if (allNanGeom.size > 0) {
            // 粗ズーム取得が真の no-data（外洋等）だった場合のフォールバック用に、視界内の
            // 有効タイル代表標高（中央ピクセル平均）を一度だけ算出する（同様の近似）。
            const mid = (TILE_SIZE >> 1) * TILE_SIZE + (TILE_SIZE >> 1);
            let inViewSum = 0;
            let inViewCount = 0;
            for (const [k, data] of elevCache) {
                if (allNanGeom.has(k)) continue; // 未解決 all-NaN は除外
                const v = data[mid];
                if (!isInvalidElev(v)) { inViewSum += v; inViewCount++; }
            }
            const inViewRep = inViewCount > 0 ? inViewSum / inViewCount : undefined;
            // 視界内に有効タイルがあれば代表標高を更新して保持する（全面水面化後の同期
            // フォールバックに使う）。湖へ陸地から接近する経路では湖岸標高が記録される。
            if (inViewRep !== undefined) lastRepElev = inViewRep;

            for (const gk of [...allNanGeom]) {
                if (!elevCache.has(gk)) continue;
                const { zoom: gz, x: gx, y: gy } = parseKey(gk);
                // 同 zoom 隣接が in-flight の間は確定を見送る（揃えば波状反復で解決しうる）。
                const neighborLoading = allNanNeighborOffsets.some(
                    ([dx, dy]) => loading.has(tileKey(gz, gx + dx, gy + dy)),
                );
                if (neighborLoading) continue;

                const coarse = coarseSeed.get(gk);
                if (coarse !== undefined) {
                    // (2a) 粗ズーム祖先 DEM の代表標高（湖面標高近似）で平坦化。最優先。
                    elevCache.set(gk, flatElevArray(coarse));
                    allNanGeom.delete(gk);
                    dirty.add(gk);
                    lastRepElev = coarse;
                } else if (coarseSeedDone.has(gk)) {
                    // (2b) 粗ズーム祖先にも有効標高無し（真の no-data: 外洋等）。視界内に有効タイルが
                    //      あればその代表標高、無ければ直近の代表標高（湖岸標高）で平坦化する。
                    //      どちらも無い場合のみ生 NaN のまま（build で海面 0m＝外洋として妥当）。
                    const rep = inViewRep ?? lastRepElev;
                    if (rep !== undefined) {
                        elevCache.set(gk, flatElevArray(rep));
                    }
                    allNanGeom.delete(gk);
                    dirty.add(gk);
                } else {
                    // (2c) 未取得 → 粗ズーム祖先取得を起動し、確定は次 sync へ見送る。確定までは
                    //      build が暫定代表標高で平坦化するため 0m クレーターも下地露出も生じない。
                    requestCoarseSeed(gk);
                }
            }
        }

        // --- Step 3: 解決/レスキュー済み geom を共有する建築済み表示タイルを再建築対象にする ---
        if (dirty.size > 0) {
            for (const key of [...builtEdgeSig.keys()]) {
                if (dirty.has(geomKeyOfDisplay(key))) builtEdgeSig.delete(key);
            }
        }
    };

    /**
     * 同一ズーム隣接（同 geom zoom）の有効標高を `elevCache` から収集する。
     * planar の `getNeighborElevations` 相当。実標高タイルの辺を `stitchTileEdges` で平均化し、
     * タイル境界の陰影シームを解消するために用いる。未解決 all-NaN 隣接（湖面・no-data 全面）は
     * 有効な辺標高を持たないためシード源にしない（`nanMean` で自然除外されるが署名を意味のある
     * ものに保つためここでも除外する）。揃っていた隣接方位の署名も返し、隣接が後からロードされた
     * ら sig 差分で再縫合・再建築させる。
     * 経度方向（x）は日付変更線で巡回（wrap）するため `%limit` で折り返して隣接を探索し（globeLod の
     * root seed 生成と同じ規約）、緯度方向（y）は極で巡回しないため範囲外をスキップする。
     */
    const collectSameZoomNeighbors = (
        gz: number,
        gx: number,
        gy: number,
    ): { neighbors: StitchNeighbors; sig: string } => {
        const neighbors: StitchNeighbors = {};
        const present: string[] = [];
        const limit = 2 ** gz; // 軸方向タイル数（= 2^gz）
        for (const [dx, dy, dir] of allNanNeighborOffsets) {
            const ny = gy + dy;
            if (ny < 0 || ny >= limit) continue; // y は wrap しない
            const nx = (((gx + dx) % limit) + limit) % limit; // x は日付変更線で wrap
            const nKey = tileKey(gz, nx, ny);
            if (allNanGeom.has(nKey)) continue;
            const nElev = elevCache.get(nKey);
            if (!nElev) continue;
            neighbors[dir] = nElev;
            present.push(dir);
        }
        return { neighbors, sig: present.sort().join(",") };
    };

    /**
     * geom 標高が揃った desired タイルについて再構築要否を判定する。
     *
     * `continuous=false`（既定・従来動作）: 判定後ただちに `executeBuildJob` で実ビルドする
     * （sync 呼び出し内で同期完了、テスト・既存デモの前提を変えない）。
     * `continuous=true`（連続カメラアニメーション向け・#501）: 実ビルドを `pendingBuilds` へ
     * 積み、`drainBuildQueue` が毎フレーム高々数件ずつ消化することでバーストを分散する。
     */
    const buildReadyTiles = (tiles: readonly GlobeTile[], continuous: boolean): void => {
        for (const t of tiles) {
            const k = tileKey(t.zoom, t.x, t.y);
            const { gz, gx, gy } = geomCoordOf(t);
            const gk = tileKey(gz, gx, gy);
            // 遠方の粗 zoom タイルは距離適応でメッシュ分割数を上げ、ロード済み DEM 詳細を活かす（#460）。
            const segs = adaptiveMeshSegments(t.tileSizeMeters, t.zoom, gz, segments);
            const cachedElev = elevCache.get(gk);
            // 標高が視覚的に意味を持つか。固定 minZoom ではなく、カメラ距離も考慮する
            // （`ELEVATION_RELEVANT_MAX_DISTANCE_M` 参照）。`globeLod` の SSE 距離累進で root zoom
            // が minZoom を下回っても、東京駅〜富士山間（≈100.5km）のような近距離では実 DEM があれば
            // 地形表現を維持したい（#457）。全球視点（distance が極めて大きい）は従来どおり
            // 「標高が視覚的に無意味」として扱う。
            const isElevationRelevant =
                t.zoom >= minZoom || t.distance <= ELEVATION_RELEVANT_MAX_DISTANCE_M;
            // #459: gz<gateBelowGz の距離適応タイルが「標高が意味を持つ」間だけ terrainElevAt の
            // 採用対象に載せる。距離が離れて無意味化したら外す（terrainElevAt が全球視点の超粗
            // タイル標高を返さないため）。gz>=gateBelowGz は常に採用対象なので記録不要。判定基準を
            // terrainElevAt の距離ゲートと同じ gateBelowGz に揃える（minZoom>geomMaxZoom で
            // gz=geomMaxZoom を無駄に Set へ追加しない）。
            if (gz < gateBelowGz) {
                if (isElevationRelevant) elevRelevantGeom.add(gk);
                else elevRelevantGeom.delete(gk);
            }
            // 実標高が未取得（ロード中 or 取得失敗でバックオフ中）の場合の暫定値（海面フラット 0m）。
            // ただしフラットで暫定建築するのは「取得失敗でバックオフ中(failedRetryAt)」または
            // 「標高が視覚的に無意味（isElevationRelevant=false）」に限る。それ以外（有意義な
            // ロード中）は直後の分岐で建築自体をスキップする（フラット→実標高の近景チラつきを避ける）。
            // loadElevationTile は no-data(404) と一時的障害を区別できないため、失敗は一律バックオフ
            // 扱い。実標高が届いたら次 sync で実標高へ再構築（sig で検知）、失敗継続なら海面のまま残す。
            const isFlatFallback = !cachedElev;
            let geomElev = cachedElev ?? FLAT_SEA_ELEV;

            // 標高が視覚的に意味を持つ（isElevationRelevant）場合は、標高ロード中は建築をスキップ。
            // フラット(0m)で一度表示してから実標高で再構築するとカメラ近景でチラつくため。
            // - failedRetryAt（取得失敗でバックオフ中）は「フラット確定」扱いで即建築（恒久欠けを防ぐ）。
            // - 標高が視覚的に無意味（全球視点等）なら即建築。
            if (isFlatFallback && !failedRetryAt.has(gk) && isElevationRelevant) continue;

            // 暫定平坦建築の代表標高[m]（sig へ反映し、隣接ロードで値が変われば再建築させる）。
            let repElev: number | undefined;

            // (A) 取得失敗(404/no-data)タイル（本栖湖の z15 湖面タイル 15/28998/12927 等は 404）。
            //     GSI は水域の高 zoom タイルを 404 で配信しないため、従来は FLAT_SEA_ELEV(0m) で
            //     平坦建築され「湖中央が 0m に沈む（≒900m クレーター）」原因になっていた。
            //     隣接タイルの接線標高（湖岸/湖面 ≒ 湖面標高）で平坦化し、段差無く連続させる。
            //     隣接も全て無効なら従来どおり 0m（外洋として妥当）。標高が無意味な距離帯は対象外。
            if (isFlatFallback && isElevationRelevant) {
                repElev = coarseSeed.get(gk) ?? neighborRepElev(gz, gx, gy) ?? lastRepElev;
                if (repElev !== undefined) geomElev = flatElevArray(repElev);
            }

            // (B) 確定前（粗ズーム祖先 DEM の取得待ち等）の all-NaN タイル（湖面・no-data 全面）。
            //     生 NaN をそのまま建築すると globeMesh が海面 0m へ倒し「湖中央の沈み込み（クレーター）」、
            //     逆に建築を見送ると下地の低解像度ベースレイヤ（陸地=橙系）が露出する。どちらも避けるため、
            //     暫定代表標高（粗ズーム祖先 ?? 隣接接線 ?? 直近代表標高 ?? referenceAltitude）で平坦建築。
            //     地図テクスチャは標高非依存で読まれるため、湖面相当の高さに平坦な正しい地図が描かれる。
            //     `refineAllNaNTiles` が正確な湖面標高で確定（allNanGeom から除外）し次第、sig 差分で再建築。
            const isAllNanPending = !!cachedElev && allNanGeom.has(gk) && isElevationRelevant;
            if (isAllNanPending) {
                repElev =
                    coarseSeed.get(gk) ??
                    neighborRepElev(gz, gx, gy) ??
                    lastRepElev ??
                    lastReferenceAltitude;
                geomElev = flatElevArray(repElev);
            }

            // 同一ズーム隣接辺スティッチング。実標高 geom タイル（フラット/暫定 all-NaN
            // 建築ではない）に限り、同 geom zoom 隣接の有効標高で辺を平均化したコピーを建築入力に
            // する。隣接 GSI DEM タイルは辺が 1 セルずれるため、平均化しないと境界に段差（陰影シーム）
            // が出る（planar は `applyStitchedElevation` で縫合済み）。原本 `elevCache` は破壊せず
            // コピーへ適用する。クロスレベルスナップ（CoarseEdge）は LOD 境界辺、本縫合は同一ズーム辺
            // を対象とし排他的に共存する。揃っていた隣接方位を sig に含め、隣接後ロードで再縫合させる。
            // ここでは隣接収集（軽量）と署名計算のみ行い、256x256 コピー＋`stitchTileEdges` は再建築が
            // 必要な場合（sig 不一致 or 新規）に限定する。隣接が揃った定常フレームで sig 一致による
            // 再建築スキップが、無駄な全コピーを伴わないようにするため（レビュー指摘）。
            let stitchNeighbors: StitchNeighbors | undefined;
            let stitchSig = "";
            if (!isFlatFallback && !isAllNanPending && isElevationRelevant) {
                const { neighbors, sig: nSig } = collectSameZoomNeighbors(gz, gx, gy);
                if (nSig.length > 0) {
                    stitchNeighbors = neighbors;
                    stitchSig = `s${nSig}|`;
                }
            }

            // クロスレベル「標高スナップ」は z<=geomMaxZoom の LOD 境界にのみ適用する。
            // crossLevel は細タイル zoom == その geom zoom を前提に、細グローバルピクセルを
            // 粗ラスタへ写像するため。z16-18 は z15 をサブサンプルして共有するので intra-level
            // は連続で、LOD 境界の「亀裂/穴」自体はスカート（垂直フランジ）が全境界で隠す。
            // 残る z16-18×粗 境界の「陰影シーム」除去（geom 座標へ写像した粗表面評価）は
            // 後続フェーズの磨き込み対象。
            let edges: readonly CoarseEdge[] = [];
            if (snapEnabled && t.zoom <= geomMaxZoom && !isFlatFallback && !isAllNanPending) {
                const r = selectCoarseEdges(
                    t,
                    (kk) => desiredKeys.has(kk),
                    (kk) => elevCache.get(kk),
                    (kk) => failedRetryAt.has(kk),
                    minZoom,
                );
                // r.pending（粗隣接の標高がまだロード中）でもビルドは遅延しない。遅延すると、
                // 海上・列島外など no-data の粗タイルが 404 を返すまで（または視界出入りで失敗記録が
                // 消える間）、その粗タイルに接する細タイルが恒久的に未建築＝LOD 境界で「四分木の
                // 2 個／1 ライン分が欠ける」症状になる（tilt 65-70°）。利用可能な edges だけで
                // 即建築し、粗標高が届いたら sig 変化で再建築してスナップを適用する（一時的な陰影
                // シームは許容。欠けるよりは良い）。
                edges = r.edges;
            }
            // フラット建築・暫定 all-NaN 建築かどうかと、暫定代表標高（10m 量子化）も署名に含める。
            // 実標高で確定したら coarse-edge 同一でも再構築させ、隣接ロードで代表標高が変わったら
            // （0m→湖面標高 等）追従して再構築させるため。
            const sig =
                (isFlatFallback ? "flat|" : "") +
                (isAllNanPending ? "allnan|" : "") +
                (repElev !== undefined ? `r${Math.round(repElev / 10)}|` : "") +
                stitchSig +
                edgeSignature(edges);

            // 既存メッシュは coarse-edge 集合が同一ならそのまま、変化していれば
            // ジオメトリのみ差し替える（テクスチャ・マテリアルは再利用し再読込を避ける）。
            const existing = loaded.get(k);
            // sig 一致（再建築不要）ならコピー＋縫合に入る前に早期スキップする（レビュー指摘）。
            if (existing && builtEdgeSig.get(k) === sig) continue;

            // 同一ズーム縫合はここで一度だけ適用する（原本 elevCache は非破壊）。以降このジョブが
            // 実ビルドされるまでの間、対象 geom タイルの elevCache が更新されても本ジョブの入力は
            // 変化しない（次の sync で sig 差分が出れば新しいジョブに上書きされ再度この処理を通る）。
            if (stitchNeighbors) {
                const copy = Float32Array.from(geomElev);
                stitchTileEdges(copy, stitchNeighbors, TILE_SIZE);
                geomElev = copy;
            }

            if (continuous) {
                // 実ビルド（Mesh/Geometry/Texture 生成）は重いため、この場では行わずキューへ積む。
                // `drainBuildQueue` がフレーム毎に時間予算内だけ処理する（#501）。
                // 同キー再登録は最新の判定結果（新しい geomElev/edges/sig）で上書きする。
                pendingBuilds.set(k, { tile: t, geomElev, segs, edges, sig });
            } else {
                // 既定（非連続カメラ）: 従来通り即座に実ビルドする。
                executeBuildJob(k, { tile: t, geomElev, segs, edges, sig });
            }
        }
    };

    /**
     * キューに積まれた1件のビルドジョブを実行し、Mesh/Geometry/Texture を生成・適用する。
     *
     * `existing`（既存メッシュの有無）と `hiddenChild`（祖先の pendingRelease 状態）は、
     * enqueue 時点ではなくここ（実行時点）の最新状態で判定する。enqueue から実行までの間に
     * pendingRelease からの復帰や新規解放が起こり得るため。
     */
    const executeBuildJob = (k: string, job: BuildJob): void => {
        const { tile: t, geomElev, segs, edges, sig } = job;
        const { gz, gx, gy } = geomCoordOf(t);

        // 実行時点で再度 sig 一致を確認する（enqueue 後に他経路で同キーが同じ内容へ既に
        // 再構築されていた場合の二重ビルドを防ぐ安全網）。
        const existing = loaded.get(k);
        if (existing && builtEdgeSig.get(k) === sig) return;

        if (existing) {
            applyGeometry(
                existing,
                buildGlobeTileMeshData({
                    zoom: t.zoom, tx: t.x, ty: t.y,
                    geomElev, geomZoom: gz, geomX: gx, geomY: gy, segments: segs, edges,
                }),
            );
            builtEdgeSig.set(k, sig);
            return;
        }

        const data = buildGlobeTileMeshData({
            zoom: t.zoom,
            tx: t.x,
            ty: t.y,
            geomElev,
            geomZoom: gz,
            geomX: gx,
            geomY: gy,
            segments: segs,
            edges,
        });

        const mesh = new Mesh(`tile-${k}`, scene);
        applyGeometry(mesh, data);
        // 前景タイルも非ピッカブルにする。ピッカブルだと `GeospatialCamera` 内蔵パン
        // の `scene.pick` がこのメッシュにヒットし、独自パン（scenes/globe.ts の onPointerMove）
        // と二重にカメラを動かして水平方向にガタつく。基準タイル（base-tile）と挙動を揃える。
        mesh.isPickable = false;

        // 地理院タイル画像を diffuseTexture として適用（同一 z/x/y）。タイルごとに専有し、
        // アンロード時に mesh.dispose(_, true) でテクスチャごと破棄する。
        const mat = new StandardMaterial(`tile-mat-${k}`, scene);
        mat.specularColor = TILE_SPECULAR;
        // 巻き順を外向きに揃えたので片面描画。スカート壁は両面三角形で culling 下でも見える。
        mat.backFaceCulling = true;
        mesh.material = mat;

        // テクスチャ未ロード中は白色メッシュが見えるので非表示にする。
        // onLoad / onError 到着時に表示する（背景球が代わりに見える）。
        mesh.setEnabled(false);

        // 祖先タイルが pendingRelease 中なら、この子タイルは非表示待機として登録する。
        // テクスチャ onLoad での表示を抑止し、旧粗タイル解放と同時に一斉表示して原子的に
        // スワップする（レベルの違うタイルの重なりちらつきを防ぐ）。多段 zoom も全祖先を確認。
        let isHiddenChild = false;
        for (let az = t.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
            const diff = t.zoom - az;
            if (pendingRelease.has(tileKey(az, t.x >> diff, t.y >> diff))) {
                isHiddenChild = true;
                break;
            }
        }
        if (isHiddenChild) hiddenChildTiles.add(k);

        // GPU テクスチャが確実に生成された onLoad 内で diffuseTexture を設定する
        // （WebGPU の "null gpu texture bind" を避ける。平面版 tileManager と同様）。
        // invertY=true は UV（v=1 が北端）の前提に必要。ロード前に mesh が破棄されていれば
        // 孤立テクスチャを破棄する。ロードは非同期なので、ロード中に setMapType で地図種別が
        // 変わった場合は、この（旧種別の）テクスチャを適用すると誤表示になる。生成時の種別を
        // 捕捉し、完了時に currentMapType と一致する場合のみ適用する（不一致なら破棄。描画可能化は
        // setMapType が起動した再テクスチャ側 onLoad/onError が担う）。
        const builtFor = currentMapType;
        const tex = new Texture(
            textureUrl(currentMapType, t.zoom, t.x, t.y),
            scene,
            false,
            true,
            Texture.TRILINEAR_SAMPLINGMODE,
            () => {
                if (mesh.isDisposed() || currentMapType !== builtFor) {
                    tex.dispose();
                    return;
                }
                mat.diffuseTexture = tex;
                // 描画可能になったことを記録（isAreaCovered / カバー判定で参照）。
                readyMeshes.add(mesh);
                // 非表示待機中（祖先が pendingRelease 中）の子タイルは表示しない。
                if (!hiddenChildTiles.has(k)) mesh.setEnabled(true);
                // このタイルでカバーされた旧 pending タイルを解放する。
                checkAndReleaseCoveredTiles({ zoom: t.zoom, x: t.x, y: t.y });
            },
            // onError: ロード失敗（404/ネットワーク断等）時は Texture を破棄してリークを防ぐ。
            // テクスチャなし（白）でもホールより良いので描画可能扱いにする。ただし祖先が
            // pendingRelease 中の hiddenChild は即表示しない（onLoad と同様）。即表示すると
            // 親と子が同時に見えて原子スワップ（重なりちらつき防止）が壊れる。readyMeshes に
            // 登録するのでカバー判定が成立し、enableDescendants 経由でスワップ時に表示される。
            // 種別不一致（ロード中に setMapType）の場合は再テクスチャ側に委ねる。
            () => {
                tex.dispose();
                if (mesh.isDisposed() || currentMapType !== builtFor) return;
                readyMeshes.add(mesh);
                if (!hiddenChildTiles.has(k)) mesh.setEnabled(true);
                checkAndReleaseCoveredTiles({ zoom: t.zoom, x: t.x, y: t.y });
            },
        );
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;

        loaded.set(k, mesh);
        builtEdgeSig.set(k, sig);
    };

    /**
     * ビルドキューを実測時間予算 `TILE_BUILD_TIME_BUDGET_MS` 内で消化する。`globe.ts` から毎
     * フレーム呼ばれる想定（#501: 重い実ビルドを複数フレームへ分散し、バーストによるガタつきを
     * 防ぐ）。地表付近（細かい zoom）ほど 1 件あたりの実ビルドコストが増えるため、固定件数では
     * 予算オーバーを防ぎきれない。実測時間で打ち切ることでタイル複雑度・実行環境の速度差に
     * 自動適応する（固定4件/回だと近接ズームでガタつきが残ることを確認したための見直し）。
     * 進捗保証のため最低 1 件は必ず処理し、`TILE_BUILDS_MAX_PER_DRAIN` を安全上限として設ける。
     * 消化時点で可視から外れていた（`desiredKeys` に無い）ジョブは構築せず破棄する。
     */
    const drainBuildQueue = (): void => {
        if (pendingBuilds.size === 0) return;
        const start = performance.now();
        let n = 0;
        for (const [k, job] of pendingBuilds) {
            if (
                n > 0 &&
                (n >= TILE_BUILDS_MAX_PER_DRAIN ||
                    performance.now() - start >= TILE_BUILD_TIME_BUDGET_MS)
            ) {
                break;
            }
            pendingBuilds.delete(k);
            n++;
            if (!desiredKeys.has(k)) continue;
            executeBuildJob(k, job);
        }
    };

    const sync = (params: GlobeTileSyncParams): GlobeTileSyncStats => {
        syncedAtLeastOnce = true;
        // 暫定代表標高の最終フォールバックとして referenceAltitude（カメラ中心地表標高）を保持。
        if (Number.isFinite(params.referenceAltitude)) lastReferenceAltitude = params.referenceAltitude;
        // #465: カメラ高度で base の見た目（地図テクスチャ/海色）を切り替える。低〜中高度では
        // 海色にして地平線際の緑（低ズーム世界地図）露出を防ぐ。境界をまたいだときのみ再適用する。
        lastCamAltMeters = ecefToGeodetic(params.cameraEcef).altMeters;
        if (wantBaseMap() !== baseMapApplied) {
            baseMapApplied = wantBaseMap();
            applyBaseAppearance();
        }
        // root 探索はカメラの現在の注視点(center)を追従する（パン後もカメラ直下を選択）。
        const camGeo = ecefToGeodetic(params.centerEcef);
        const tiles = selectGlobeTiles({
            cameraEcef: params.cameraEcef,
            centerLat: camGeo.latDeg,
            centerLon: camGeo.lonDeg,
            minZoom,
            maxZoom: params.maxZoom,
            viewportHeight: params.viewportHeight,
            viewportWidth: params.viewportWidth,
            verticalFov: params.verticalFov,
            sseThreshold: params.sseThreshold,
            maxTiles: params.maxTiles,
            rootSearchRadius: params.rootSearchRadius,
            maxRootTiles: params.maxRootTiles,
            horizonDotThreshold: params.horizonDotThreshold,
            referenceAltitude: params.referenceAltitude,
            rootZoomFloor: params.rootZoomFloor,
            frustumPlanes: params.frustumPlanes,
            pinnedPoints: params.pinnedPoints,
            textureQualityFloorZoom: params.textureQualityFloorZoom,
            viewForward: params.viewForward,
        });
        desiredKeys = new Set(tiles.map((t) => tileKey(t.zoom, t.x, t.y)));
        // 可視タイルの全祖先キー集合と最大 zoom を構築（カバー判定・zoom 階層判定に使う）。
        visibleAncestorKeys = new Set<string>();
        currentMaxZoom = SEAMLESS_FLOOR_ZOOM;
        for (const t of tiles) {
            if (t.zoom > currentMaxZoom) currentMaxZoom = t.zoom;
            for (let az = t.zoom - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = t.zoom - az;
                visibleAncestorKeys.add(tileKey(az, t.x >> diff, t.y >> diff));
            }
        }
        /**
         * 旧タイルが新可視タイル群と zoom 階層関係にあるか（祖先 or 子孫が可視）。
         * いずれでもなければ単なる横パン外なので pendingRelease せず即破棄する（フレーム落ち対策）。
         */
        const hasZoomRelation = (z: number, x: number, y: number): boolean => {
            for (let az = z - 1; az >= SEAMLESS_FLOOR_ZOOM; az--) {
                const diff = z - az;
                if (desiredKeys.has(tileKey(az, x >> diff, y >> diff))) return true;
            }
            return visibleAncestorKeys.has(tileKey(z, x, y));
        };

        // 不要になったメッシュを処理: zoom 階層関係があれば pendingRelease で表示を維持し、
        // なければ即破棄する（平面版の applyVisibleTiles 同等）。
        for (const [key, mesh] of loaded) {
            if (desiredKeys.has(key)) continue;
            const c = parseKey(key);
            // 非表示待機中(hiddenChild)のメッシュは描画されていないので pending にせず即破棄。
            const wasHidden = hiddenChildTiles.has(key);
            hiddenChildTiles.delete(key);
            if (
                !wasHidden &&
                isMeshTextureReady(mesh) &&
                hasZoomRelation(c.zoom, c.x, c.y)
            ) {
                if (!pendingRelease.has(key)) {
                    const timerId = setTimeout(
                        () => releasePendingTile(key),
                        PENDING_RELEASE_TIMEOUT_MS,
                    );
                    // builtEdgeSig は残す（再可視化で復元する際の不要な再構築を避ける）。
                    addPendingRelease(key, { mesh, zoom: c.zoom, x: c.x, y: c.y, timerId });
                }
            } else {
                disposeMesh(key, mesh);
            }
            loaded.delete(key);
        }

        // pendingRelease にあるタイルが再び可視になった場合、loaded に復元する。
        for (const key of desiredKeys) {
            const pending = pendingRelease.get(key);
            if (pending) {
                clearTimeout(pending.timerId);
                loaded.set(key, pending.mesh);
                removePendingRelease(key);
            }
        }

        // 現在の可視タイル群ともはや zoom 階層関係が無い stale な pending を即時解放する
        // （視界が連続して変わった場合にタイムアウトまで滞留してちらつくのを防ぐ）。
        for (const [key, pending] of pendingRelease) {
            if (!hasZoomRelation(pending.zoom, pending.x, pending.y)) {
                releasePendingTile(key);
            }
        }
        // 不要になった geom 標高キャッシュを破棄（必要 geom キー集合で判定）。
        // 必要な geom 標高タイルのキー集合（z16-18 は z15 祖先を共有）。
        const neededGeom = new Set(
            tiles.map((t) => {
                const { gz, gx, gy } = geomCoordOf(t);
                return tileKey(gz, gx, gy);
            }),
        );
        for (const key of elevCache.keys()) {
            if (!neededGeom.has(key)) {
                elevCache.delete(key);
                allNanGeom.delete(key);
                coarseSeed.delete(key);
                coarseSeedPending.delete(key);
                coarseSeedDone.delete(key);
            }
        }
        // elevRelevantGeom は標高未ロード（elevCache 未登録）でも buildReadyTiles で追加され得るため、
        // elevCache 起点の掃除では取りこぼす。可視タイル（neededGeom）を基準に直接 prune し、セッション
        // 中の移動で Set が上限なく増え続けないようにする（#472 レビュー対応。loading/failedRetryAt と同型）。
        for (const key of elevRelevantGeom) {
            if (!neededGeom.has(key)) elevRelevantGeom.delete(key);
        }
        // 不要になった in-flight ロードを loading から外す。これにより、その後 resolve した
        // 結果は loadTile の then/catch ゲート（loading.has）で無視され、不要な geom が
        // elevCache に入ってメモリを占有するのを防ぐ。再度必要になれば次 sync で再取得する。
        for (const key of loading) {
            if (!neededGeom.has(key)) loading.delete(key);
        }
        // 視界外になった失敗タイルのバックオフ状態も破棄（メモリ無制限増加を防ぐ。
        // 再び視界に入れば即座に新規試行できる）。
        for (const key of failedRetryAt.keys()) {
            if (!neededGeom.has(key)) failedRetryAt.delete(key);
        }
        // 新規タイルをロードし、標高が揃ったものを（クロスレベルスナップ付きで）建築。
        const continuous = params.continuous === true;
        for (const t of tiles) loadTile(t, continuous);
        // 隣接が揃った all-NaN タイルを補間してから建築。
        refineAllNaNTiles();
        buildReadyTiles(tiles, continuous);

        // 新規ロードが発生しない再 sync（同一可視集合での再評価など）では loadTile 経路の
        // checkAndReleaseCoveredTiles が呼ばれず、既に祖先/子孫が揃った pending が
        // タイムアウトまで滞留しうる。全 pending を対象に再判定し即時解放する（同等）。
        if (pendingRelease.size > 0) checkAndReleaseCoveredTiles();


        // 新規取得失敗を 1 行へ間引いて出力（per-tile 警告の氾濫を防ぐ）。失敗要因は
        // no-data/404 と一時的なネットワーク障害の双方があり区別しないため、中立な文言にする。
        if (newlyFailed.length > 0) {
            if (process.env.NODE_ENV !== "production") {
                const sample = newlyFailed.slice(0, 3).join(", ");
                const more = newlyFailed.length > 3 ? " …" : "";
                console.debug(
                    `[globeTileManager] ${newlyFailed.length} geom tile(s) failed to load ` +
                        `(no-data or transient errors; will retry with backoff): ${sample}${more}`,
                );
            }
            newlyFailed.length = 0;
        }

        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const t of tiles) {
            if (t.zoom < minZ) minZ = t.zoom;
            if (t.zoom > maxZ) maxZ = t.zoom;
        }

        return {
            selected: tiles,
            minZoom: Number.isFinite(minZ) ? minZ : null,
            maxZoom: Number.isFinite(maxZ) ? maxZ : null,
            loadedCount: loaded.size,
            pendingCount: pendingRelease.size,
            loadingCount: loading.size,
        };
    };

    /**
     * 常時表示の粗いベースレイヤを構築する。全球を覆う z=BASE_LAYER_ZOOM の固定
     * タイル集合（4^zoom 枚）を、海面フラット（0m）の楕円体パッチとして一度だけ生成し、以後ずっと
     * 保持する。新規に回転インする地平線の縁のタイルが未ロードでも、この背景が見えるため背景球
     * （青）が露出しない。
     *
     * 層順は Babylon の既定 PainterSortCompare（マテリアル uniqueId=生成順で昇順描画）で決定的に
     * 制御される。背景球マテリアルは本マネージャ生成前（globe.ts）に作られ、ベースは本関数で、LOD は
     * 後続 sync で作られるため、描画順は「背景球 → ベース → LOD」になる。ベースは深度を書かない
     * （disableDepthWrite）ので背景球の手前に塗られ、かつ後描画で深度を書く LOD には常に上書きされる。
     * これによりメッシュ弦のたるみ（粗タイルの幾何）に依存せず、LOD がある画素では LOD、ない画素では
     * ベース、ベースも無い極域などでは背景球、という安定した重なりになる。
     */
    const buildBaseLayer = (): void => {
        const count = 1 << BASE_LAYER_ZOOM; // 軸方向のタイル数（= 2^zoom）。
        for (let x = 0; x < count; x++) {
            for (let y = 0; y < count; y++) {
                const k = tileKey(BASE_LAYER_ZOOM, x, y);
                const data = buildGlobeTileMeshData({
                    zoom: BASE_LAYER_ZOOM,
                    tx: x,
                    ty: y,
                    geomElev: FLAT_SEA_ELEV,
                    geomZoom: BASE_LAYER_ZOOM,
                    geomX: x,
                    geomY: y,
                    segments: BASE_LAYER_SEGMENTS,
                    edges: [],
                });
                const mesh = new Mesh(`base-tile-${k}`, scene);
                applyGeometry(mesh, data);
                mesh.isPickable = false;

                const mat = new StandardMaterial(`base-tile-mat-${k}`, scene);
                mat.specularColor = TILE_SPECULAR;
                mat.backFaceCulling = true;
                // 深度を書かず純粋な背景として描く（背景球の手前・LOD の背面に固定する鍵）。
                mat.disableDepthWrite = true;
                // テクスチャ到着までは海色で塗る（白フラッシュ・青球露出を避ける）。
                mat.diffuseColor = BASE_LAYER_OCEAN;
                mesh.material = mat;

                // GPU テクスチャ生成完了（onLoad）で diffuseTexture を設定する（WebGPU の
                // "null gpu texture bind" 回避。LOD タイルと同様）。ベースは常時表示なので
                // setEnabled の出し入れはしない。ロード中に setMapType で地図種別が変わった場合は
                // 旧種別の適用を避けるため、生成時の種別を捕捉して一致時のみ適用する（不一致なら
                // 破棄。新種別の適用は setMapType の再テクスチャ側が担う）。
                const builtFor = currentMapType;
                const tex = new Texture(
                    textureUrl(currentMapType, BASE_LAYER_ZOOM, x, y),
                    scene,
                    false,
                    true,
                    Texture.TRILINEAR_SAMPLINGMODE,
                    () => {
                        if (mesh.isDisposed() || currentMapType !== builtFor) {
                            tex.dispose();
                            return;
                        }
                        // #465: テクスチャは保持しつつ、適用は高度依存。低〜中高度では海色のまま
                        // にして地平線際の緑（世界地図）露出を防ぐ。高高度でのみ地図を貼る。
                        baseTex.set(k, tex);
                        if (wantBaseMap()) {
                            mat.diffuseTexture = tex;
                            // 暫定の海色ティントを解除（白に戻す）。さもないと diffuseTexture が乗算で
                            // 暗く青くティントされ、地図画像が意図どおり発色しない。
                            mat.diffuseColor = BASE_LAYER_TEXTURE_TINT;
                        }
                    },
                    // onError: 取得失敗時は Texture を破棄し、海色のまま背景として残す。
                    () => tex.dispose(),
                );
                tex.wrapU = Texture.CLAMP_ADDRESSMODE;
                tex.wrapV = Texture.CLAMP_ADDRESSMODE;

                baseLoaded.set(k, mesh);
            }
        }
    };

    /**
     * #465: カメラ高度に応じて base レイヤの見た目を切り替える。高高度（全球表示）では
     * 保持済みの地図テクスチャを適用し、低〜中高度では海色（BASE_LAYER_OCEAN）に戻す
     * （地平線際で LOD が投影されない画素に緑の世界地図が透けるのを防ぐ）。
     */
    const applyBaseAppearance = (): void => {
        const showMap = wantBaseMap();
        for (const [k, mesh] of baseLoaded) {
            const mat = mesh.material as StandardMaterial | null;
            if (!mat) continue;
            const tex = baseTex.get(k);
            if (showMap && tex) {
                mat.diffuseTexture = tex;
                mat.diffuseColor = BASE_LAYER_TEXTURE_TINT;
            } else {
                mat.diffuseTexture = null;
                mat.diffuseColor = BASE_LAYER_OCEAN;
            }
        }
    };

    const dispose = (): void => {
        for (const mesh of loaded.values()) mesh.dispose(false, true);
        loaded.clear();
        // 常時表示ベースレイヤもテクスチャごと破棄する。high-alt でアタッチ中の base テクスチャは
        // mesh.dispose(false, true) が破棄するため、二重 dispose を避けるべく破棄対象を控える。
        const disposedBaseTex = new Set<unknown>();
        for (const mesh of baseLoaded.values()) {
            const mat = mesh.material as StandardMaterial | null;
            if (mat?.diffuseTexture) disposedBaseTex.add(mat.diffuseTexture);
            mesh.dispose(false, true);
        }
        baseLoaded.clear();
        // #465: 低〜中高度では base テクスチャは material に未アタッチ（diffuseTexture=null）で
        // baseTex にのみ保持され mesh.dispose では解放されないため、ここで破棄する。ただし上で
        // 既に破棄済み（アタッチ中だった）テクスチャは二重 dispose しない。
        for (const tex of baseTex.values()) {
            if (!disposedBaseTex.has(tex)) tex.dispose();
        }
        baseTex.clear();
        // LOD 遷移中に残した pending タイルのタイマー解除＋メッシュ破棄。
        for (const pending of pendingRelease.values()) {
            clearTimeout(pending.timerId);
            pending.mesh.dispose(false, true);
        }
        pendingRelease.clear();
        pendingAncestorIndex.clear();
        hiddenChildTiles.clear();
        readyMeshes.clear();
        visibleAncestorKeys = new Set<string>();
        builtEdgeSig.clear();
        loading.clear();
        elevCache.clear();
        allNanGeom.clear();
        coarseSeed.clear();
        coarseSeedPending.clear();
        coarseSeedDone.clear();
        coarseTileMemo.clear();
        failedRetryAt.clear();
        newlyFailed.length = 0;
        desiredKeys = new Set<string>();
        pendingBuilds.clear();
        geomLoadQueue.length = 0;
        activeGeomLoads = 0;
    };

    const getMapType = (): MapType => currentMapType;

    /**
     * 指定メッシュのテクスチャを現在の currentMapType の URL で差し替える。
     * 新テクスチャの onLoad で diffuseTexture を張り替え、旧テクスチャを破棄する
     * （張替え前にちらつかないよう、新テクスチャ準備完了まで旧テクスチャを保持）。
     * base レイヤはテクスチャ適用時に海色ティントを白へ戻す（buildBaseLayer と同様）。
     * 初回テクスチャ未到着（setEnabled(false)・readyMeshes 未登録）の LOD メッシュに対して
     * setMapType された場合も、ここで描画可能化（readyMeshes 登録・表示・カバー判定）を行う。
     * これがないとタイルが永続的に非表示になり isIdle も false のままになる。
     */
    const retextureMesh = (
        mesh: Mesh,
        zoom: number,
        x: number,
        y: number,
        isBase: boolean,
    ): void => {
        const mat = mesh.material as StandardMaterial | null;
        if (!mat) return;
        const oldTex = mat.diffuseTexture;
        const k = tileKey(zoom, x, y);
        // ロードは非同期。setMapType を短時間に複数回呼ぶと（例: 地図切替の連打）
        // 旧種別のテクスチャが後から完了して選択と不一致になりうるため、
        // 生成時の種別を捕捉し、完了時に currentMapType と一致する場合のみ適用する。
        const builtFor = currentMapType;
        // base 以外（LOD/pendingRelease）は未 ready のメッシュを描画可能化する。
        const markReady = (): void => {
            if (isBase) return;
            readyMeshes.add(mesh);
            if (!hiddenChildTiles.has(k)) mesh.setEnabled(true);
            checkAndReleaseCoveredTiles({ zoom, x, y });
        };
        const tex = new Texture(
            textureUrl(currentMapType, zoom, x, y),
            scene,
            false,
            true,
            Texture.TRILINEAR_SAMPLINGMODE,
            () => {
                if (mesh.isDisposed() || currentMapType !== builtFor) {
                    tex.dispose();
                    return;
                }
                if (isBase) {
                    // #465: base はテクスチャを保持しつつ適用は高度依存。高高度でのみ地図を貼る
                    // （低〜中高度は海色のまま）。旧 base テクスチャの dispose は、新テクスチャ/null を
                    // material へ適用した後に行う（表示中の旧テクスチャを外す前に破棄すると、一瞬
                    // material が dispose 済み Texture を参照するのを避ける, Copilotレビュー指摘）。
                    const prev = baseTex.get(k);
                    baseTex.set(k, tex);
                    if (wantBaseMap()) {
                        mat.diffuseTexture = tex;
                        mat.diffuseColor = BASE_LAYER_TEXTURE_TINT;
                    } else {
                        mat.diffuseTexture = null;
                        mat.diffuseColor = BASE_LAYER_OCEAN;
                    }
                    if (prev && prev !== tex) prev.dispose();
                    return;
                }
                mat.diffuseTexture = tex;
                markReady();
                // 新テクスチャ適用後に旧テクスチャを破棄（GPU リソースリーク防止）。
                oldTex?.dispose();
            },
            // onError: 取得失敗時は新テクスチャを破棄し、旧テクスチャ（現状表示）を保持する。
            // ただし未 ready の LOD メッシュは白のままでも描画可能化する（ホールより良い）。
            () => {
                tex.dispose();
                if (mesh.isDisposed() || currentMapType !== builtFor) return;
                if (!isBase && !readyMeshes.has(mesh)) markReady();
            },
        );
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    };

    const setMapType = (next: MapType): void => {
        if (next === currentMapType) return;
        currentMapType = next;
        // key="z/x/y"。ロード済み LOD・LOD 遷移中の pendingRelease・常時表示ベースレイヤを再テクスチャする。
        for (const [k, mesh] of loaded) {
            const { zoom, x, y } = parseKey(k);
            retextureMesh(mesh, zoom, x, y, false);
        }
        for (const [k, pending] of pendingRelease) {
            const { zoom, x, y } = parseKey(k);
            retextureMesh(pending.mesh, zoom, x, y, false);
        }
        for (const [k, mesh] of baseLoaded) {
            const { zoom, x, y } = parseKey(k);
            retextureMesh(mesh, zoom, x, y, true);
        }
    };

    const isIdle = (): boolean => {
        if (!syncedAtLeastOnce) return false;
        // 標高ロード中・LOD 遷移の残置タイル・ビルドキュー滞留（#501）がある間は安定とみなさない。
        // pendingBuilds は既存メッシュのジオメトリ更新（縫合差し替え等）だけを積む場合もあり、
        // その場合 loaded/readyMeshes の判定だけでは反映前を検知できないため個別にチェックする。
        if (loading.size > 0 || pendingRelease.size > 0 || pendingBuilds.size > 0) return false;
        // さらに、現在の希望タイル(desiredKeys)がすべて loaded かつテクスチャ適用済み(readyMeshes)で
        // あることを要求する。loading/pendingRelease だけでは、メッシュ生成済みでもテクスチャの
        // onLoad/onError 到達前（白メッシュ）に「安定」と誤判定しうるため（ビジュアル回帰の
        // waitForTerrainStable がテクスチャ適用前にスクショを撮るのを防ぐ）。
        for (const key of desiredKeys) {
            const mesh = loaded.get(key);
            if (!mesh || !readyMeshes.has(mesh)) return false;
        }
        return true;
    };

    // 常時表示の粗いベースレイヤを一度だけ構築する。
    buildBaseLayer();

    return { sync, drainBuildQueue, terrainElevAt, isIdle, getMapType, setMapType, dispose };
};
