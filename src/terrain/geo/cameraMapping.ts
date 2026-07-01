/**
 * グローブカメラの UI/URL ⇄ `GeospatialCamera` マッピングと、
 * floating origin 下で `scene.pick` に依存しないパン（地表接線移動）・カメラ地形衝突の純関数群。
 *
 * 既存（平面版）の UI / URL 共有は `azimuth`(方位) / `tilt`(チルト) / `altitude`(高度) を用いる。
 * これを `GeospatialCamera` の `yaw` / `pitch` / `radius` / `center`(ECEF) と相互変換する。
 * PoC の純関数を本体共有モジュールへ昇格したもの。
 *
 * 対応関係:
 * - azimuth[deg] ⇄ yaw[rad]   （どちらも 0 = 北、+ = 東回り）
 * - tilt[deg]    ⇄ pitch[rad] （0 = 直下、90 = 水平。既存 UI の「地面からの傾き」と同義）
 *
 * 本モジュールは `GeospatialCamera` を直接 import しない（jest 環境を軽く保つ）。`yaw`/`pitch`
 * から視線（lookAt）を組む処理は Babylon の `ComputeLookAtFromYawPitchToRef` を呼ぶ
 * 呼び出し側（`scenes/globe.ts`）が担い、本モジュールには算出済みのベクトルを渡す。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { DEG2RAD, RAD2DEG, ecefToGeodeticToRef, type Geodetic } from "./ecef";

/** ECEF 北極軸（`EcefFromLatLonAltToRef` 規約: X→経度0, Y→東経90°, Z→北極）。 */
const ECEF_POLE = new Vector3(0, 0, 1);

/** 接線基底が縮退（特異点）とみなす長さ二乗のしきい値。 */
const DEGENERATE_EPS = 1e-12;

/** パン減速の高さ（長さ次元[m]）方向の 0 除算回避用しきい値。`DEGENERATE_EPS`（長さ二乗）とは次元が異なる。 */
const MIN_PAN_HEIGHT_EPS = 1e-6;

/** 既存 UI の azimuth/tilt[deg] → `GeospatialCamera` の yaw/pitch[rad]。 */
export const uiToYawPitch = (
    azimuthDeg: number,
    tiltDeg: number,
): { yaw: number; pitch: number } => ({
    yaw: azimuthDeg * DEG2RAD,
    pitch: tiltDeg * DEG2RAD,
});

/** `GeospatialCamera` の yaw/pitch[rad] → 既存 UI の azimuth/tilt[deg]。 */
export const yawPitchToUi = (
    yaw: number,
    pitch: number,
): { azimuthDeg: number; tiltDeg: number } => ({
    // azimuth は既存 URL 表現に合わせ [0, 360) に正規化（JS の % は負値を返すため二重剰余）。
    azimuthDeg: (((yaw * RAD2DEG) % 360) + 360) % 360,
    tiltDeg: pitch * RAD2DEG,
});

/**
 * 注視点(center)の地表における **地理的接線基底**（東・北）を `ref` に書き込む。WASD パン用。
 *
 * 地心 up（center 正規化）と ECEF 北極軸の外積で東を、up×東 で北を作る。極（up が北極軸と平行）
 * では東が定義できないため `false` を返す（呼び出し側はパンをスキップ）。
 *
 * @returns 基底を計算できたら true、極などの特異点で計算不能なら false。
 */
export const geographicTangentBasisToRef = (
    center: Vector3,
    eastRef: Vector3,
    northRef: Vector3,
): boolean => {
    const r = center.length();
    if (r < 1) return false;
    const up = center.scale(1 / r);
    Vector3.CrossToRef(ECEF_POLE, up, eastRef);
    if (eastRef.lengthSquared() < DEGENERATE_EPS) return false;
    eastRef.normalize();
    Vector3.CrossToRef(up, eastRef, northRef); // 北
    northRef.normalize();
    return true;
};

/**
 * 注視点(center)から見たカメラ視線(lookAt)を基準に、地表に沿った **右・前方向** を `ref` に書き込む。
 * 左ドラッグパン用（「マップを掴む」操作の縮尺をカメラ向きに合わせる）。
 *
 * `lookAt` はカメラ→center 方向（`ComputeLookAtFromYawPitchToRef` の出力）。地心 up との外積で
 * 画面右、up×右 で地表に沿った前方を作る。真下視点（lookAt ∥ up）では右が定義できず `false`。
 *
 * @returns 基底を計算できたら true、真下視点などの特異点で計算不能なら false。
 */
export const cameraTangentBasisToRef = (
    center: Vector3,
    lookAt: Vector3,
    rightRef: Vector3,
    fwdRef: Vector3,
): boolean => {
    const r = center.length();
    if (r < 1) return false;
    const up = center.scale(1 / r);
    Vector3.CrossToRef(lookAt, up, rightRef);
    if (rightRef.lengthSquared() < DEGENERATE_EPS) return false; // 真下視点
    rightRef.normalize();
    Vector3.CrossToRef(up, rightRef, fwdRef); // 地表に沿ったカメラ前方
    fwdRef.normalize();
    return true;
};

/**
 * 極付近のパン減速係数（[0,1]）を返す。極では東西の一定メートル移動が経度（極回りの方位角）の
 * 巨大な変化に対応し、地球が高速回転して見える。Babylon 組み込みパン
 * (`geospatialCameraMovement.computeCurrentFrameDeltas`) の緯度ダンピングと同等の式で、
 * 独自パン（`scenes/globe.ts`）にも極減速を与える。
 *
 * - 赤道では 1.0（減速なし）、極へ近づくほど 0 へ漸近する（`sqrt(cos(lat))`）。
 * - 高度が低い（`cameraHeight` が地心距離に対して小さい）ほど減速を緩め、地表付近では
 *   緯度の影響を受けないようにする（`max(1, centerRadius/height)` でスケール）。
 *
 * @param center      注視点(ECEF)。`center.z/|center|` が球面緯度の sin。
 * @param cameraHeight カメラの対地高度相当[m]（独自パンでは `camera.radius` を渡す）。
 * @returns           [0,1] のパン速度係数。`center` が原点近傍、または `center`/`cameraHeight` が
 *                    非有限（NaN/Infinity）などの退化時は 1（呼び出し側で NaN が伝播しないよう保証）。
 */
export const polePanSpeedMultiplier = (
    center: Vector3,
    cameraHeight: number,
): number => {
    const centerRadius = center.length();
    // 非有限入力は NaN を返さず減速なし(1)に倒す（呼び出し側の tangent.scaleInPlace(NaN) で
    // カメラ中心が壊れるのを防ぐ。Math.max/min は NaN を潰せないため明示ガードする）。
    if (
        !Number.isFinite(centerRadius) ||
        !Number.isFinite(center.z) ||
        !Number.isFinite(cameraHeight)
    ) {
        return 1;
    }
    if (centerRadius < 1) return 1;
    const sineLat = Math.min(1, Math.max(-1, center.z / centerRadius));
    const cosLat = Math.sqrt(Math.max(0, 1 - sineLat * sineLat));
    const latitudeDampening = Math.sqrt(cosLat); // sqrt で赤道付近の効きを弱める
    const height = Math.max(cameraHeight, MIN_PAN_HEIGHT_EPS);
    // 地表付近（height が小さい）では係数を 1 へ寄せ、緯度減速を無効化する。
    const latitudeDampeningScale = Math.max(1, centerRadius / height);
    const m = latitudeDampeningScale * latitudeDampening;
    return Math.min(1, Math.max(0, m));
};

/**
 * 注視点(center)を接線移動量 `tangentMove`[m] だけ動かし、地心距離 |center| を保つよう
 * 球面へ再投影した結果を `ref` に書き込む。パン共通の後処理。
 */
export const panCenterOnSphereToRef = (
    center: Vector3,
    tangentMove: Vector3,
    ref: Vector3,
): Vector3 => {
    const r = center.length();
    ref.copyFrom(center).addInPlace(tangentMove);
    const moved = ref.length();
    if (moved < 1) {
        ref.copyFrom(center);
        return ref;
    }
    ref.scaleInPlace(r / moved); // 地心距離 r を保って球面上へ戻す
    return ref;
};

/**
 * 原点 `origin` から方向 `dir` のレイと、**世界原点中心の楕円体**
 * `(x/radiusX)² + (y/radiusY)² + (z/radiusZ)² = 1` との手前側交点を `ref` に書き込む。
 * `dir` は**正規化不要**（二次方程式の係数 `t` がスケールに追従するだけで、交点
 * `origin + t·dir` は `dir` の長さに依らず正しく求まる）。
 * zoom-to-cursor のカーソル下の目標点を `scene.pick` 非依存かつ**地球楕円体上の固定点**として
 * 求める用途（球近似だとカメラがズームで動くたび `center.length()` 変化＋楕円体との差で目標点が
 * フレーム毎にずれ、カーソル下の地点が固定されず揺れる。WGS84 楕円体で解けば物理的に同一点へ収束）。
 *
 * 楕円体を各軸 `1/radius*` でスケールすると単位球に写るため、スケール空間でレイ係数 `t` を解く
 * （`t` はスケール変換に不変なので元空間の `origin + t·dir` に適用できる）。
 *
 * @param dir レイ方向。正規化は不要（長さは交点に影響しない）。
 * @returns 交点があり t>=0 なら true（`ref` に交点。t=0 は origin が楕円体面上の境界ケース）、
 *          レイが楕円体を外す/両交点とも背面、または半径・origin・dir が非有限/半径が非正なら false。
 */
export const rayEllipsoidNearHitToRef = (
    origin: Vector3,
    dir: Vector3,
    radiusX: number,
    radiusY: number,
    radiusZ: number,
    ref: Vector3,
): boolean => {
    // 半径が非有限/非正だと 0 除算で NaN が伝播し、disc<0 / t<0 判定を素通りして ref に NaN を
    // 書きつつ true を返し得る。origin/dir に NaN/Infinity が入った場合も同様に NaN が比較を
    // 素通りする。export 関数として入力（半径・origin・dir）の有限性を早期ガードする
    // （呼び出し側は通常正の有限値を渡す。退化入力時は ref を変更せず false）。
    if (
        !(radiusX > 0) ||
        !(radiusY > 0) ||
        !(radiusZ > 0) ||
        !Number.isFinite(radiusX) ||
        !Number.isFinite(radiusY) ||
        !Number.isFinite(radiusZ) ||
        !Number.isFinite(origin.x) ||
        !Number.isFinite(origin.y) ||
        !Number.isFinite(origin.z) ||
        !Number.isFinite(dir.x) ||
        !Number.isFinite(dir.y) ||
        !Number.isFinite(dir.z)
    ) {
        return false;
    }
    const ox = origin.x / radiusX;
    const oy = origin.y / radiusY;
    const oz = origin.z / radiusZ;
    const dx = dir.x / radiusX;
    const dy = dir.y / radiusY;
    const dz = dir.z / radiusZ;
    const a = dx * dx + dy * dy + dz * dz;
    if (a <= 0) return false;
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false; // レイが楕円体と交わらない（空を指している等）
    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a); // 手前側
    if (t < 0) t = (-b + sq) / (2 * a); // 手前が背面なら奥側（カメラが内部＝地中の保険）
    if (t < 0) return false; // 両交点とも背面
    ref.copyFrom(dir).scaleInPlace(t).addInPlace(origin);
    return true;
};

/** `rayEllipsoidHitsToRef` の出力用構造体。 */
interface EllipsoidHitsT {
    t0: number;
    t1: number;
}

/**
 * レイと楕円体の交点を `origin + t·dir` の t で両方（手前 t0 <= 奥 t1）求め、`outT` に書き込む。
 * `origin` が楕円体の内側にあれば t0<0<t1（後方に1つ、前方に1つ）になり得る。
 * `rayEllipsoidNearHitToRef` は手前かつ t>=0 の交点のみを返すため、球殻状の探索区間
 * （`resolveTerrainClickElevationToRef` が地表の存在し得る範囲を決める用途）には使えない。
 *
 * @param dir レイ方向。正規化不要。
 * @param outT 交点の書き込み先。
 * @returns 交点があれば true（`outT` に t0<=t1 を書き込む）、交わらない/半径・入力が不正なら false
 *          （この場合 `outT` は変更しない）。
 */
const rayEllipsoidHitsToRef = (
    origin: Vector3,
    dir: Vector3,
    radiusX: number,
    radiusY: number,
    radiusZ: number,
    outT: EllipsoidHitsT,
): boolean => {
    if (
        !(radiusX > 0) ||
        !(radiusY > 0) ||
        !(radiusZ > 0) ||
        !Number.isFinite(radiusX) ||
        !Number.isFinite(radiusY) ||
        !Number.isFinite(radiusZ) ||
        !Number.isFinite(origin.x) ||
        !Number.isFinite(origin.y) ||
        !Number.isFinite(origin.z) ||
        !Number.isFinite(dir.x) ||
        !Number.isFinite(dir.y) ||
        !Number.isFinite(dir.z)
    ) {
        return false;
    }
    const ox = origin.x / radiusX;
    const oy = origin.y / radiusY;
    const oz = origin.z / radiusZ;
    const dx = dir.x / radiusX;
    const dy = dir.y / radiusY;
    const dz = dir.z / radiusZ;
    const a = dx * dx + dy * dy + dz * dz;
    if (a <= 0) return false;
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false; // レイが楕円体と交わらない
    const sq = Math.sqrt(disc);
    const ta = (-b - sq) / (2 * a);
    const tb = (-b + sq) / (2 * a);
    if (ta <= tb) {
        outT.t0 = ta;
        outT.t1 = tb;
    } else {
        outT.t0 = tb;
        outT.t1 = ta;
    }
    return true;
};

// resolveTerrainClickElevationToRef 専用の作業用バッファ。同関数はズーム/パン中に毎フレーム
// 呼ばれ得るため、内部の一時ベクトル・オブジェクトをモジュールスコープで再利用しアロケーション
// を避ける（JS はシングルスレッドで本関数は再入しないため安全）。
const rtcUnitDir = new Vector3();
const rtcPoint = new Vector3();
const rtcOuterHits: EllipsoidHitsT = { t0: 0, t1: 0 };
const rtcInnerHits: EllipsoidHitsT = { t0: 0, t1: 0 };
// 探索中の各サンプル点の測地座標（呼び出し元の outGeo は採用確定時のみ書き込む）。
const rtcGeo: Geodetic = { latDeg: 0, lonDeg: 0, altMeters: 0 };

/**
 * レイと地形表面（実標高データに基づく面）の交点を、レイに沿ったマーチング（粗い等分探索 +
 * 二分探索での絞り込み）で求める（地形クリックピック・ズーム貫通対策）。
 *
 * 解析的な楕円体（クリック方向 1 点の標高だけで構成した定数面）との交差では、レイが経路上で
 * 通過する手前の山を無視してしまい、急斜面・山岳地帯でレイが山を貫通して奥の地表（山の裏側）に
 * 着地する（貫通・埋没・意図しない移動先の原因）。そこで「地表が存在し得る球殻（標高 0 〜
 * maxTerrainElevM）とレイが交差する区間」を手前から奥へ進め、レイの高度が地形標高を初めて
 * 下回る区間を検出し、二分探索で精度を上げる。奥端は通常「標高 0 面との交点」だが、水平線
 * よりわずかに上を見ていて標高 0 面に当たらない（高い山の頂上だけが見えている）場合は「外殻
 * （maxTerrainElevM 面）の奥側交点」を使う。その場合に地表を検出できなければ、実際の地形と
 * 無関係な遠方の仮想点を返さないよう null を返す（詳細は本体コメント参照）。
 *
 * @param origin レイ原点（ECEF）。
 * @param dir レイ方向（非ゼロなら正規化不要）。
 * @param ellipsoidSemiMajor 標高 0 の赤道半径 [m]。
 * @param ellipsoidSemiMinor 標高 0 の極半径 [m]。
 * @param terrainElevAt 緯度経度[deg]→地形標高[m]。取得不可時は null（未ロード等。その点は
 *        標高 0 として扱う）。
 * @param maxTerrainElevM 想定する地形標高の上限 [m]（探索範囲の手前側を決める。実際の地表が
 *        これを超える場合、超えた部分より奥の交点を採用してしまう）。
 * @param stepDistanceM 粗い探索の目標ステップ間隔 [m]（地形データの水平解像度目安。これより
 *        粗いと、幅の狭い稜線をステップが飛び越えて検出漏れし、山を貫通し得る）。探索区間の
 *        距離に応じてステップ数 `= 距離 / stepDistanceM` を算出し、`[minCoarseSteps,
 *        maxCoarseSteps]` にクランプする。
 * @param minCoarseSteps 粗い探索ステップ数の下限。
 * @param maxCoarseSteps 粗い探索ステップ数の上限（探索区間が長大でも計算量を頭打ちにする）。
 * @param refineIterations 符号反転区間を絞り込む二分探索の反復数。
 * @param outHit 採用した交点（ECEF）の書き込み先。
 * @param outGeo 採用した交点の測地座標の書き込み先。
 * @returns 交点を採用できたら true。レイが地球を完全に外す（空を指す）、または地表（山）を
 *          検出できなかった場合は false（この場合 `outHit`/`outGeo` は変更しない）。
 */
export const resolveTerrainClickElevationToRef = (
    origin: Vector3,
    dir: Vector3,
    ellipsoidSemiMajor: number,
    ellipsoidSemiMinor: number,
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null,
    maxTerrainElevM: number,
    stepDistanceM: number,
    minCoarseSteps: number,
    maxCoarseSteps: number,
    refineIterations: number,
    outHit: Vector3,
    outGeo: Geodetic,
): boolean => {
    const dirLen = dir.length();
    if (dirLen < 1e-12) return false;
    rtcUnitDir.copyFrom(dir).scaleInPlace(1 / dirLen);

    // 地表が存在し得る球殻（標高 0 〜 maxTerrainElevM）とレイの交差区間を求める。
    if (
        !rayEllipsoidHitsToRef(
            origin,
            rtcUnitDir,
            ellipsoidSemiMajor + maxTerrainElevM,
            ellipsoidSemiMajor + maxTerrainElevM,
            ellipsoidSemiMinor + maxTerrainElevM,
            rtcOuterHits,
        ) ||
        rtcOuterHits.t1 < 0
    ) {
        return false; // 空（地球外、想定最大標高でも当たらない）を指している
    }
    // origin が外殻の内側（カメラ高度 < maxTerrainElevM、通常のデモ視点）なら t=0（origin）から、
    // 外側なら外殻の手前交点から探索する。
    const tNear = Math.max(0, rtcOuterHits.t0);

    // 標高 0（海面）面の手前交点が tNear より奥にあればそれを奥端に使う（通常ケース）。
    // 無ければ（水平線よりわずかに上に高い山の頂上だけが見えている等、レイが海面には
    // 当たらず外殻だけをかすめるケース）、外殻の奥側交点を奥端に使う。
    const hasInnerHits = rayEllipsoidHitsToRef(
        origin,
        rtcUnitDir,
        ellipsoidSemiMajor,
        ellipsoidSemiMajor,
        ellipsoidSemiMinor,
        rtcInnerHits,
    );
    const hasSeaLevelFar = hasInnerHits && rtcInnerHits.t0 >= tNear;
    const tFar = hasSeaLevelFar ? rtcInnerHits.t0 : rtcOuterHits.t1;

    const heightAboveTerrainToRef = (t: number): number => {
        // 探索中の一時計算は rtcGeo（内部スクラッチ）に書く。呼び出し元の outGeo は採用が
        // 確定した adopt() でのみ書き込む（失敗時に outGeo を変更しない契約を守るため）。
        rtcPoint.copyFrom(rtcUnitDir).scaleInPlace(t).addInPlace(origin);
        ecefToGeodeticToRef(rtcPoint, rtcGeo);
        const elev = terrainElevAt(rtcGeo.latDeg, rtcGeo.lonDeg);
        return rtcGeo.altMeters - (elev ?? 0);
    };
    const adopt = (t: number): true => {
        rtcPoint.copyFrom(rtcUnitDir).scaleInPlace(t).addInPlace(origin);
        outHit.copyFrom(rtcPoint);
        ecefToGeodeticToRef(rtcPoint, outGeo);
        return true;
    };

    if (heightAboveTerrainToRef(tNear) <= 0) {
        // 想定最大標高面（手前）がすでに地表以下 → その点を交点として採用する。
        return adopt(tNear);
    }

    // ステップ幅を stepDistanceM 相当に保つよう、探索距離に応じてステップ数を動的に決める。
    const steps = Math.min(
        Math.max(minCoarseSteps, Math.ceil((tFar - tNear) / stepDistanceM)),
        maxCoarseSteps,
    );
    let loT = tNear;
    let hiT = tFar;
    let crossed = false;
    for (let i = 1; i <= steps; i++) {
        const t = tNear + ((tFar - tNear) * i) / steps;
        if (heightAboveTerrainToRef(t) <= 0) {
            hiT = t;
            crossed = true;
            break;
        }
        loT = t;
    }
    if (!crossed) {
        if (hasSeaLevelFar) {
            // 通常ケース（標高0面が奥端）: 地表が見つからないのは理論上ほぼ起きないはずだが、
            // 保険として従来通り標高0交点にフォールバックする。
            return adopt(tFar);
        }
        // 水平線よりわずかに上を見ている（標高0面には当たらない）ケースで地表（山）を検出
        // できなかった。外殻の奥交点は実際の地形と無関係などこか遠方の仮想点になり得るため、
        // 採用せず false を返す（採用するとズームやセンター再計算が遠方点へ暴走する）。
        return false;
    }

    let lo = loT;
    let hi = hiT;
    for (let i = 0; i < refineIterations; i++) {
        const mid = (lo + hi) / 2;
        if (heightAboveTerrainToRef(mid) <= 0) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return adopt(hi);
};

/**
 * カメラが地形に潜らないための最小クリアランスを満たす `radius` を返す（カメラ地形衝突）。
 *
 * `GeospatialCamera` のカメラ位置は center/yaw/pitch/radius から導出されるため、潜り込みは
 * radius を増やして解消する。カメラ高度はおおむね radius に線形（係数 `dAltPerRadius`
 * = カメラ位置での地心 up・(center→camera 方向)）で増えるので、不足分を 1 ステップで補う。
 *
 * @param radius            現在の radius[m]。
 * @param camAltMeters      カメラの楕円体高度[m]（`ecefToGeodetic(cameraEcef).altMeters`）。
 * @param terrainElevMeters カメラ直下の地形標高[m]（無ければ呼び出し側で 0）。
 * @param minClearance      地表からの最小クリアランス[m]。
 * @param dAltPerRadius     radius あたりのカメラ高度増加率（up・(center→camera 単位方向)）。
 * @returns クリアランスを満たす radius[m]（潜っていなければ入力 radius のまま）。
 */
export const clampRadiusForGroundClearance = (
    radius: number,
    camAltMeters: number,
    terrainElevMeters: number,
    minClearance: number,
    dAltPerRadius: number,
): number => {
    const deficit = terrainElevMeters + minClearance - camAltMeters;
    if (deficit <= 0) return radius; // 既にクリアランスを満たす
    // 水平視（dAltPerRadius≈0）や非有限値（NaN/Infinity）では radius を増やしても高度が
    // 上がらない/壊れるので入力 radius を返す（NaN は比較が常に false のため明示判定する）。
    if (!Number.isFinite(dAltPerRadius) || dAltPerRadius < 1e-3) return radius;
    const next = radius + deficit / dAltPerRadius;
    return Number.isFinite(next) ? next : radius;
};
