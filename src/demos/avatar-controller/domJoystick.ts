/**
 * 画面左下に配置する小型タッチジョイスティック。
 *
 * Babylon.js の `VirtualJoystick` は canvas が画面全体を覆ってしまい、
 * 他の Babylon canvas（地形クリック等）に対するマウス操作を奪うため、
 * このデモでは DOM 要素ベースの軽量ジョイスティックを使う。
 *
 * - container 内 (`pointer-events: auto`) のみ入力を受け付ける
 * - container 外（マップ等）の pointer events は素通しする
 * - 正規化された (vx, vy) を読み出せる（vx: 右=+1, vy: 上=+1）
 */

export interface DomJoystickOptions {
    /** 親要素。デフォルトは document.body */
    parent?: HTMLElement;
    /** コンテナ（背景円）の直径 px。default 120 */
    containerSize?: number;
    /** スティック（つまみ）の直径 px。default 50 */
    puckSize?: number;
    /** 左端からのオフセット px。default 24 */
    leftOffset?: number;
    /** 下端からのオフセット px。default 24 */
    bottomOffset?: number;
    /** 色 */
    color?: string;
}

export interface DomJoystickValue {
    /** 右方向 +1 .. 左方向 -1 */
    vx: number;
    /** 上方向 +1 .. 下方向 -1 */
    vy: number;
}

export interface DomJoystick {
    /** 現在の正規化入力値（押下されていなければ {0,0}） */
    readonly value: DomJoystickValue;
    /** 押下中か */
    readonly pressed: boolean;
    /** 後始末（DOM 削除・listener 解除） */
    dispose(): void;
}

export const createDomJoystick = (
    opts: DomJoystickOptions = {},
): DomJoystick => {
    const parent = opts.parent ?? document.body;
    const containerSize = opts.containerSize ?? 120;
    const puckSize = opts.puckSize ?? 50;
    const leftOffset = opts.leftOffset ?? 24;
    const bottomOffset = opts.bottomOffset ?? 24;
    const color = opts.color ?? "#4af";
    const maxOffset = (containerSize - puckSize) / 2;

    const container = document.createElement("div");
    container.className = "dom-joystick";
    Object.assign(container.style, {
        position: "absolute",
        left: `${leftOffset}px`,
        bottom: `${bottomOffset}px`,
        width: `${containerSize}px`,
        height: `${containerSize}px`,
        borderRadius: "50%",
        background: "rgba(0, 0, 0, 0.25)",
        border: `1px solid ${color}`,
        boxShadow: "0 0 6px rgba(0, 0, 0, 0.35)",
        zIndex: "20",
        touchAction: "none",
        // 親要素 (#avatar-overlay 等) で pointer-events: none が指定されていても
        // この要素だけは受け取る。
        pointerEvents: "auto",
        userSelect: "none",
        webkitUserSelect: "none",
    } as Partial<CSSStyleDeclaration>);

    const puck = document.createElement("div");
    Object.assign(puck.style, {
        position: "absolute",
        left: `${(containerSize - puckSize) / 2}px`,
        top: `${(containerSize - puckSize) / 2}px`,
        width: `${puckSize}px`,
        height: `${puckSize}px`,
        borderRadius: "50%",
        background: color,
        opacity: "0.85",
        pointerEvents: "none",
        transform: "translate(0px, 0px)",
    } as Partial<CSSStyleDeclaration>);
    container.appendChild(puck);
    parent.appendChild(container);

    const state = {
        pressed: false,
        pointerId: null as number | null,
        value: { vx: 0, vy: 0 } as DomJoystickValue,
    };

    const setPuck = (dx: number, dy: number): void => {
        puck.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const reset = (): void => {
        state.pressed = false;
        state.pointerId = null;
        state.value = { vx: 0, vy: 0 };
        setPuck(0, 0);
    };

    const onPointerDown = (e: PointerEvent): void => {
        if (state.pointerId !== null) return;
        state.pointerId = e.pointerId;
        state.pressed = true;
        container.setPointerCapture(e.pointerId);
        update(e);
        e.preventDefault();
    };

    const update = (e: PointerEvent): void => {
        const rect = container.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = e.clientX - cx;
        let dy = e.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxOffset) {
            dx = (dx / dist) * maxOffset;
            dy = (dy / dist) * maxOffset;
        }
        setPuck(dx, dy);
        state.value = {
            vx: dx / maxOffset,
            // 画面 Y は下方向で +、ジョイスティック値は上=+1 にしたいので反転
            vy: -dy / maxOffset,
        };
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (e.pointerId !== state.pointerId) return;
        update(e);
        e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent): void => {
        if (e.pointerId !== state.pointerId) return;
        try {
            container.releasePointerCapture(e.pointerId);
        } catch {
            /* noop */
        }
        reset();
        e.preventDefault();
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);
    container.addEventListener("lostpointercapture", () => {
        reset();
    });

    return {
        get value(): DomJoystickValue {
            return state.value;
        },
        get pressed(): boolean {
            return state.pressed;
        },
        dispose(): void {
            container.removeEventListener("pointerdown", onPointerDown);
            container.removeEventListener("pointermove", onPointerMove);
            container.removeEventListener("pointerup", onPointerUp);
            container.removeEventListener("pointercancel", onPointerUp);
            container.remove();
        },
    };
};
