/**
 * artillery の地形バックエンド解決 (Issue #404, P4-4)
 *
 * artillery は Havok 物理 + 地形コリジョンメッシュ + 地形 Y サンプリングという
 * 「平面ワールド前提」に深く結合した唯一の物理デモ。globe（ECEF + floating origin）
 * では物理ワールド座標が地心規模（~6.4e6 m）となるが、`scene.floatingOriginMode`
 * 下では Havok が region ごとの float32 安全な小座標で解くため、ステージを ENU→ECEF
 * の `stageRoot`（stageFrame.ts）へ載せることで globe 上でも物理が成立する。
 *
 * 本関数は URL クエリ（`?terrainEngine=`）から planar / globe を解決して返す。
 */
import { resolveTerrainEngine } from "../../terrain/urlState";
import type { TerrainEngine } from "../../lib/types";

export interface ArtilleryEngineResolution {
    /**
     * `JpmapTerrain.create` に渡す地形バックエンド。
     * `undefined` は未指定（lib 既定 = planar）。
     */
    engine: TerrainEngine | undefined;
}

/**
 * URL クエリ（`?terrainEngine=`）から artillery 用の地形バックエンドを解決する。
 *
 * - `planar` / 未指定 → そのまま（未指定は `undefined` を返し lib 既定に委ねる）。
 * - `globe` → globe（stageFrame による局所 ENU 物理で対応）。
 */
export const resolveArtilleryTerrainEngine = (
    search: string,
): ArtilleryEngineResolution => {
    return { engine: resolveTerrainEngine(search) };
};

