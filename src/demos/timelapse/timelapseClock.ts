/**
 * タイムラプス用シミュレーション時刻計算（純粋関数）
 *
 * 24 時間を任意秒数（既定 60s）に圧縮した「シミュレーション時刻」を計算する。
 * `JpmapTerrain.dateTime` setter に渡す `Date` をフレームごとに生成するために使う。
 *
 * Babylon.js / DOM 依存なし。テスト容易性のため副作用は持たない。
 */

/** 24 時間 = 86,400,000 ms */
export const MS_PER_DAY = 86_400_000;

export interface TimelapseClockOptions {
    /** シミュレーションの開始日時（UTC として扱う、`Date.UTC` 系で比較） */
    startUtc: Date;
    /** 24 時間ぶんを実時間で何秒に圧縮するか（既定 60s） */
    periodSec: number;
    /** 一時停止中なら `true`。`true` の場合、経過秒に関わらず `startUtc` を返す */
    paused: boolean;
}

/**
 * オプションを安全な値に丸める。
 * - `periodSec`: 0 以下や非有限値の場合は 60s にフォールバック
 * - `startUtc`: `Invalid Date` の場合は `2025-06-21T00:00:00Z` にフォールバック
 */
export const sanitizeTimelapseOptions = (
    options: Partial<TimelapseClockOptions>,
): TimelapseClockOptions => {
    const fallbackStart = new Date(Date.UTC(2025, 5, 21, 0, 0, 0));
    const start =
        options.startUtc instanceof Date &&
        !Number.isNaN(options.startUtc.getTime())
            ? options.startUtc
            : fallbackStart;
    const period =
        typeof options.periodSec === "number" &&
        Number.isFinite(options.periodSec) &&
        options.periodSec > 0
            ? options.periodSec
            : 60;
    return {
        startUtc: start,
        periodSec: period,
        paused: options.paused === true,
    };
};

/**
 * 経過秒からシミュレーション時刻を計算する。
 *
 * 数式: `simulated = startUtc + ((elapsedSec mod periodSec) / periodSec) * 86400000 ms`
 *
 * - `elapsedSec` が負の場合や非有限値は 0 として扱う。
 * - `paused = true` の場合は `startUtc` をそのまま返す。
 */
export const computeSimulatedDate = (
    elapsedSec: number,
    options: TimelapseClockOptions,
): Date => {
    if (options.paused) {
        return new Date(options.startUtc.getTime());
    }
    const safeElapsed =
        Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
    const phase = (safeElapsed % options.periodSec) / options.periodSec;
    const offsetMs = phase * MS_PER_DAY;
    return new Date(options.startUtc.getTime() + offsetMs);
};

// 日時部分（`T` 以降に時刻を含む）にタイムゾーン指定（`Z` または `±hh:mm` / `±hhmm`）が
// 付いているか判定する。
const HAS_TZ_DESIGNATOR = /T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/;
// `URLSearchParams` が `+hh:mm` の `+` を空白へデコードした形（`...T09:30:00 09:00`）を捉える。
const PLUS_OFFSET_AS_SPACE =
    /^(.*T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) (\d{2}:?\d{2})$/;

/**
 * `?start=` の生文字列を `Date` に解釈する。`start` は仕様上 UTC として解釈する（決定的表示）。
 * - `URLSearchParams` は `application/x-www-form-urlencoded` 規約で `+` を空白へデコードするため、
 *   `+09:00` のような正のタイムゾーンオフセットが空白に化けて `Invalid Date` になる。日時の後ろに
 *   ` hh:mm` が続く形を検出し、`+hh:mm` へ復元する（`%2B` で明示エンコードされた場合は既に `+`）。
 * - タイムゾーン指定（`Z` / `±hh:mm`）が無いベア日時は、ECMAScript では実行環境のローカル時刻として
 *   解釈され非決定的になる。仕様（UTC 解釈）に合わせて末尾に `Z` を補う。日付のみ（時刻なし）は
 *   ES 仕様で既に UTC 扱いのため変更しない。
 * @returns 解釈できた `Date`。空文字や解釈不能なら `undefined`。
 */
export const parseStartDate = (raw: string): Date | undefined => {
    let s = raw.trim();
    if (s === "") return undefined;
    const spaceOffset = PLUS_OFFSET_AS_SPACE.exec(s);
    if (spaceOffset) s = `${spaceOffset[1]}+${spaceOffset[2]}`;
    if (s.includes("T") && !HAS_TZ_DESIGNATOR.test(s)) s = `${s}Z`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * URL クエリ文字列からタイムラプス設定を解決する。
 * - `?start=` ISO 8601（タイムゾーン無指定は UTC として解釈）。失敗時は本日 0 時 (UTC)
 * - `?speed=` 数値秒（24h を何秒で再生するか）。0 以下や NaN は 60s にフォールバック
 * - `?paused`（値なし）または `?paused=true` で停止
 */
export const parseTimelapseQuery = (
    search: string,
    now: Date = new Date(),
): TimelapseClockOptions => {
    const params = new URLSearchParams(
        search.startsWith("?") ? search.slice(1) : search,
    );

    let startUtc: Date | undefined;
    const startRaw = params.get("start");
    if (startRaw !== null) {
        startUtc = parseStartDate(startRaw);
    }
    if (!startUtc) {
        // 当日 0 時 UTC を既定値にする（決定的な見やすい初期表示）。
        startUtc = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
    }

    const speedRaw = params.get("speed");
    const speedNum = speedRaw !== null ? Number(speedRaw) : NaN;

    const pausedRaw = params.get("paused");
    const paused =
        pausedRaw !== null && pausedRaw !== "false" && pausedRaw !== "0";

    return sanitizeTimelapseOptions({
        startUtc,
        periodSec: speedNum,
        paused,
    });
};
