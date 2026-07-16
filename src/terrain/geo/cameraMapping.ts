/**
 * グローブカメラの UI/URL ⇄ `GeospatialCamera` マッピングと、
 * floating origin 下で `scene.pick` に依存しないパン（地表接線移動）・カメラ地形衝突の関数群。
 *
 * 既存（平面版）の UI / URL 共有は `azimuth`(方位) / `tilt`(チルト) / `altitude`(高度) を用いる。
 * これを `GeospatialCamera` の `yaw` / `pitch` / `radius` / `center`(ECEF) と相互変換する。
 * PoC の関数群を本体共有モジュールへ昇格したもの。
 *
 * 対応関係:
 * - azimuth[deg] ⇄ yaw[rad]   （どちらも 0 = 北、+ = 東回り）
 * - tilt[deg]    ⇄ pitch[rad] （0 = 直下、90 = 水平。既存 UI の「地面からの傾き」と同義）
 *
 * 本モジュールは `GeospatialCamera` を直接 import しない（Babylon の実行時オブジェクトに
 * 依存させず、DOM/WebGL 環境が無くても実行できるようにするため）。`yaw`/`pitch`
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
/** レイ楕円体交差の二次方程式の係数（`a`,`b`,判別式平方根 `sq`）。 */
interface EllipsoidRayCoeffs {
    a: number;
    b: number;
    sq: number;
}

/**
 * `rayEllipsoidNearHitToRef` / `rayEllipsoidHitsToRef` 共通の入力検証とスケール空間での
 * 二次方程式係数解決を行う。両関数は求める交点（手前のみ／両方）が異なるだけで、
 * ここまでの計算は完全に同一のため切り出す。
 * 呼び出しはズーム/パン中に毎フレーム発生するため、`outCoeffs` への書き込みでアロケーションを避ける。
 *
 * @returns 交点が存在すれば true（`outCoeffs` に係数を書き込む）、
 *          半径・origin・dir が非有限/半径が非正、またはレイが楕円体と交わらないなら false。
 */
const solveEllipsoidRayCoeffsToRef = (
    origin: Vector3,
    dir: Vector3,
    radiusX: number,
    radiusY: number,
    radiusZ: number,
    outCoeffs: EllipsoidRayCoeffs,
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
    outCoeffs.a = a;
    outCoeffs.b = b;
    outCoeffs.sq = Math.sqrt(disc);
    return true;
};

/** `rayEllipsoidNearHitToRef` / `rayEllipsoidHitsToRef` 用の使い回し係数バッファ。 */
const ellipsoidRayCoeffsScratch: EllipsoidRayCoeffs = { a: 0, b: 0, sq: 0 };

export const rayEllipsoidNearHitToRef = (
    origin: Vector3,
    dir: Vector3,
    radiusX: number,
    radiusY: number,
    radiusZ: number,
    ref: Vector3,
): boolean => {
    if (
        !solveEllipsoidRayCoeffsToRef(
            origin,
            dir,
            radiusX,
            radiusY,
            radiusZ,
            ellipsoidRayCoeffsScratch,
        )
    ) {
        return false;
    }
    const { a, b, sq } = ellipsoidRayCoeffsScratch;
    let t = (-b - sq) / (2 * a); // 手前側
    if (t < 0) t = (-b + sq) / (2 * a); // 手前が背面なら奥側（カメラが内部＝地中の保険）
    if (t < 0) return false; // 両交点とも背面
    ref.copyFrom(dir).scaleInPlace(t).addInPlace(origin);
    return true;
};

/** `rayEllipsoidHitsToRef` の出力用構造体。 */
interface EllipsoidHits {
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
    outT: EllipsoidHits,
): boolean => {
    if (
        !solveEllipsoidRayCoeffsToRef(
            origin,
            dir,
            radiusX,
            radiusY,
            radiusZ,
            ellipsoidRayCoeffsScratch,
        )
    ) {
        return false;
    }
    const { a, b, sq } = ellipsoidRayCoeffsScratch;
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
// を避ける。
// 安全性の前提（呼び出し側が守るべき契約）: JS はシングルスレッドだが、それだけでは
// 「関数実行中に同じバッファへ別の書き込みが割り込まない」ことは保証されない。もし
// terrainElevAt が同期的に resolveTerrainClickElevationToRef 自身（または本バッファを
// 使う他の呼び出し）を呼び返す（同期再入する）と、このバッファが呼び出し中に書き換わり
// 結果が壊れる。terrainElevAt は同期的な純粋関数（キャッシュ参照＋補間程度）であり、
// 本関数を再入させないことを前提とする。
const rtcUnitDir = new Vector3();
const rtcPoint = new Vector3();
const rtcOuterHits: EllipsoidHits = { t0: 0, t1: 0 };
const rtcInnerHits: EllipsoidHits = { t0: 0, t1: 0 };
// 探索中の各サンプル点の測地座標（呼び出し元の outGeo は採用確定時のみ書き込む）。
const rtcGeo: Geodetic = { latDeg: 0, lonDeg: 0, altMeters: 0 };
// 遠方海面ケースの全域細分が上限で頭打ちして実効ステップ幅が想定より粗いままになったことを
// 一度だけ警告するためのガード（毎フレーム同じ警告を出さないための one-shot）。
let farSubdivideCapWarned = false;

/**
 * レイと地形表面（実標高データに基づく面）の交点を、レイに沿ったマーチング（二段階の粗探索 +
 * 二分探索での絞り込み）で求める（地形クリックピック・ズーム貫通対策）。
 *
 * 解析的な楕円体（クリック方向 1 点の標高だけで構成した定数面）との交差では、レイが経路上で
 * 通過する手前の山を無視してしまい、急斜面・山岳地帯でレイが山を貫通して奥の地表（山の裏側）に
 * 着地する（貫通・埋没・意図しない移動先の原因）。そこで「地表が存在し得る球殻（標高 0 〜
 * maxTerrainElevM）とレイが交差する区間」を手前から奥へ進め、レイの高度が地形標高を初めて
 * 下回る区間を検出し、二分探索で精度を上げる。奥端は通常「標高 0 面との交点」だが、水平線
 * よりわずかに上を見ていて標高 0 面に当たらない（高い山の頂上だけが見えている）場合は「外殻
 * （maxTerrainElevM 面）の奥側交点」を使う。その場合に地表を検出できなければ、実際の地形と
 * 無関係な遠方の仮想点を返さないよう false を返す（詳細は本体コメント参照）。
 *
 * 粗探索は二段階で行う（two-tier coarse marching）。第1段は当たり付けのスキャンで、ステップ数を
 * `[minCoarseSteps, maxCoarseSteps]` にクランプして tNear→tFar を進み、レイ高度が地形以下に
 * なる（符号反転する）手前区間を第2段の細分対象として絞り込む。第2段はその区間だけを
 * `stepDistanceM` 相当の細かさ（上限 `SUBDIVIDE_MAX_STEPS`）で再サンプリングして符号反転区間を
 * 確定し、二分探索へ渡す。すなわち `maxCoarseSteps` は「第1段の当たり付けの計算量上限」を担い、
 * 狭い尾根に対する検出精度は第2段の局所細分が担保する。
 *
 * 近水平視線では探索区間が数十 km に伸び、第1段が `maxCoarseSteps` で頭打ちして実効ステップ幅が
 * `stepDistanceM` より粗くなる。すると途中の幅の狭い尾根が第1段のサンプル格子の間隙に隠れて反転が
 * 検出されず（尾根の頂はどの粗サンプルにも入らずレイ高度の反転も局所ディップも第1段には現れない）、
 * レイはそのまま奥端の標高 0 面まで到達してしまう。この「第1段で反転せず、かつ奥端が標高 0 面
 * （海面）であり、かつ `maxCoarseSteps` の頭打ちで実効ステップ幅が `stepDistanceM` より粗くなっている
 * （`steps < idealSteps`）」ケースに限り、手前区間の細分では尾根を見つけられないため第2段の対象を
 * 探索区間全体に広げ、専用の上限 `SUBDIVIDE_MAX_STEPS_FAR` まで細かく刻み直して隠れた尾根を捕捉する
 * （通常フレームは第1段が手前で反転するか、頭打ちしておらずすでに `stepDistanceM` 相当の解像度で
 * 走査済みのため全域細分に入らず、コストを増やさない）。全域細分でも反転が見つからなければ本当に
 * 地表が無い（平地・海面）ので、従来どおり標高 0 交点にフォールバックする。頭打ちしていない場合
 * （`steps === idealSteps`）は、第1段がすでに設計解像度で走査済みであり反転も見つからなかった＝
 * 本当に地表が無いと判断できるため、全域再細分せず直接標高 0 交点にフォールバックする。
 *
 * 注意: 奥端が標高 0 面（`hasSeaLevelFar`）のとき、第1段の最終サンプル（t=tFar）でその地点の
 * 地形標高が実際に 0（海面・未ロードのフォールバック含む）であれば、レイ高度は定義上つねにそこで
 * 0 に収束する（隠れた尾根の有無と無関係に成立するトートロジー）。これを通常の「反転検出」として
 * 採用すると、途中で尾根を見逃していても最終サンプルで必ず crossed 扱いになってしまい、全域細分
 * （本来の対策）が発火しなくなる。そのため第1段では、hasSeaLevelFar かつ最終サンプルかつ地形標高が
 * 実際に 0 の場合に限り反転判定から除外する（tFar 近傍の地形標高が 0 でない沿岸・低地等では、その
 * 反転は本物の地表検出なので除外しない。詳細は実装のコメント参照）。
 *
 * 内部の ECEF↔測地変換（`ecefToGeodeticToRef`）は WGS84 の離心率で固定されているため、
 * `ellipsoidSemiMajor`/`ellipsoidSemiMinor` には WGS84 の値（`Wgs84Ellipsoid.semiMajorAxis`/
 * `semiMinorAxis`）を渡すこと。異なる楕円体を渡すと、半径ベースの交差判定と測地座標変換の
 * 基準がズレて緯度経度・標高が破綻し得る。
 *
 * @param origin レイ原点（ECEF）。
 * @param dir レイ方向（非ゼロなら正規化不要）。
 * @param ellipsoidSemiMajor 標高 0 の赤道半径 [m]。WGS84 の値（`Wgs84Ellipsoid.semiMajorAxis`）
 *        を渡すこと。
 * @param ellipsoidSemiMinor 標高 0 の極半径 [m]。WGS84 の値（`Wgs84Ellipsoid.semiMinorAxis`）
 *        を渡すこと。
 * @param terrainElevAt 緯度経度[deg]→地形標高[m]。取得不可時は null（未ロード等。その点は
 *        標高 0 として扱う）。
 * @param maxTerrainElevM 想定する地形標高の上限 [m]（探索範囲の手前側を決める。実際の地表が
 *        これを超える場合、超えた部分より奥の交点を採用してしまう）。0 以上の有限数。
 * @param stepDistanceM 粗い探索の目標ステップ間隔 [m]（地形データの水平解像度目安。これより
 *        粗いと、幅の狭い稜線をステップが飛び越えて検出漏れし、山を貫通し得る）。探索区間の
 *        距離に応じてステップ数 `= 距離 / stepDistanceM` を算出し、`[minCoarseSteps,
 *        maxCoarseSteps]` にクランプする。正の有限数。
 * @param minCoarseSteps 粗い探索ステップ数の下限。1 以上の整数。
 * @param maxCoarseSteps 粗い探索ステップ数の上限（探索区間が長大でも計算量を頭打ちにする）。
 *        `minCoarseSteps` 以上の整数。
 * @param refineIterations 符号反転区間を絞り込む二分探索の反復数。0 以上の整数。
 * @param outHit 採用した交点（ECEF）の書き込み先。
 * @param outGeo 採用した交点の測地座標の書き込み先。
 * @returns 交点を採用できたら true。レイが地球を完全に外す（空を指す）、地表（山）を
 *          検出できなかった、または探索パラメータ（`maxTerrainElevM`/`stepDistanceM`/
 *          `minCoarseSteps`/`maxCoarseSteps`/`refineIterations`）が上記の範囲・型を満たさなければ
 *          false
 *          （この場合 `outHit`/`outGeo` は変更しない）。
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
    // 探索パラメータが不正（NaN/非有限、負値、非整数、範囲外）だと steps 計算が NaN になり
    // 粗探索ループがスキップされて意図しないフォールバックに落ちる、あるいは for ループの
    // 回数が意図せず丸められる。rayEllipsoidNearHitToRef と同様に exported API として早期に
    // ガードする（呼び出し側は通常正の妥当な値を渡す）。ステップ数系（min/maxCoarseSteps・
    // refineIterations）は for ループの反復回数として使うため整数を要求する
    // （`Number.isInteger` は NaN/Infinity にも false を返すため有限性チェックを兼ねる）。
    if (
        !Number.isFinite(maxTerrainElevM) ||
        maxTerrainElevM < 0 ||
        !(stepDistanceM > 0) ||
        !Number.isFinite(stepDistanceM) ||
        !Number.isInteger(minCoarseSteps) ||
        minCoarseSteps < 1 ||
        !Number.isInteger(maxCoarseSteps) ||
        maxCoarseSteps < minCoarseSteps ||
        !Number.isInteger(refineIterations) ||
        refineIterations < 0
    ) {
        return false;
    }
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

    // tNear 以降で最初に現れる標高 0（海面）面の交点を奥端に使う（通常ケース）。通常は t0
    // （手前交点）だが、origin が海面の内側にある異常ケース（カメラが地下・海面下に潜っている
    // 場合等）では t0<0<t1 になり t0 が tNear より手前になるため、その場合は t1（海面から
    // 抜け出す前方交点）を使う。tNear 以降のどちらの交点も無ければ（水平線よりわずかに上に
    // 高い山の頂上だけが見えている等、レイが海面には当たらず外殻だけをかすめるケース）、
    // 外殻の奥側交点を奥端に使う。
    const hasInnerHits = rayEllipsoidHitsToRef(
        origin,
        rtcUnitDir,
        ellipsoidSemiMajor,
        ellipsoidSemiMajor,
        ellipsoidSemiMinor,
        rtcInnerHits,
    );
    let hasSeaLevelFar = false;
    let seaLevelFarT = 0;
    if (hasInnerHits) {
        if (rtcInnerHits.t0 >= tNear) {
            hasSeaLevelFar = true;
            seaLevelFarT = rtcInnerHits.t0;
        } else if (rtcInnerHits.t1 >= tNear) {
            hasSeaLevelFar = true;
            seaLevelFarT = rtcInnerHits.t1;
        }
    }
    const tFar = hasSeaLevelFar ? seaLevelFarT : rtcOuterHits.t1;

    // heightAboveTerrainToRef が直近に評価した地形標高（本関数内で「地形自体が海抜0か」を
    // 判定するために参照する。地表以下判定そのものには使わない）。
    let lastTerrainElevM = 0;
    const heightAboveTerrainToRef = (t: number): number => {
        // 探索中の一時計算は rtcGeo（内部スクラッチ）に書く。呼び出し元の outGeo は採用が
        // 確定した adopt() でのみ書き込む（失敗時に outGeo を変更しない契約を守るため）。
        rtcPoint.copyFrom(rtcUnitDir).scaleInPlace(t).addInPlace(origin);
        ecefToGeodeticToRef(rtcPoint, rtcGeo);
        const elev = terrainElevAt(rtcGeo.latDeg, rtcGeo.lonDeg) ?? 0;
        lastTerrainElevM = elev;
        return rtcGeo.altMeters - elev;
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

    // 第2段（局所細分）の再サンプリング数の上限。第1段で当たりを付けた狭い区間だけを
    // stepDistanceM 相当の細かさで刻み直すためのローカル定数。ズーム毎フレーム呼び出しでの
    // コスト増を避けるため控えめに取る（第1段 maxCoarseSteps + 第2段でも数百回程度に収める）。
    const SUBDIVIDE_MAX_STEPS = 64;
    // 第1段が反転を検出できず、かつ奥端が標高0面（hasSeaLevelFar）のケースで、探索区間全体を
    // 細分し直すときの上限。近水平・長距離の探索では第1段が maxCoarseSteps で頭打ちして実効
    // ステップ幅が広がり、途中の狭い尾根が粗サンプル格子の間隙に隠れる（尾根の頂はどの粗サンプル
    // にも入らずレイ高度の反転も局所ディップも第1段には現れない）。このとき探索区間全体（数十km）を
    // 細かく刻み直して隠れた尾根を捕捉するため、通常の上限より大きく取る（実効ステップ幅が想定
    // 尾根幅より十分細かくなる目安。詳細は下の分岐コメント参照）。
    const SUBDIVIDE_MAX_STEPS_FAR = 2048;

    // 対象区間 [ta, tb] を stepDistanceM 相当（上限 cap）で細分し、最初の符号反転区間を
    // [loT, hiT] に確定して true を返す局所探索。反転が無ければ false（loT/hiT は未確定）。
    let loT = tNear;
    let hiT = tFar;
    const subdivideForCrossing = (ta: number, tb: number, cap: number): boolean => {
        const subSpan = tb - ta;
        const subSteps = Math.min(Math.max(1, Math.ceil(subSpan / stepDistanceM)), cap);
        let subPrevT = ta;
        for (let i = 1; i <= subSteps; i++) {
            const t = ta + (subSpan * i) / subSteps;
            if (heightAboveTerrainToRef(t) <= 0) {
                loT = subPrevT;
                hiT = t;
                return true;
            }
            subPrevT = t;
        }
        return false;
    };

    // 第1段（粗スキャン / 当たり付け）: ステップ幅を stepDistanceM 相当に保つよう探索距離に
    // 応じてステップ数を動的に決めるが、上限 maxCoarseSteps で頭打ちにする（近水平視線で探索
    // 区間が数十kmに伸びると実効ステップ幅が stepDistanceM より粗くなり得る）。ここでは
    // 「符号反転が起きた手前区間」を第2段の細分対象として絞り込むだけで、精度は第2段が担保する。
    // idealSteps は頭打ち前の理想ステップ数（= 実効ステップ幅が stepDistanceM 相当に保てているか
    // の判定にも使う。steps < idealSteps なら maxCoarseSteps で頭打ちして粗くなっている）。
    const idealSteps = Math.max(1, Math.ceil((tFar - tNear) / stepDistanceM));
    const steps = Math.min(Math.max(minCoarseSteps, idealSteps), maxCoarseSteps);
    let crossed = false;
    let coarseLoT = tNear; // 反転区間の手前端（直前の非反転サンプル）
    let coarseHiT = tFar; // 反転区間の奥端（初めて反転したサンプル）
    let prevT = tNear;
    for (let i = 1; i <= steps; i++) {
        const t = tNear + ((tFar - tNear) * i) / steps;
        const h = heightAboveTerrainToRef(t);
        // hasSeaLevelFar のとき、最終サンプル（t=tFar）は「標高0面との交点」そのものであり、
        // その地点の地形標高が実際に0（海面・未ロードのフォールバック含む）なら定義上つねに
        // heightAboveTerrain(tFar)≈0 になる（実測: WGS84の実楕円体を渡すと厳密に 0）。これは
        // 隠れた尾根の有無と無関係なので「反転」として採用すると、途中で尾根を見逃していても
        // ここで crossed=true になってしまい、後段の全域細分（下の else if 分岐）が発火しない
        // ＝隠れた尾根を貫通する。そこで最終サンプルかつ hasSeaLevelFar かつ地形標高が実際に0の
        // 場合だけは「反転」として採用せず、ループを反転なしのまま終える。tFar 近傍の地形標高が
        // 0 でない（沿岸・低地等）場合は、そこでの反転は本物の地表検出なので通常どおり採用する。
        const isTautologicalSeaLevelEnd =
            i === steps && hasSeaLevelFar && Math.abs(lastTerrainElevM) < 1e-6;
        if (!isTautologicalSeaLevelEnd && h <= 0) {
            coarseLoT = prevT;
            coarseHiT = t;
            crossed = true;
            break;
        }
        prevT = t;
    }

    if (crossed) {
        // 通常ケース: 反転した手前の狭区間 [coarseLoT, coarseHiT] だけを stepDistanceM 相当で
        // 細分して反転区間を確定する。第1段で h(coarseHiT)<=0 を確認済みなので、この区間の
        // 細分は最終サンプルで必ず反転を捉える（subdivideForCrossing は true を返す）。
        subdivideForCrossing(coarseLoT, coarseHiT, SUBDIVIDE_MAX_STEPS);
    } else if (hasSeaLevelFar && steps < idealSteps) {
        // 第1段は反転を検出しなかったが、奥端が標高0面（海面）に到達しており、かつ
        // maxCoarseSteps で頭打ちして実効ステップ幅が stepDistanceM より粗くなっている
        // （steps < idealSteps）。この場合のみ、途中の狭い尾根を格子間隙で跨いで見逃した
        // 可能性がある（見逃すとレイは奥の海面まで貫通し、遠方点が回転中心になってしまう）。
        // 頭打ちしていない（steps === idealSteps、通常の近距離・低速フレーム）場合は第1段が
        // すでに stepDistanceM 相当の解像度で走査済みなので、全域再細分は不要かつ無駄なコスト
        // 増になるため行わない。
        //
        // 探索区間全体を専用上限 SUBDIVIDE_MAX_STEPS_FAR まで細分し直し、隠れた尾根（＝反転）を
        // 探す。反転が見つかればその区間を二分探索へ回し、見つからなければ本当に地表が無い
        // （平地・海面）ので従来どおり標高0交点にフォールバックする。
        if (idealSteps > SUBDIVIDE_MAX_STEPS_FAR && !farSubdivideCapWarned) {
            // 全域細分が上限で頭打ちし、実効ステップ幅が stepDistanceM より粗いままになる。
            // 想定より狭い尾根を再び見逃し得るため、パラメータ調整の観測点として一度だけ警告する
            // （恒常ログは避け、モジュールスコープのフラグで再発火を防ぐ）。
            farSubdivideCapWarned = true;
            console.warn(
                `[cameraMapping] far subdivide capped (span=${(tFar - tNear).toFixed(0)}m, ` +
                    `cap=${SUBDIVIDE_MAX_STEPS_FAR}); narrow terrain may be missed`,
            );
        }
        if (!subdivideForCrossing(tNear, tFar, SUBDIVIDE_MAX_STEPS_FAR)) {
            // 隠れた尾根も無かった → 従来通り標高0交点にフォールバックする。
            return adopt(tFar);
        }
    } else if (hasSeaLevelFar) {
        // 第1段が頭打ちしておらず（steps === idealSteps）、すでに stepDistanceM 相当の解像度で
        // 走査済み。反転が見つからなかった＝本当に地表が無い（平地・海面）ので、全域再細分せず
        // 直接標高0交点にフォールバックする。
        return adopt(tFar);
    } else {
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

/** {@link stepGroundClearanceRadius} の結果。 */
export interface GroundClearanceStep {
    /** 補正後の radius[m]。 */
    radius: number;
    /** 補正後の追加分[m]（次フレームへ持ち越す）。 */
    boost: number;
}

/**
 * カメラ地形衝突の radius 補正を 1 フレーム分だけスムーズに進める。
 *
 * `clampRadiusForGroundClearance` が求める必要 radius を直接代入するとカメラ位置が一段で
 * 跳ね、また一度増えた radius が戻らずカメラが被写体から離れていく。これを避けるため:
 * - 追加分 `boost` を除いた「素の radius / 高度」を基準に必要 radius（= 目標追加分）を求める。
 *   これにより目標追加分が前フレームの補正量に依存せず一意に決まり、押し出しと復帰が振動しない。
 * - 押し出し（増加）は `pushLerp`、復帰（減少）は `relaxLerp` で補間する。障害が解消すると
 *   目標追加分は 0 になり `boost` は 0 へ戻り、radius は素の値へ復帰する（単調増加を避ける）。
 *
 * @param radius            現在の radius[m]（前フレームの追加分を含む）。
 * @param boost             現在の追加分[m]（前フレームから持ち越した補正量）。
 * @param camAltMeters      現在の radius に対応するカメラの楕円体高度[m]。
 * @param terrainElevMeters カメラ直下の地形標高[m]。
 * @param minClearance      地表からの最小クリアランス[m]。
 * @param dAltPerRadius     radius あたりのカメラ高度増加率。
 * @param pushLerp          押し出し（増加）の 1 フレーム補間率 (0〜1)。
 * @param relaxLerp         復帰（減少）の 1 フレーム補間率 (0〜1)。
 * @returns 補正後の radius と追加分。
 */
export const stepGroundClearanceRadius = (
    radius: number,
    boost: number,
    camAltMeters: number,
    terrainElevMeters: number,
    minClearance: number,
    dAltPerRadius: number,
    pushLerp: number,
    relaxLerp: number,
): GroundClearanceStep => {
    // 追加分を除いた素の radius / 高度（高度は radius に線形と近似）。
    const naturalRadius = radius - boost;
    const naturalAlt = camAltMeters - boost * dAltPerRadius;
    const requiredRadius = clampRadiusForGroundClearance(
        naturalRadius,
        naturalAlt,
        terrainElevMeters,
        minClearance,
        dAltPerRadius,
    );
    // 潜り込み中（deficit>0）なのに clampRadiusForGroundClearance が radius を増やせなかった
    // （水平視 dAltPerRadius≈0 や非有限などのガードで naturalRadius 据え置き）フレームは、
    // targetBoost=0 として relax で追加分を戻すと衝突が悪化する。この場合は現状維持（radius/boost
    // を変えない）にして、押し出せる姿勢に戻るまで既存の追加分を保つ。
    const deficit = terrainElevMeters + minClearance - naturalAlt;
    if (deficit > 0 && requiredRadius <= naturalRadius) {
        return { radius, boost };
    }
    const targetBoost = Math.max(0, requiredRadius - naturalRadius);
    const lerp = targetBoost > boost ? pushLerp : relaxLerp;
    const nextBoost = boost + (targetBoost - boost) * lerp;
    return { radius: naturalRadius + nextBoost, boost: nextBoost };
};

/**
 * ズーム中の毎フレーム向き補正（center 再スナップ）で、レイマーチングの地表検出（true/false）が
 * 境界付近でちらついても補正を連続させるための「使用する center の選び方」を決める純関数。
 *
 * 背景: 山岳地帯でチルトを水平に近づけると、視線レイが稜線をわずかに超えて空を指す状態
 * （地表未検出＝pick 失敗）と、山を捉える状態（pick 成功）の境界付近になりやすい。ズーム中は
 * カメラ位置が毎フレーム動くため、この境界を数フレームにわたり断続的にまたぐ。向き補正は失敗
 * フレームで完全に停止するため、その間ネイティブズームのフレーム結合誤差が無補正で蓄積し、次に
 * 成功したフレームで一括補正されて画面が急に動く（ズーム終了間際のスナップ）。
 *
 * 対策として、pick が失敗しても「同一ズームジェスチャ内で直近に成功した実在の地表点」がまだ新しい
 * 間はそれを補正に再利用し、補正の停止（＝誤差の一括蓄積→スナップ）を避ける。再利用するのは
 * あくまで直近フレームで実際に検出した実在の近傍地表点であり、遠方の仮想点を捏造しない
 * （水平チルトで遠方点へ暴走する既知不具合を再発させない）ことがこの設計の要点。
 *
 * @param pickSucceeded 今フレームのレイマーチングが地表交点を採用できたか。
 * @param hasLastValid 同一ズームジェスチャ内で過去に採用できた地表点を保持しているか。
 * @param frameGapMs 直近の成功フレームから今フレームまでの経過時間 [ms]（保持点の鮮度）。
 * @param maxHoldMs 保持点を再利用してよい最大経過時間 [ms]。これを超えたら保持を破棄して補正を
 *        止める（古すぎる点の再利用でカメラが的外れな向きへ寄るのを防ぐ）。0 以上の有限数。
 * @returns "current" = 今フレームの成功結果を使う / "held" = 保持している直近の成功結果を再利用する /
 *          "skip" = 使える center が無いので補正しない。
 */
export const resolveRecalcCenterSource = (
    pickSucceeded: boolean,
    hasLastValid: boolean,
    frameGapMs: number,
    maxHoldMs: number,
): "current" | "held" | "skip" => {
    if (pickSucceeded) return "current";
    if (
        hasLastValid &&
        Number.isFinite(frameGapMs) &&
        frameGapMs >= 0 &&
        Number.isFinite(maxHoldMs) &&
        maxHoldMs >= 0 &&
        frameGapMs <= maxHoldMs
    ) {
        return "held";
    }
    return "skip";
};
