/**
 * 標高ラスタのサンプリング。
 *
 * `globeMesh`（メッシュ頂点標高）と `crossLevel`（クロスレベル境界スナップ）の双方が
 * 同一のサンプリングを共有できるよう、低レベルの bilinear サンプラを独立モジュールに
 * 切り出す（両者が相互参照すると循環依存になるため）。両者が同じ式を使うことで、
 * 粗タイル表面の再構成がメッシュ生成と一致し、LOD 境界の陰影シームを防ぐ。
 */
import { isInvalidElev, TILE_SIZE } from "../gsiTile";

/**
 * 標高ラスタ（TILE_SIZE 角）をローカルピクセル座標で bilinear サンプルする。
 *
 * 無効値（NaN/Infinity/NO_DATA_SENTINEL）は重み計算から除外し、有効な隅だけで重みを正規化して加重平均する
 * （平面版 tileManager と同じ方式）。NaN を 0 として混ぜると、4 隅の一部だけ無効な
 * 湖面・欠測境界で結果が 0 側へ強く引っ張られ不自然に沈むため。4 隅すべて無効なら 0 を返す。
 */
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

    let wSum = 0;
    let valSum = 0;
    const addCorner = (x: number, y: number, w: number): void => {
        const v = elev[y * TILE_SIZE + x];
        if (!isInvalidElev(v) && Number.isFinite(v)) {
            wSum += w;
            valSum += w * v;
        }
    };
    addCorner(x0, y0, (1 - fx) * (1 - fy));
    addCorner(x1, y0, fx * (1 - fy));
    addCorner(x0, y1, (1 - fx) * fy);
    addCorner(x1, y1, fx * fy);

    return wSum > 0 ? valSum / wSum : 0;
};
