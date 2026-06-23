/**
 * CircleManager の公開契約 interface (Issue #201 / #203 / #414)。
 *
 * `JpmapTerrain.addCircle / getCircle / removeCircle / setCircle*Enabled / listCircles`
 * から利用される circle 操作の境界型。globe 単一バックエンド（#414）では
 * `globeSceneController` のアダプタがこの契約を実装する。
 */

import type {
    CircleHandle,
    CircleOptions,
    CircleUpdate,
} from "../lib/types";

export interface CircleManager {
    add(id: string, options: CircleOptions): CircleHandle;
    update(id: string, partial: CircleUpdate): CircleHandle;
    get(id: string): CircleHandle | null;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    setPointEnabled(id: string, enabled: boolean): void;
    setLineEnabled(id: string, enabled: boolean): void;
    setWallEnabled(id: string, enabled: boolean): void;
    setLabelEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    dispose(): void;
}
