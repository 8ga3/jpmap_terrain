/**
 * 「いまDOM上で実際に押下されているポインタ」を追跡する共通ヘルパー。
 *
 * @remarks
 * Babylon.js の入力状態が実際の押下状態と食い違ったまま固着する不具合の対策
 * （`dioramaTouchSlotRecovery.ts`）で、「そのポインタは本当に押されているのか」
 * を判断するために用いる。判定材料としての再利用を想定し、対策本体とは
 * 分離している。
 *
 * **`pointerup` が届かない場合への備え**: 実機（Meta Quest Browser）では
 * `pointerup` が配送されないまま次の操作へ移る可能性がある。そこで、押下中で
 * ないことが確実に分かるイベント（`buttons === 0` を伴う `pointermove` /
 * `pointerover` / `pointerout`）も観測して追跡を補正する。`buttons` は
 * そのイベント時点で押されているボタンのビットマスクであり、`0` は
 * 「どのボタンも押されていない」ことを意味する。
 *
 * 監視は capture 段階で行うため、Babylon 自身のハンドラ（`<canvas>` 上の
 * bubble 段階）より先に呼ばれる。これにより、Babylon が処理を始める前に
 * 最新の押下状態を参照できる。
 */

/** 押下状態が更新された直後に呼ばれるコールバック。 */
export type PressedPointerListener = (event: PointerEvent) => void;

/** {@link createPressedPointerTracker} の戻り値。 */
export interface PressedPointerTracker {
    /** 現在DOM上で押下中の `pointerId` の集合（読み取り専用）。 */
    readonly pressedPointerIds: ReadonlySet<number>;
    /** 監視を解除する。 */
    dispose: () => void;
}

/** 押下状態を直接表すイベント種別。 */
const PRESS_EVENT_TYPES = ["pointerdown", "pointerup", "pointercancel"] as const;

/**
 * 押下状態の追跡を補正するための補助的なイベント種別。
 * `buttons === 0` の場合のみ「押されていない」と判断する。
 */
const RELEASE_HINT_EVENT_TYPES = ["pointermove", "pointerover", "pointerout"] as const;

/**
 * 押下中ポインタの追跡を開始する。
 *
 * @param listener 押下状態を更新した直後（capture段階）に呼ばれる。
 *   `pointerdown` の場合、呼ばれた時点で当該 `pointerId` は既に
 *   {@link PressedPointerTracker.pressedPointerIds} に含まれている。
 */
export const createPressedPointerTracker = (listener: PressedPointerListener): PressedPointerTracker => {
    const pressedPointerIds = new Set<number>();

    const onPressEvent = (event: Event): void => {
        const pointerEvent = event as PointerEvent;
        if (pointerEvent.type === "pointerdown") {
            pressedPointerIds.add(pointerEvent.pointerId);
        } else {
            pressedPointerIds.delete(pointerEvent.pointerId);
        }
        listener(pointerEvent);
    };

    const onReleaseHintEvent = (event: Event): void => {
        const pointerEvent = event as PointerEvent;
        if (pointerEvent.buttons !== 0) return;
        // 追跡内容が実際に変わったときだけ通知する（`pointermove` は大量に
        // 発生するため、無駄な後続処理を避ける）。
        if (!pressedPointerIds.delete(pointerEvent.pointerId)) return;
        listener(pointerEvent);
    };

    PRESS_EVENT_TYPES.forEach((type) => document.addEventListener(type, onPressEvent, { capture: true }));
    RELEASE_HINT_EVENT_TYPES.forEach((type) => document.addEventListener(type, onReleaseHintEvent, { capture: true }));

    return {
        pressedPointerIds,
        dispose: (): void => {
            PRESS_EVENT_TYPES.forEach((type) => document.removeEventListener(type, onPressEvent, { capture: true }));
            RELEASE_HINT_EVENT_TYPES.forEach((type) => document.removeEventListener(type, onReleaseHintEvent, { capture: true }));
            pressedPointerIds.clear();
        },
    };
};
