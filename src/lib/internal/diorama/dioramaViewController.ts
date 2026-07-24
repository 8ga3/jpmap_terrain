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
import type { DioramaTerrain } from "../../../terrain/diorama/dioramaTerrain";
import type { DioramaCenter } from "../../../terrain/diorama/dioramaGrid";
import { offsetToLatLon } from "../../../terrain/diorama/dioramaGrid";
import {
    computeDioramaPanMetersFromStick,
    computeFootprintHalfSizeFactorFromStick,
    clampFootprintHalfSizeM,
    type StickAxes,
} from "./dioramaControllerMapping";

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
    /**
     * 中心・フットプリント半辺長を明示的に設定する（ホストアプリからの
     * `JpmapDiorama.setCenter`/`setFootprintHalfSize`/`setView` 呼び出し用）。
     * `feedAxes` が基準にする内部状態（`getCenter`/`getFootprintHalfSizeM`）も
     * 合わせて更新するため、以後の継続入力（キーボード/タッチ/ARコントローラー）は
     * 新しい値を起点に動作する。失敗時は `dioramaTerrain.setView` の reject を
     * そのまま呼び出し元へ伝える（`feedAxes` 経由の継続入力と異なり、明示的な
     * 単発呼び出しのためエラーを握りつぶさない）。
     */
    setView(patch: { center?: DioramaCenter; footprintHalfSizeM?: number }): Promise<void>;
    /**
     * 中心・フットプリント半辺長が確定（`feedAxes`・`setView` いずれの経路でも）
     * した後に呼ばれるリスナーを登録する（`JpmapDiorama.onViewChange` が使う）。
     * @returns 購読解除関数。
     */
    onChange(listener: (center: DioramaCenter, footprintHalfSizeM: number) => void): () => void;
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
    let currentFootprintHalfSizeM = clampFootprintHalfSizeM(initialFootprintHalfSizeM);
    let lastAppliedFootprintHalfSizeM = currentFootprintHalfSizeM;

    let pendingEastM = 0;
    let pendingNorthM = 0;
    /**
     * 進行中の `dioramaTerrain.setView` 呼び出し（rebuild）。`feedAxes`（`flush()`
     * 経由）と明示的な `setView()` の双方がこれを共有し、いずれか一方が実行中は
     * 他方が新規リクエストを発行しないようにする（同時実行によるrebuildの競合を防ぐ）。
     * `null` なら現在実行中のリクエストが無いことを示す。
     */
    let inFlight: Promise<void> | null = null;

    const changeListeners: Array<(center: DioramaCenter, footprintHalfSizeM: number) => void> = [];
    const notifyChange = (): void => {
        for (const listener of changeListeners.slice()) {
            try {
                listener(currentCenter, currentFootprintHalfSizeM);
            } catch (err) {
                console.error("[jpmap-terrain diorama] onChange listener threw:", err);
            }
        }
    };

    /**
     * `dioramaTerrain.setView(patch)` を発行し、完了まで `inFlight` を占有する。
     * 呼び出し元（`flush()`/`setView()`）は返り値の Promise へ個別に
     * 成功/失敗ハンドラを付与できる（`inFlight` 自体は排他制御専用で、
     * reject をそのまま伝播させても他の `.then()` の実行を妨げない）。
     */
    const startSetView = (patch: { center?: DioramaCenter; footprintHalfSizeM?: number }): Promise<void> => {
        const request = dioramaTerrain.setView(patch);
        inFlight = request.then(
            () => undefined,
            () => undefined,
        );
        inFlight.finally(() => {
            inFlight = null;
        });
        return request;
    };

    const flush = (): void => {
        if (inFlight) return;
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

        startSetView(patch).then(
            () => {
                if (nextCenter !== undefined) currentCenter = nextCenter;
                if (sentFootprintHalfSizeM !== undefined) lastAppliedFootprintHalfSizeM = sentFootprintHalfSizeM;
                notifyChange();
            },
            (err: unknown) => {
                console.error("[jpmap-terrain diorama] setView failed:", err);
                // lastAppliedFootprintHalfSizeM は更新していないため、hasZoom判定により
                // 次回のflushで自然に再送される。パン分は差し引いていた値を復元する。
                pendingEastM += sentEastM;
                pendingNorthM += sentNorthM;
            },
        );
    };

    return {
        getCenter: () => currentCenter,
        getFootprintHalfSizeM: () => currentFootprintHalfSizeM,
        feedAxes: (panAxes: StickAxes, zoomAxisY: number, dtSeconds: number): void => {
            if (!(dtSeconds > 0)) return;

            const { eastM, northM } = computeDioramaPanMetersFromStick(panAxes, dtSeconds, currentFootprintHalfSizeM);
            pendingEastM += eastM;
            pendingNorthM += northM;

            const factor = computeFootprintHalfSizeFactorFromStick(zoomAxisY, dtSeconds);
            if (factor !== 1) {
                currentFootprintHalfSizeM = clampFootprintHalfSizeM(currentFootprintHalfSizeM * factor);
            }

            flush();
        },
        setView: async (patch: { center?: DioramaCenter; footprintHalfSizeM?: number }): Promise<void> => {
            const resolvedPatch: { center?: DioramaCenter; footprintHalfSizeM?: number } = {};
            if (patch.center !== undefined) resolvedPatch.center = patch.center;
            if (patch.footprintHalfSizeM !== undefined) {
                resolvedPatch.footprintHalfSizeM = clampFootprintHalfSizeM(patch.footprintHalfSizeM);
            }
            // `flush()` 由来のrebuildが進行中であれば、まずその完了を待ってから
            // 自分のリクエストを発行する（`inFlight` を共有した直列化。冒頭コメント参照）。
            while (inFlight) {
                await inFlight;
            }
            await startSetView(resolvedPatch);
            if (resolvedPatch.center !== undefined) currentCenter = resolvedPatch.center;
            if (resolvedPatch.footprintHalfSizeM !== undefined) {
                currentFootprintHalfSizeM = resolvedPatch.footprintHalfSizeM;
                lastAppliedFootprintHalfSizeM = resolvedPatch.footprintHalfSizeM;
            }
            notifyChange();
        },
        onChange: (listener: (center: DioramaCenter, footprintHalfSizeM: number) => void): (() => void) => {
            changeListeners.push(listener);
            let removed = false;
            return (): void => {
                if (removed) return;
                removed = true;
                const idx = changeListeners.indexOf(listener);
                if (idx !== -1) changeListeners.splice(idx, 1);
            };
        },
    };
};
