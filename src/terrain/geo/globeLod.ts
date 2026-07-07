/**
 * グローブ（ECEF）向け LOD/SSE タイル選択。
 *
 * 平面ワールド前提の `src/terrain/visibleTiles.ts`（Quadtree+SSE）を、グローブ
 * （地心 ECEF）向けに再定義したもの。本体共有モジュールへ昇格し、
 * ECEF 変換を `geo/ecef` に委譲する。
 *
 * 平面版との差分:
 * - タイル距離は AABB との XZ 最短距離＋カメラ高度の合成ではなく、タイル中心 ECEF と
 *   カメラ ECEF の **素直な地心 3D 距離** を使う（地心距離は常に正のため平面版の
 *   `distanceFootprintToPoint` ハックが不要）。
 * - 視錐台 6 平面カリングのかわりに、floating origin 下でも安定する **地平線カリング**
 *   （地心法線とカメラ方向の内積）で裏側タイルを除外する。
 * - SSE 式 `tileSizeMeters * viewportHeight / (distance * 2 tan(fov/2))` は座標系非依存で流用。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { TILE_SIZE, tileCenterLatLon, tileEdgeMeters, toTileXY, JAPAN_BOUNDS, WORLD_TEXTURE_MAX_ZOOM } from "../gsiTile";
import { ecefToGeodetic, geodeticToEcefToRef } from "./ecef";
import { latLonToPixel, totalPixelsForZoom } from "./mapping";
import { isAABBInFrustum, DEFAULT_MAX_ELEVATION, type FrustumPlane } from "../visibleTiles";

/** LOD 選択されたタイル。 */
export interface GlobeTile {
    zoom: number;
    x: number;
    y: number;
    /** タイル 1 辺の実距離 [m]（メッシュ生成・距離評価に流用可）。 */
    tileSizeMeters: number;
    /** カメラ ECEF からタイル中心 ECEF までの距離 [m]（maxTiles 打ち切り用）。 */
    distance: number;
}

export interface GlobeLodOptions {
    /** カメラの真の ECEF 位置。 */
    cameraEcef: Vector3;
    /** 中心緯度 [deg]（root 探索の中心）。 */
    centerLat: number;
    /** 中心経度 [deg]。 */
    centerLon: number;
    /** 最低ズーム（root）。 */
    minZoom: number;
    /** 最高ズーム（分割上限）。 */
    maxZoom: number;
    /** ビューポート高さ [px]。 */
    viewportHeight: number;
    /** ビューポート幅 [px]（水平 FOV＝横方向被覆の算出に使用）。 */
    viewportWidth: number;
    /** 垂直 FOV [rad]。 */
    verticalFov: number;
    /** SSE 採用しきい値 [px]。大きいほど粗いタイルを早期受容。 */
    sseThreshold: number;
    /** 結果タイル数の上限。 */
    maxTiles: number;
    /**
     * root タイル（minZoom）の帯の横半幅（lateral）かつ nadir 手前の後方マージン（±N 格子）。
     * 直下視（nadir≒center）では nadir 中心の対称ボックス（一辺 2N+1）状に張る。ただし生成は
     * 常に `maxRootTiles` の予算内に収まり、`maxRootTiles < (2N+1)^2` のときは前景優先で
     * 打ち切られる（対称ボックスを満たし切らない）。
     */
    rootSearchRadius: number;
    /**
     * root 帯に張る minZoom タイル数の予算（上限）。前景（nadir 側）から地平線側へ
     * 帯を張り、予算を使い切ったら地平線側を捨てて前景を残す（水平チルト時の前景被覆を優先）。
     */
    maxRootTiles: number;
    /**
     * 地平線カリングの内積しきい値。
     * `dot(normalize(tileEcef), normalize(cameraEcef)) < threshold` のタイルを裏側として除外。
     * 0 で半球、負値で地平線の少し裏まで許容。
     */
    horizonDotThreshold: number;
    /**
     * 遠景 root の最粗 zoom（距離適応ルートレベルの下限）。
     * 高チルト時、近景 minZoom 帯の外側を距離に応じて minZoom-1, -2, … rootZoomFloor まで
     * 粗く張り、少数の粗タイルで地平線まで安価に被覆する（SSE が近景のみ細分化）。
     * 省略時は minZoom（粗化なし＝従来挙動）。下限はデータソース依存で選ぶ。GSI はテクスチャ
     * z0〜・dem_png z1〜z14 を供給し、DEM 欠損（z1 未満や海上 no-data）はタイルを海面フラット
     * (0m) で暫定建築して許容するため、全球視点では低ズーム（既定 rootZoomFloor=2）まで張れる。
     */
    rootZoomFloor?: number;
    /**
     * SSE 距離評価に使うタイル中心の基準標高[m]。
     * 高標高地（富士山等）では実地表が海面より高く、タイル中心を alt=0 で評価すると
     * カメラ↔タイルの距離が過大になり LOD が上がらない。中心付近の地形標高を渡すことで
     * 距離が地表基準になり、近接時に高 zoom が選択される。省略時 0。
     */
    referenceAltitude?: number;
    /**
     * カメラの真の視錐台6平面。**camera 相対**（原点 = `cameraEcef`、回転のみ・並進なし）で
     * 定義すること。ECEF 原点基準（ワールド座標そのもの）で構築した平面を渡すと、Babylon の
     * Float32 行列演算が ~6.4e6m の巨大並進を含むことで桁落ちし、実際に画面内の遠方地物を
     * 「視錐台外」と誤判定する（#463 で発生した回帰。呼び出し側は eye=原点・target=視線方向の
     * 回転のみの view 行列で平面を作ること。`globe.ts` の `computeCameraFrustumPlanes` 参照）。
     * 指定時、各ノードのAABB（水平フットプリント×標高範囲[0, DEFAULT_MAX_ELEVATION]、
     * cameraEcef 分平行移動して camera 相対化）が完全に視錐台外なら早期除外する
     * （地平線カリング・SSEに続く3段目のカリング）。帯モデル・SSE遠方粗化だけでは
     * 「視錐台に入っていないのに鉛直高度基準でレベルが決まる」無駄が生じるため、実frustum判定で
     * 候補を絞り、浮いた maxTiles 予算を実際に視界へ入る（山の起伏で近く見える）タイルへ回す。
     * 省略時は従来通り帯モデル＋地平線カリングのみで判定する（後方互換）。
     */
    frustumPlanes?: readonly FrustumPlane[];
    /**
     * 視錐台に関わらず必ず最粗root（minZoom）を確保したい地点（緯度経度）。
     * 通常のroot帯（nadir→center→地平線）は画面表示用の候補選定であり、`terrainElevAt`や
     * モデル接地（`addModel`のavatar等）が必要とする地点は注視点(center)やカメラ視界と
     * 無関係な場所にありうる。真の視錐台カリング導入（#463）により、これらの地点が画面外だと
     * `terrainElevAt`が永久にnullを返す回帰が生じた（例: avatar-controllerデモでアバターが
     * 常に固定地点にスポーンし、カメラ注視点と無関係な場合）。centerLat/centerLon自体も
     * 暗黙に対象に含む。省略時は空。
     */
    pinnedPoints?: readonly { lat: number; lon: number }[];
    /**
     * 距離適応 root zoom がこれより粗くならないようにする下限（`GlobeRootSeedOptions` 参照）。
     * 省略時は無効（既存の `rootZoomFloor`/SSE のみで判定、後方互換）。
     */
    textureQualityFloorZoom?: number;
    /**
     * 実カメラ視線 forward（ECEF 向きベクトル）。前方 swath 到達距離を決める tilt をこの向きから
     * 求める（`GlobeRootSeedOptions.viewForward` 参照）。`selectGlobeRootTiles` へそのまま転送する。
     * 省略時は従来どおり camera→center から tilt を算出（後方互換）。
     */
    viewForward?: Vector3;
}

/** タイル中心の ECEF（基準標高 alt）を ref に書き込み、その緯度経度を返す。 */
const tileCenterEcefToRef = (
    zoom: number,
    x: number,
    y: number,
    alt: number,
    ref: Vector3,
): { lat: number; lon: number } => {
    const { lat, lon } = tileCenterLatLon(x, y, zoom);
    geodeticToEcefToRef(lat, lon, alt, ref);
    return { lat, lon };
};

/** root 帯のシード（タイル座標とその zoom）。遠景は minZoom より粗い zoom を持つ。 */
export interface RootSeed {
    x: number;
    y: number;
    /** この root を traverse 開始する zoom（近景=minZoom、遠景は距離適応で粗い）。 */
    zoom: number;
}

/** `selectGlobeRootTiles` の入力（root 帯の選定に必要な最小集合）。 */
export interface GlobeRootSeedOptions {
    /** カメラの真の ECEF 位置。 */
    cameraEcef: Vector3;
    /** 注視点（look-at center）の緯度 [deg]。 */
    centerLat: number;
    /** 注視点の経度 [deg]。 */
    centerLon: number;
    /**
     * root の最細（最高）ズーム。SSE 最適より近景が細かい場合の上限で、これ以上の細分化は
     * 後段の Quadtree+SSE（`selectGlobeTiles`）に任せる。実質「近景 root の基準ズーム」。
     */
    minZoom: number;
    /** 帯の横半幅かつ nadir 手前の後方マージン（±N 格子, emit ズーム単位）。 */
    rootSearchRadius: number;
    /** root タイル数の予算（上限）。 */
    maxRootTiles: number;
    /** 遠景 root の最粗 zoom（距離適応ルートレベルの下限）。省略時 minZoom。 */
    rootZoomFloor?: number;
    /** ビューポート高さ [px]（root ズームの SSE 算出に使用）。 */
    viewportHeight: number;
    /** ビューポート幅 [px]（水平 FOV＝横方向被覆の算出に使用）。 */
    viewportWidth: number;
    /** 垂直 FOV [rad]（同上）。 */
    verticalFov: number;
    /** SSE 採用しきい値 [px]（同上, 256px タイルの表示サイズ境界）。 */
    sseThreshold: number;
    /**
     * 距離適応 root zoom（`zoomForDist`）がこれより粗くならないようにする、`rootZoomFloor` とは
     * 別枠の下限（省略時は無効）。地理院タイルは `WORLD_TEXTURE_MAX_ZOOM` を境に、それ以下は
     * 世界全域の低解像度ベースマップ、それ以上（日本周辺）は高解像度の実データに切り替わり、
     * ソース画像の見た目が大きく変わる。低〜中高度・高チルトで地平線付近を見るとき、距離累進
     * SSE だけに任せるとこの境界を跨いだ混在（低解像度と高解像度が同一画面に混在する見た目の
     * 破綻）が生じうる（#463 フォローアップ）。`rootZoomFloor`（全球モード用の効率優先の下限）
     * とは独立に効かせるため別オプションとする。予算（`maxRootTiles`/`maxTiles`）が逼迫した場合は
     * 既存の「前景優先で奥を捨てる」挙動により地平線側の被覆が狭まる形で吸収される
     * （破綻するのではなく、覆う範囲が狭まる）。全球モード（`GLOBAL_VIEW_EARTH_ANG_RADIUS` 分岐）
     * には適用しない。省略時は既存の `rootZoomFloor`/SSE のみで判定する（後方互換）。
     */
    textureQualityFloorZoom?: number;
    /**
     * 注視点(center)の地表標高[m]。前方到達距離を決める tilt を「camera→center 地表点」の
     * 実ベクトルから求める際に使う。省略時 0（海面）だが、高標高地（富士山頂等）を注視点にすると
     * seat-on-terrain でカメラが山頂相当高度へ持ち上がり、center を海面(0m)扱いすると camera→center
     * が実際より急な下向きと誤算出され、tilt 過小→前方到達距離が極端に短縮→遠方（例: 50km 先）が
     * 未種付けになる。center を実標高で評価すると正しい tilt になり遠方まで帯が伸びる（#465 続き）。
     * 負値（海面下）と NaN/Infinity は 0（海面）へ丸める。
     */
    referenceAltitude?: number;
    /**
     * 実カメラ視線 forward（ECEF 向きベクトル、camera 相対回転で導出可）。指定時、前方到達距離
     * `forwardReach` を決める tilt（直下=-cameraEcef からの視線角）をこの向きから求める。
     * Follow mode のように center（=機体直下地表）と実視線が乖離する経路で、center 由来の tilt が
     * 過小算出され前方（地平線側）が未種付けになる問題（#475）を防ぐ。省略・零ベクトル・非有限は
     * 従来どおり camera→center から tilt を算出（後方互換）。内部で正規化するため単位でなくてもよい。
     */
    viewForward?: Vector3;
}

/** カメラ↔地表点の弦距離の概算に使う WGS84 平均半径 [m]。 */
const EARTH_MEAN_RADIUS_M = 6_371_000;

/** z0（zoom 0）のタイル 1 辺の実距離 [m]（緯度 lat）。`tileEdgeMeters(lat,0)`。 */
const tileEdge0Meters = (lat: number): number => tileEdgeMeters(lat, 0);

/** 1 断面あたりの lateral 片側タイル数の上限（暴発防止）。emit zoom 適応で通常は数枚で足りる。 */
const LATERAL_TILE_CAP = 16;

/** 前方到達距離のマージン係数。粗タイルの粒度で視錐台上端が僅かに欠けないよう少し超えて張る。 */
const FORWARD_REACH_MARGIN = 1.25;

/**
 * 全球モードに切り替える地球の見かけ角半径しきい値 [rad]。地球の角半径
 * `asin(R/(R+h))` がこの値以下＝高高度で可視領域が地球の大きな部分（広いキャップ）になると、
 * 視線方向に沿う 1 次元の帯（swath）では 2 次元キャップを覆い切れず縁が欠ける。そこで全球を最粗
 * `floorZoom` で種付けし、traverse の SSE 細分化＋地平線カリングに委ねる方式へ切り替える。
 * 約 1.0rad（≒57°, 高度 ≳1,000km）。これ未満（低〜中高度）は従来の帯で効率を維持する。
 */
const GLOBAL_VIEW_EARTH_ANG_RADIUS = 1.0;

/**
 * この高度[m]以上では root zoom のテクスチャ品質下限（textureQualityFloorZoom）を外し、
 * zoom を HIGH_ALT_MAX_ZOOM に頭打ちにする。高度が上がるほど可視域が広く（地図の文字も読めなく）
 * なるため、詳細タイル（z9〜）を張るとタイル数が maxTiles を食い潰し可視域の外周が欠ける
 * （高高度で「半分しか出ない」）。距離累進（zStar/distCapZoom）の対数的粗化に委ね、上限で
 * 抑えることで少数の粗タイルで広域を被覆する。しきい値は「200km 以上は z8 以下で十分」という
 * 実地の目視基準に合わせる。全球モード（GLOBAL_VIEW_EARTH_ANG_RADIUS, ≒1,200km 以上）は
 * 別途 floorZoom で全球種付けするため、本キャップは 200km〜全球境界の帯モードに効く。
 */
const HIGH_ALT_ZOOM_CAP_M = 190_000;

/** 高高度（HIGH_ALT_ZOOM_CAP_M 以上）での root zoom 上限。 */
const HIGH_ALT_MAX_ZOOM = 8;

/**
 * SSE しきい値の距離累進係数。実効しきい値を
 * `sseThreshold · (1 + SSE_FALLOFF_RATE · distance / altitude)` とし、遠方ほど大きく＝粗く受容する。
 * 近景（distance≈altitude）はほぼ不変、遠方は幾何 LOD（距離 2 倍で 1 段粗）より速く粗化して
 * 高チルト時の総タイル数を抑える（遠方タイルは文字も読めず粗くて問題ない）。root emit と
 * traverse の受容判定の双方に同一式を用い、整合（root が即受容され再分割されない）を保つ。
 */
const SSE_FALLOFF_RATE = 0.4;

/** 距離 distance[m]・カメラ高度 alt[m] に対する実効 SSE しきい値（距離累進）。 */
const effectiveSseThreshold = (
    sseThreshold: number,
    distance: number,
    altMeters: number,
): number =>
    sseThreshold *
    (1 + (SSE_FALLOFF_RATE * Math.max(0, distance)) / Math.max(1, altMeters));
/**
 * 可視地表を覆う root タイル集合を選定する（ground-track の帯＋高度/距離適応）。
 *
 * **帯の張り方**: カメラ直下点（nadir, 前景）から注視点（center）を通り視線方向へ伸びる
 * ground-track の帯（swath）に root を張る。along-track は nadir 手前のマージンから center を越え
 * FOV 端まで、lateral は ±`rootSearchRadius`。これによりチルト時も前景（nadir）が欠落しない。
 *
 * **高度/距離適応ルートレベル**: 各 root の zoom を固定 `minZoom` ではなく、その地点までの
 * カメラ距離 d に対する **SSE（256px タイルの表示サイズ）最適 zoom** から決める。すなわち
 * `tileEdge(z)·viewportHeight / (d·2·tan(fov/2)) ≈ sseThreshold` を満たす最も粗い z。これにより
 * 高高度では粗い root（例: 500km 上空で日本列島が数枚〜十数枚）になり、低高度では細かい root に
 * なる。emit zoom は `[rootZoomFloor, minZoom]` にクランプし、minZoom より細かい近景の細分化は後段の
 * Quadtree+SSE（`selectGlobeTiles`）に委ねる。lateral・along-track いずれも emit zoom のタイルサイズ
 * 刻みで進めるため、結果のタイル数は高度に依らず画面被覆相当に有界化する。
 *
 * 帯の被覆過多や裏側は後段の地平線カリング・SSE・maxTiles 打ち切りで間引かれる。直下視
 * （nadir≒center で方向が定まらない）では nadir 中心の対称ボックスにフォールバックする。
 */
/**
 * camera 相対（原点=cameraEcef、回転のみ・並進なし）の視錐台6平面から視線 forward（ECEF 向き
 * 単位ベクトル）を `ref` に書き込む。`FrustumPlane` の法線は内向き（`normal·p + d < 0` で外側,
 * `visibleTiles.ts` 規約）で、near/far は forward の逆向き同士＝相殺し、left/right・top/bottom は
 * lateral/vertical 成分が相殺し forward 成分のみ残るため、6平面法線の和は forward に比例する。
 * 平面インデックス順序に依存しない（順序非依存）。導出できたら `true`、平面数≠6・零和・非有限は
 * `false`（`ref` は未変更、呼び出し側でフォールバック）。毎フレーム呼ぶ経路（`globe.ts` syncTiles）が
 * Vector3 を新規生成せず再利用できるよう ToRef 形にする。
 */
export const viewForwardFromFrustumPlanesToRef = (
    planes: readonly FrustumPlane[],
    ref: Vector3,
): boolean => {
    if (planes.length !== 6) return false;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const p of planes) {
        sx += p.normal.x;
        sy += p.normal.y;
        sz += p.normal.z;
    }
    const lenSq = sx * sx + sy * sy + sz * sz;
    if (!Number.isFinite(lenSq) || lenSq < 1e-12) return false;
    const inv = 1 / Math.sqrt(lenSq);
    ref.set(sx * inv, sy * inv, sz * inv);
    return true;
};

/**
 * `viewForwardFromFrustumPlanesToRef` の Vector3 生成版（新規 Vector3 を返す。導出不能なら `null`）。
 * 毎フレームでない呼び出し・テスト向け。ホットパスでは ToRef 版を使うこと。
 */
export const viewForwardFromFrustumPlanes = (
    planes: readonly FrustumPlane[],
): Vector3 | null => {
    const out = new Vector3();
    return viewForwardFromFrustumPlanesToRef(planes, out) ? out : null;
};

export const selectGlobeRootTiles = (opts: GlobeRootSeedOptions): RootSeed[] => {
    const {
        cameraEcef,
        centerLat,
        centerLon,
        minZoom,
        rootSearchRadius,
        maxRootTiles,
        viewportHeight,
        viewportWidth,
        verticalFov,
        sseThreshold,
        textureQualityFloorZoom,
        referenceAltitude,
    } = opts;
    const margin = Math.max(0, rootSearchRadius);
    const budget = Math.max(1, maxRootTiles);
    // emit zoom の最粗下限。minZoom 以下に丸める（minZoom は最細＝近景 root 基準）。
    const floorZoom = Math.min(minZoom, Math.max(0, opts.rootZoomFloor ?? minZoom));

    // カメラ直下点（nadir, 前景）と注視点（center）の minZoom タイル座標（帯の基準格子）。
    // **分数（fractional）タイル座標**で持つ。整数タイル（toTileXY）だと、低高度・斜め見で
    // nadir↔center の水平距離が 1 タイル未満のとき t0==t1 になり dirLen=0 ＝ 帯の方向（方位）が
    // 失われ、nadir 中心ボックスのフォールバックに落ちて帯が視線方向とは無関係（軸整列）に
    // 敷かれる。結果、前景（地平線方向）が横方向スプレッドぶんしか覆われず奥に穴が空く（例:
    // radius 8000・tilt 67°・az 174.9° で nadir 直下の z7 タイルが未被覆）。分数座標なら nadir と
    // center が同一整数タイル内でも真の方位差が残り、帯を正しく視線方向へ向けられる。
    const nadir = ecefToGeodetic(cameraEcef);
    const totalMin = totalPixelsForZoom(minZoom);
    // `latLonToPixel` は px/py を [0, totalPixels] の閉区間にクランプするため、メルカトル端
    // （緯度 ±85.05° 付近）で py=totalPixels となり得る。そのまま割ると y=2^minZoom（=limit）に
    // なり、`addAt` の `ty>=limit` 判定で root seed が捨てられて可視タイルが選べなくなる。
    // y（緯度）は巡回しないので最南端ピクセルを 1px 内側へクランプし、タイル座標を常に
    // [0, 2^minZoom) に収める（旧 `toTileXY` のタイル index クランプと同等）。x（経度）は
    // `addAt` 内の wrap（`%limit`）で px=totalPixels→tile 0 に正しく折り返るためクランプ不要。
    const fracTile = (px: number, py: number) => ({
        x: px / TILE_SIZE,
        y: Math.min(py, totalMin - 1) / TILE_SIZE,
    });
    const nPix = latLonToPixel(nadir.latDeg, nadir.lonDeg, totalMin);
    const cPix = latLonToPixel(centerLat, centerLon, totalMin);
    const t0 = fracTile(nPix.px, nPix.py);
    const t1 = fracTile(cPix.px, cPix.py);

    // x（経度方向）は日付変更線で巡回する（2^minZoom タイル周期）。単純差分だと境界を
    // またいだとき t0.x≒2048/t1.x≒0 のように巨大な dx になり帯の方向・長さが壊れるため、
    // 最短符号付き差分（[-n/2, n/2)）に正規化する。y（メルカトル緯度）は巡回しない。
    const n = 2 ** minZoom;
    let dx = ((((t1.x - t0.x) % n) + n) % n);
    if (dx > n / 2) dx -= n;
    const dy = t1.y - t0.y;
    const dirLen = Math.hypot(dx, dy);

    // along-track（帯の進行方向）と lateral（直交方向）の単位ベクトル。直下視で方向が
    // 定まらない（dirLen≒0）ときは nadir 中心の対称ボックスへフォールバックする。
    let ux = 1;
    let uy = 0;
    let px = 0;
    let py = 1;
    if (dirLen > 1e-6) {
        ux = dx / dirLen;
        uy = dy / dirLen;
        px = -uy;
        py = ux;
    }

    const seeds: RootSeed[] = [];
    const seen = new Set<string>();
    /**
     * minZoom 座標 (cxMin, cyMin) を含む zoom レベルのタイルを 1 枚追加する。
     * 粗 zoom（zoom < minZoom）では minZoom 座標を `2^(minZoom-zoom)` で割って粗グリッドへ
     * スナップする（量子化で近接断面が同一粗タイルに収束し、自然にデデュプされる）。
     */
    const addAt = (cxMin: number, cyMin: number, zoom: number): void => {
        if (seeds.length >= budget) return;
        const f = 2 ** (minZoom - zoom); // 粗タイル 1 枚 = minZoom タイル f 個分
        const limit = 2 ** zoom;
        // y（メルカトル緯度）は巡回しない。範囲外（極側のはみ出し）は無効タイルなので捨て、
        // 予算を浪費しない。x（経度）は巡回するため範囲内へ正規化する。
        const ty = Math.floor(cyMin / f);
        if (ty < 0 || ty >= limit) return;
        const tx = ((Math.floor(cxMin / f) % limit) + limit) % limit;
        const key = `${zoom},${tx},${ty}`;
        if (seen.has(key)) return;
        seen.add(key);
        seeds.push({ x: tx, y: ty, zoom });
    };
    const edge0 = tileEdge0Meters(centerLat);
    const tanHalfV = Math.max(1e-6, Math.tan(verticalFov / 2));
    const denom = 2 * tanHalfV;
    // 水平 FOV の半角 tan。画面は縦より横が広い（アスペクト比）ため横方向被覆に必要。
    const aspect = viewportWidth / Math.max(1, viewportHeight);
    const tanHalfH = aspect * tanHalfV;
    const R = EARTH_MEAN_RADIUS_M;
    const h = Math.max(0, nadir.altMeters);
    const refTileMeters = Math.max(1, tileEdgeMeters(centerLat, minZoom));
    // 地平線までの地表弧長（中心角 acos(R/(R+h))）。帯の along-track 距離（弧長）と整合。
    const horizonArc = R * Math.acos(Math.min(1, R / (R + h)));

    // ---- 全球モード（高高度） ----
    // 地球の見かけ角半径が小さい（高高度で地球の大部分＝広いキャップが視界に入る）と、視線方向に
    // 沿う 1 次元の帯では 2 次元キャップを覆い切れず縁が欠ける（低高度の帯アルゴリズムを高高度へ
    // 流用するのは無理がある）。この帯域では全球（反対側も含む）を最粗 floorZoom で一様に種付けし、
    // 後段 traverse の SSE 細分化（サブカメラ直下ほど細かく）＋地平線カリング（裏側を早期に除去）で
    // 可視半球を適切な LOD で被覆する。floorZoom=2 なら全球 16 枚と安価で、地理院タイルは
    // テクスチャ z0〜・標高 z1〜を供給するため全球を地図でマッピングできる。
    const earthAngRadius = Math.asin(Math.min(1, R / (R + h)));
    if (earthAngRadius <= GLOBAL_VIEW_EARTH_ANG_RADIUS) {
        const gz = floorZoom;
        const limit = 2 ** gz;
        // nadir/center を最優先で確保する。全球一様種付けは gy/gx の 0 起点ラスタ順のため、
        // 予算（budget）が全球枚数 2^gz×2^gz に満たない場合（例: rootZoomFloor 未指定で
        // floorZoom===minZoom だと 2^minZoom 周期となり budget 超過）、ラスタ順では視界中央の
        // nadir/center 付近に到達する前に予算が尽き、視界周辺が未被覆になり得る。先に必ず種付け
        // しておけば、予算が一様種付けに満たなくても視界中央は被覆される（予算切れ時は addAt の
        // budget ガードでループは打ち切られ、その時点の seeds を返す）。
        addAt(t0.x, t0.y, gz);
        addAt(t1.x, t1.y, gz);
        for (let gy = 0; gy < limit && seeds.length < budget; gy++) {
            for (let gx = 0; gx < limit && seeds.length < budget; gx++) {
                addAt(gx * 2 ** (minZoom - gz), gy * 2 ** (minZoom - gz), gz);
            }
        }
        return seeds;
    }

    /** 地表沿い距離 arc[m] の地点へのカメラ弦距離 d[m]（球面近似）。 */
    const chordDist = (arcMeters: number): number => {
        const theta = Math.abs(arcMeters) / R;
        return Math.sqrt(
            (R + h) * (R + h) + R * R - 2 * (R + h) * R * Math.cos(theta),
        );
    };
    /**
     * カメラ距離 d[m] の地点の SSE 最適 root zoom（256px ルール＋距離累進, [floor, minZoom]）。
     * 併せて「タイル 1 辺 ≤ カメラ距離」になる粗さ下限（distCapZoom）を課す。これがないと距離累進で
     * 遠方タイルが極端に粗く（1 辺が距離より大）なり、その巨大タイルが近景領域まで内包して後段の
     * quadtree カット整形（粗い方優先）が近景の細タイルを誤除去してしまう（画面全体が数枚に潰れる）。
     */
    const zoomForDist = (d: number): number => {
        const eff = effectiveSseThreshold(sseThreshold, d, h);
        const zStar = Math.log2(
            (edge0 * viewportHeight) / (eff * Math.max(1, d) * denom),
        );
        const distCapZoom = Math.ceil(Math.log2(edge0 / Math.max(1, d)));
        // 高高度（HIGH_ALT_ZOOM_CAP_M 以上）では、テクスチャ品質下限
        // （textureQualityFloorZoom）を外し、zoom 上限を HIGH_ALT_MAX_ZOOM に抑える。
        // 高度が上がると可視域が広がり地図の文字も読めなくなるため、詳細（z9〜）を張ると
        // タイル数が maxTiles を食い潰して可視域の外周が欠ける（半分しか出ない）。下限を外して
        // zStar/distCapZoom の距離累進（対数的）に委ね、上限で頭打ちにすることで、少数の粗タイルで
        // 可視域全体を被覆する。低〜中高度（未満）は従来どおり詳細＋品質下限を維持する。
        const highAlt = h >= HIGH_ALT_ZOOM_CAP_M;
        const texFloor = highAlt ? 0 : (textureQualityFloorZoom ?? 0);
        // 上限は常に minZoom 以下に収める。minZoom < HIGH_ALT_MAX_ZOOM（URL/デモで minZoom を
        // 小さく設定）でも seed zoom が minZoom を超えないようにする（超えると addAt の
        // f=2**(minZoom-zoom) が負指数=f<1 になり不正なタイル座標変換になる, Copilotレビュー指摘）。
        const zCap = highAlt ? Math.min(minZoom, HIGH_ALT_MAX_ZOOM) : minZoom;
        // 高高度では下限を 0 にして zStar/distCapZoom の距離累進（対数的粗化）を活かす。
        // floorZoom（rootZoomFloor 省略時は minZoom）を下限に残すと、それが zCap を上回るケース
        // （rootZoomFloor 未指定など）で下の Math.max が張り付き z=zCap(8) に平坦化して 8 未満へ
        // 粗化できず、rootZoomFloor 指定有無で挙動が変わってしまう。粗化の暴発は distCapZoom
        // （タイル 1 辺 ≤ カメラ距離）が抑えるため 0 で安全（Copilotレビュー指摘）。
        const effFloorZoom = highAlt ? 0 : floorZoom;
        return Math.min(
            zCap,
            Math.max(effFloorZoom, texFloor, Math.ceil(zStar), distCapZoom),
        );
    };

    /**
     * along-track 位置 s（minZoom タイル単位。s * refTileMeters で距離[m]へ換算）の emit zoom・
     * カメラ距離 d における lateral 断面を張る。横半幅は
     * 視錐台の台形に合わせ「カメラ距離 × 水平 FOV」をその emit タイルサイズで割った枚数とする
     * （遠方ほど広い台形を、粗い emit タイルで少数被覆）。emit タイルが大きいと枚数は少なく済む。
     */
    const addCrossSection = (s: number, zoom: number): void => {
        const f = 2 ** (minZoom - zoom);
        const tileM = tileEdgeMeters(centerLat, zoom);
        const d = chordDist(Math.abs(s) * refTileMeters);
        const halfTiles = Math.min(
            LATERAL_TILE_CAP,
            Math.ceil((d * tanHalfH) / Math.max(1, tileM)) + margin,
        );
        const cx = t0.x + ux * s;
        const cy = t0.y + uy * s;
        // lateral も **半タイル刻み**で張る。帯（track）がタイル格子に対して斜め（az が格子非整列）
        // のとき、横方向に 1 タイル（px·f, py·f）ずつ進めると配置点が対角線上に並び、直交隣接の
        // global タイルを飛ばして横帯に穴が空く（例 az174.9°・arc127km で root 未被覆）。
        // 0.5 刻みにすると帯をタイルサイズの半分の解像度で標本化でき、斜めでも重なる global タイルを
        // 1 枚も飛ばさない。重複は addAt の seen でデデュプ。
        for (let w = -halfTiles; w <= halfTiles; w += 0.5) {
            addAt(cx + px * w * f, cy + py * w * f, zoom);
        }
    };

    // nadir↔center の地表距離とチルトは、整数タイル座標（dirLen）由来だと丸め誤差で dFar が
    // 不正確になり特定高度で奥が欠けるため、実カメラ幾何（ベクトル）から正確に求める。
    // dirLenMeters = R·中心角(nadir↔center)。tilt = 視線(camera→center) と直下(−camera) のなす角。
    // 注視点の地表標高で center を評価する（tilt/前方到達距離の正確化）。負値（海面下）と
    // NaN/Infinity は 0（海面）へ丸め、下流の cosPsi/acos への異常値伝播を防ぐ。
    const centerAlt = Number.isFinite(referenceAltitude)
        ? Math.max(0, referenceAltitude as number)
        : 0;
    const centerEcef = geodeticToEcefToRef(
        centerLat,
        centerLon,
        centerAlt,
        new Vector3(),
    );
    const camLen = Math.max(1, cameraEcef.length());
    const cosPsi = Math.min(
        1,
        Math.max(-1, Vector3.Dot(cameraEcef, centerEcef) / (camLen * centerEcef.length())),
    );
    const dirLenMeters = R * Math.acos(cosPsi);
    const lookDir = centerEcef.subtract(cameraEcef); // camera→center
    // tilt = 視線と直下（−cameraEcef）のなす角。Follow mode では実カメラが機体（高度あり）を見て
    // ほぼ水平前方を向くのに center=機体直下地表のため、camera→center 由来の tilt が実際より小さく
    // （下向き寄りに）算出され forwardReach が短縮、前方（地平線側）が未種付けになる（#475）。
    // viewForward（実視線）が渡された場合はそれで tilt を求め、前方到達距離を実視線に一致させる。
    // 零ベクトル・非有限は camera→center へフォールバック（後方互換）。
    const vf = opts.viewForward;
    const vfLenSq = vf ? vf.lengthSquared() : 0;
    const tilt =
        vf && Number.isFinite(vfLenSq) && vfLenSq > 1e-12
            ? Math.acos(
                  Math.min(
                      1,
                      Math.max(-1, -Vector3.Dot(vf, cameraEcef) / (Math.sqrt(vfLenSq) * camLen)),
                  ),
              )
            : Math.acos(
                  Math.min(
                      1,
                      Math.max(-1, -Vector3.Dot(lookDir, cameraEcef) / (lookDir.length() * camLen)),
                  ),
              );

    // nadir と center の root を最優先確保（各々の SSE 最適 zoom で）。budget=1 では nadir のみ。
    addAt(t0.x, t0.y, zoomForDist(chordDist(0)));
    addAt(t1.x, t1.y, zoomForDist(chordDist(dirLenMeters)));

    // 前方到達距離 [m]: 視錐台「上端」（tilt＋垂直 FOV 半角）が地表に当たる距離まで張る。上端が
    // 地平線を越える（≧90°）場合は地平線で打ち切る。これにより高チルトでも奥（地平線側）まで
    // 欠けずに被覆できる。後方は nadir 手前のフットプリント分。フットプリント半幅は直下視の可視半径で、
    // 画面は横が広い（水平 FOV）ため tanHalfH を使う（直下視で along-track が任意方向でも広い方の軸を
    // 被覆）。粗タイルの粒度で上端が僅かに欠けないよう到達距離に小さなマージン係数を掛ける。
    const footprintMeters = Math.max(refTileMeters, h * tanHalfH);
    // 視錐台上端レイ（直下から角 alpha = tilt + 垂直FOV半角）と地球（半径 R）の近交点までの地表弧長
    // を球面で正確に求める（平面 h·tan は斜め見で地表到達点を過小評価し奥が欠ける）。レイが球面に
    // 当たらない（地平線以遠）/真上向きなら地平線まで張る。中心角 ψ = asin((R+h)·sinα/R) − α。
    const Rc = R + h;
    const alpha = tilt + verticalFov / 2;
    const sinA = Math.sin(alpha);
    const reachesGround = alpha < Math.PI / 2 && (Rc * sinA) / R < 1;
    const dFar = reachesGround
        ? R * (Math.asin((Rc * sinA) / R) - alpha)
        : horizonArc;
    const forwardReachM = Math.min(
        horizonArc,
        Math.max(footprintMeters, dFar) * FORWARD_REACH_MARGIN,
    );
    const backReachM = footprintMeters;

    // 前方: nadir(s=0) から forwardReach まで、along-track 位置 s（minZoom タイル単位）を進めながら
    // 各 s で「現在距離の SSE 最適 emit zoom」の断面を張って連続被覆する。刻みは現在の emit タイルの
    // **半分**（s 単位で f/2）にする。これにより距離適応で zoom（タイルサイズ）が変わる継ぎ目でも、
    // 軌道が通る global タイルを 1 枚も飛ばさず重ねて被覆できる。配置（addAt）は emit zoom の global
    // タイル格子に量子化し、重複は seen 集合でデデュプされるため、半刻みの重なりはコスト（反復数）
    // のみで結果のタイル数は被覆相当に有界。旧実装は s 空間の f-セル単位で歩いたため、s 格子（nadir
    // 起点）と global タイル格子（lon/lat 原点起点）のオフセットが zoom 遷移と重なると最遠側で
    // global タイル 1 枚分（例: 389-630km 帯）を張り残し、奥（地平線側）が 1 行欠けた。
    // 最遠端まで確実に含めるよう reach に最遠 emit タイル 1 枚分の余白を足す。
    const STEP_MIN_S = 0.5; // s（minZoom タイル）刻みの下限（停滞防止）。
    const fFar = 2 ** (minZoom - zoomForDist(chordDist(forwardReachM)));
    const reachS = forwardReachM / refTileMeters + fFar;
    const backS = backReachM / refTileMeters + fFar;
    for (let s = 0; s <= reachS && seeds.length < budget; ) {
        const z = zoomForDist(chordDist(s * refTileMeters));
        addCrossSection(s, z);
        s += Math.max(STEP_MIN_S, 2 ** (minZoom - z) / 2);
    }
    // 後方（nadir 手前）。s>0 を −s に写して同様に半刻みで連続被覆する（s=0 は前方と重複するが
    // デデュプされるため STEP_MIN_S から開始）。
    for (let s = STEP_MIN_S; s <= backS && seeds.length < budget; ) {
        const z = zoomForDist(chordDist(s * refTileMeters));
        addCrossSection(-s, z);
        s += Math.max(STEP_MIN_S, 2 ** (minZoom - z) / 2);
    }
    return seeds;
};

/**
 * タイル (zoom,x,y) の境界緯度経度（角、タイル中心ではない）を返す。
 * `tileCenterLatLon` は中心を返すため、+0.5 オフセットを打ち消す形で角を直接算出する。
 */
const tileLatLonBounds = (
    zoom: number,
    x: number,
    y: number,
): { lonWest: number; lonEast: number; latNorth: number; latSouth: number } => {
    const n = 2 ** zoom;
    const lonWest = (x / n) * 360 - 180;
    const lonEast = ((x + 1) / n) * 360 - 180;
    const latNorth =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const latSouth =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
    return { lonWest, lonEast, latNorth, latSouth };
};

/**
 * タイル (zoom,x,y) の地理範囲が日本テクスチャ被覆域（`JAPAN_BOUNDS`）と交差するか判定する。
 *
 * 地理院テクスチャ（std/seamlessphoto）は世界全域を z0–`WORLD_TEXTURE_MAX_ZOOM` まで、それより
 * 高ズームは日本周辺のみ配信する。域外を高ズーム細分化するとタイルが 404 で欠けるため、交差判定で
 * 域外タイルの細分化上限をクランプする。
 */
const tileIntersectsJapan = (zoom: number, x: number, y: number): boolean => {
    const { lonWest, lonEast, latNorth, latSouth } = tileLatLonBounds(zoom, x, y);
    return (
        lonEast >= JAPAN_BOUNDS.minLon &&
        lonWest <= JAPAN_BOUNDS.maxLon &&
        latNorth >= JAPAN_BOUNDS.minLat &&
        latSouth <= JAPAN_BOUNDS.maxLat
    );
};

/**
 * タイル (zoom,x,y) のECEF AABBを求める（4隅の経緯度×標高[0, DEFAULT_MAX_ELEVATION]の8点包含）。
 * 標高範囲は実測ではなく固定上限（日本の最高標高+マージン、平面版 `visibleTiles.ts` と同じ定数）
 * を使う保守的な近似。実測より広め＝カリングは「完全に外側」の場合のみ働く安全側の近似となる。
 */
const tileEcefAabb = (
    zoom: number,
    x: number,
    y: number,
    scratch: Vector3,
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } => {
    const { lonWest, lonEast, latNorth, latSouth } = tileLatLonBounds(zoom, x, y);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    // 8隅（lat×lon×alt の2×2×2）をビット選択の固定回数ループで巡る。selectGlobeTiles の
    // traverse ホットパスで毎回配列リテラル（[latSouth,latNorth]等）を生成しないための対策
    // （PR #467 レビュー指摘）。
    for (let i = 0; i < 8; i++) {
        const lat = i & 1 ? latNorth : latSouth;
        const lon = i & 2 ? lonEast : lonWest;
        const alt = i & 4 ? DEFAULT_MAX_ELEVATION : 0;
        geodeticToEcefToRef(lat, lon, alt, scratch);
        if (scratch.x < minX) minX = scratch.x;
        if (scratch.x > maxX) maxX = scratch.x;
        if (scratch.y < minY) minY = scratch.y;
        if (scratch.y > maxY) maxY = scratch.y;
        if (scratch.z < minZ) minZ = scratch.z;
        if (scratch.z > maxZ) maxZ = scratch.z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
};

/**
 * グローブ向け Quadtree+SSE でカメラ近傍の可視タイルを選択する。
 *
 * root は `selectGlobeRootTiles` が選ぶ「nadir→center→地平線」の帯。
 * 各ノードで「地平線カリング → SSE 判定」を行い、受容 or 4 子へ分割。
 * 最後にカメラ距離の昇順で maxTiles 件に打ち切る。
 */
export const selectGlobeTiles = (opts: GlobeLodOptions): GlobeTile[] => {
    const {
        cameraEcef,
        centerLat,
        centerLon,
        minZoom,
        maxZoom,
        viewportHeight,
        viewportWidth,
        verticalFov,
        sseThreshold,
        maxTiles,
        rootSearchRadius,
        maxRootTiles,
        horizonDotThreshold,
        referenceAltitude = 0,
        rootZoomFloor = minZoom,
        frustumPlanes,
        pinnedPoints,
        textureQualityFloorZoom,
        viewForward,
    } = opts;

    if (maxZoom < minZoom) return [];

    // 視錐台に関わらず必ず最粗root(minZoom)を確保したい地点（centerLat/Lon自体を暗黙に含む）。
    // `terrainElevAt`/モデル接地が必要とする地点はカメラ視界と無関係な場合があるため（#463）。
    const pinnedRootKeys = new Set<string>();
    {
        const t = toTileXY(centerLat, centerLon, minZoom);
        pinnedRootKeys.add(tileKey(minZoom, t.x, t.y));
    }
    for (const p of pinnedPoints ?? []) {
        const t = toTileXY(p.lat, p.lon, minZoom);
        pinnedRootKeys.add(tileKey(minZoom, t.x, t.y));
    }

    const tanHalfFov = Math.max(1e-6, Math.tan(verticalFov / 2));
    const sseDenomBase = 2 * tanHalfFov;
    const camDir = cameraEcef.clone().normalize();
    // カメラ高度（楕円体高度）。SSE 距離累進（遠方ほど粗く）に使う。`selectGlobeRootTiles` が
    // root の emit zoom を決める際に使う高度（`ecefToGeodetic(cameraEcef).altMeters`）と**同一定義**に
    // 揃える。地心距離−平均半径の近似だと緯度により数 km ズレ、root と traverse で実効 SSE しきい値が
    // 食い違って余計な分割・訪問が起き得るため（選択ごとに 1 回のみの呼び出しでコストは無視できる）。
    const camAlt = Math.max(1, ecefToGeodetic(cameraEcef).altMeters);
    // 高高度では traverse の細分化上限も HIGH_ALT_MAX_ZOOM に抑える（root だけでなく quadtree 分割も
    // 頭打ちにしないと、近 nadir で root(z8) が z9 へ再分割されて「200km 以上は z8 以下」を満たさない）。
    const effectiveMaxZoom =
        camAlt >= HIGH_ALT_ZOOM_CAP_M ? Math.min(maxZoom, HIGH_ALT_MAX_ZOOM) : maxZoom;
    // 可視地平線の中心角（acos(R/r), r=カメラ地心距離）。地平線カリングの「タイルサイズ考慮」救済に
    // 使う（高高度の全球被覆で粗タイルの可視縁を取りこぼさないため）。
    const capAngle = Math.acos(
        Math.max(-1, Math.min(1, EARTH_MEAN_RADIUS_M / Math.max(1, cameraEcef.length()))),
    );

    const accepted: GlobeTile[] = [];
    // 受容済みタイルキー。距離適応で粗 root と近景 root が継ぎ目で重なり、別 root の細分化が
    // 同一 z/x/y へ到達しうるため、重複受容を防いで予算（maxTiles）の浪費を避ける。
    const acceptedKeys = new Set<string>();
    const tileEcef = new Vector3();
    const aabbScratch = new Vector3();
    // 暴発防止の訪問上限。
    const maxVisited = Math.max(maxTiles, 256) * 32;
    let visited = 0;

    /**
     * `exempt=true` は、この呼び出し（root シード自体のみ、子孫には継承しない）で
     * 視錐台カリングを行わない。root シード自体（帯モデルの along-track/lateral 計算）は
     * 距離・FOV に基づく球面幾何で慎重に到達距離を計算済みであり、frustum の AABB 近似
     * （地平線際のグレージング角度で誤判定しやすい, #463 フォローアップ）より信頼できる。
     * 遠方の root は通常 SSE が「粗いまま受容（分割不要）」を選ぶため、この免除で
     * 地平線際の被覆が frustum 誤判定で縮む回帰を防げる。一方、子孫（SSE 細分化で生じる
     * より高精細なタイル）には免除を継承しない＝画面外への過剰な精細化（#463 が解消した
     * 本来の無駄）は引き続き frustum で防ぐ。
     */
    const traverse = (zoom: number, x: number, y: number, exempt = false): void => {
        if (visited >= maxVisited) return;
        visited++;

        const limit = 1 << zoom;
        if (x < 0 || x >= limit || y < 0 || y >= limit) return;

        // 距離適応で粗 root と近景 root の継ぎ目が重なる等、複数 root から同一タイルへ
        // 到達し得る。既に受容済みなら結果は変わらないため、地平線/視錐台カリングや距離計算に
        // 進む前に早期 return して重い計算を避ける（PR #467 レビュー指摘）。
        const k = tileKey(zoom, x, y);
        if (acceptedKeys.has(k)) return;

        const { lat } = tileCenterEcefToRef(zoom, x, y, referenceAltitude, tileEcef);

        // 地平線カリング: タイルの地心法線（= normalize(tileEcef)）とカメラ方向の内積。
        // 裏側（地球の向こう側）のタイルを除外する。camDir は正規化済みなので
        // dot(normalize(tileEcef), camDir) = dot(tileEcef, camDir) / |tileEcef| として
        // 計算し、ホットパスでの Vector3 割り当て（clone/normalize）を避ける。
        const tileLen = tileEcef.length();
        const horizonDot =
            tileLen > 0 ? Vector3.Dot(tileEcef, camDir) / tileLen : 0;
        if (horizonDot < horizonDotThreshold) {
            // 中心ベースのしきい値だけだと、粗タイル（z2 等）は中心が地平線の裏でも近縁が可視キャップ
            // 内に入る場合に取りこぼし、高高度の全球視点で縁/内側に穴が空く。タイルの角半径ぶん緩めた
            // 「可視キャップ（capAngle）と重なるか」で救済する。角半径はメルカトルタイルの経度幅
            // (2π/2^zoom) の 0.75 倍と十分大きめに見積もり、可視縁を確実に含める（裏側は依然カリング。
            // 余分な裏寄りタイルは描画時に背面/深度で隠れ無害）。低高度では cap が小さく、かつ
            // 帯 root が地平線裏を種付けしないため、この救済は実質高高度のみで効く。
            const centerAngle = Math.acos(Math.max(-1, Math.min(1, horizonDot)));
            const nodeAngRadius = ((2 * Math.PI) / (1 << zoom)) * 0.75;
            if (centerAngle - nodeAngRadius > capAngle) return;
        }

        // 視錐台カリング（#463）: 実カメラ frustum が渡されていれば、タイルの AABB
        // （水平フットプリント×標高範囲）が完全に外側の場合は除外する。帯モデル・地平線カリングは
        // 「裏側/概形」のみ見て真の視錐台を見ないため、チルトアップ時に画面外の地表も鉛直高度基準の
        // 距離累進でレベルが決まり、maxTiles 予算を浪費して真に見えている山（起伏で近い）が
        // 粗くなる無駄が生じていた。AABB が親の水平フットプリントの部分集合＝子で外側→親も外側なので、
        // ここで打ち切れば子孫の探索ごと安全に省略できる。
        //
        // `frustumPlanes` は「camera 相対」座標系（原点 = cameraEcef、回転のみ・並進なし）で定義される
        // 契約（呼び出し側は cameraEcef を原点とみなした frustum を渡す）。ECEF は原点からカメラまで
        // ~6.4e6m の巨大な並進を持ち、これを含む行列を Babylon の Float32 演算で作ると、view*proj の
        // 合成やそこからの平面抽出で桁落ち（catastrophic cancellation）し、実際に画面内の遠方地物
        // （例: 50km 先の富士山）が「視錐台外」と誤判定される（#463 回帰: 本ファイル参照元
        // `globe.ts` の zoom-to-cursor 精度ワークアラウンドと同種の精度要因）。そこで AABB 側を
        // ここで cameraEcef 分だけ平行移動（JS 倍精度の単純な減算）してから camera 相対平面へ渡す。
        //
        // ただし center / pinnedPoints の最粗root（minZoom）はこのカリングを免除する。真の視錐台
        // カリングは「画面に映るタイル」の最適化として正しいが、`terrainElevAt` やモデル接地は
        // 画面外の地点（例: 注視点と無関係な位置にスポーンするアバター）に対しても機能する必要が
        // あり、そこまで厳密に画面内へ絞ると回帰する（#463 で発生・修正）。
        // 契約は「6平面」。6平面以外（空配列・不完全な配列）だと部分平面での誤カリングや意図せぬ
        // カリング無効化につながるため、length===6 のときのみ視錐台カリングを適用する。
        if (
            frustumPlanes &&
            frustumPlanes.length === 6 &&
            !exempt &&
            !(zoom === minZoom && pinnedRootKeys.has(k))
        ) {
            const aabb = tileEcefAabb(zoom, x, y, aabbScratch);
            if (
                !isAABBInFrustum(
                    aabb.minX - cameraEcef.x,
                    aabb.minY - cameraEcef.y,
                    aabb.minZ - cameraEcef.z,
                    aabb.maxX - cameraEcef.x,
                    aabb.maxY - cameraEcef.y,
                    aabb.maxZ - cameraEcef.z,
                    frustumPlanes,
                )
            ) {
                return;
            }
        }

        const distance = Vector3.Distance(cameraEcef, tileEcef);
        const tileSizeMeters = tileEdgeMeters(lat, zoom);

        // 受容条件: SSE（距離累進）を満たし、かつ「タイル 1 辺 ≤ カメラ距離」（巨大タイルが
        // 近景を内包して整形で誤除去されるのを防ぐ粗さ上限）。maxZoom 到達時はそれ以上分割不可。
        // 日本テクスチャ被覆域外のタイルは z>WORLD_TEXTURE_MAX_ZOOM のテクスチャが存在せず 404 で
        // 欠けるため、実効 maxZoom を WORLD_TEXTURE_MAX_ZOOM にクランプして低レベル表示を維持する。
        // 交差判定は z>=WORLD_TEXTURE_MAX_ZOOM のノードに限定してコストを抑える。
        const effMaxZoom =
            zoom >= WORLD_TEXTURE_MAX_ZOOM &&
            effectiveMaxZoom > WORLD_TEXTURE_MAX_ZOOM &&
            !tileIntersectsJapan(zoom, x, y)
                ? WORLD_TEXTURE_MAX_ZOOM
                : effectiveMaxZoom;
        const accept =
            zoom >= effMaxZoom ||
            ((tileSizeMeters * viewportHeight) /
                (Math.max(1, distance) * sseDenomBase) <=
                effectiveSseThreshold(sseThreshold, distance, camAlt) &&
                tileSizeMeters <= distance);

        if (accept) {
            // k は関数先頭の acceptedKeys.has(k) チェックを通過済み（未受容）なのでここでは
            // 常に新規追加になる。
            acceptedKeys.add(k);
            accepted.push({ zoom, x, y, tileSizeMeters, distance });
            return;
        }

        const nz = zoom + 1;
        for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
                traverse(nz, x * 2 + sx, y * 2 + sy);
            }
        }
    };

    const roots = selectGlobeRootTiles({
        cameraEcef,
        centerLat,
        centerLon,
        minZoom,
        rootSearchRadius,
        maxRootTiles,
        rootZoomFloor,
        viewportHeight,
        viewportWidth,
        verticalFov,
        sseThreshold,
        textureQualityFloorZoom,
        referenceAltitude,
        viewForward,
    });
    // root シードを traverse 開始点とする。日本被覆域外の root が minZoom(>WORLD_TEXTURE_MAX_ZOOM)
    // で生成されると、それ以上分割しなくても root タイル自体のテクスチャが存在せず(404)白く欠ける。
    // そこで域外 root は WORLD_TEXTURE_MAX_ZOOM の祖先に丸めて開始する。複数 root が
    // 同一祖先へ collapse しても acceptedKeys の重複排除で吸収される。
    for (const r of roots) {
        if (
            r.zoom > WORLD_TEXTURE_MAX_ZOOM &&
            maxZoom > WORLD_TEXTURE_MAX_ZOOM &&
            !tileIntersectsJapan(r.zoom, r.x, r.y)
        ) {
            const dz = r.zoom - WORLD_TEXTURE_MAX_ZOOM;
            traverse(WORLD_TEXTURE_MAX_ZOOM, r.x >> dz, r.y >> dz, true);
        } else {
            traverse(r.zoom, r.x, r.y, true);
        }
    }

    // pinned地点（center含む）の最粗rootは帯モデルの被覆と無関係に必ず traverse を開始する
    // （帯が地平線方向へしか伸びず pinned 地点をそもそも種付けしないケースの保険。#463）。
    // 既に roots 経由で到達済みなら acceptedKeys の重複排除で吸収される。
    // 開始ノードは roots 側と同様に exempt=true（視錐台カリング免除）で呼ぶ。域外 pinned を
    // WORLD_TEXTURE_MAX_ZOOM へ丸める分岐では zoom≠minZoom となり traverse 内の pinnedRootKeys
    // 免除が効かないため、exempt を渡さないと pinned の保険タイル自体が視錐台外判定で除外され、
    // terrainElevAt/モデル接地の回帰防止という目的を満たせない（開始ノードは effMaxZoom で即
    // 受容されるため中間ノードのカリング問題は生じない）。
    for (const key of pinnedRootKeys) {
        const [pz, px, py] = key.split("/").map(Number);
        // pinned は minZoom(z11) 固定で開始するが、開始ノードは effMaxZoom で即受容されるため、
        // 高高度キャップ（effectiveMaxZoom）や域外 WORLD_TEXTURE_MAX_ZOOM 丸めを開始 zoom にも
        // 適用しないと、キャップ下でも center の z11 タイル 1 枚が残ってしまう（#465 フォロー）。
        const outOfJapan =
            pz > WORLD_TEXTURE_MAX_ZOOM &&
            maxZoom > WORLD_TEXTURE_MAX_ZOOM &&
            !tileIntersectsJapan(pz, px, py);
        const startZoom = Math.min(
            pz,
            effectiveMaxZoom,
            outOfJapan ? WORLD_TEXTURE_MAX_ZOOM : pz,
        );
        const dz = pz - startZoom;
        traverse(startZoom, px >> dz, py >> dz, true);
    }

    // 正しい quadtree カットへ整える: 距離適応で root の zoom が位置ごとに変わるため、
    // ズーム遷移の継ぎ目で粗いタイルと、その中に含まれる細いタイル（子孫）が同じ地表を二重に
    // 覆うことがある（タイルの重なり描画）。各採用タイルについて、より粗い採用タイル（祖先）が
    // 存在する＝その粗タイルに包含されるものを除外する（粗い方を残す＝被覆は維持される）。
    // floorZoom（最粗 root）まで祖先を辿れば十分。
    const floorZoom = Math.min(minZoom, Math.max(0, rootZoomFloor));
    const dedup =
        accepted.length > 1
            ? accepted.filter((t) => {
                  for (let z = t.zoom - 1; z >= floorZoom; z--) {
                      const dz = t.zoom - z;
                      if (acceptedKeys.has(tileKey(z, t.x >> dz, t.y >> dz))) return false;
                  }
                  return true;
              })
            : accepted;

    // maxTiles 予算に収める。素朴に「距離昇順で slice」すると最遠（地平線側）のタイルから捨てられ、
    // 高 DPI・低高度・高チルトで近景の細タイルが予算を食い切ると地平線側の被覆が丸ごと欠けて
    // ベースレイヤ（青）が露出する（sseThreshold を下げるほどタイル総数が増えて予算超過が早まり、
    // この症状が悪化する）。そこで削除ではなく「最遠の完全な 4 兄弟を親へ粗化統合」して枚数を
    // 減らす。粗化は被覆を保ったままタイル数を 3 減らすため、地平線側の被覆を維持しつつ近景の
    // 詳細を残せる（遠方から順に粗くする）。粗化しきれない（全タイルが floorZoom で兄弟統合の
    // 余地がない）縮退ケースのみ、従来どおり距離昇順 slice で強制的に上限を満たす。
    const budgeted = coarsenToBudget(
        dedup,
        maxTiles,
        floorZoom,
        cameraEcef,
        referenceAltitude,
        tileEcef,
    );
    budgeted.sort((a, b) => a.distance - b.distance);
    return budgeted.length > maxTiles ? budgeted.slice(0, maxTiles) : budgeted;
};

/**
 * quadtree カット `tiles`（重なりなしの完全被覆）を、被覆を保ったまま `maxTiles` 枚以内へ粗化する。
 *
 * 距離昇順 slice が最遠タイルを削除して地平線側にベースレイヤ露出の穴を空けるのを避けるため、
 * 「最遠の、4 兄弟がすべて揃った」ノードを親（zoom-1）へ統合する操作を繰り返す。完全な 4 兄弟の
 * みを統合するので重なり（祖先-子孫の二重被覆）は生じず、被覆は厳密に保たれ、1 回で枚数が 3 減る。
 * `floorZoom` 未満へは粗化しない。完全な兄弟集合が尽きた時点で打ち切り、呼び出し側の距離昇順
 * slice が縮退ケースの上限保証を担う（このとき初めて穴が生じ得るが、floorZoom が十分粗ければ
 * 到達しない）。統合順は「最遠優先」で近景の詳細を温存する。
 */
const coarsenToBudget = (
    tiles: GlobeTile[],
    maxTiles: number,
    floorZoom: number,
    cameraEcef: Vector3,
    referenceAltitude: number,
    scratch: Vector3,
): GlobeTile[] => {
    if (tiles.length <= maxTiles) return tiles;
    const byKey = new Map<string, GlobeTile>();
    for (const t of tiles) byKey.set(tileKey(t.zoom, t.x, t.y), t);
    // 統合は 1 回で高々 3 枚減り、各統合で zoom 総和が単調減少するため必ず停止する。ガードは保険。
    let guard = tiles.length * 4 + 64;
    while (byKey.size > maxTiles && guard-- > 0) {
        // 4 兄弟がすべて揃い、親が floorZoom 以上になる、最も遠いノードを探す。
        let bestDist = -1;
        let bestZoom = -1;
        let bestPx = 0;
        let bestPy = 0;
        for (const t of byKey.values()) {
            const pz = t.zoom - 1;
            if (pz < floorZoom) continue;
            const px = t.x >> 1;
            const py = t.y >> 1;
            let complete = true;
            for (let sy = 0; sy < 2 && complete; sy++) {
                for (let sx = 0; sx < 2 && complete; sx++) {
                    if (!byKey.has(tileKey(t.zoom, px * 2 + sx, py * 2 + sy))) complete = false;
                }
            }
            if (!complete) continue;
            if (t.distance > bestDist) {
                bestDist = t.distance;
                bestZoom = t.zoom;
                bestPx = px;
                bestPy = py;
            }
        }
        if (bestZoom < 0) break; // 統合可能な完全兄弟集合なし（縮退）。
        for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
                byKey.delete(tileKey(bestZoom, bestPx * 2 + sx, bestPy * 2 + sy));
            }
        }
        const pz = bestZoom - 1;
        const { lat } = tileCenterEcefToRef(pz, bestPx, bestPy, referenceAltitude, scratch);
        byKey.set(tileKey(pz, bestPx, bestPy), {
            zoom: pz,
            x: bestPx,
            y: bestPy,
            tileSizeMeters: tileEdgeMeters(lat, pz),
            distance: Vector3.Distance(cameraEcef, scratch),
        });
    }
    return [...byKey.values()];
};

/** タイル一意キー（"z/x/y"）。 */
export const tileKey = (zoom: number, x: number, y: number): string =>
    `${zoom}/${x}/${y}`;
