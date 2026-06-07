/**
 * 標高ラスタのサンプリング (Issue #275 Phase 1)。
 *
 * `globeMesh`（メッシュ頂点標高）と `crossLevel`（クロスレベル境界スナップ）の双方が
 * 同一のサンプリングを共有できるよう、低レベルの bilinear サンプラを独立モジュールに
 * 切り出す（両者が相互参照すると循環依存になるため）。両者が同じ式を使うことで、
 * 粗タイル表面の再構成がメッシュ生成と一致し、LOD 境界の陰影シームを防ぐ。
 */
import { TILE_SIZE } from "../gsiTile";

/** 標高ラスタ（TILE_SIZE 角）をローカルピクセル座標で bilinear サンプル（無効値は 0）。 */
export const sampleElevBilinear = (
    elev: Float32Array,
    px: number,
    py: number,
): number => {
    const cx = Math.max(0, Math.min(TILE_SIZE - 1, px));
    const cy = Math.max(0, Math.min(TILE_SIZE - 1, py));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
    const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
    const fx = cx - x0;
    const fy = cy - y0;
    const g = (x: number, y: number): number => {
        const v = elev[y * TILE_SIZE + x];
        return Number.isFinite(v) ? v : 0;
    };
    const a = g(x0, y0) * (1 - fx) + g(x1, y0) * fx;
    const b = g(x0, y1) * (1 - fx) + g(x1, y1) * fx;
    return a * (1 - fy) + b * fy;
};
