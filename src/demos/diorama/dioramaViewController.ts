/**
 * diorama デモの「現在の実世界中心・フットプリント半径」を単独で保持し、
 * パン/ズーム入力（入力源を問わない共通の軸表現、`StickAxes`/ズーム軸値）を
 * `dioramaTerrain.setView` へ橋渡しする。
 *
 * @remarks
 * AR中のコントローラー/GUI操作（`dioramaArControls.ts`）とデスクトップの
 * キーボード操作（`dioramaKeyboardControls.ts`）の両方から共有される、
 * 単独の状態保持者（single source of truth）である。これにより、AR突入前に
 * キーボードで移動した位置がAR突入後も引き継がれる（逆に、AR中にコントローラー
 * で移動した位置がAR退出後もデスクトップ側に引き継がれる）。入力経路ごとに
 * 別々の状態を持つと値がずれるため、地図移動・拡大縮小に関わる全ての入力は
 * 必ず本モジュール経由で行うこと。
 *
 * `setCenter`/`setFootprintRadius`（`dioramaTerrain.setView`が内部で使う）は
 * 非同期の地形rebuild（DEM/テクスチャの再取得を伴う）のため毎フレーム呼ぶと
 * ネットワーク往復のレイテンシが積み重なる。前回の`setView`呼び出しが完了する
 * まで次を発行しない「完了待ち合流」方式で、rebuildキューへの際限ない
 * バックログ蓄積を防ぐ（固定間隔タイマー方式で実機に生じた応答遅延不具合の教訓）。
 */
import type { DioramaTerrain } from "../../terrain/diorama/dioramaTerrain";
import type { DioramaCenter } from "../../terrain/diorama/dioramaGrid";
import { offsetToLatLon } from "../../terrain/diorama/dioramaGrid";
import {
    computeDioramaPanMetersFromStick,
    computeFootprintRadiusFactorFromStick,
    clampFootprintRadiusM,
    type StickAxes,
} from "./dioramaControllerMapping";

export interface DioramaViewController {
    /** 現在の実世界中心（読み取り専用スナップショット）。 */
    getCenter(): DioramaCenter;
    /** 現在のフットプリント半径[m]（読み取り専用スナップショット）。 */
    getFootprintRadiusM(): number;
    /**
     * パン軸・ズーム軸（[-1,1]、複数入力源から合算済みの値を想定）を
     * 1フレーム分適用する。呼び出し元が毎フレーム呼ぶこと。
     */
    feedAxes(panAxes: StickAxes, zoomAxisY: number, dtSeconds: number): void;
    /**
     * 中心・フットプリント半径を、生成時に渡された初期値（`initialCenter`/
     * `initialFootprintRadiusM`）へ絶対値でリセットする（「トップ復帰」操作）。
     *
     * @remarks 蓄積中のパン差分（`pendingEastM`/`pendingNorthM`）は破棄し、
     * 絶対値の中心へ直接ジャンプする。`setView` 呼び出し中（`applying`）の
     * 場合は即座には送信されず、次回 `feedAxes` 呼び出し時の `flush()` で
     * 自然に反映される（既存のパン/ズームと同じ完了待ち合流の仕組みに乗せる）。
     */
    resetToInitial(): void;
}

/**
 * `DioramaViewController` を生成する。
 * @param initialCenter 初期の実世界中心（デモ既定値）。
 * @param initialFootprintRadiusM 初期のフットプリント半径[m]（デモ既定値）。
 */
export const createDioramaViewController = (
    dioramaTerrain: DioramaTerrain,
    initialCenter: DioramaCenter,
    initialFootprintRadiusM: number,
): DioramaViewController => {
    let currentCenter = initialCenter;
    let currentFootprintRadiusM = clampFootprintRadiusM(initialFootprintRadiusM);
    let lastAppliedFootprintRadiusM = currentFootprintRadiusM;

    let pendingEastM = 0;
    let pendingNorthM = 0;
    // `resetToInitial()` によるトップ復帰時、相対パン差分ではなく絶対値で中心を
    // 送信するためのオーバーライド。設定されている間は `pendingEastM`/`pendingNorthM`
    // による相対移動より優先する（両者は同時に意味を持たないため、resetToInitial側で
    // 相対差分を破棄してから設定する）。
    let pendingAbsoluteCenter: DioramaCenter | null = null;
    // 前回の `setView` 呼び出し（rebuild）が完了するまで次を発行しない。
    let applying = false;

    const flush = (): void => {
        if (applying) return;
        const hasPan = pendingAbsoluteCenter !== null || pendingEastM !== 0 || pendingNorthM !== 0;
        const hasZoom = currentFootprintRadiusM !== lastAppliedFootprintRadiusM;
        if (!hasPan && !hasZoom) return;

        const patch: { center?: DioramaCenter; footprintRadiusM?: number } = {};
        // `setView` が失敗した場合に取りこぼさず次回へ再送できるよう、
        // 楽観的な状態確定（currentCenter/lastAppliedFootprintRadiusM の更新）は
        // 成功時のみ行う。送信予定分は一旦 pending から差し引いておき、
        // 失敗時のみ復元する（成功時は復元せず currentCenter に取り込む）。
        let sentEastM = 0;
        let sentNorthM = 0;
        let sentAbsoluteCenter: DioramaCenter | null = null;
        let nextCenter: DioramaCenter | undefined;
        if (hasPan) {
            if (pendingAbsoluteCenter !== null) {
                sentAbsoluteCenter = pendingAbsoluteCenter;
                nextCenter = sentAbsoluteCenter;
                pendingAbsoluteCenter = null;
                // 絶対値リセットは相対パン差分と意味が競合するため、蓄積中のオフセットも破棄する。
                pendingEastM = 0;
                pendingNorthM = 0;
            } else {
                sentEastM = pendingEastM;
                sentNorthM = pendingNorthM;
                nextCenter = offsetToLatLon(currentCenter, sentEastM, sentNorthM);
                pendingEastM = 0;
                pendingNorthM = 0;
            }
            patch.center = nextCenter;
        }
        let sentFootprintRadiusM: number | undefined;
        if (hasZoom) {
            sentFootprintRadiusM = currentFootprintRadiusM;
            patch.footprintRadiusM = sentFootprintRadiusM;
        }

        applying = true;
        dioramaTerrain
            .setView(patch)
            .then(
                () => {
                    if (nextCenter !== undefined) currentCenter = nextCenter;
                    if (sentFootprintRadiusM !== undefined) lastAppliedFootprintRadiusM = sentFootprintRadiusM;
                },
                (err: unknown) => {
                    console.error("[jpmap-terrain diorama demo] setView failed:", err);
                    // lastAppliedFootprintRadiusM は更新していないため、hasZoom判定により
                    // 次回のflushで自然に再送される。パン分（絶対値/相対差分のいずれか）を復元する。
                    if (sentAbsoluteCenter !== null) {
                        pendingAbsoluteCenter = sentAbsoluteCenter;
                    } else {
                        pendingEastM += sentEastM;
                        pendingNorthM += sentNorthM;
                    }
                },
            )
            .finally(() => {
                applying = false;
            });
    };

    return {
        getCenter: () => currentCenter,
        getFootprintRadiusM: () => currentFootprintRadiusM,
        feedAxes: (panAxes: StickAxes, zoomAxisY: number, dtSeconds: number): void => {
            if (!(dtSeconds > 0)) return;

            const { eastM, northM } = computeDioramaPanMetersFromStick(panAxes, dtSeconds, currentFootprintRadiusM);
            pendingEastM += eastM;
            pendingNorthM += northM;

            const factor = computeFootprintRadiusFactorFromStick(zoomAxisY, dtSeconds);
            if (factor !== 1) {
                currentFootprintRadiusM = clampFootprintRadiusM(currentFootprintRadiusM * factor);
            }

            flush();
        },
        resetToInitial: (): void => {
            pendingEastM = 0;
            pendingNorthM = 0;
            pendingAbsoluteCenter = initialCenter;
            currentFootprintRadiusM = clampFootprintRadiusM(initialFootprintRadiusM);
            flush();
        },
    };
};
