/**
 * Babylon.js のタッチ入力スロット枯渇により、`pointerdown` が丸ごと破棄されて
 * カメラ操作が効かなくなる不具合への対策。
 *
 * @remarks
 * ## 不具合の内容
 *
 * 実機（Meta Quest Browser）で、バーチャルジョイスティックなどを操作している
 * うちに「3D画面をドラッグしてもカメラが回転しなくなる」状態に陥る。何か
 * ボタンを押すと復帰する。左右のコントローラーで症状が独立して発生する。
 *
 * ## 原因
 *
 * Babylon の `WebDeviceInputSystem` は、タッチ（コントローラーのレイを含む）を
 * `navigator.maxTouchPoints` 個の固定スロット（`_activeTouchIds`）で管理する。
 * `pointerdown` 受信時に空きスロットが無いと、**イベントを処理せずそのまま
 * 破棄する**（`Tools.Warn` を出して `return`）。破棄された `pointerdown` は
 * `scene.onPointerObservable` まで到達しないため、カメラは一切反応せず、
 * 診断ログにも痕跡が残らない。実機ログで「回転できなかったドラッグだけ記録が
 * 無い」という観測結果と一致する。
 *
 * そしてスロットは以下の理由でリークする。
 *
 * - `_pointerMoveEvent` は、追跡していないタッチの**移動**に対しても空き
 *   スロットを割り当てる（押下前の `pointermove` を取りこぼさないための処理）。
 *   Meta Quest のコントローラーはレイを向けているだけで `pointermove` を
 *   発生させるため、**押していないのにスロットが確保される**。
 * - スロットを解放するのは `pointerup` / `pointercancel` の経路のみ。ホバーの
 *   移動で確保されたスロットには対応する `pointerup` が来ないため、
 *   **永久に解放されない**。
 * - ウィンドウの blur 時の後始末ですら、押下中（`LeftClick === 1`）の
 *   スロットしか解放しないため、ホバー由来のスロットは残り続ける。
 *
 * 結果、スロットが埋まった時点以降の `pointerdown` が破棄され続ける。左右の
 * コントローラーで独立に見えるのは、スロットを掴んだままの `pointerId` が
 * どちらのコントローラーのものかで挙動が変わるためである。
 *
 * ## 対策
 *
 * 「押されていないポインタがスロットを占有している」状態は常に誤りである。
 * そこで `pointerdown` を capture 段階（Babylon 自身のハンドラは `<canvas>` 上の
 * bubble 段階なので、必ずそれより先に動く）で観測し、**Babylon がイベントを
 * 破棄してしまう状況に限って**、押下中でないポインタが占有するスロットを
 * 解放する。解放は Babylon 自身の解放処理と同じく `-1` を代入するだけで、
 * ホバー由来のスロットは押下状態を保持していない（`LeftClick === 0`）ため、
 * 中途半端な押下状態が残ることもない。
 *
 * 空きスロットがある通常時は何もしないため、正常な操作（2本指のピンチ等）へ
 * 影響しない。
 *
 * ## 上流（Babylon.js）での修正状況
 *
 * 本件を Babylon.js フォーラムへ報告した結果、上流でも修正が取り込まれた
 * （`github.com/BabylonJS/Babylon.js/pull/18748`。`_pointerMoveEvent` で
 * `evt.buttons === 0` のときはスロットを確保しない、という本対策と同じ方針）。
 *
 * ただし 2026-08-04 時点の最新リリース `@babylonjs/core` 9.19.0 には**まだ
 * 含まれていない**（マージが 9.19.0 のリリース後だったため）。したがって
 * 本対策は現時点では引き続き必要である。
 *
 * **削除の判断**: 修正を含むバージョンへ更新したら、本モジュールと
 * `dioramaPressedPointerTracker.ts`、およびそれらのunit testは削除してよい。
 * 更新後、`node_modules/@babylonjs/core/DeviceInput/webDeviceInputSystem.js`
 * の `_pointerMoveEvent` に `evt.buttons === 0` の早期returnがあるかで、
 * 修正が入っているか判別できる。あわせて `package.json` の依存下限を
 * その版へ引き上げること（下限が古いままだと、修正前の版でも
 * インストールできてしまい不具合が再発するため）。
 *
 * なお、上流修正が入った版と本対策が同時に有効でも問題は起きない。
 * ホバーがスロットを確保しなくなる＝常に空きがある状態になり、
 * {@link reclaimTouchSlotsForPointer} は何もせず終了する。
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

import { createPressedPointerTracker } from "./dioramaPressedPointerTracker";

/**
 * Babylon の `WebDeviceInputSystem` のうち、本対策が参照するフィールド
 * （非公開のため、参照側で存在チェックを行う）。
 */
interface TouchSlotHolder {
    /** タッチスロット。各要素は占有中の `pointerId`、空きは `-1`。 */
    _activeTouchIds?: unknown;
}

/**
 * タッチスロットの配列を取得する。Babylon のバージョン差や未初期化で取得
 * できない場合は `null` を返す（呼び出し側は「何もしない」）。
 */
export const readActiveTouchIds = (engine: AbstractEngine): number[] | null => {
    try {
        const manager = (engine as unknown as Record<string, unknown>)["_deviceSourceManager"];
        const system = (manager as Record<string, unknown> | undefined)?.["_deviceInputSystem"] as
            | TouchSlotHolder
            | undefined;
        const slots = system?._activeTouchIds;
        if (!Array.isArray(slots)) return null;
        return slots as number[];
    } catch {
        return null;
    }
};

/** タッチスロットの空きを表す値（Babylon の実装に合わせる）。 */
const EMPTY_SLOT = -1;

/**
 * 新たに押下されたポインタのためのスロットを確保する。
 *
 * @remarks
 * Babylon が `pointerdown` を破棄してしまう状況（＝当該ポインタのスロットが
 * 無く、かつ空きスロットも無い）に限り、押下中でないポインタが占有している
 * スロットを解放する。それ以外の場合は一切変更しない。
 *
 * @param activeTouchIds タッチスロット（破壊的に更新する）。
 * @param pressedPointerIds 現在DOM上で実際に押下中の `pointerId` の集合。
 * @param pointerId これから Babylon が処理する `pointerdown` の `pointerId`。
 * @returns 解放したスロットが占有していた `pointerId` の一覧（解放しなければ空）。
 */
export const reclaimTouchSlotsForPointer = (
    activeTouchIds: number[],
    pressedPointerIds: ReadonlySet<number>,
    pointerId: number,
): number[] => {
    // 既にスロットを持っている、または空きがあるなら、Babylonは破棄しない。
    if (activeTouchIds.includes(pointerId)) return [];
    if (activeTouchIds.includes(EMPTY_SLOT)) return [];

    const reclaimed: number[] = [];
    for (let slot = 0; slot < activeTouchIds.length; slot += 1) {
        const occupant = activeTouchIds[slot];
        if (occupant === EMPTY_SLOT) continue;
        // 実際に押下中のポインタは、正当な操作（2本指のピンチ等）なので触らない。
        if (pressedPointerIds.has(occupant)) continue;
        activeTouchIds[slot] = EMPTY_SLOT;
        reclaimed.push(occupant);
    }
    return reclaimed;
};

/**
 * タッチスロット枯渇の自動回復をセットアップする。
 *
 * @param engine 対象エンジン。
 * @returns 後始末用の破棄関数。
 */
export const setupDioramaTouchSlotRecovery = (engine: AbstractEngine): (() => void) => {
    const tracker = createPressedPointerTracker((event) => {
        if (event.type !== "pointerdown") return;
        // Babylonはマウスを専用スロットで扱うため、タッチ（ペン含む）のみ対象。
        if (event.pointerType === "mouse") return;
        const activeTouchIds = readActiveTouchIds(engine);
        if (activeTouchIds === null) return;
        reclaimTouchSlotsForPointer(activeTouchIds, tracker.pressedPointerIds, event.pointerId);
    });

    return tracker.dispose;
};
