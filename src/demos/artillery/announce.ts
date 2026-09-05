/**
 * 中央ターン告知オーバーレイ
 *
 * ステージ名と攻撃ターン（RED / BLUE）を画面中央に表示する。
 * - 登場: フェードイン（小さく・ぼやけた状態から原寸・くっきりへ）
 * - 退場: ブラーしながら爆発するように拡大して消える
 *
 * 表示の見た目（トランジション）は artillery.html の CSS クラス
 * （.turn-announce の in / out / team-red / team-blue / no-stage）で定義し、
 * このモジュールはクラスの付け替えとタイマー管理だけを担当する。
 */
import type { Team } from "./gameLogic";

/** フェードインのトランジション時間 (ms)。CSS の .in と一致させる。 */
const FADE_IN_MS = 450;
/** 退場（爆散）のトランジション時間 (ms)。CSS の .out と一致させる。 */
const OUT_MS = 600;

export interface ShowOptions {
    /** ステージ名（指定時のみ stage 行を表示）。 */
    stage?: string;
    /** 攻撃ターンのチーム。 */
    team: Team;
    /**
     * 表示を保持する時間 (ms)。フェードイン完了後この時間だけ表示してから
     * 自動で退場する。`null` の場合は自動退場せず、{@link AnnounceController.dismiss}
     * が呼ばれるまで表示し続ける（最低表示時間は内部で保証する）。
     */
    hold: number | null;
}

export interface AnnounceController {
    /** 告知を表示する。連続呼び出し時は前の表示を打ち切って差し替える。 */
    show: (opts: ShowOptions) => void;
    /** `hold: null` で表示中の告知を退場させる。 */
    dismiss: () => void;
    /** 内部タイマーを破棄する。 */
    dispose: () => void;
}

export interface AnnounceElements {
    /** ルート要素 (.turn-announce)。 */
    root: HTMLElement;
    /** ステージ名要素 (.announce-stage)。 */
    stage: HTMLElement;
    /** ターン要素 (.announce-turn)。 */
    turn: HTMLElement;
    /**
     * 入力遮断オーバーレイ (.input-blocker)。指定すると、告知の表示中（登場〜退場アニメ
     * 完了まで）`active` クラスを付与してマウス操作を全面的に遮断する。
     */
    blocker?: HTMLElement;
}

/** `hold: null` 表示時に保証する最低表示時間 (ms)。 */
const MIN_VISIBLE_MS = 600;

/**
 * 告知オーバーレイのコントローラを生成する。
 *
 * DOM 要素を受け取り、クラス付け替えとタイマーで登場・退場を制御する。
 */
export const createAnnounce = (els: AnnounceElements): AnnounceController => {
    const { root, stage, turn, blocker } = els;

    let outTimer: ReturnType<typeof setTimeout> | null = null;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    /** `hold: null` 表示の自動退場待ち（最低表示時間経過後に dismiss する場合）用。 */
    let pendingDismiss = false;
    let shownAt = 0;

    const enableBlocker = (): void => {
        blocker?.classList.add("active");
    };
    const disableBlocker = (): void => {
        blocker?.classList.remove("active");
    };

    const clearTimers = (): void => {
        if (outTimer !== null) {
            clearTimeout(outTimer);
            outTimer = null;
        }
        if (resetTimer !== null) {
            clearTimeout(resetTimer);
            resetTimer = null;
        }
    };

    /** 退場アニメーション（ブラー＋拡大で爆散）を開始する。 */
    const playOut = (): void => {
        pendingDismiss = false;
        root.classList.remove("in");
        root.classList.add("out");
        resetTimer = setTimeout(() => {
            root.classList.remove("out");
            resetTimer = null;
            // 退場アニメ完了で入力遮断を解除する。
            disableBlocker();
        }, OUT_MS);
    };

    const show = (opts: ShowOptions): void => {
        clearTimers();
        pendingDismiss = false;
        // 表示中は入力を遮断する。
        enableBlocker();

        // テキスト・チーム色・stage 有無を反映
        turn.textContent = `${opts.team.toUpperCase()} ATTACK`;
        if (opts.stage) {
            stage.textContent = opts.stage;
            root.classList.remove("no-stage");
        } else {
            root.classList.add("no-stage");
        }
        root.classList.remove("team-red", "team-blue");
        root.classList.add(opts.team === "red" ? "team-red" : "team-blue");

        // いったん初期状態（hidden, 小・ブラー）へ戻し、リフローを挟んでから
        // .in を付けてトランジションを確実に発火させる。
        root.classList.remove("in", "out");
        // 強制リフロー（戻した状態を確定させる）
        void root.offsetWidth;
        root.classList.add("in");
        shownAt = Date.now();

        if (opts.hold !== null) {
            outTimer = setTimeout(playOut, FADE_IN_MS + opts.hold);
        }
    };

    const dismiss = (): void => {
        // すでに退場済み/未表示なら何もしない
        if (!root.classList.contains("in")) return;
        const elapsed = Date.now() - shownAt;
        if (elapsed < MIN_VISIBLE_MS) {
            // 最低表示時間に満たない場合は残り時間だけ待ってから退場
            if (pendingDismiss) return;
            pendingDismiss = true;
            outTimer = setTimeout(playOut, MIN_VISIBLE_MS - elapsed);
            return;
        }
        clearTimers();
        playOut();
    };

    const dispose = (): void => {
        clearTimers();
        disableBlocker();
    };

    return { show, dismiss, dispose };
};

export interface HitBannerController {
    /** HIT! バナーをアニメーション再生する。連続呼び出しでも再発火する。 */
    flash: () => void;
    /** アニメーション総時間 (ms)。後続演出の待ち時間に使う。 */
    readonly durationMs: number;
    /** 内部タイマーを破棄する。 */
    dispose: () => void;
}

/** HIT! バナーのアニメーション総時間 (ms)。CSS の hit-pop と一致させる。 */
const HIT_ANIM_MS = 1000;

/**
 * 命中時に表示する HIT! バナーのコントローラを生成する。
 *
 * `play` クラスの付け外しで CSS アニメーションを発火させる。
 */
export const createHitBanner = (el: HTMLElement): HitBannerController => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const flash = (): void => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        // クラスを外しリフローを挟んで付け直すことでアニメーションを確実に再発火
        el.classList.remove("play");
        void el.offsetWidth;
        el.classList.add("play");
        hideTimer = setTimeout(() => {
            el.classList.remove("play");
            hideTimer = null;
        }, HIT_ANIM_MS);
    };

    const dispose = (): void => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    };

    return { flash, dispose, durationMs: HIT_ANIM_MS };
};
