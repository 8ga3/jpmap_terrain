/**
 * Artillery Game ゲームロジック
 *
 * ターン管理・スコア・命中判定・リスポーンの純粋関数群。
 */

export type Team = "red" | "blue";

export interface CannonState {
    team: Team;
    lat: number;
    lon: number;
    altitude: number;
    azimuthDeg: number;
}

export interface GameState {
    turn: Team;
    scoreRed: number;
    scoreBlue: number;
    redCannon: CannonState;
    blueCannon: CannonState;
}

export const opponent = (team: Team): Team =>
    team === "red" ? "blue" : "red";

export const nextTurn = (state: GameState): GameState => ({
    ...state,
    turn: opponent(state.turn),
});

export const addScore = (state: GameState, scoringTeam: Team): GameState => ({
    ...state,
    scoreRed: scoringTeam === "red" ? state.scoreRed + 1 : state.scoreRed,
    scoreBlue: scoringTeam === "blue" ? state.scoreBlue + 1 : state.scoreBlue,
});

/**
 * 命中判定: 砲弾位置と対象大砲位置の距離が閾値以下か。
 * 3D 空間の距離で判定する（Y は標高差）。
 */
export const HIT_RADIUS = 30;

export const isHit = (
    projectileX: number,
    projectileY: number,
    projectileZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    radius: number = HIT_RADIUS,
): boolean => {
    const dx = projectileX - targetX;
    const dy = projectileY - targetY;
    const dz = projectileZ - targetZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
};

/**
 * 初期ゲーム状態を生成。
 */
export const createInitialState = (
    redCannon: CannonState,
    blueCannon: CannonState,
): GameState => ({
    turn: "red",
    scoreRed: 0,
    scoreBlue: 0,
    redCannon,
    blueCannon,
});
