/**
 * 自動スクロール（カメラ追従）ロジック
 *
 * アバターが画面端に近づいたときにカメラを自動追従させるための純粋関数群。
 *
 * 方式: デッドゾーン追従
 * - 画面中央にデッドゾーン（カメラが動かない領域）を定義
 * - アバターがデッドゾーン外に出たら、はみ出し量に比例してカメラを移動
 * - デッドゾーン内ではカメラを動かさない
 *
 * 座標系:
 * - カメラ中心を原点とし、東=+x / 北=+y の平面座標で扱う
 * - ビューポート比率は altitude と tilt から概算した可視範囲で正規化
 */

/** 自動スクロール計算に必要なパラメータ */
export interface AutoScrollParams {
    /** アバターの緯度 */
    avatarLat: number;
    /** アバターの経度 */
    avatarLon: number;
    /** カメラ中心の緯度 */
    cameraLat: number;
    /** カメラ中心の経度 */
    cameraLon: number;
    /** カメラの高度 (m) */
    cameraAltitude: number;
    /** カメラの傾き (度, 0=真上, 90=水平) */
    cameraTilt: number;
    /** デッドゾーンの画面比率 (0〜1)。0.6 = 中央60%はカメラ不動 */
    deadzoneRatio: number;
    /** 追従の補間係数 (0〜1)。大きいほど即座に追従 */
    scrollLerp: number;
    /**
     * 可視範囲（カメラ中心から画面端までのメートル）を外部から指定する。
     * 2D (ortho) モードのように altitude/tilt から推定できない場合に使用。
     * 省略時は altitude/tilt から推定する。
     */
    viewExtentOverride?: number;
    /**
     * 実スクリーン射影（ワールド→スクリーン座標変換）に必要なパラメータ。
     * 指定時は平坦地形前提の幾何近似（estimateViewExtent）ではなく、カメラの方位・FOV・
     * アスペクト・地形標高差を用いた射影でアバターのスクリーン位置を求める。勾配地形でも
     * アバターが画面内に収まるようにするために使用する。
     */
    projection?: ViewportProjection;
}

/** 実スクリーン射影に必要なカメラ・地形パラメータ。 */
export interface ViewportProjection {
    /** カメラの方位（度, 0=北, 時計回りに東）。視線の水平方向。 */
    cameraAzimuth: number;
    /** 垂直 FOV (rad)。 */
    fovYRad: number;
    /** ビューポートのアスペクト比 (width / height)。 */
    aspect: number;
    /** アバター直下の地形標高 (m)。 */
    avatarGroundElevation: number;
    /** カメラ注視点（中心）直下の地形標高 (m)。 */
    cameraGroundElevation: number;
}

/** スクリーン正規化座標（-1〜1）と背面フラグ。 */
export interface ViewportPoint {
    /** 水平方向のスクリーン正規化座標 (-1=左端, +1=右端)。 */
    rx: number;
    /** 垂直方向のスクリーン正規化座標 (-1=下端, +1=上端)。 */
    ry: number;
    /** カメラ背面 or 射影不能（奥行き成分 <= 0）。true のとき rx/ry は無効。 */
    behind: boolean;
}

/** 自動スクロールの計算結果 */
export interface AutoScrollResult {
    /** 新しいカメラ緯度 */
    lat: number;
    /** 新しいカメラ経度 */
    lon: number;
    /** カメラが移動したか */
    scrolled: boolean;
}

/** デフォルトのデッドゾーン比率 */
export const DEFAULT_DEADZONE_RATIO = 0.6;

/** デフォルトの追従補間係数 */
export const DEFAULT_SCROLL_LERP = 0.3;

/** 緯度 1 度あたりのメートル数（地球の平均値） */
const METERS_PER_DEGREE_LAT = 111320;

const DEG2RAD = Math.PI / 180;

/**
 * カメラ中心（注視点）を原点とする局所 ENU 系（x=東 / y=北 / z=上）上の地表点を、
 * カメラの姿勢（tilt / azimuth）・FOV・アスペクトを用いてスクリーン正規化座標へ射影する。
 *
 * ピンホールカメラモデルによる解析的な射影で、floating origin や Babylon の行列に依存しない。
 * tilt=0（真上）では従来の平坦近似と一致し、tilt があり地表点に標高差がある場合は
 * 奥行き（近／遠）と上下方向のずれを正しく反映する（勾配地形でアバターが想定外に画面外へ
 * 出るのを防ぐ）。
 *
 * @param dEastM     カメラ中心から見た東方向のオフセット (m)
 * @param dNorthM    カメラ中心から見た北方向のオフセット (m)
 * @param dHeightM   カメラ中心（注視点）に対する対象点の高さ (m)。標高差。
 * @param cameraRadiusM カメラ中心からカメラ位置までの距離 (m)。GeospatialCamera の radius。
 * @param tiltDeg    カメラの傾き (度, 0=真上, 90=水平)
 * @param azimuthDeg カメラの方位 (度, 0=北, 時計回りに東)
 * @param fovYRad    垂直 FOV (rad)
 * @param aspect     ビューポートのアスペクト比 (width / height)
 * @returns スクリーン正規化座標 rx/ry（±1 が画面端）と背面フラグ。
 */
export const projectToViewport = (
    dEastM: number,
    dNorthM: number,
    dHeightM: number,
    cameraRadiusM: number,
    tiltDeg: number,
    azimuthDeg: number,
    fovYRad: number,
    aspect: number,
): ViewportPoint => {
    // tilt は真上(0)〜ほぼ水平にクランプ。水平ちょうど(90)は奥行き発散を招くため 89.9 で止める。
    const theta = Math.min(Math.max(tiltDeg, 0), 89.9) * DEG2RAD;
    const phi = azimuthDeg * DEG2RAD;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    const R = Math.max(cameraRadiusM, 1);

    // 視線前方 d（カメラ→中心）、右 r、上 u（ENU 基底）。
    // d = sinθ·(水平方位) + cosθ·(-上) → 真上見下ろしで (0,0,-1)、水平で水平方位。
    const dx = sinT * sinP;
    const dy = sinT * cosP;
    const dz = -cosT;
    // r = normalize(cross(d, worldUp))。θ に依らず (cosφ, -sinφ, 0)。
    const rxv = cosP;
    const ryv = -sinP;
    // u = cross(r, d)。
    const ux = sinP * cosT;
    const uy = cosP * cosT;
    const uz = sinT;

    // カメラ位置 = 中心 - R·d。対象点 P=(dEast, dNorth, dHeight)。
    // camera→P ベクトル w = P - camPos = P + R·d。
    const wx = dEastM + R * dx;
    const wy = dNorthM + R * dy;
    const wz = dHeightM + R * dz;

    const zc = wx * dx + wy * dy + wz * dz; // 奥行き（前方成分）
    if (zc <= 1e-6) {
        return { rx: 0, ry: 0, behind: true };
    }
    const xc = wx * rxv + wy * ryv; // 右成分（rz=0）
    const yc = wx * ux + wy * uy + wz * uz; // 上成分

    const tanHalfY = Math.tan(fovYRad / 2);
    const tanHalfX = tanHalfY * Math.max(aspect, 1e-6);
    return {
        rx: xc / zc / tanHalfX,
        ry: yc / zc / tanHalfY,
        behind: false,
    };
};

/**
 * カメラの altitude と tilt から、画面に映る地表面の概算可視範囲（メートル）を返す。
 *
 * 近似:
 * - tilt=0° (真上) なら可視範囲 ≈ altitude * tan(FOV/2)
 * - tilt が大きいと far side は広がるが near side は縮む
 * - 自動スクロールでは near side（カメラに近い側）で画面外に出ないことが重要なので、
 *   near side 基準の保守的な値を返す
 *
 * @returns halfExtentM — カメラ中心から画面端（near side）までの概算距離 (m)
 */
export const estimateViewExtent = (
    altitude: number,
    tilt: number,
): number => {
    // 非有限値は安全なデフォルトにフォールバック
    const safeAltitude = Number.isFinite(altitude) ? altitude : 1;
    const safeTilt = Number.isFinite(tilt) ? tilt : 0;
    const alt = Math.max(safeAltitude, 1);
    // FOV ≈ 60° → half FOV = 30° → tan(30°) ≈ 0.577
    const halfFovTan = 0.577;
    // tilt=0: 真上から見下ろし。near/far 対称。extent = alt * tan(halfFov)
    // tilt>0: near side は alt * tan(halfFov - tilt) に近づく（狭くなる）
    // 保守的近似: cos(tilt) で near side の縮小を反映
    const tiltRad = (Math.min(Math.max(safeTilt, 0), 85) * Math.PI) / 180;
    const nearFactor = Math.max(Math.cos(tiltRad), 0.3);
    return alt * halfFovTan * nearFactor;
};

/**
 * アバターのカメラ中心からのオフセットをビューポート比率 (-1〜1) で返す。
 *
 * @returns rx (東方向), ry (北方向)。0 = カメラ中心、±1 = 画面端
 */
export const viewportOffset = (
    avatarLat: number,
    avatarLon: number,
    cameraLat: number,
    cameraLon: number,
    cameraAltitude: number,
    cameraTilt: number,
): { rx: number; ry: number } => {
    const extent = estimateViewExtent(cameraAltitude, cameraTilt);
    if (extent <= 0) return { rx: 0, ry: 0 };

    // 緯度経度差をメートルに変換
    const dLatM = (avatarLat - cameraLat) * METERS_PER_DEGREE_LAT;
    const cosLat = Math.cos((cameraLat * Math.PI) / 180);
    const dLonM = (avatarLon - cameraLon) * METERS_PER_DEGREE_LAT * cosLat;

    return {
        rx: dLonM / extent,
        ry: dLatM / extent,
    };
};

/** ハードクランプの画面端しきい値（正規化座標）。この比率を超えたら必ず引き戻す。 */
const EDGE_LIMIT = 0.95;

/**
 * 実スクリーン射影ベースの自動スクロール計算。
 *
 * アバターの実スクリーン位置（射影で求めた正規化座標）を用いてデッドゾーン判定を行い、
 * カメラ中心をアバター方向（実際の地表ベクトル方向）へ寄せてスクリーン上のはみ出しを縮める。
 * デッドゾーン内なら不動。EDGE_LIMIT を超える場合は必ず画面内へ引き戻す。
 *
 * 移動はカメラ中心とアバターの緯度経度を線形補間する形で行うため、方位が誤っていても
 * 常にアバター方向へ寄る（射影軸の取り違えで逆方向へ押し出す事故を避ける）。
 */
const computeAutoScrollProjected = (
    params: AutoScrollParams,
    proj: ViewportProjection,
): AutoScrollResult => {
    const { avatarLat, avatarLon, cameraLat, cameraLon, cameraAltitude, cameraTilt } =
        params;

    const rawDeadzone = params.deadzoneRatio;
    const rawLerp = params.scrollLerp;
    const deadzoneRatio = Number.isFinite(rawDeadzone)
        ? Math.max(0, Math.min(1, rawDeadzone))
        : 0;
    const scrollLerp = Number.isFinite(rawLerp)
        ? Math.max(0, Math.min(1, rawLerp))
        : 0;

    // カメラ中心からアバターまでの地表オフセット（東 / 北）と標高差。
    const cosLat = Math.cos((cameraLat * Math.PI) / 180);
    const dNorthM = (avatarLat - cameraLat) * METERS_PER_DEGREE_LAT;
    const dEastM = (avatarLon - cameraLon) * METERS_PER_DEGREE_LAT * cosLat;
    const dHeightM = proj.avatarGroundElevation - proj.cameraGroundElevation;

    const { rx, ry, behind } = projectToViewport(
        dEastM,
        dNorthM,
        dHeightM,
        cameraAltitude,
        cameraTilt,
        proj.cameraAzimuth,
        proj.fovYRad,
        proj.aspect,
    );

    const halfDz = deadzoneRatio / 2;
    // 背面（射影不能）はアバターが画面外にあるとみなし最大はみ出し扱いにする。
    const rmax = behind ? Infinity : Math.max(Math.abs(rx), Math.abs(ry));

    // デッドゾーン内、または追従無効ならカメラを動かさない。
    if (rmax <= halfDz || scrollLerp === 0) {
        return { lat: cameraLat, lon: cameraLon, scrolled: false };
    }

    // 背面（射影不能）はスクリーン位置を評価できない。他分岐と同様に scrollLerp で緩やかに
    // アバター方向（確実な地表ベクトル）へ寄せる（1 フレームでのワープを避ける）。数フレームで
    // アバターが前方へ戻れば通常の射影判定へ復帰する。
    if (!Number.isFinite(rmax)) {
        return {
            lat: cameraLat + scrollLerp * (avatarLat - cameraLat),
            lon: cameraLon + scrollLerp * (avatarLon - cameraLon),
            scrolled: true,
        };
    }

    // はみ出し分を scrollLerp だけ縮める目標 rmax。EDGE_LIMIT 超えは必ず境界内へ引き戻す。
    let targetR = halfDz + (rmax - halfDz) * (1 - scrollLerp);
    if (rmax > EDGE_LIMIT) targetR = Math.min(targetR, EDGE_LIMIT);

    // rmax を targetR まで下げるためにカメラ中心をアバター方向へ寄せる割合。
    // スクリーン正規化座標は地表距離にほぼ比例するため、緯度経度の線形補間で近似する
    // （毎フレーム反復で収束する）。
    const moveFraction = Math.max(0, Math.min(1, 1 - targetR / rmax));
    return {
        lat: cameraLat + moveFraction * (avatarLat - cameraLat),
        lon: cameraLon + moveFraction * (avatarLon - cameraLon),
        scrolled: moveFraction > 0,
    };
};

/**
 * デッドゾーン判定 + カメラ追従位置を計算する。
 *
 * アバターがデッドゾーン外にいる場合、はみ出し量に比例してカメラを移動する。
 * デッドゾーン内に収まっている場合はカメラを動かさない。
 * さらに、アバターがビューポート境界（比率 ±1.0）を超えないよう
 * ハードクランプを適用し、高速移動時も画面外に出ないことを保証する。
 *
 * `params.projection` を指定した場合は実スクリーン射影ベースで判定する
 * （{@link computeAutoScrollProjected}）。
 */
export const computeAutoScroll = (params: AutoScrollParams): AutoScrollResult => {
    const {
        avatarLat,
        avatarLon,
        cameraLat,
        cameraLon,
        cameraAltitude,
        cameraTilt,
        viewExtentOverride,
    } = params;

    // 座標値に非有限値が含まれる場合は安全のため不動を返す
    if (
        !Number.isFinite(avatarLat) || !Number.isFinite(avatarLon) ||
        !Number.isFinite(cameraLat) || !Number.isFinite(cameraLon)
    ) {
        return { lat: Number.isFinite(cameraLat) ? cameraLat : 0, lon: Number.isFinite(cameraLon) ? cameraLon : 0, scrolled: false };
    }

    // 実スクリーン射影パラメータが指定されていれば、平坦近似ではなく射影ベースで判定する。
    if (params.projection) {
        return computeAutoScrollProjected(params, params.projection);
    }

    // 入力パラメータを有効範囲にクランプ（NaN は isFinite チェック後なのでここでは有限数のみ）
    const rawDeadzone = params.deadzoneRatio;
    const rawLerp = params.scrollLerp;
    const deadzoneRatio = Number.isFinite(rawDeadzone) ? Math.max(0, Math.min(1, rawDeadzone)) : 0;
    const scrollLerp = Number.isFinite(rawLerp) ? Math.max(0, Math.min(1, rawLerp)) : 0;

    // viewExtentOverride の非有限値は無視して estimateViewExtent にフォールバック
    const safeOverride =
        viewExtentOverride !== undefined &&
        Number.isFinite(viewExtentOverride) &&
        viewExtentOverride > 0
            ? viewExtentOverride
            : undefined;
    const extent = safeOverride !== undefined
        ? safeOverride
        : estimateViewExtent(cameraAltitude, cameraTilt);

    // 緯度経度差をメートルに変換
    const dLatM = (avatarLat - cameraLat) * METERS_PER_DEGREE_LAT;
    const cosLat = Math.cos((cameraLat * Math.PI) / 180);
    const dLonM = (avatarLon - cameraLon) * METERS_PER_DEGREE_LAT * cosLat;
    const rx = extent > 0 ? dLonM / extent : 0;
    const ry = extent > 0 ? dLatM / extent : 0;

    const halfDz = deadzoneRatio / 2;

    // デッドゾーン内なら何もしない
    if (Math.abs(rx) <= halfDz && Math.abs(ry) <= halfDz) {
        return { lat: cameraLat, lon: cameraLon, scrolled: false };
    }

    // scrollLerp=0 なら追従無効（カメラを動かさない）
    if (scrollLerp === 0) {
        return { lat: cameraLat, lon: cameraLon, scrolled: false };
    }

    // はみ出し量を計算（デッドゾーン境界からの超過分）
    const overflowX = Math.abs(rx) > halfDz ? rx - Math.sign(rx) * halfDz : 0;
    const overflowY = Math.abs(ry) > halfDz ? ry - Math.sign(ry) * halfDz : 0;

    // はみ出し量をメートルに戻して lerp 分だけカメラを移動
    let dLonDeg =
        cosLat !== 0
            ? (overflowX * extent * scrollLerp) / (METERS_PER_DEGREE_LAT * cosLat)
            : 0;
    let dLatDeg = (overflowY * extent * scrollLerp) / METERS_PER_DEGREE_LAT;

    // ハードクランプ: アバターがビューポート境界（±EDGE_LIMIT）を超える場合、
    // 境界ちょうどに収まるようカメラを強制移動する。
    // これにより高速移動時も画面外に出ない。
    // scrollLerp=0 の場合は追従無効なのでクランプも適用しない。
    if (scrollLerp > 0) {
        if (Math.abs(rx) > EDGE_LIMIT) {
            const clampX = rx - Math.sign(rx) * EDGE_LIMIT;
            const clampDLon =
                cosLat !== 0
                    ? (clampX * extent) / (METERS_PER_DEGREE_LAT * cosLat)
                    : 0;
            if (Math.abs(clampDLon) > Math.abs(dLonDeg)) {
                dLonDeg = clampDLon;
            }
        }
        if (Math.abs(ry) > EDGE_LIMIT) {
            const clampY = ry - Math.sign(ry) * EDGE_LIMIT;
            const clampDLat = (clampY * extent) / METERS_PER_DEGREE_LAT;
            if (Math.abs(clampDLat) > Math.abs(dLatDeg)) {
                dLatDeg = clampDLat;
            }
        }
    }

    return {
        lat: cameraLat + dLatDeg,
        lon: cameraLon + dLonDeg,
        scrolled: true,
    };
};
