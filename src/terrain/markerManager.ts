/**
 * MarkerManager の公開契約 interface。
 *
 * `JpmapTerrain.addMarker / updateMarker / removeMarker / setMarkerEnabled / listMarkers / getMarker`
 * から利用される marker 操作の境界型。globe 単一バックエンドでは
 * `globeSceneController` のアダプタ（`createGlobeMarkerManagerAdapter` 等）がこの契約を実装する。
 */

import type {
    MarkerHandle,
    MarkerOptions,
    MarkerUpdate,
} from "../lib/types";

export interface MarkerManager {
    add(id: string, options: MarkerOptions): MarkerHandle;
    get(id: string): MarkerHandle | null;
    update(id: string, partial: MarkerUpdate): MarkerHandle;
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): void;
    list(): readonly string[];
    dispose(): void;
}
