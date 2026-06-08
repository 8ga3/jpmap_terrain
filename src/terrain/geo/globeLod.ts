/**
 * グローブ（ECEF）向け LOD/SSE タイル選択 (Issue #275 Phase 1)。
 *
 * 平面ワールド前提の `src/terrain/visibleTiles.ts`（Quadtree+SSE）を、グローブ
 * （地心 ECEF）向けに再定義したもの。PoC (#321) を本体共有モジュールへ昇格し、
 * ECEF 変換を Phase 0 の `geo/ecef` に委譲する。
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

import { TILE_SIZE, tileCenterLatLon, tileEdgeMeters } from "../gsiTile";
import { ecefToGeodetic, geodeticToEcefToRef } from "./ecef";
import { latLonToPixel, totalPixelsForZoom } from "./mapping";

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
     * 遠景 root の最粗 zoom（距離適応ルートレベルの下限, Issue #335）。
     * 高チルト時、近景 minZoom 帯の外側を距離に応じて minZoom-1, -2, … rootZoomFloor まで
     * 粗く張り、少数の粗タイルで地平線まで安価に被覆する（SSE が近景のみ細分化）。
     * 省略時は minZoom（粗化なし＝従来挙動）。GSI 標高は dem_png が z8〜z14 を供給する
     * ため z8 程度を下限とするのが安全。
     */
    rootZoomFloor?: number;
    /**
     * SSE 距離評価に使うタイル中心の基準標高[m]。
     * 高標高地（富士山等）では実地表が海面より高く、タイル中心を alt=0 で評価すると
     * カメラ↔タイルの距離が過大になり LOD が上がらない。中心付近の地形標高を渡すことで
     * 距離が地表基準になり、近接時に高 zoom が選択される。省略時 0。
     */
    referenceAltitude?: number;
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
    /** 遠景 root の最粗 zoom（距離適応ルートレベルの下限, Issue #335）。省略時 minZoom。 */
    rootZoomFloor?: number;
    /** ビューポート高さ [px]（root ズームの SSE 算出に使用）。 */
    viewportHeight: number;
    /** ビューポート幅 [px]（水平 FOV＝横方向被覆の算出に使用）。 */
    viewportWidth: number;
    /** 垂直 FOV [rad]（同上）。 */
    verticalFov: number;
    /** SSE 採用しきい値 [px]（同上, 256px タイルの表示サイズ境界）。 */
    sseThreshold: number;
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
 * 全球モードに切り替える地球の見かけ角半径しきい値 [rad]（Issue #335）。地球の角半径
 * `asin(R/(R+h))` がこの値以下＝高高度で可視領域が地球の大きな部分（広いキャップ）になると、
 * 視線方向に沿う 1 次元の帯（swath）では 2 次元キャップを覆い切れず縁が欠ける。そこで全球を最粗
 * `floorZoom` で種付けし、traverse の SSE 細分化＋地平線カリングに委ねる方式へ切り替える。
 * 約 1.0rad（≒57°, 高度 ≳1,000km）。これ未満（低〜中高度）は従来の帯で効率を維持する。
 */
const GLOBAL_VIEW_EARTH_ANG_RADIUS = 1.0;

/**
 * SSE しきい値の距離累進係数（Issue #335）。実効しきい値を
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
 * 可視地表を覆う root タイル集合を選定する（Issue #329 の帯 ＋ Issue #335 の高度/距離適応）。
 *
 * **帯の張り方（#329）**: カメラ直下点（nadir, 前景）から注視点（center）を通り視線方向へ伸びる
 * ground-track の帯（swath）に root を張る。along-track は nadir 手前のマージンから center を越え
 * FOV 端まで、lateral は ±`rootSearchRadius`。これによりチルト時も前景（nadir）が欠落しない。
 *
 * **高度/距離適応ルートレベル（#335）**: 各 root の zoom を固定 `minZoom` ではなく、その地点までの
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
    } = opts;
    const margin = Math.max(0, rootSearchRadius);
    const budget = Math.max(1, maxRootTiles);
    // emit zoom の最粗下限。minZoom 以下に丸める（minZoom は最細＝近景 root 基準）。
    const floorZoom = Math.min(minZoom, Math.max(0, opts.rootZoomFloor ?? minZoom));

    // カメラ直下点（nadir, 前景）と注視点（center）の minZoom タイル座標（帯の基準格子）。
    // **分数（fractional）タイル座標**で持つ。整数タイル（toTileXY）だと、低高度・斜め見で
    // nadir↔center の水平距離が 1 タイル未満のとき t0==t1 になり dirLen=0 ＝ 帯の方向（方位）が
    // 失われ、nadir 中心ボックスのフォールバックに落ちて帯が視線方向とは無関係（軸整列）に
    // 敷かれる。結果、前景（地平線方向）が横方向スプレッドぶんしか覆われず奥に穴が空く（#335:
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

    // ---- 全球モード（高高度, #335） ----
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
        return Math.min(
            minZoom,
            Math.max(floorZoom, Math.ceil(zStar), distCapZoom),
        );
    };

    /**
     * along-track 位置 arc[m]（emit zoom・カメラ距離 d）の lateral 断面を張る。横半幅は
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
        // global タイルを飛ばして横帯に穴が空く（#335: 例 az174.9°・arc127km で root 未被覆）。
        // 0.5 刻みにすると帯をタイルサイズの半分の解像度で標本化でき、斜めでも重なる global タイルを
        // 1 枚も飛ばさない。重複は addAt の seen でデデュプ。
        for (let w = -halfTiles; w <= halfTiles; w += 0.5) {
            addAt(cx + px * w * f, cy + py * w * f, zoom);
        }
    };

    // nadir↔center の地表距離とチルトは、整数タイル座標（dirLen）由来だと丸め誤差で dFar が
    // 不正確になり特定高度で奥が欠けるため、実カメラ幾何（ベクトル）から正確に求める。
    // dirLenMeters = R·中心角(nadir↔center)。tilt = 視線(camera→center) と直下(−camera) のなす角。
    const centerEcef = geodeticToEcefToRef(centerLat, centerLon, 0, new Vector3());
    const camLen = Math.max(1, cameraEcef.length());
    const cosPsi = Math.min(
        1,
        Math.max(-1, Vector3.Dot(cameraEcef, centerEcef) / (camLen * centerEcef.length())),
    );
    const dirLenMeters = R * Math.acos(cosPsi);
    const lookDir = centerEcef.subtract(cameraEcef); // camera→center（このあと未使用なので破棄可）
    const tilt = Math.acos(
        Math.min(1, Math.max(-1, -Vector3.Dot(lookDir, cameraEcef) / (lookDir.length() * camLen))),
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
    // global タイル 1 枚分（例: 389-630km 帯）を張り残し、奥（地平線側）が 1 行欠けた（#335）。
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
 * グローブ向け Quadtree+SSE でカメラ近傍の可視タイルを選択する。
 *
 * root は `selectGlobeRootTiles` が選ぶ「nadir→center→地平線」の帯（Issue #329）。
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
    } = opts;

    if (maxZoom < minZoom) return [];

    const tanHalfFov = Math.max(1e-6, Math.tan(verticalFov / 2));
    const sseDenomBase = 2 * tanHalfFov;
    const camDir = cameraEcef.clone().normalize();
    // カメラ高度（楕円体高度）。SSE 距離累進（遠方ほど粗く）に使う。`selectGlobeRootTiles` が
    // root の emit zoom を決める際に使う高度（`ecefToGeodetic(cameraEcef).altMeters`）と**同一定義**に
    // 揃える。地心距離−平均半径の近似だと緯度により数 km ズレ、root と traverse で実効 SSE しきい値が
    // 食い違って余計な分割・訪問が起き得るため（選択ごとに 1 回のみの呼び出しでコストは無視できる）。
    const camAlt = Math.max(1, ecefToGeodetic(cameraEcef).altMeters);
    // 可視地平線の中心角（acos(R/r), r=カメラ地心距離）。地平線カリングの「タイルサイズ考慮」救済に
    // 使う（高高度の全球被覆で粗タイルの可視縁を取りこぼさないため, #335）。
    const capAngle = Math.acos(
        Math.max(-1, Math.min(1, EARTH_MEAN_RADIUS_M / Math.max(1, cameraEcef.length()))),
    );

    const accepted: GlobeTile[] = [];
    // 受容済みタイルキー。距離適応で粗 root と近景 root が継ぎ目で重なり、別 root の細分化が
    // 同一 z/x/y へ到達しうるため、重複受容を防いで予算（maxTiles）の浪費を避ける。
    const acceptedKeys = new Set<string>();
    const tileEcef = new Vector3();
    // 暴発防止の訪問上限。
    const maxVisited = Math.max(maxTiles, 256) * 32;
    let visited = 0;

    const traverse = (zoom: number, x: number, y: number): void => {
        if (visited >= maxVisited) return;
        visited++;

        const limit = 1 << zoom;
        if (x < 0 || x >= limit || y < 0 || y >= limit) return;

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
            // 余分な裏寄りタイルは描画時に背面/深度で隠れ無害, #335）。低高度では cap が小さく、かつ
            // 帯 root が地平線裏を種付けしないため、この救済は実質高高度のみで効く。
            const centerAngle = Math.acos(Math.max(-1, Math.min(1, horizonDot)));
            const nodeAngRadius = ((2 * Math.PI) / (1 << zoom)) * 0.75;
            if (centerAngle - nodeAngRadius > capAngle) return;
        }

        const distance = Vector3.Distance(cameraEcef, tileEcef);
        const tileSizeMeters = tileEdgeMeters(lat, zoom);

        // 受容条件: SSE（距離累進）を満たし、かつ「タイル 1 辺 ≤ カメラ距離」（巨大タイルが
        // 近景を内包して整形で誤除去されるのを防ぐ粗さ上限）。maxZoom 到達時はそれ以上分割不可。
        const accept =
            zoom >= maxZoom ||
            ((tileSizeMeters * viewportHeight) /
                (Math.max(1, distance) * sseDenomBase) <=
                effectiveSseThreshold(sseThreshold, distance, camAlt) &&
                tileSizeMeters <= distance);

        if (accept) {
            const k = tileKey(zoom, x, y);
            if (!acceptedKeys.has(k)) {
                acceptedKeys.add(k);
                accepted.push({ zoom, x, y, tileSizeMeters, distance });
            }
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
    });
    for (const r of roots) traverse(r.zoom, r.x, r.y);

    // 正しい quadtree カットへ整える（#335）: 距離適応で root の zoom が位置ごとに変わるため、
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

    dedup.sort((a, b) => a.distance - b.distance);
    return dedup.slice(0, maxTiles);
};

/** タイル一意キー（"z/x/y"）。 */
export const tileKey = (zoom: number, x: number, y: number): string =>
    `${zoom}/${x}/${y}`;
