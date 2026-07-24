/**
 * diorama デモの「現在の実世界中心・フットプリントの半辺長」を単独で保持し、
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
 * `setCenter`/`setFootprintHalfSize`（`dioramaTerrain.setView`が内部で使う）は
 * 非同期の地形rebuild（DEM/テクスチャの再取得を伴う）のため毎フレーム呼ぶと
 * ネットワーク往復のレイテンシが積み重なる。前回の`setView`呼び出しが完了する
 * まで次を発行しない「完了待ち合流」方式で、rebuildキューへの際限ない
 * バックログ蓄積を防ぐ（固定間隔タイマー方式で実機に生じた応答遅延不具合の教訓）。
 */
import type { DioramaTerrain } from "../../terrain/diorama/dioramaTerrain";
import type { DioramaCenter } from "../../terrain/diorama/dioramaGrid";
import { offsetToLatLon } from "../../terrain/diorama/dioramaGrid";
import {
    computePanMetersFromStick,
    computeZoomFactorFromStick,
    clampViewScaleM,
    type StickAxes,
} from "../../lib/webxr/webXrStickInput";

export interface DioramaViewController {
    /** 現在の実世界中心（読み取り専用スナップショット）。 */
    getCenter(): DioramaCenter;
    /** 現在のフットプリントの半辺長[m]（読み取り専用スナップショット）。 */
    getFootprintHalfSizeM(): number;
    /**
     * パン軸・ズーム軸（[-1,1]、複数入力源から合算済みの値を想定）を
     * 1フレーム分適用する。呼び出し元が毎フレーム呼ぶこと。
     */
    feedAxes(panAxes: StickAxes, zoomAxisY: number, dtSeconds: number): void;
}

/**
 * `DioramaViewController` を生成する。
 * @param initialCenter 初期の実世界中心（デモ既定値）。
 * @param initialFootprintHalfSizeM 初期のフットプリントの半辺長[m]（デモ既定値）。
 */
export const createDioramaViewController = (
    dioramaTerrain: DioramaTerrain,
    initialCenter: DioramaCenter,
    initialFootprintHalfSizeM: number,
): DioramaViewController => {
    let currentCenter = initialCenter;
    let currentFootprintHalfSizeM = clampViewScaleM(initialFootprintHalfSizeM);
    let lastAppliedFootprintHalfSizeM = currentFootprintHalfSizeM;

    let pendingEastM = 0;
    let pendingNorthM = 0;
    // 前回の `setView` 呼び出し（rebuild）が完了するまで次を発行しない。
    let applying = false;

    const flush = (): void => {
        if (applying) return;
        const hasPan = pendingEastM !== 0 || pendingNorthM !== 0;
        const hasZoom = currentFootprintHalfSizeM !== lastAppliedFootprintHalfSizeM;
        if (!hasPan && !hasZoom) return;

        const patch: { center?: DioramaCenter; footprintHalfSizeM?: number } = {};
        // `setView` が失敗した場合に取りこぼさず次回へ再送できるよう、
        // 楽観的な状態確定（currentCenter/lastAppliedFootprintHalfSizeM の更新）は
        // 成功時のみ行う。送信予定分は一旦 pending から差し引いておき、
        // 失敗時のみ復元する（成功時は復元せず currentCenter に取り込む）。
        let sentEastM = 0;
        let sentNorthM = 0;
        let nextCenter: DioramaCenter | undefined;
        if (hasPan) {
            sentEastM = pendingEastM;
            sentNorthM = pendingNorthM;
            nextCenter = offsetToLatLon(currentCenter, sentEastM, sentNorthM);
            patch.center = nextCenter;
            pendingEastM = 0;
            pendingNorthM = 0;
        }
        let sentFootprintHalfSizeM: number | undefined;
        if (hasZoom) {
            sentFootprintHalfSizeM = currentFootprintHalfSizeM;
            patch.footprintHalfSizeM = sentFootprintHalfSizeM;
        }

        applying = true;
        dioramaTerrain
            .setView(patch)
            .then(
                () => {
                    if (nextCenter !== undefined) currentCenter = nextCenter;
                    if (sentFootprintHalfSizeM !== undefined) lastAppliedFootprintHalfSizeM = sentFootprintHalfSizeM;
                },
                (err: unknown) => {
                    console.error("[jpmap-terrain diorama demo] setView failed:", err);
                    // lastAppliedFootprintHalfSizeM は更新していないため、hasZoom判定により
                    // 次回のflushで自然に再送される。パン分は差し引いていた値を復元する。
                    pendingEastM += sentEastM;
                    pendingNorthM += sentNorthM;
                },
            )
            .finally(() => {
                applying = false;
            });
    };

    return {
        getCenter: () => currentCenter,
        getFootprintHalfSizeM: () => currentFootprintHalfSizeM,
        feedAxes: (panAxes: StickAxes, zoomAxisY: number, dtSeconds: number): void => {
            if (!(dtSeconds > 0)) return;

            const { eastM, northM } = computePanMetersFromStick(panAxes, dtSeconds, currentFootprintHalfSizeM);
            pendingEastM += eastM;
            pendingNorthM += northM;

            const factor = computeZoomFactorFromStick(zoomAxisY, dtSeconds);
            if (factor !== 1) {
                currentFootprintHalfSizeM = clampViewScaleM(currentFootprintHalfSizeM * factor);
            }

            flush();
        },
    };
};
