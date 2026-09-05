/**
 * Boids フロッキングアルゴリズム
 *
 * Craig Reynolds (1987) の 3 ルール（分離・整列・結合）に加え、
 * 速度制限・境界回避を実装する純粋関数群。
 *
 * 座標系: 2D 平面上 (x, y) をメートル単位で扱う。
 * 地理座標 (lat, lon) との変換はデモ側 (index.ts / region.ts) で行う。
 */

/** Boid の状態 */
export interface BoidState {
    /** X 位置 (m) */
    x: number;
    /** Y 位置 (m) */
    y: number;
    /** X 速度 (m/s) */
    vx: number;
    /** Y 速度 (m/s) */
    vy: number;
}

/** Boids シミュレーションパラメータ */
export interface BoidsParams {
    /** 近隣認識半径 (m) */
    perceptionRadius: number;
    /** 分離判定半径 (m) — これより近いと反発力が働く */
    separationRadius: number;
    /** 分離ルールの重み */
    separationWeight: number;
    /** 整列ルールの重み */
    alignmentWeight: number;
    /** 結合ルールの重み */
    cohesionWeight: number;
    /** 最大速度 (m/s) */
    maxSpeed: number;
    /** 最小速度 (m/s) — 完全停止を防ぐ */
    minSpeed: number;
    /** 最大操舵力 (m/s²) */
    maxForce: number;
}

/** 矩形境界 (メートル座標系) */
export interface BoidsBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

/** デフォルトパラメータ */
export const BOIDS_DEFAULTS: Readonly<BoidsParams> = {
    perceptionRadius: 50,
    separationRadius: 25,
    separationWeight: 1.8,
    alignmentWeight: 1.0,
    cohesionWeight: 1.0,
    maxSpeed: 45.0,
    minSpeed: 15.0,
    maxForce: 5.0,
};

/** 境界回避が効き始める距離 (m) */
const BOUNDARY_MARGIN = 40;
/** 境界回避の基本強さ — 距離の逆二乗で急激に増大 */
const BOUNDARY_WEIGHT = 15.0;

/**
 * 2 点間のユークリッド距離
 */
export const distance = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number => {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
};

/**
 * ベクトルの長さを制限する
 */
const clampMagnitude = (
    x: number,
    y: number,
    max: number,
): { x: number; y: number } => {
    const mag = Math.sqrt(x * x + y * y);
    if (mag <= max || mag === 0) return { x, y };
    const scale = max / mag;
    return { x: x * scale, y: y * scale };
};

/**
 * 分離 (Separation): 近すぎる仲間から離れる方向の操舵力
 */
export const separation = (
    boid: BoidState,
    flock: readonly BoidState[],
    params: BoidsParams,
): { x: number; y: number } => {
    let steerX = 0;
    let steerY = 0;
    let count = 0;

    for (const other of flock) {
        if (other === boid) continue;
        const d = distance(boid.x, boid.y, other.x, other.y);
        if (d > 0 && d < params.separationRadius) {
            // 距離に反比例する反発ベクトル
            const dx = (boid.x - other.x) / d;
            const dy = (boid.y - other.y) / d;
            steerX += dx / d;
            steerY += dy / d;
            count++;
        }
    }

    if (count > 0) {
        steerX /= count;
        steerY /= count;
        // 目標速度方向に正規化して操舵力を算出
        const mag = Math.sqrt(steerX * steerX + steerY * steerY);
        if (mag > 0) {
            steerX = (steerX / mag) * params.maxSpeed - boid.vx;
            steerY = (steerY / mag) * params.maxSpeed - boid.vy;
            const clamped = clampMagnitude(steerX, steerY, params.maxForce);
            steerX = clamped.x;
            steerY = clamped.y;
        }
    }

    return { x: steerX, y: steerY };
};

/**
 * 整列 (Alignment): 近隣の仲間と速度方向を揃える操舵力
 */
export const alignment = (
    boid: BoidState,
    flock: readonly BoidState[],
    params: BoidsParams,
): { x: number; y: number } => {
    let avgVx = 0;
    let avgVy = 0;
    let count = 0;

    for (const other of flock) {
        if (other === boid) continue;
        const d = distance(boid.x, boid.y, other.x, other.y);
        if (d > 0 && d < params.perceptionRadius) {
            avgVx += other.vx;
            avgVy += other.vy;
            count++;
        }
    }

    if (count > 0) {
        avgVx /= count;
        avgVy /= count;
        const mag = Math.sqrt(avgVx * avgVx + avgVy * avgVy);
        if (mag > 0) {
            avgVx = (avgVx / mag) * params.maxSpeed;
            avgVy = (avgVy / mag) * params.maxSpeed;
        }
        let steerX = avgVx - boid.vx;
        let steerY = avgVy - boid.vy;
        const clamped = clampMagnitude(steerX, steerY, params.maxForce);
        steerX = clamped.x;
        steerY = clamped.y;
        return { x: steerX, y: steerY };
    }

    return { x: 0, y: 0 };
};

/**
 * 結合 (Cohesion): 近隣の仲間の重心に向かう操舵力
 */
export const cohesion = (
    boid: BoidState,
    flock: readonly BoidState[],
    params: BoidsParams,
): { x: number; y: number } => {
    let centerX = 0;
    let centerY = 0;
    let count = 0;

    for (const other of flock) {
        if (other === boid) continue;
        const d = distance(boid.x, boid.y, other.x, other.y);
        if (d > 0 && d < params.perceptionRadius) {
            centerX += other.x;
            centerY += other.y;
            count++;
        }
    }

    if (count > 0) {
        centerX /= count;
        centerY /= count;
        // 重心に向かうベクトル
        let desiredX = centerX - boid.x;
        let desiredY = centerY - boid.y;
        const mag = Math.sqrt(desiredX * desiredX + desiredY * desiredY);
        if (mag > 0) {
            desiredX = (desiredX / mag) * params.maxSpeed;
            desiredY = (desiredY / mag) * params.maxSpeed;
        }
        let steerX = desiredX - boid.vx;
        let steerY = desiredY - boid.vy;
        const clamped = clampMagnitude(steerX, steerY, params.maxForce);
        steerX = clamped.x;
        steerY = clamped.y;
        return { x: steerX, y: steerY };
    }

    return { x: 0, y: 0 };
};

/**
 * 境界回避力: 壁に近づくほど急激に強くなる反発力（逆二乗法則）。
 * 魚群シミュレーションで用いられる「水槽の壁」方式。
 */
export const boundaryForce = (
    boid: BoidState,
    bounds: BoidsBounds,
): { x: number; y: number } => {
    let fx = 0;
    let fy = 0;

    const dLeft = boid.x - bounds.minX;
    const dRight = bounds.maxX - boid.x;
    const dBottom = boid.y - bounds.minY;
    const dTop = bounds.maxY - boid.y;

    const repulse = (d: number): number => {
        if (d <= 0) return BOUNDARY_WEIGHT * 10;
        if (d >= BOUNDARY_MARGIN) return 0;
        // 逆二乗: 壁に近いほど急激に強くなる
        const ratio = BOUNDARY_MARGIN / d;
        return BOUNDARY_WEIGHT * ratio * ratio;
    };

    fx += repulse(dLeft);
    fx -= repulse(dRight);
    fy += repulse(dBottom);
    fy -= repulse(dTop);

    return { x: fx, y: fy };
};

/**
 * 1 体の Boid を 1 ステップ更新する
 */
export const updateBoid = (
    boid: BoidState,
    flock: readonly BoidState[],
    params: BoidsParams,
    bounds: BoidsBounds,
    dt: number,
): BoidState => {
    const sep = separation(boid, flock, params);
    const ali = alignment(boid, flock, params);
    const coh = cohesion(boid, flock, params);
    const boundary = boundaryForce(boid, bounds);

    // 加速度 = 各ルールの重み付き合計 + 境界回避
    const ax =
        sep.x * params.separationWeight +
        ali.x * params.alignmentWeight +
        coh.x * params.cohesionWeight +
        boundary.x;
    const ay =
        sep.y * params.separationWeight +
        ali.y * params.alignmentWeight +
        coh.y * params.cohesionWeight +
        boundary.y;

    let newVx = boid.vx + ax * dt;
    let newVy = boid.vy + ay * dt;

    // 速度制限
    const speed = Math.sqrt(newVx * newVx + newVy * newVy);
    if (speed > params.maxSpeed) {
        newVx = (newVx / speed) * params.maxSpeed;
        newVy = (newVy / speed) * params.maxSpeed;
    } else if (speed < params.minSpeed && speed > 0) {
        newVx = (newVx / speed) * params.minSpeed;
        newVy = (newVy / speed) * params.minSpeed;
    }

    let newX = boid.x + newVx * dt;
    let newY = boid.y + newVy * dt;

    // ハードクランプ — 万一境界外に出た場合
    newX = Math.max(bounds.minX, Math.min(bounds.maxX, newX));
    newY = Math.max(bounds.minY, Math.min(bounds.maxY, newY));

    return { x: newX, y: newY, vx: newVx, vy: newVy };
};

/** 重なり解消判定に使うアバター半径 (m) */
const COLLISION_RADIUS = 8;

/**
 * 全 Boid を 1 ステップ一括更新する（同時更新 — 旧状態を参照して一斉に更新）
 */
export const updateFlock = (
    flock: readonly BoidState[],
    params: BoidsParams,
    bounds: BoidsBounds,
    dt: number,
): BoidState[] => {
    const updated = flock.map((boid) =>
        updateBoid(boid, flock, params, bounds, dt),
    );

    // 簡易重なり解消: 近すぎるペアを互いに押し出す（1パス）
    const minDist = COLLISION_RADIUS * 2;
    for (let i = 0; i < updated.length; i++) {
        for (let j = i + 1; j < updated.length; j++) {
            const dx = updated[j].x - updated[i].x;
            const dy = updated[j].y - updated[i].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > 0 && d < minDist) {
                const overlap = (minDist - d) * 0.5;
                const nx = dx / d;
                const ny = dy / d;
                updated[i] = {
                    ...updated[i],
                    x: Math.max(
                        bounds.minX,
                        Math.min(bounds.maxX, updated[i].x - nx * overlap),
                    ),
                    y: Math.max(
                        bounds.minY,
                        Math.min(bounds.maxY, updated[i].y - ny * overlap),
                    ),
                };
                updated[j] = {
                    ...updated[j],
                    x: Math.max(
                        bounds.minX,
                        Math.min(bounds.maxX, updated[j].x + nx * overlap),
                    ),
                    y: Math.max(
                        bounds.minY,
                        Math.min(bounds.maxY, updated[j].y + ny * overlap),
                    ),
                };
            }
        }
    }

    return updated;
};

/**
 * Boid の進行方向角度（度, 北=0, 時計回り）を返す。
 * 速度がゼロの場合は 0 を返す。
 */
export const boidHeading = (boid: BoidState): number => {
    const speed = Math.sqrt(boid.vx * boid.vx + boid.vy * boid.vy);
    if (speed === 0) return 0;
    // atan2(vx, vy) → 北(+Y)=0, 東(+X)=90 の方位角
    const rad = Math.atan2(boid.vx, boid.vy);
    return ((rad * 180) / Math.PI + 360) % 360;
};
