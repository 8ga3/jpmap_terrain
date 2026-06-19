/**
 * artillery の地形バックエンド解決 (Issue #404, P4-4)
 *
 * artillery は Havok 物理（局所下向き重力）+ 平面格子の地形コリジョンメッシュ +
 * pick 依存の地形 Y サンプリングという「平面ワールド前提」に深く結合した唯一の物理デモ。
 * globe（ECEF + GeospatialCamera + floating origin）では物理ワールド座標が地心規模
 * （~6.4e6 m）となり、Havok の float32 内部演算が量子化されてコリジョンが破綻する
 * （砲弾が地形メッシュをすり抜ける）。これは検証スパイク #405 で実証済み。
 *
 * 局所 ENU 物理空間（原点近傍の小座標で物理を解き、可視メッシュのみ ECEF へ写像）の
 * 実装が完了するまでは、`?terrainEngine=globe` 指定時に警告を出して planar へ
 * グレースフルにフォールバックする（親 Issue #349「最悪一時非対応」方針）。
 */
import { resolveTerrainEngine } from "../../terrain/urlState";
import type { TerrainEngine } from "../../lib/types";

export interface ArtilleryEngineResolution {
    /**
     * `JpmapTerrain.create` に渡す地形バックエンド。
     * globe 要求時は planar へ倒す。`undefined` は未指定（lib 既定 = planar）。
     */
    engine: TerrainEngine | undefined;
    /** globe が要求され planar へフォールバックしたか（呼び出し側の warn 用）。 */
    fellBackFromGlobe: boolean;
}

/**
 * URL クエリ（`?terrainEngine=`）から artillery 用の地形バックエンドを解決する。
 *
 * - `planar` / 未指定 → そのまま（未指定は `undefined` を返し lib 既定に委ねる）。
 * - `globe` → 現状未対応のため `planar` へフォールバックし `fellBackFromGlobe=true`。
 */
export const resolveArtilleryTerrainEngine = (
    search: string,
): ArtilleryEngineResolution => {
    const requested = resolveTerrainEngine(search);
    if (requested === "globe") {
        return { engine: "planar", fellBackFromGlobe: true };
    }
    return { engine: requested, fellBackFromGlobe: false };
};
