/**
 * @vitest-environment jsdom
 */
/**
 * GPX Viewer デモの純粋関数ユニットテスト。
 *
 * - parseGpx: GPX (XML) のパースとフィルタリング
 * - computeTrackStats / computeGpxStats: 距離・標高統計の集計
 * - formatElevationMeters / formatTrackLabel / formatWaypointLabel: ラベル整形
 */
import { describe, it, expect } from "vitest";

import { parseGpx } from "../src/demos/gpx/parseGpx";
import type { ParsedGpxTrack } from "../src/demos/gpx/parseGpx";
import {
    computeGpxStats,
    computeTrackStats,
    decimatePoints,
    flattenSegments,
    formatElevationMeters,
    formatTrackLabel,
    formatWaypointLabel,
} from "../src/demos/gpx/utils";

// ---- parseGpx ----

describe("parseGpx", () => {
    const singleTrackGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>剱岳-2025-07-27</name>
    <trkseg>
      <trkpt lat="36.602896666154265" lon="137.6161671616137"><ele>2531.199951171875</ele><time>2025-07-26T19:22:53Z</time></trkpt>
      <trkpt lat="36.602898593991995" lon="137.6161639764905"><ele>2531.199951171875</ele><time>2025-07-26T19:22:54Z</time></trkpt>
      <trkpt lat="36.60290412604809" lon="137.6161248330027"><ele>2530.60009765625</ele><time>2025-07-26T19:23:27Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    it("単一トラック・単一セグメントを正常にパースできる", () => {
        const result = parseGpx(singleTrackGpx);
        expect(result.tracks).toHaveLength(1);
        expect(result.tracks[0].name).toBe("剱岳-2025-07-27");
        expect(result.tracks[0].segments).toHaveLength(1);
        expect(result.tracks[0].segments[0].points).toHaveLength(3);
        expect(result.tracks[0].segments[0].points[0]).toEqual({
            lat: 36.602896666154265,
            lon: 137.6161671616137,
            ele: 2531.199951171875,
        });
        expect(result.waypoints).toHaveLength(0);
    });

    it("不正な入力で例外を投げる", () => {
        expect(() => parseGpx("not xml")).toThrow();
        expect(() => parseGpx("<foo></foo>")).toThrow("root element is not <gpx>");
        expect(() => parseGpx("<gpx></gpx>")).toThrow("no track points or waypoints found");
    });

    it("複数トラック・複数セグメントをパースできる", () => {
        const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk>
            <name>Track A</name>
            <trkseg>
              <trkpt lat="35.0" lon="139.0"><ele>100</ele></trkpt>
              <trkpt lat="35.01" lon="139.01"><ele>110</ele></trkpt>
            </trkseg>
            <trkseg>
              <trkpt lat="35.1" lon="139.1"><ele>120</ele></trkpt>
            </trkseg>
          </trk>
          <trk>
            <trkseg>
              <trkpt lat="36.0" lon="140.0"><ele>200</ele></trkpt>
            </trkseg>
          </trk>
        </gpx>`;
        const result = parseGpx(xml);
        expect(result.tracks).toHaveLength(2);
        expect(result.tracks[0].name).toBe("Track A");
        expect(result.tracks[0].segments).toHaveLength(2);
        expect(result.tracks[0].segments[0].points).toHaveLength(2);
        expect(result.tracks[0].segments[1].points).toHaveLength(1);
        expect(result.tracks[1].name).toBeNull();
        expect(result.tracks[1].segments[0].points).toHaveLength(1);
    });

    it("ele が無い trkpt は ele: null としてパースする", () => {
        const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="35.0" lon="139.0"></trkpt>
          </trkseg></trk>
        </gpx>`;
        const result = parseGpx(xml);
        expect(result.tracks[0].segments[0].points[0].ele).toBeNull();
    });

    it("lat/lon が数値でない trkpt はスキップする", () => {
        const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="invalid" lon="139.0"><ele>100</ele></trkpt>
            <trkpt lat="35.0" lon="139.0"><ele>100</ele></trkpt>
          </trkseg></trk>
        </gpx>`;
        const result = parseGpx(xml);
        expect(result.tracks[0].segments[0].points).toHaveLength(1);
    });

    it("空の trkseg はセグメントとして扱わない", () => {
        const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk>
            <trkseg></trkseg>
            <trkseg><trkpt lat="35.0" lon="139.0"><ele>100</ele></trkpt></trkseg>
          </trk>
        </gpx>`;
        const result = parseGpx(xml);
        expect(result.tracks[0].segments).toHaveLength(1);
    });

    it("wpt (ウェイポイント) をパースする", () => {
        const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <wpt lat="35.5" lon="139.5"><ele>50</ele><name>山頂</name></wpt>
          <wpt lat="35.6" lon="139.6"></wpt>
        </gpx>`;
        const result = parseGpx(xml);
        expect(result.tracks).toHaveLength(0);
        expect(result.waypoints).toHaveLength(2);
        expect(result.waypoints[0]).toEqual({ lat: 35.5, lon: 139.5, ele: 50, name: "山頂" });
        expect(result.waypoints[1].name).toBeNull();
    });

    it("トラック・ウェイポイント両方を同時にパースできる", () => {
        const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <wpt lat="35.5" lon="139.5"><ele>50</ele></wpt>
          <trk><trkseg><trkpt lat="35.0" lon="139.0"><ele>100</ele></trkpt></trkseg></trk>
        </gpx>`;
        const result = parseGpx(xml);
        expect(result.tracks).toHaveLength(1);
        expect(result.waypoints).toHaveLength(1);
    });
});

// ---- computeTrackStats / computeGpxStats ----

describe("computeTrackStats", () => {
    it("距離・標高上昇/下降・最高/最低標高・点数を計算する", () => {
        const track: ParsedGpxTrack = {
            name: "T",
            segments: [
                {
                    points: [
                        { lat: 35.0, lon: 139.0, ele: 100 },
                        { lat: 35.0, lon: 139.01, ele: 150 }, // +50
                        { lat: 35.0, lon: 139.02, ele: 120 }, // -30
                    ],
                },
            ],
        };
        const stats = computeTrackStats(track);
        expect(stats.pointCount).toBe(3);
        expect(stats.elevationGainMeters).toBe(50);
        expect(stats.elevationLossMeters).toBe(30);
        expect(stats.maxElevationMeters).toBe(150);
        expect(stats.minElevationMeters).toBe(100);
        expect(stats.distanceMeters).toBeGreaterThan(0);
    });

    it("セグメントをまたいだ2点間の距離は加算しない（セグメント単位で計算）", () => {
        const trackOneSegment: ParsedGpxTrack = {
            name: null,
            segments: [
                {
                    points: [
                        { lat: 35.0, lon: 139.0, ele: null },
                        { lat: 36.0, lon: 140.0, ele: null },
                    ],
                },
            ],
        };
        const trackTwoSegments: ParsedGpxTrack = {
            name: null,
            segments: [
                { points: [{ lat: 35.0, lon: 139.0, ele: null }] },
                { points: [{ lat: 36.0, lon: 140.0, ele: null }] },
            ],
        };
        expect(computeTrackStats(trackTwoSegments).distanceMeters).toBe(0);
        expect(computeTrackStats(trackOneSegment).distanceMeters).toBeGreaterThan(0);
    });

    it("ele が欠損する区間の標高差は加算しない", () => {
        const track: ParsedGpxTrack = {
            name: null,
            segments: [
                {
                    points: [
                        { lat: 35.0, lon: 139.0, ele: 100 },
                        { lat: 35.0, lon: 139.01, ele: null },
                        { lat: 35.0, lon: 139.02, ele: 200 },
                    ],
                },
            ],
        };
        const stats = computeTrackStats(track);
        expect(stats.elevationGainMeters).toBe(0);
        expect(stats.elevationLossMeters).toBe(0);
        expect(stats.maxElevationMeters).toBe(200);
        expect(stats.minElevationMeters).toBe(100);
    });

    it("ele を持つ点が無ければ min/max は null", () => {
        const track: ParsedGpxTrack = {
            name: null,
            segments: [{ points: [{ lat: 35.0, lon: 139.0, ele: null }] }],
        };
        const stats = computeTrackStats(track);
        expect(stats.maxElevationMeters).toBeNull();
        expect(stats.minElevationMeters).toBeNull();
    });

    it("点が無いトラックは全て 0/null", () => {
        const stats = computeTrackStats({ name: null, segments: [] });
        expect(stats).toEqual({
            distanceMeters: 0,
            elevationGainMeters: 0,
            elevationLossMeters: 0,
            maxElevationMeters: null,
            minElevationMeters: null,
            pointCount: 0,
        });
    });
});

describe("computeGpxStats", () => {
    it("複数トラックの統計を合算する", () => {
        const tracks: ParsedGpxTrack[] = [
            {
                name: "A",
                segments: [
                    {
                        points: [
                            { lat: 35.0, lon: 139.0, ele: 100 },
                            { lat: 35.0, lon: 139.01, ele: 150 },
                        ],
                    },
                ],
            },
            {
                name: "B",
                segments: [
                    {
                        points: [
                            { lat: 36.0, lon: 140.0, ele: 50 },
                            { lat: 36.0, lon: 140.01, ele: 30 },
                        ],
                    },
                ],
            },
        ];
        const stats = computeGpxStats(tracks);
        expect(stats.pointCount).toBe(4);
        expect(stats.elevationGainMeters).toBe(50);
        expect(stats.elevationLossMeters).toBe(20);
        expect(stats.maxElevationMeters).toBe(150);
        expect(stats.minElevationMeters).toBe(30);
        expect(stats.distanceMeters).toBeGreaterThan(0);
    });

    it("空配列は全て 0/null", () => {
        const stats = computeGpxStats([]);
        expect(stats.pointCount).toBe(0);
        expect(stats.maxElevationMeters).toBeNull();
        expect(stats.minElevationMeters).toBeNull();
    });
});

describe("flattenSegments", () => {
    it("複数セグメントの点を1つの配列に平坦化する", () => {
        const points = flattenSegments([
            { points: [{ lat: 1, lon: 1, ele: null }] },
            { points: [{ lat: 2, lon: 2, ele: null }, { lat: 3, lon: 3, ele: null }] },
        ]);
        expect(points).toHaveLength(3);
    });
});

describe("decimatePoints", () => {
    it("上限以下ならそのまま返す", () => {
        const points = [1, 2, 3];
        expect(decimatePoints(points, 10)).toEqual([1, 2, 3]);
    });

    it("上限を超える場合は間引き、先頭・末尾を保持する", () => {
        const points = Array.from({ length: 5513 }, (_, i) => i);
        const result = decimatePoints(points, 1000);
        expect(result.length).toBeLessThanOrEqual(1000);
        expect(result[0]).toBe(0);
        expect(result[result.length - 1]).toBe(5512);
    });

    it("重複する index は連続して含めない", () => {
        const points = [1, 2, 3, 4, 5];
        const result = decimatePoints(points, 4);
        const uniqueConsecutive = result.every((v, i) => i === 0 || v !== result[i - 1]);
        expect(uniqueConsecutive).toBe(true);
    });
});

// ---- format ----

describe("formatElevationMeters", () => {
    it("四捨五入して m 表記にする", () => {
        expect(formatElevationMeters(150.4)).toBe("150 m");
        expect(formatElevationMeters(150.6)).toBe("151 m");
    });

    it("null / 非有限値は - を返す", () => {
        expect(formatElevationMeters(null)).toBe("-");
        expect(formatElevationMeters(NaN)).toBe("-");
        expect(formatElevationMeters(Infinity)).toBe("-");
    });
});

describe("formatTrackLabel", () => {
    it("name があればそれを使う", () => {
        expect(formatTrackLabel({ name: "剱岳", segments: [] }, 0)).toBe("剱岳");
    });

    it("name が無ければ連番を使う（1始まり）", () => {
        expect(formatTrackLabel({ name: null, segments: [] }, 0)).toBe("トラック 1");
        expect(formatTrackLabel({ name: null, segments: [] }, 2)).toBe("トラック 3");
    });
});

describe("formatWaypointLabel", () => {
    it("name があればそれを使う", () => {
        expect(formatWaypointLabel("山頂", 0)).toBe("山頂");
    });

    it("name が無ければ連番を使う（1始まり）", () => {
        expect(formatWaypointLabel(null, 0)).toBe("WPT 1");
        expect(formatWaypointLabel(null, 4)).toBe("WPT 5");
    });
});
