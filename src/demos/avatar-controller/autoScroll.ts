/**
 * 自動スクロール（カメラ追従）ロジック (Issue #287)
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
    const alt = Math.max(altitude, 1);
    // FOV ≈ 60° → half FOV = 30° → tan(30°) ≈ 0.577
    const halfFovTan = 0.577;
    // tilt=0: 真上から見下ろし。near/far 対称。extent = alt * tan(halfFov)
    // tilt>0: near side は alt * tan(halfFov - tilt) に近づく（狭くなる）
    // 保守的近似: cos(tilt) で near side の縮小を反映
    const tiltRad = (Math.min(Math.max(tilt, 0), 85) * Math.PI) / 180;
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
    const dLatM = (avatarLat - cameraLat) * 111320;
    const cosLat = Math.cos((cameraLat * Math.PI) / 180);
    const dLonM = (avatarLon - cameraLon) * 111320 * cosLat;

    return {
        rx: dLonM / extent,
        ry: dLatM / extent,
    };
};

/**
 * デッドゾーン判定 + カメラ追従位置を計算する。
 *
 * アバターがデッドゾーン外にいる場合、はみ出し量に比例してカメラを移動する。
 * デッドゾーン内に収まっている場合はカメラを動かさない。
 * さらに、アバターがビューポート境界（比率 ±1.0）を超えないよう
 * ハードクランプを適用し、高速移動時も画面外に出ないことを保証する。
 */
export const computeAutoScroll = (params: AutoScrollParams): AutoScrollResult => {
    const {
        avatarLat,
        avatarLon,
        cameraLat,
        cameraLon,
        cameraAltitude,
        cameraTilt,
        deadzoneRatio,
        scrollLerp,
        viewExtentOverride,
    } = params;

    const extent = viewExtentOverride !== undefined && viewExtentOverride > 0
        ? viewExtentOverride
        : estimateViewExtent(cameraAltitude, cameraTilt);

    // 緯度経度差をメートルに変換
    const dLatM = (avatarLat - cameraLat) * 111320;
    const cosLat = Math.cos((cameraLat * Math.PI) / 180);
    const dLonM = (avatarLon - cameraLon) * 111320 * cosLat;
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
            ? (overflowX * extent * scrollLerp) / (111320 * cosLat)
            : 0;
    let dLatDeg = (overflowY * extent * scrollLerp) / 111320;

    // ハードクランプ: アバターがビューポート境界（±EDGE_LIMIT）を超える場合、
    // 境界ちょうどに収まるようカメラを強制移動する。
    // これにより高速移動時も画面外に出ない。
    // scrollLerp=0 の場合は追従無効なのでクランプも適用しない。
    if (scrollLerp > 0) {
        const EDGE_LIMIT = 0.95;
        if (Math.abs(rx) > EDGE_LIMIT) {
            const clampX = rx - Math.sign(rx) * EDGE_LIMIT;
            const clampDLon =
                cosLat !== 0
                    ? (clampX * extent) / (111320 * cosLat)
                    : 0;
            if (Math.abs(clampDLon) > Math.abs(dLonDeg)) {
                dLonDeg = clampDLon;
            }
        }
        if (Math.abs(ry) > EDGE_LIMIT) {
            const clampY = ry - Math.sign(ry) * EDGE_LIMIT;
            const clampDLat = (clampY * extent) / 111320;
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
