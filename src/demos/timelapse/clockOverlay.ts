/**
 * アナログ時計オーバーレイ
 *
 * SVG ベースの軽量アナログ時計。`renderClockSvg` は時計盤と針を含む SVG マークアップ文字列を返す純粋関数。
 * `mountClock` は既存の `<svg>` 要素に対して針要素を初期化／更新する DOM 操作を担う。
 *
 * 設計方針:
 * - 時計盤（目盛り・中心円）は初回マウント時に 1 度だけ描画する。
 * - 針角度の更新は SVG 要素の `transform` 属性のみを書き換える（`innerHTML` 再生成しない）。
 * - 純粋関数（角度計算）と DOM 副作用を分離して unit test しやすくする。
 */

/** 時針・分針の回転角度（度、12 時を 0° として時計回り正） */
export interface ClockAngles {
    hourDeg: number;
    minuteDeg: number;
}

/**
 * 経度 [deg] から地方平均太陽時のUTCオフセット (ms) を導出する。
 * 経度 15° ごとに 1 時間（= 経度 1° あたり 4 分）。これにより太陽の南中（経線通過）が
 * おおよそ地方時の正午に一致する。経度は (-180, 180] に正規化する。
 */
export const longitudeToOffsetMs = (lonDeg: number): number => {
    if (!Number.isFinite(lonDeg)) return 0;
    // (-180, 180] へ正規化する（経度 180° は -180° へ折り返さず +180° = UTC+12 とする）。
    const normalized = 180 - ((((180 - lonDeg) % 360) + 360) % 360);
    // 1° = 24h/360 = 240000 ms。
    return normalized * 240000;
};

/** UTC オフセット (ms) を `UTC±H[:MM]` 形式のラベルへ整形する。 */
export const formatUtcOffsetLabel = (offsetMs: number): string => {
    // 符号は丸め後の分で判定する。-1ms のような「ほぼ 0 の負値」でも totalMin=0 なら UTC+0 に正規化する。
    const totalMin = Math.round(offsetMs / 60000);
    const sign = totalMin < 0 ? "-" : "+";
    const absMin = Math.abs(totalMin);
    const h = Math.floor(absMin / 60);
    const m = absMin % 60;
    return m === 0
        ? `UTC${sign}${h}`
        : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
};

/**
 * `Date` から各針の角度を算出する純粋関数。
 *
 * - 時針は分に応じて連続的に回転する（12 時間で 360°）。
 * - 分針は秒に応じて連続的に回転する（60 分で 360°）。
 *
 * `offsetMs` は表示先タイムゾーンのUTCオフセット (ms)。シミュレーション時刻は UTC で保持される
 * ため、ここで `offsetMs` を加えてから UTC ゲッタで分解する（既定 0 = UTC）。
 *
 * `Invalid Date` が渡された場合は 0° を返す（呼び出し側でフォールバック値を期待しないよう注意）。
 */
export const computeClockAngles = (
    date: Date,
    offsetMs = 0,
): ClockAngles => {
    if (Number.isNaN(date.getTime())) {
        return { hourDeg: 0, minuteDeg: 0 };
    }
    const local = new Date(date.getTime() + offsetMs);
    const ms = local.getUTCMilliseconds();
    const s = local.getUTCSeconds() + ms / 1000;
    const m = local.getUTCMinutes() + s / 60;
    const h = (local.getUTCHours() % 12) + m / 60;
    return {
        hourDeg: h * 30, // 360 / 12
        minuteDeg: m * 6, // 360 / 60
    };
};

/**
 * シミュレーション時刻の表示用ラベル（`HH:MM UTC±H`）を整形する。
 * `offsetMs` は表示先タイムゾーンのUTCオフセット (ms、既定 0 = UTC)。
 */
export const formatClockLabel = (date: Date, offsetMs = 0): string => {
    const offsetLabel = formatUtcOffsetLabel(offsetMs);
    if (Number.isNaN(date.getTime())) return `--:-- ${offsetLabel}`;
    const local = new Date(date.getTime() + offsetMs);
    const hh = String(local.getUTCHours()).padStart(2, "0");
    const mm = String(local.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm} ${offsetLabel}`;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const HAND_HOUR_ID = "tl-clock-hand-hour";
const HAND_MINUTE_ID = "tl-clock-hand-minute";

/**
 * 時計盤のテンプレート（目盛り・中心円・固定文字）。
 * 100x100 ビューポート前提で 12 個の目盛りを生成する。
 */
const buildDialMarkup = (): string => {
    const ticks: string[] = [];
    for (let i = 0; i < 12; i++) {
        const isHour = i % 3 === 0;
        const len = isHour ? 8 : 5;
        const x1 = 50;
        const y1 = 50 - 44;
        const x2 = 50;
        const y2 = 50 - 44 + len;
        const stroke = isHour ? "#ffffff" : "#cdd6e4";
        const w = isHour ? 1.6 : 0.8;
        ticks.push(
            `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" transform="rotate(${i * 30} 50 50)" />`,
        );
    }
    return [
        '<circle cx="50" cy="50" r="48" fill="rgba(20, 28, 44, 0.78)" stroke="rgba(255,255,255,0.35)" stroke-width="1" />',
        ...ticks,
    ].join("");
};

/**
 * SVG 文字列としての完全な時計マークアップ（テスト用）。
 * 角度は与えられた `ClockAngles` を使用。
 */
export const renderClockSvg = (angles: ClockAngles): string =>
    [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        buildDialMarkup(),
        `<line id="${HAND_HOUR_ID}" x1="50" y1="50" x2="50" y2="22" stroke="#ffffff" stroke-width="3" stroke-linecap="round" transform="rotate(${angles.hourDeg} 50 50)" />`,
        `<line id="${HAND_MINUTE_ID}" x1="50" y1="50" x2="50" y2="14" stroke="#ffffff" stroke-width="2" stroke-linecap="round" transform="rotate(${angles.minuteDeg} 50 50)" />`,
        '<circle cx="50" cy="50" r="2.4" fill="#ffffff" />',
        "</svg>",
    ].join("");

/** マウント済みクロックを更新するためのハンドル。 */
export interface ClockHandle {
    /** シミュレーション時刻と表示先UTCオフセット (ms) に基づき針位置・ラベルを更新する */
    update(date: Date, offsetMs?: number): void;
}

/**
 * 既存の `<svg>` 要素に時計盤と針を構築し、更新ハンドルを返す。
 * - 同じ要素に対して再マウントしないこと（再マウント時は `update` を使う）。
 * - DOM が無い環境（Vitest の jsdom 以外）では呼び出さない。
 */
export const mountClock = (
    svg: SVGSVGElement,
    labelEl: HTMLElement | null,
): ClockHandle => {
    // 子要素をいったんクリアし、目盛り＋針を構築する。
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // viewBox はテンプレ側で設定済みだが、未設定ならデフォルト値を設定する。
    if (!svg.getAttribute("viewBox")) {
        svg.setAttribute("viewBox", "0 0 100 100");
    }
    // 目盛り（HTMLパーサに任せず DOM API で組むのが安全だが、
    // ここでは静的な内容なので `innerHTML` でまとめて挿入する）。
    svg.insertAdjacentHTML("afterbegin", buildDialMarkup());

    const createHand = (
        id: string,
        y2: number,
        stroke: string,
        width: number,
    ): SVGLineElement => {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("id", id);
        line.setAttribute("x1", "50");
        line.setAttribute("y1", "50");
        line.setAttribute("x2", "50");
        line.setAttribute("y2", String(y2));
        line.setAttribute("stroke", stroke);
        line.setAttribute("stroke-width", String(width));
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("transform", "rotate(0 50 50)");
        svg.appendChild(line);
        return line;
    };

    const hourHand = createHand(HAND_HOUR_ID, 22, "#ffffff", 3);
    const minuteHand = createHand(HAND_MINUTE_ID, 14, "#ffffff", 2);

    const center = document.createElementNS(SVG_NS, "circle");
    center.setAttribute("cx", "50");
    center.setAttribute("cy", "50");
    center.setAttribute("r", "2.4");
    center.setAttribute("fill", "#ffffff");
    svg.appendChild(center);

    return {
        update(date: Date, offsetMs = 0): void {
            const angles = computeClockAngles(date, offsetMs);
            hourHand.setAttribute(
                "transform",
                `rotate(${angles.hourDeg} 50 50)`,
            );
            minuteHand.setAttribute(
                "transform",
                `rotate(${angles.minuteDeg} 50 50)`,
            );
            if (labelEl) labelEl.textContent = formatClockLabel(date, offsetMs);
        },
    };
};
