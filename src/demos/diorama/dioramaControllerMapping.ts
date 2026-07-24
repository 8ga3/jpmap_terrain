/**
 * diorama デモ固有の入力変換ロジック（タイル種別の巡回）と、コントローラー操作割り当ての
 * 一覧ドキュメント。
 *
 * @remarks
 * デッドゾーン処理・パン/ズーム/回転/高さ変更の入力変換など、Babylon.js Scene / WebXR に
 * 依存しない汎用の純粋関数群は `src/lib/webxr/webXrStickInput.ts`（公開API）へ移設した。
 * 本ファイルには `DioramaTileMode` 型に依存するdiorama固有の巡回ロジックのみを残す。
 *
 * 操作割り当て（以降のコントローラー操作機能もこれに従う）:
 * - 左スティック / GUI仮想ジョイスティック: 地図中心の東西・南北移動（パン）
 * - 右スティックY（前後） / GUIズームボタン: フットプリントの半辺長のズーム
 *   （前方向・GUIの「+」= ズームイン/縮小、後方向・GUIの「-」= ズームアウト/拡大）
 * - 右スティックX（左右）: 箱庭の回転（`webXrStickInput.ts`の`computeRotationRadFromStick`）
 *
 * **右スティックは十字ボタン相当の排他動作**: 物理コントローラーの右スティックは
 * X（回転）・Y（ズーム）を同時に検知しうるが、上下・左右いずれか一方だけを
 * 操作するつもりでもわずかに斜めへずれやすく、意図しない同時発火（下へ倒して
 * ズームしているつもりが、わずかな左右のずれで回転も発火する等）が起きやすい。
 * そのため物理スティックの生入力（`dioramaArControls.ts`の`sticks.right`）へは
 * 個別デッドゾーン処理の前段で`applyDPadGate`（`webXrStickInput.ts`）を適用し、
 * 支配的な軸のみを有効にする（十字ボタンと同じ「一方向のみ」の挙動。速度自体は
 * アナログのまま）。GUIのズーム/回転ボタン（`dioramaArControlHud.ts`）はもともと
 * 個別のボタンで排他的なため、本ゲート処理の対象外（適用不要）。
 * - トリガー（左右）: 箱庭の設置高さ変更（`webXrStickInput.ts`の`computeHeightMetersFromTriggers`）
 * - 太陽の位置移動によるライティング操作（グリップ + 左スティック等のモディファイア割当を予定していた）は
 *   操作が複雑になり機能的にも過剰と判断し、開発をキャンセルした。太陽光は
 *   `index.ts` の固定 `DirectionalLight` のまま、コントローラーでは操作しない。
 * - A/Xボタン / GUIタイル切替ボタン: 地図タイル種別切替（本ファイルで実装、
 *   {@link nextDioramaTileMode}。std→photo→wireframeの順に巡回する）
 * - B/Yボタン / GUIのARを終了するボタン: ARモードを終了し通常表示へ戻る
 *   （`dioramaArControls.ts`が`xr.baseExperience.exitXRAsync()`を直接呼ぶ。
 *   AR中でなければ意味を持たない操作のため、常時表示のタッチHUD側では
 *   このボタンをグレーアウトして無効化する。箱庭の表示状態
 *   （center/footprintHalfSizeM/回転/高さ）はリセットしない）
 */
import type { DioramaTileMode } from "../../terrain/diorama/dioramaTerrain";

/**
 * タイル種別の巡回順序（A/Xボタン・GUIタイル切替ボタン共通）。
 * `DioramaTileMode`（`dioramaTerrain.ts`、型のみimport）を直接使うことで、
 * 巡回対象の値集合を型定義側と同期させる。
 */
export const DIORAMA_TILE_MODE_CYCLE_ORDER: readonly DioramaTileMode[] = ["std", "photo", "wireframe"];

/**
 * 現在のタイル種別から、巡回順序（{@link DIORAMA_TILE_MODE_CYCLE_ORDER}）における
 * 次のタイル種別を返す純粋関数。末尾（wireframe）の次は先頭（std）へ戻る。
 *
 * @param current 現在のタイル種別。巡回順序に含まれない値が渡された場合
 *   （型システム上は起こり得ないが、念のため）は先頭（std）を返す。
 */
export const nextDioramaTileMode = (current: DioramaTileMode): DioramaTileMode => {
    const currentIndex = DIORAMA_TILE_MODE_CYCLE_ORDER.indexOf(current);
    if (currentIndex < 0) return DIORAMA_TILE_MODE_CYCLE_ORDER[0];
    return DIORAMA_TILE_MODE_CYCLE_ORDER[(currentIndex + 1) % DIORAMA_TILE_MODE_CYCLE_ORDER.length];
};
