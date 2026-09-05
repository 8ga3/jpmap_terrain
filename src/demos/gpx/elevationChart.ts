/**
 * 標高-時間グラフ（Canvas 2D）
 *
 * GPX トラックの記録時刻 (横軸, JST 表示) と標高 (縦軸) を折れ線＋塗りつぶし
 * （折れ線からプロット下端＝標高最小値ラインまでの領域を半透明で塗る）で描画する。
 * 外部チャートライブラリには依存せず、Canvas 2D API のみで実装する
 * （デモ 1 画面のための小さな描画に留まるため）。
 */
import type { ElevationProfileSeries } from "./utils";
import { formatJstTime } from "./utils";

/** 標高軸の目盛り分割数。 */
const ELEVATION_GRID_STEPS = 3;
/** 時間軸の目盛り分割数（パネル幅が十分な場合の最大値）。 */
const MAX_TIME_GRID_STEPS = 4;
/** 時間軸の目盛り分割数の最小値（パネルが狭くても最低限これだけは表示する）。 */
const MIN_TIME_GRID_STEPS = 1;
/** "HH:MM" ラベル同士が重ならないために必要な最小間隔(px)。 */
const MIN_TIME_LABEL_SPACING_PX = 55;

const PADDING_LEFT = 46;
const PADDING_RIGHT = 12;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 20;

/**
 * `canvas` の内容をクリアする（GPX 未読み込み/時刻情報なしの場合に使用）。
 */
export const clearElevationChart = (canvas: HTMLCanvasElement): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
};

/**
 * 標高-時間グラフを `canvas` に描画する。
 *
 * `canvas` の CSS 表示サイズ（`getBoundingClientRect`）に合わせて
 * `devicePixelRatio` 分の解像度で描画し直すため、リサイズ時は毎回呼び直すこと。
 * `series` が空、または全系列合わせて点が無い場合は何も描画せずクリアする。
 */
export const renderElevationChart = (
    canvas: HTMLCanvasElement,
    series: readonly ElevationProfileSeries[],
    colorForTrack: (index: number) => string,
): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const allPoints = series.flatMap((s) => s.points);
    if (allPoints.length === 0) return;

    let minEle = Infinity;
    let maxEle = -Infinity;
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const p of allPoints) {
        if (p.ele < minEle) minEle = p.ele;
        if (p.ele > maxEle) maxEle = p.ele;
        if (p.timeMs < minTime) minTime = p.timeMs;
        if (p.timeMs > maxTime) maxTime = p.timeMs;
    }
    if (minEle === maxEle) {
        minEle -= 1;
        maxEle += 1;
    }
    if (minTime === maxTime) {
        maxTime = minTime + 1;
    }

    const plotW = Math.max(1, width - PADDING_LEFT - PADDING_RIGHT);
    const plotH = Math.max(1, height - PADDING_TOP - PADDING_BOTTOM);
    const xFor = (timeMs: number): number =>
        PADDING_LEFT + ((timeMs - minTime) / (maxTime - minTime)) * plotW;
    const yFor = (ele: number): number =>
        PADDING_TOP + (1 - (ele - minEle) / (maxEle - minEle)) * plotH;

    ctx.font =
        "10px -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
    ctx.lineWidth = 1;

    // 標高の目盛り線・ラベル
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
    for (let i = 0; i <= ELEVATION_GRID_STEPS; i++) {
        const ele = minEle + ((maxEle - minEle) * i) / ELEVATION_GRID_STEPS;
        const y = yFor(ele);
        ctx.beginPath();
        ctx.moveTo(PADDING_LEFT, y);
        ctx.lineTo(width - PADDING_RIGHT, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`${Math.round(ele)}m`, PADDING_LEFT - 4, y);
    }

    // 時間の目盛りラベル（JST）。パネル幅が狭い場合はラベル同士が重ならないよう分割数を減らす。
    const timeGridSteps = Math.max(
        MIN_TIME_GRID_STEPS,
        Math.min(
            MAX_TIME_GRID_STEPS,
            Math.floor(plotW / MIN_TIME_LABEL_SPACING_PX),
        ),
    );
    for (let i = 0; i <= timeGridSteps; i++) {
        const t = minTime + ((maxTime - minTime) * i) / timeGridSteps;
        const x = xFor(t);
        ctx.textAlign =
            i === 0 ? "left" : i === timeGridSteps ? "right" : "center";
        ctx.textBaseline = "top";
        ctx.fillText(formatJstTime(t), x, height - PADDING_BOTTOM + 4);
    }

    // 各トラックの折れ線 + 折れ線より下の塗りつぶし
    for (const s of series) {
        if (s.points.length === 0) continue;
        const color = colorForTrack(s.trackIndex);
        const xy = s.points.map((p) => ({ x: xFor(p.timeMs), y: yFor(p.ele) }));
        const baselineY = PADDING_TOP + plotH;

        // 塗りつぶし（折れ線とプロット下端 = 標高最小値ラインで囲んだ領域）。
        ctx.beginPath();
        xy.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.lineTo(xy[xy.length - 1].x, baselineY);
        ctx.lineTo(xy[0].x, baselineY);
        ctx.closePath();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;

        // 折れ線本体
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        xy.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
    }
};
