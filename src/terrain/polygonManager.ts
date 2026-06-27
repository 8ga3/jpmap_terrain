/**
 * PolygonManager の公開契約 interface。
 *
 * `JpmapTerrain.addPolygon / getPolygon / removePolygon / setPolygonEnabled / listPolygons`
 * から利用される polygon 操作の境界型。globe 単一バックエンドでは
 * `globeSceneController` のアダプタがこの契約を実装する。
 */

import type {
    PolygonHandle,
    PolygonOptions,
    PolygonPointOptions,
    PolygonPointPartial,
    PolygonUpdate,
} from "../lib/types";

export interface PolygonManager {
    add(id: string, options: PolygonOptions): PolygonHandle;
    get(id: string): PolygonHandle | null;
    /**
     * 部分更新。`partial` を現在状態へマージしてポリゴンを再構築する（id は維持）。
     * globe アダプタは点数等が不変なら in-place 更新する（`globeSceneController`）。
     */
    update(id: string, partial: PolygonUpdate): PolygonHandle;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    setVerticalsEnabled(id: string, enabled: boolean): void;
    setLabelsEnabled(id: string, enabled: boolean): void;
    setWallsEnabled(id: string, enabled: boolean): void;
    /**
     * 指定 index に新しい頂点を挿入する。`index === points.length` で末尾追加。
     * 範囲外 / 緯度経度範囲外 / `absolute` モードでの altitude 未指定 は throw。
     */
    insertPoint(
        id: string,
        index: number,
        point: PolygonPointOptions,
    ): PolygonHandle;
    /** 指定 index の頂点を削除する。残り 2 点未満になる場合は throw。 */
    removePoint(id: string, index: number): PolygonHandle;
    /** 指定 index の頂点を部分更新する。 */
    updatePoint(
        id: string,
        index: number,
        partial: PolygonPointPartial,
    ): PolygonHandle;
    /** 全頂点を置き換える。`points.length < 1` は throw。 */
    replacePoints(
        id: string,
        points: readonly PolygonPointOptions[],
    ): PolygonHandle;
    list(): readonly string[];
    dispose(): void;
}
