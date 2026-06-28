/**
 * 標高ダイレクト参照による地形サンプラ（#435 案A）
 *
 * 地形コリジョン構築のサンプリングを、頂点ごとのレイキャストから
 * `terrainElevAt`（O(1) バイリニア標高ルックアップ）へ置換するための純関数ファクトリ。
 *
 * 手順:
 *   1. ステージローカル `(x=East, 0, z=North)` → ECEF（`stage.localToWorld`）
 *   2. ECEF → 測地 `(lat, lon)`（`ecefToGeodetic`）
 *   3. `elevAt(lat, lon)` で地表標高[m]（楕円体面基準）を引く
 *   4. 地表点 `(lat, lon, elev)` を ECEF へ戻す（`geodeticToEcefToRef`）
 *   5. ECEF → ステージローカル Y（`stage.worldToLocal`）
 *
 * 地球曲率による落差はステップ 4–5 のローカル Y 変換へ自然に織り込まれるため、
 * 平面近似に伴う誤差を持たない。`elevAt` が `null`（標高タイル未ロード、または
 * planar バックエンド）の座標では `null` を返し、呼び出し側でレイキャストへ
 * フォールバックさせる。
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { ecefToGeodetic, geodeticToEcefToRef } from "../../terrain/geo/ecef";

/** サンプラが必要とするステージ座標変換の最小インターフェース。 */
export interface StageTransform {
    /** ステージローカル座標（ENU）→ ワールド（ECEF）。`ref` に書き込んで返す。 */
    localToWorld(local: Vector3, ref: Vector3): Vector3;
    /** ワールド（ECEF）→ ステージローカル座標。`ref` に書き込んで返す。 */
    worldToLocal(world: Vector3, ref: Vector3): Vector3;
}

/**
 * 標高ダイレクト参照サンプラを生成する。
 *
 * 返される関数はステージローカル `(x, z)` を受け取り、地表のステージローカル Y を
 * 返す。`elevAt` が当該座標で `null` を返した場合は `null` を返す。
 *
 * 高頻度（コリジョン構築で約 1 万回）に呼ばれるため、内部の `Vector3` は使い回して
 * アロケーションを抑える。
 *
 * @param stage  ステージ座標フレーム（ENU↔ECEF 変換）。
 * @param elevAt 測地座標 `(lat, lon)` の地表標高[m] を返す。取得不可なら `null`。
 */
export const createDirectTerrainSampler = (
    stage: StageTransform,
    elevAt: (latDeg: number, lonDeg: number) => number | null,
): ((x: number, z: number) => number | null) => {
    const scratch = new Vector3();
    return (x: number, z: number): number | null => {
        scratch.copyFromFloats(x, 0, z);
        stage.localToWorld(scratch, scratch);
        const geo = ecefToGeodetic(scratch);
        const elev = elevAt(geo.latDeg, geo.lonDeg);
        if (elev === null) return null;
        geodeticToEcefToRef(geo.latDeg, geo.lonDeg, elev, scratch);
        stage.worldToLocal(scratch, scratch);
        return scratch.y;
    };
};
