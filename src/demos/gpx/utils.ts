/**
 * GPX Viewer デモ用ユーティリティ
 *
 * トラック統計（距離・標高の上昇/下降・最高/最低標高）の集計と、
 * ステータスパネル向けのラベル整形関数。
 * haversine 距離計算・距離フォーマットは共通ユーティリティ `../shared/geoUtils` を使用する。
 */

import type { ParsedGpxPoint, ParsedGpxSegment, ParsedGpxTrack } from "./parseGpx";
export {
    haversineDistanceMeters,
    formatHorizontalDistance,
} from "../shared/geoUtils";
import { haversineDistanceMeters } from "../shared/geoUtils";

/** トラック統計（1トラック分、または複数トラック合算） */
export interface GpxTrackStats {
    /** 総水平距離 (m)。セグメントをまたいだ2点間は加算しない。 */
    distanceMeters: number;
    /** 累積標高上昇 (m)。`ele` が欠損する区間の差分はスキップする。 */
    elevationGainMeters: number;
    /** 累積標高下降 (m)。値は常に 0 以上（下降量の絶対値）。 */
    elevationLossMeters: number;
    /** 最高標高 (m)。`ele` を持つ点が1つも無ければ null。 */
    maxElevationMeters: number | null;
    /** 最低標高 (m)。 */
    minElevationMeters: number | null;
    /** トラックポイント総数（全セグメント合算）。 */
    pointCount: number;
}

const EMPTY_STATS: GpxTrackStats = {
    distanceMeters: 0,
    elevationGainMeters: 0,
    elevationLossMeters: 0,
    maxElevationMeters: null,
    minElevationMeters: null,
    pointCount: 0,
};

/** 1 セグメント分の統計を計算し、`acc` に加算する（min/max は Math.min/max で更新）。 */
const accumulateSegmentStats = (points: ParsedGpxPoint[], acc: GpxTrackStats): void => {
    acc.pointCount += points.length;
    for (let i = 0; i < points.length; i++) {
        const ele = points[i].ele;
        if (ele !== null) {
            acc.maxElevationMeters = acc.maxElevationMeters === null ? ele : Math.max(acc.maxElevationMeters, ele);
            acc.minElevationMeters = acc.minElevationMeters === null ? ele : Math.min(acc.minElevationMeters, ele);
        }
        if (i === 0) continue;
        const prev = points[i - 1];
        acc.distanceMeters += haversineDistanceMeters(prev, points[i]);
        if (prev.ele !== null && ele !== null) {
            const delta = ele - prev.ele;
            if (delta > 0) acc.elevationGainMeters += delta;
            else acc.elevationLossMeters += -delta;
        }
    }
};

/** 1 トラック分（複数セグメント）の統計を計算する。 */
export const computeTrackStats = (track: ParsedGpxTrack): GpxTrackStats => {
    const acc: GpxTrackStats = { ...EMPTY_STATS };
    for (const segment of track.segments) {
        accumulateSegmentStats(segment.points, acc);
    }
    return acc;
};

/** 複数トラックの統計を合算する。 */
export const computeGpxStats = (tracks: readonly ParsedGpxTrack[]): GpxTrackStats => {
    const acc: GpxTrackStats = { ...EMPTY_STATS };
    for (const track of tracks) {
        const trackStats = computeTrackStats(track);
        acc.distanceMeters += trackStats.distanceMeters;
        acc.elevationGainMeters += trackStats.elevationGainMeters;
        acc.elevationLossMeters += trackStats.elevationLossMeters;
        acc.pointCount += trackStats.pointCount;
        if (trackStats.maxElevationMeters !== null) {
            acc.maxElevationMeters =
                acc.maxElevationMeters === null
                    ? trackStats.maxElevationMeters
                    : Math.max(acc.maxElevationMeters, trackStats.maxElevationMeters);
        }
        if (trackStats.minElevationMeters !== null) {
            acc.minElevationMeters =
                acc.minElevationMeters === null
                    ? trackStats.minElevationMeters
                    : Math.min(acc.minElevationMeters, trackStats.minElevationMeters);
        }
    }
    return acc;
};

/** 標高 (m) を整数に丸めて整形する。null / 非有限値は "-"。 */
export const formatElevationMeters = (meters: number | null): string => {
    if (meters === null || !Number.isFinite(meters)) return "-";
    return `${Math.round(meters)} m`;
};

/** セグメント配列を平坦化した点列を返す（描画用ではなく統計/表示補助向け）。 */
export const flattenSegments = (segments: readonly ParsedGpxSegment[]): ParsedGpxPoint[] =>
    segments.flatMap((s) => s.points);

/** トラックラベル（トラック名。無ければ連番）。 */
export const formatTrackLabel = (track: ParsedGpxTrack, index: number): string =>
    track.name ?? `トラック ${index + 1}`;

/**
 * 描画用ポリライン頂点数の上限（1セグメントあたり）。
 *
 * `addPolygon` は頂点ごとに球体メッシュ（点マーカー）を生成するため、GPX トラックのような
 * 数千点規模の入力をそのまま渡すとメッシュ数が膨大になり描画性能を損なう。
 * 統計計算（距離・標高）は元の全点データを使い、描画時のみ間引く。
 */
export const MAX_RENDER_POINTS_PER_SEGMENT = 1000;

/** JST (UTC+9, サマータイムなし) のオフセット (ms)。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * epoch ms を日本ローカル時刻 (JST, UTC+9固定) の `HH:MM` 表記に整形する。
 *
 * GPX の `<time>` は通常 UTC で記録されるため、閲覧者のブラウザ/OS のタイムゾーンに
 * 依存せず常に JST で表示できるよう、UTC 基準の getters + オフセット加算で計算する
 * （`toLocaleString` 等は環境依存のため使わない）。
 */
export const formatJstTime = (epochMs: number): string => {
    const jst = new Date(epochMs + JST_OFFSET_MS);
    const hh = String(jst.getUTCHours()).padStart(2, "0");
    const mm = String(jst.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
};

/** 標高グラフ 1 点分（時刻 + 標高）。 */
export interface ElevationProfilePoint {
    /** 記録時刻 (epoch ms, UTC)。表示時は `formatJstTime` で JST に変換する。 */
    timeMs: number;
    ele: number;
}

/** 標高グラフ 1 系列分（トラック 1 本に対応）。 */
export interface ElevationProfileSeries {
    trackIndex: number;
    points: ElevationProfilePoint[];
}

/** 標高グラフ描画用ポリライン頂点数の上限（1トラックあたり）。 */
export const MAX_CHART_POINTS_PER_TRACK = 400;

/**
 * トラック群から標高-時間グラフ用のデータを組み立てる。
 *
 * `time` / `ele` の両方を持つ点のみを対象とする（どちらか欠損する点はスキップ）。
 * 有効点が 2 未満のトラックは折れ線を描けないため除外する。
 * 描画性能のため `MAX_CHART_POINTS_PER_TRACK` まで間引く。
 */
export const buildElevationProfiles = (
    tracks: readonly ParsedGpxTrack[],
): ElevationProfileSeries[] => {
    const series: ElevationProfileSeries[] = [];
    tracks.forEach((track, trackIndex) => {
        const points: ElevationProfilePoint[] = [];
        for (const point of flattenSegments(track.segments)) {
            if (point.time !== null && point.ele !== null) {
                points.push({ timeMs: point.time, ele: point.ele });
            }
        }
        if (points.length < 2) return;
        series.push({ trackIndex, points: decimatePoints(points, MAX_CHART_POINTS_PER_TRACK) });
    });
    return series;
};

/**
 * 配列を最大 `maxPoints` 件まで等間隔に間引く。先頭・末尾は必ず保持する。
 * `points.length <= maxPoints` の場合はそのまま返す。連続して同一 index を
 * 選ばないよう重複は除去する。
 */
export const decimatePoints = <T>(points: readonly T[], maxPoints: number): T[] => {
    if (points.length <= maxPoints || maxPoints < 2) return [...points];
    const result: T[] = [];
    const step = (points.length - 1) / (maxPoints - 1);
    let lastIndex = -1;
    for (let i = 0; i < maxPoints; i++) {
        const idx = Math.min(points.length - 1, Math.round(i * step));
        if (idx === lastIndex) continue;
        result.push(points[idx]);
        lastIndex = idx;
    }
    return result;
};

/** ウェイポイントラベル（名前。無ければ連番）。 */
export const formatWaypointLabel = (name: string | null, index: number): string =>
    name ?? `WPT ${index + 1}`;
