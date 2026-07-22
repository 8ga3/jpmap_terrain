/**
 * diorama デモの操作GUI（オンスクリーン仮想ジョイスティック + ズーム/回転/高さボタン +
 * タイル種別切替/トップ復帰ボタン）。
 *
 * @remarks
 * 物理コントローラー・キーボードが無い環境（Androidスマホ等の画面タッチのみの
 * 環境）でも、地図移動・拡大縮小・箱庭回転・高さ変更・タイル種別切替・トップ復帰を
 * 操作できるようにする代替入力。「タッチ・ピンチ・スワイプだけでは操作の発見性・精度が
 * 不十分」という実機検証を踏まえ、常時可視の仮想ジョイスティック（ドラッグでパン方向・
 * 強度を指定）と、明示的なズーム/回転/高さ/タイル切替/リセットボタンをGUIとして提供する。
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
    /**
     * タイル種別切替ボタン（単発タップ）の押下イベントを購読する。
     * ジョイスティック/ズーム等（押しっぱなし＝継続入力）とは異なり、ボタン要素の
     * 標準 `click` イベント（ポインタ・キーボード操作の双方で発火）1回につき
     * 1回だけ `callback` を呼ぶ。
     * @returns 購読解除関数。
     */
    onTileModeCyclePress(callback: () => void): () => void;
    /**
     * トップ復帰ボタン（単発タップ）の押下イベントを購読する。
     * {@link onTileModeCyclePress} と同じ単発トリガーの規約。
     * @returns 購読解除関数。
     */
    onResetToInitialPress(callback: () => void): () => void;
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
        // テキストグリフ（⟲⟳▲▼等）・SVGアイコンのいずれも中央揃えにする
        // （SVGはinline要素でベースライン基準の配置になりがちで、flex centeringが
        // 無いと縦位置が微妙にずれるため）。
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    } satisfies Partial<CSSStyleDeclaration>);
};

/**
 * タイル種別切替ボタンのアイコン（重なった2枚の菱形＝「レイヤー切替」を表す、
 * 地図アプリ等で一般的なピクトグラムの自作版）。
 *
 * @remarks
 * 絵文字（🌐等）はプラットフォームごとに色・デザインが異なり、他のボタン
 * （⟲⟳▲▼⌂、いずれもシステムフォントのモノクロ記号）と見た目の一貫性が
 * 崩れるため使わない。特定のアイコンフォント/アイコンセットの成果物を
 * 流用するのではなく、シンプルな幾何学形状（菱形2つ）から自前でSVGを組み立て、
 * どの環境でも同じ見た目になるようにする。
 *
 * 手前の菱形は塗りつぶし（`fill="#fff"`）にし、奥の2枚目は輪郭線が手前の菱形と
 * 重ならない範囲（下側から覗く山形部分のみ）だけを描く。座標は、手前の菱形の
 * 外形線と奥の山形の線分が一切交差しないように計算済み（両図形の境界を数式で
 * 検証し、下側・左右にはみ出す部分のみを描画する設計）。単純に2枚の菱形の
 * 輪郭線同士を重ねると交差線に見えてしまい「手前が奥を隠す」重なりに見えない
 * ため、この設計にしている。
 *
 * 隣接する「⌂」（トップ復帰）ボタンとの縦方向のバランスは、本アイコンの形状を
 * 変える（菱形を扁平でなくする）のではなく、`RESET_ICON_FONT_SIZE`で「⌂」側の
 * フォントサイズを大きくすることで調整する（{@link createTopCenterButtons}参照）。
 */
const TILE_MODE_ICON_SVG = `
<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M4.5,12.5 L12,19 L19.5,12.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <polygon points="12,2 22,9 12,16 2,9" fill="#fff"/>
</svg>`.trim();

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
 *
 * @param onActiveChange このボタンの押下状態が変化するたびに呼ばれる
 *   （`true`=押下開始、`false`=押下終了）。呼び出し元（`createHoldButtonGroup`）が
 *   グループ内の他ボタンの押下状態と合算し、最終的な軸値を算出する。
 */
const bindHoldButton = (
    button: HTMLButtonElement,
    onActiveChange: (active: boolean) => void,
): Array<{ el: HTMLElement; type: string; fn: EventListener }> => {
    const entries: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];
    const bind = (el: HTMLElement, type: string, fn: EventListener): void => {
        el.addEventListener(type, fn);
        entries.push({ el, type, fn });
    };

    // 複数指（複数pointerId）が絡んだ場合に、片方の pointerup/pointercancel で
    // このボタン自身の押下状態が誤って解除されないよう、最初に押下したpointerIdの
    // みを追跡し、一致しないpointerIdのup/cancelは無視する。
    let activePointerId: number | null = null;
    bind(button, "pointerdown", (event) => {
        const pointerId = (event as PointerEvent).pointerId;
        if (activePointerId !== null) return;
        activePointerId = pointerId;
        // ジョイスティックと同様、ポインタキャプチャで固定する。ボタン外へ指が
        // 出た状態で離しても pointerup/pointercancel を確実にこのボタンで受け取れる
        // ようにし、「押しっぱなし」のまま解除漏れになるのを防ぐ。
        // jsdom（テスト環境）は `setPointerCapture` 未実装のため任意呼び出しにする。
        button.setPointerCapture?.(pointerId);
        onActiveChange(true);
    });
    const onPointerEnd = (event: PointerEvent): void => {
        if (event.pointerId !== activePointerId) return;
        activePointerId = null;
        onActiveChange(false);
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
        onActiveChange(true);
    }) as EventListener;
    const onKeyUp = ((event: KeyboardEvent) => {
        if (!isActivationKey(event.key)) return;
        onActiveChange(false);
    }) as EventListener;
    bind(button, "keydown", onKeyDown);
    bind(button, "keyup", onKeyUp);
    // フォーカスを失った際に押しっぱなし扱いのまま残らないようにする
    // （keyupを取りこぼすケース、例: 押下中にTab/クリックで別要素へ移動した場合）。
    bind(button, "blur", () => onActiveChange(false));

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

/** [-1,1] へクランプする（想定外にホールドボタンの合算軸値が範囲を超えないようにする）。 */
const clampAxis = (v: number): number => Math.max(-1, Math.min(1, v));

/**
 * 縦に並んだ2つのホールドボタン（押している間だけ軸値を持ち、離すと0に戻る）を
 * 生成する共通ファクトリ。ズーム・回転・高さ変更ボタンはいずれも
 * 「符号の異なる2ボタンで単一の軸値[-1,1]を共有する」という同じ構造のため、
 * 配置（`position`）とボタン仕様（`buttons`）のみを差し替えて再利用する。
 *
 * @remarks
 * 各ボタンの押下状態は互いに独立して管理し（`activeStates`）、軸値は
 * 「現在押下中の全ボタンのaxisValueの合計」として毎回算出する。以前は
 * 2ボタンで単一の `axis` 変数を共有方式（後勝ち・単純代入）だったため、
 * 複数指で「+」を押したまま別指で「−」を押してから「−」だけ離すと、
 * 「−」側のpointerup処理が軸を無条件に0へ戻してしまい、「+」を押し続けて
 * いるにも関わらず入力が止まる不具合があった（実機のマルチタッチ操作で
 * 発生し得る）。ボタンごとに独立した押下状態を保持し合算する方式に変更する
 * ことで、他方のボタンの押下状態を破壊しないようにした。
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

    // ボタンごとの押下状態（インデックス対応）。
    const activeStates: boolean[] = buttons.map(() => false);
    let axis = 0;
    const recomputeAxis = (): void => {
        let sum = 0;
        buttons.forEach((spec, i) => {
            if (activeStates[i]) sum += spec.axisValue;
        });
        axis = clampAxis(sum);
    };

    const listeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

    buttons.forEach((spec, i) => {
        const button = document.createElement("button");
        styleHudButton(button);
        button.textContent = spec.label;
        button.setAttribute("aria-label", spec.ariaLabel);
        listeners.push(
            ...bindHoldButton(button, (active) => {
                activeStates[i] = active;
                recomputeAxis();
            }),
        );
        container.appendChild(button);
    });

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
 * 単発（タップ/クリック）ボタン1個を生成する。押しっぱなし入力のズーム/回転/高さ
 * ボタン（{@link createHoldButtonGroup}）とは異なり、押した瞬間に1回だけ実行される
 * 操作（タイル種別切替・表示リセット）に使う。button要素のネイティブ `click`
 * イベントはポインタ操作・キーボード操作（Enter/Space）の両方で発火するため、
 * `bindHoldButton` のような独自のキーボードハンドリングは不要。
 */
const createTapButton = (spec: {
    /** ボタンに表示するテキスト（`iconHtml`未指定時に使用）。 */
    label?: string;
    /**
     * ボタンに表示するアイコンのSVGマークアップ（指定時は`label`より優先）。
     * プラットフォーム依存の絵文字ではなく、自前のSVGでモノクロアイコンを
     * 描画したい場合に使う（{@link TILE_MODE_ICON_SVG}参照）。
     */
    iconHtml?: string;
    ariaLabel: string;
    /**
     * `label`使用時のフォントサイズ上書き（既定は`styleHudButton`の20px）。
     * グリフごとの見た目の大きさ（インク量）は文字種によって異なるため、
     * 隣接するボタンとの視覚的なバランスを取るために使う
     * （{@link RESET_ICON_FONT_SIZE}参照）。
     */
    fontSize?: string;
}): { element: HTMLButtonElement; onPress: (callback: () => void) => () => void; dispose: () => void } => {
    const button = document.createElement("button");
    styleHudButton(button);
    if (spec.iconHtml !== undefined) {
        button.innerHTML = spec.iconHtml;
    } else {
        button.textContent = spec.label ?? "";
    }
    if (spec.fontSize !== undefined) {
        button.style.fontSize = spec.fontSize;
    }
    button.setAttribute("aria-label", spec.ariaLabel);

    const callbacks = new Set<() => void>();
    const onClick = (): void => {
        callbacks.forEach((callback) => callback());
    };
    button.addEventListener("click", onClick);

    return {
        element: button,
        onPress: (callback: () => void): (() => void) => {
            callbacks.add(callback);
            return () => callbacks.delete(callback);
        },
        dispose: (): void => {
            button.removeEventListener("click", onClick);
            callbacks.clear();
        },
    };
};

/**
 * トップ復帰ボタン（「⌂」文字グリフ）のフォントサイズ。
 *
 * @remarks
 * 隣接するタイル種別切替ボタン（自作SVGアイコン、{@link TILE_MODE_ICON_SVG}）と
 * 並べたとき、「⌂」は既定のボタン共通フォントサイズ（20px）では他の記号
 * （▲▼⟲⟳）と比べてインク量（実際に塗られる面積）が少なく縦方向の存在感が
 * 乏しく見え、ボタン間のバランスが悪いことを実機確認で確認した
 * （フォントサイズ20pxでの実測インク高さ: 「⌂」約11px、タイル切替アイコンの
 * 菱形部分は幅18px×高さ13px）。アイコンの形自体は変えず、「⌂」側の
 * フォントサイズのみを大きくして視覚的なバランスを取る。
 */
const RESET_ICON_FONT_SIZE = "28px";

/**
 * タイル種別切替・トップ復帰ボタンを横並びで作成する。画面上部中央
 * （左上の `back-link`（`public/diorama.html`）・右上のARボタンの間の空き
 * スペース）に配置し、既存のUI要素と重ならないようにする。
 */
const createTopCenterButtons = (): {
    element: HTMLElement;
    tileModeButton: ReturnType<typeof createTapButton>;
    resetButton: ReturnType<typeof createTapButton>;
    dispose: () => void;
} => {
    const container = document.createElement("div");
    Object.assign(container.style, {
        position: "absolute",
        top: "12px",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: "10px",
        pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);

    const tileModeButton = createTapButton({
        iconHtml: TILE_MODE_ICON_SVG,
        ariaLabel: "地図の種類を切り替え（標準地図・写真・ワイヤーフレーム）",
    });
    const resetButton = createTapButton({
        label: "⌂",
        ariaLabel: "表示を初期状態に戻す（中心・拡大率・回転・高さ）",
        fontSize: RESET_ICON_FONT_SIZE,
    });
    container.appendChild(tileModeButton.element);
    container.appendChild(resetButton.element);

    return {
        element: container,
        tileModeButton,
        resetButton,
        dispose: (): void => {
            tileModeButton.dispose();
            resetButton.dispose();
        },
    };
};

/**
 * diorama 操作GUI（仮想ジョイスティック + ズーム/回転/高さボタン + タイル種別切替/
 * トップ復帰ボタン）を生成する。AR中は返り値の `element` を呼び出し元
 * （`webXrArSession.ts`）が `dom-overlay` feature へ渡す。AR非対応環境・AR突入前の
 * 通常表示でも同じGUIを常時マウントし、タッチ操作だけで地図移動・拡大縮小・
 * 箱庭回転・高さ変更・タイル種別切替・トップ復帰ができるようにする
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
    const topCenterButtons = createTopCenterButtons();
    root.appendChild(joystick.element);
    root.appendChild(zoomButtons.element);
    root.appendChild(rotateButtons.element);
    root.appendChild(heightButtons.element);
    root.appendChild(topCenterButtons.element);

    return {
        element: root,
        getPanAxes: () => joystick.getAxes(),
        getZoomAxis: () => zoomButtons.getAxis(),
        getRotationAxis: () => rotateButtons.getAxis(),
        getHeightAxis: () => heightButtons.getAxis(),
        onTileModeCyclePress: (callback: () => void): (() => void) => topCenterButtons.tileModeButton.onPress(callback),
        onResetToInitialPress: (callback: () => void): (() => void) => topCenterButtons.resetButton.onPress(callback),
        dispose: () => {
            joystick.dispose();
            zoomButtons.dispose();
            rotateButtons.dispose();
            heightButtons.dispose();
            topCenterButtons.dispose();
            root.remove();
        },
    };
};
