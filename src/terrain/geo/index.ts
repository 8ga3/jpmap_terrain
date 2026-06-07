/**
 * グローブ地形（Issue #275）の座標基盤・地形エンジンユーティリティのバレル。
 *
 * Phase 0（座標基盤）:
 * - `ecef`: ECEF（WGS84）⇄ 測地座標の相互変換。
 * - `mapping`: Web メルカトルのグローバルピクセル ⇄ 緯度経度。
 *
 * Phase 1（地形エンジン）:
 * - `elevSample`: 標高ラスタの bilinear サンプリング。
 * - `globeLod`: 地心距離ベース Quadtree+SSE の可視タイル選択。
 * - `crossLevel`: LOD 境界のクロスレベル標高スナップ。
 * - `globeMesh`: 曲面タイルメッシュのジオメトリ生成（純粋関数）。
 *
 * Phase 2（カメラ・UX・URL）:
 * - `cameraMapping`: UI/URL ⇄ GeospatialCamera マッピング・接線パン・地形衝突の純関数。
 */
export * from "./ecef";
export * from "./mapping";
export * from "./elevSample";
export * from "./globeLod";
export * from "./crossLevel";
export * from "./globeMesh";
export * from "./cameraMapping";
