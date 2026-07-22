/**
 * diorama デモの操作GUI（オンスクリーン仮想ジョイスティック + ズーム/回転/高さボタン）。
 *
 * @remarks
 * 物理コントローラー・キーボードが無い環境（Androidスマホ等の画面タッチのみの
 * 環境）でも、地図移動・拡大縮小・箱庭回転・高さ変更を操作できるようにする
 * 代替入力。「タッチ・ピンチ・スワイプだけでは操作の発見性・精度が不十分」という
 * 実機検証を踏まえ、常時可視の仮想ジョイスティック（ドラッグでパン方向・強度を
 * 指定）と、明示的なズーム/回転/高さボタンをGUIとして提供する。
 *
 * WebXR (`immersive-ar`) 中は `dom-overlay` feature（`webXrArSession.ts` 側で
 * 有効化）と組み合わせ、没入セッション中も本HUDの `element` を画面上に表示し
 * 続けられる。AR非対応環境・AR突入前の通常表示でも同じHUDを常時マウントし、
 * 同じGUIで操作できるようにする（`dioramaTouchControls.ts` 参照）。
 *
 * DOM/ポインタイベントのみに依存し、Babylon.js/WebXRには依存しないため
 * jsdom上で単体テスト可能。
 *
 * 操作割り当ての全体像は {@link module:src/demos/diorama/dioramaControllerMapping.ts}
 * 冒頭コメント参照。
 */
import type { StickAxes } from "./dioramaControllerMapping";

/** 仮想ジョイスティックの外径・つまみ径[px]。 */
const JOYSTICK_OUTER_DIAMETER_PX = 96;
const JOYSTICK_KNOB_DIAMETER_PX = 40;

/** ジョイスティックのつまみが動ける最大半径[px]（外径の半分からつまみ半径を引いた値）。 */
const JOYSTICK_MAX_KNOB_OFFSET_PX = (JOYSTICK_OUTER_DIAMETER_PX - JOYSTICK_KNOB_DIAMETER_PX) / 2;

export interface DioramaArControlHud {
    /** `dom-overlay` feature の `element` オプションに渡す実体。 */
    element: HTMLElement;
    /** 現在の仮想ジョイスティック入力（ドラッグしていない間は `{x:0, y:0}`）。 */
    getPanAxes(): StickAxes;
    /** 現在のズーム軸値（「+」ボタン押下中は -1、「-」ボタン押下中は +1、それ以外は 0）。 */
    getZoomAxis(): number;
    /**
     * 現在の回転軸値（[-1,1]）。「⟳」（時計回り）ボタン押下中は +1、
     * 「⟲」（反時計回り）ボタン押下中は -1、それ以外は 0。
     * `computeDioramaRotationRadFromStick` の軸規約（正入力=正方向の回転）に合わせる。
     */
    getRotationAxis(): number;
    /**
     * 現在の高さ変更軸値（[-1,1]）。「▲」（上昇）ボタン押下中は +1、
     * 「▼」（下降）ボタン押下中は -1、それ以外は 0。呼び出し側で
     * `computeDioramaHeightMetersFromTriggers` の左右トリガー引数
     * （`rightTriggerValue = max(0, axis)`、`leftTriggerValue = max(0, -axis)`）へ変換する。
     */
    getHeightAxis(): number;
    /** HUDのDOM要素を破棄し、登録したイベントリスナーを解放する。 */
    dispose(): void;
}

/** ボタン共通のスタイル。 */
const styleHudButton = (button: HTMLButtonElement): void => {
    Object.assign(button.style, {
        width: "48px",
        height: "48px",
        borderRadius: "24px",
        border: "none",
        background: "rgba(9,18,32,0.72)",
        color: "#fff",
        fontSize: "20px",
        fontWeight: "700",
        cursor: "pointer",
        touchAction: "none",
        userSelect: "none",
    } satisfies Partial<CSSStyleDeclaration>);
};

/**
 * 仮想ジョイスティック（ドラッグでパン方向・強度を指定するGUI）を作成する。
 * つまみの中心からのドラッグ量を外径半径で正規化し、[-1,1] の2軸へ変換する。
 */
const createJoystick = (): { element: HTMLElement; getAxes: () => StickAxes; dispose: () => void } => {
    const outer = document.createElement("div");
    Object.assign(outer.style, {
        position: "absolute",
        left: "16px",
        bottom: "16px",
        width: `${JOYSTICK_OUTER_DIAMETER_PX}px`,
        height: `${JOYSTICK_OUTER_DIAMETER_PX}px`,
        borderRadius: "50%",
        background: "rgba(9,18,32,0.45)",
        border: "1px solid rgba(255,255,255,0.3)",
        touchAction: "none",
        pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);

    const knob = document.createElement("div");
    Object.assign(knob.style, {
        position: "absolute",
        left: `${(JOYSTICK_OUTER_DIAMETER_PX - JOYSTICK_KNOB_DIAMETER_PX) / 2}px`,
        top: `${(JOYSTICK_OUTER_DIAMETER_PX - JOYSTICK_KNOB_DIAMETER_PX) / 2}px`,
        width: `${JOYSTICK_KNOB_DIAMETER_PX}px`,
        height: `${JOYSTICK_KNOB_DIAMETER_PX}px`,
        borderRadius: "50%",
        background: "rgba(255,255,255,0.85)",
        pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    outer.appendChild(knob);

    let axes: StickAxes = { x: 0, y: 0 };
    let activePointerId: number | null = null;

    const setKnobOffset = (offsetX: number, offsetY: number): void => {
        knob.style.left = `${(JOYSTICK_OUTER_DIAMETER_PX - JOYSTICK_KNOB_DIAMETER_PX) / 2 + offsetX}px`;
        knob.style.top = `${(JOYSTICK_OUTER_DIAMETER_PX - JOYSTICK_KNOB_DIAMETER_PX) / 2 + offsetY}px`;
    };

    const resetKnob = (): void => {
        axes = { x: 0, y: 0 };
        setKnobOffset(0, 0);
    };

    const updateFromClientPoint = (clientX: number, clientY: number): void => {
        const rect = outer.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        let dx = clientX - centerX;
        let dy = clientY - centerY;
        const dist = Math.hypot(dx, dy);
        if (dist > JOYSTICK_MAX_KNOB_OFFSET_PX) {
            const scale = JOYSTICK_MAX_KNOB_OFFSET_PX / dist;
            dx *= scale;
            dy *= scale;
        }
        setKnobOffset(dx, dy);
        // 画面座標は下方向が正だが、スティック規約は前方向（上へドラッグ）が負値のyにする。
        axes = { x: dx / JOYSTICK_MAX_KNOB_OFFSET_PX, y: dy / JOYSTICK_MAX_KNOB_OFFSET_PX };
    };

    const onPointerDown = (event: PointerEvent): void => {
        if (activePointerId !== null) return;
        activePointerId = event.pointerId;
        // jsdom（テスト環境）は `setPointerCapture` を実装していないため任意呼び出しにする
        // （実ブラウザでは、ジョイスティック外へ指が出てもドラッグを継続するために必要）。
        outer.setPointerCapture?.(event.pointerId);
        updateFromClientPoint(event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent): void => {
        if (event.pointerId !== activePointerId) return;
        updateFromClientPoint(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent): void => {
        if (event.pointerId !== activePointerId) return;
        activePointerId = null;
        resetKnob();
    };

    outer.addEventListener("pointerdown", onPointerDown);
    outer.addEventListener("pointermove", onPointerMove);
    outer.addEventListener("pointerup", onPointerUp);
    outer.addEventListener("pointercancel", onPointerUp);

    return {
        element: outer,
        getAxes: () => axes,
        dispose: () => {
            outer.removeEventListener("pointerdown", onPointerDown);
            outer.removeEventListener("pointermove", onPointerMove);
            outer.removeEventListener("pointerup", onPointerUp);
            outer.removeEventListener("pointercancel", onPointerUp);
        },
    };
};

/**
 * ズームボタン1個分の「押している間だけ有効」入力を pointer/keyboard 両方に
 * バインドする。キーボード操作（Tabフォーカス+Enter/Space）でも同じ押しっぱなし
 * 挙動にすることで、コントローラー/タッチが使えない環境でもズームできるようにする
 * （アクセシビリティ対応）。
 * @param setAxis     軸値の設定関数（`() => (axis = value)` 相当）。
 * @param pressedAxis 押下中に設定する軸値（「+」= -1、「-」= +1）。
 */
const bindHoldButton = (
    button: HTMLButtonElement,
    setAxis: (axis: number) => void,
    pressedAxis: number,
): Array<{ el: HTMLElement; type: string; fn: EventListener }> => {
    const entries: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];
    const bind = (el: HTMLElement, type: string, fn: EventListener): void => {
        el.addEventListener(type, fn);
        entries.push({ el, type, fn });
    };

    // 複数指（複数pointerId）が絡んだ場合に、片方の pointerup/pointercancel で
    // 軸が0に戻ってしまう（押し続けているのにズームが止まる）のを防ぐため、
    // ジョイスティックと同様に最初に押下したpointerIdのみを追跡し、
    // 一致しないpointerIdのup/cancelは無視する。
    let activePointerId: number | null = null;
    bind(button, "pointerdown", (event) => {
        const pointerId = (event as PointerEvent).pointerId;
        if (activePointerId !== null) return;
        activePointerId = pointerId;
        // ジョイスティックと同様、ポインタキャプチャで固定する。ボタン外へ指が
        // 出た状態で離しても pointerup/pointercancel を確実にこのボタンで受け取れる
        // ようにし、「押しっぱなし」のままズーム軸が残り続けるのを防ぐ。
        // jsdom（テスト環境）は `setPointerCapture` 未実装のため任意呼び出しにする。
        button.setPointerCapture?.(pointerId);
        setAxis(pressedAxis);
    });
    const onPointerEnd = (event: PointerEvent): void => {
        if (event.pointerId !== activePointerId) return;
        activePointerId = null;
        setAxis(0);
    };
    bind(button, "pointerup", onPointerEnd as EventListener);
    bind(button, "pointercancel", onPointerEnd as EventListener);

    const isActivationKey = (key: string): boolean => key === "Enter" || key === " ";
    const onKeyDown = ((event: KeyboardEvent) => {
        if (!isActivationKey(event.key)) return;
        // キーリピートで再入しても実害はないが、余分な処理を避けるため無視する。
        if (event.repeat) return;
        // スペースキーの既定動作（ページスクロール）を防ぐ。
        event.preventDefault();
        setAxis(pressedAxis);
    }) as EventListener;
    const onKeyUp = ((event: KeyboardEvent) => {
        if (!isActivationKey(event.key)) return;
        setAxis(0);
    }) as EventListener;
    bind(button, "keydown", onKeyDown);
    bind(button, "keyup", onKeyUp);
    // フォーカスを失った際に押しっぱなし扱いのまま残らないようにする
    // （keyupを取りこぼすケース、例: 押下中にTab/クリックで別要素へ移動した場合）。
    bind(button, "blur", () => setAxis(0));

    return entries;
};

/**
 * ホールドボタン1個分の仕様（ラベル・aria-label・押下中に設定する軸値）。
 */
interface HoldButtonSpec {
    label: string;
    ariaLabel: string;
    /** 押下中に設定する軸値。 */
    axisValue: number;
}

/**
 * 縦に並んだ2つのホールドボタン（押している間だけ軸値を持ち、離すと0に戻る）を
 * 生成する共通ファクトリ。ズーム・回転・高さ変更ボタンはいずれも
 * 「符号の異なる2ボタンで単一の軸値[-1,1]を共有する」という同じ構造のため、
 * 配置（`position`）とボタン仕様（`buttons`）のみを差し替えて再利用する。
 */
const createHoldButtonGroup = (
    position: Partial<CSSStyleDeclaration>,
    buttons: readonly [HoldButtonSpec, HoldButtonSpec],
): { element: HTMLElement; getAxis: () => number; dispose: () => void } => {
    const container = document.createElement("div");
    Object.assign(container.style, {
        position: "absolute",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        pointerEvents: "auto",
        ...position,
    } satisfies Partial<CSSStyleDeclaration>);

    let axis = 0;
    const setAxis = (value: number): void => {
        axis = value;
    };
    const listeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

    for (const spec of buttons) {
        const button = document.createElement("button");
        styleHudButton(button);
        button.textContent = spec.label;
        button.setAttribute("aria-label", spec.ariaLabel);
        listeners.push(...bindHoldButton(button, setAxis, spec.axisValue));
        container.appendChild(button);
    }

    return {
        element: container,
        getAxis: () => axis,
        dispose: () => {
            listeners.forEach(({ el, type, fn }) => el.removeEventListener(type, fn));
        },
    };
};

/**
 * ズームボタン（+/-）を作成する。押している間だけ軸値を持ち、離すと0に戻る
 * （ジョイスティックと同様、継続的な入力として扱えるようにするため）。
 * 画面右下に配置する。
 */
const createZoomButtons = (): { element: HTMLElement; getAxis: () => number; dispose: () => void } =>
    // 「+」= ズームイン（フットプリント半径を縮める）= スティック規約の前方向 = 負の軸値。
    createHoldButtonGroup({ right: "16px", bottom: "16px" }, [
        { label: "+", ariaLabel: "ズームイン", axisValue: -1 },
        { label: "−", ariaLabel: "ズームアウト", axisValue: 1 },
    ]);

/**
 * 箱庭回転ボタン（⟲/⟳）を作成する。画面右上（ARボタンの下）に配置し、
 * ARボタンや `back-link`（`public/diorama.html`）と重ならないようにする。
 */
const createRotateButtons = (): { element: HTMLElement; getAxis: () => number; dispose: () => void } =>
    createHoldButtonGroup({ right: "16px", top: "64px" }, [
        { label: "⟲", ariaLabel: "反時計回りに回転", axisValue: -1 },
        { label: "⟳", ariaLabel: "時計回りに回転", axisValue: 1 },
    ]);

/**
 * 箱庭の設置高さ変更ボタン（▲/▼）を作成する。画面左上（`back-link` の下）に
 * 配置し、他のUI要素と重ならないようにする。
 */
const createHeightButtons = (): { element: HTMLElement; getAxis: () => number; dispose: () => void } =>
    createHoldButtonGroup({ left: "16px", top: "56px" }, [
        { label: "▲", ariaLabel: "高さを上げる", axisValue: 1 },
        { label: "▼", ariaLabel: "高さを下げる", axisValue: -1 },
    ]);

/**
 * diorama 操作GUI（仮想ジョイスティック + ズーム/回転/高さボタン）を生成する。
 * AR中は返り値の `element` を呼び出し元（`webXrArSession.ts`）が `dom-overlay`
 * feature へ渡す。AR非対応環境・AR突入前の通常表示でも同じGUIを常時マウントし、
 * タッチ操作だけで地図移動・拡大縮小・箱庭回転・高さ変更ができるようにする
 * （物理コントローラー・キーボードが無いAndroidスマホ等での操作導線を確保する目的。
 * `dioramaTouchControls.ts` 参照）。
 */
export const createDioramaArControlHud = (): DioramaArControlHud => {
    const root = document.createElement("div");
    Object.assign(root.style, {
        position: "absolute",
        inset: "0",
        // 子要素（ジョイスティック・ボタン）のみがタッチを受け付け、それ以外の領域は
        // 素通しにして背後のパススルー映像・箱庭を隠さない/操作を妨げないようにする。
        pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);

    const joystick = createJoystick();
    const zoomButtons = createZoomButtons();
    const rotateButtons = createRotateButtons();
    const heightButtons = createHeightButtons();
    root.appendChild(joystick.element);
    root.appendChild(zoomButtons.element);
    root.appendChild(rotateButtons.element);
    root.appendChild(heightButtons.element);

    return {
        element: root,
        getPanAxes: () => joystick.getAxes(),
        getZoomAxis: () => zoomButtons.getAxis(),
        getRotationAxis: () => rotateButtons.getAxis(),
        getHeightAxis: () => heightButtons.getAxis(),
        dispose: () => {
            joystick.dispose();
            zoomButtons.dispose();
            rotateButtons.dispose();
            heightButtons.dispose();
            root.remove();
        },
    };
};
