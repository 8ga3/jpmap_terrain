/**
 * GPX (GPS eXchange Format) パーサ
 *
 * GPX 1.1 の `<trk>`（トラック）/ `<wpt>`（ウェイポイント）を抽出し、
 * 描画に必要な最小限の情報（緯度経度・標高・トラック名）へ変換する。
 * `<rte>`（ルート）・拡張要素（`<extensions>` 等）は対象外。
 *
 * ブラウザ標準の `DOMParser` を使用するため、追加の XML パースライブラリに依存しない。
 */

/** トラックポイント/ウェイポイント共通の座標情報 */
export interface ParsedGpxPoint {
    lat: number;
    lon: number;
    /** 標高 (m)。`<ele>` が存在しない/数値でない場合は null。 */
    ele: number | null;
    /** 記録時刻 (epoch ms)。`<time>` が存在しない/日時として不正な場合は null。 */
    time: number | null;
}

/** `<trkseg>` 1件分 */
export interface ParsedGpxSegment {
    points: ParsedGpxPoint[];
}

/** `<trk>` 1件分 */
export interface ParsedGpxTrack {
    /** `<name>` の内容。未指定なら null。 */
    name: string | null;
    segments: ParsedGpxSegment[];
}

/** `<wpt>` 1件分 */
export interface ParsedGpxWaypoint extends ParsedGpxPoint {
    name: string | null;
}

export interface ParsedGpx {
    tracks: ParsedGpxTrack[];
    waypoints: ParsedGpxWaypoint[];
}

/** 数値属性/テキストを number にパースする。NaN の場合は null を返す。 */
const parseFloatOrNull = (value: string | null): number | null => {
    if (value === null) return null;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
};

/** 要素直下の最初の `<ele>` テキストを標高値としてパースする。 */
const readElevation = (el: Element): number | null => {
    const eleEl = el.getElementsByTagName("ele")[0];
    if (!eleEl?.textContent) return null;
    return parseFloatOrNull(eleEl.textContent.trim());
};

/** 要素直下の最初の `<name>` テキストを返す。空文字は null 扱い。 */
const readName = (el: Element): string | null => {
    const nameEl = el.getElementsByTagName("name")[0];
    const text = nameEl?.textContent?.trim();
    return text ? text : null;
};

/**
 * 要素直下の最初の `<time>` テキストを epoch ms としてパースする。
 * GPX の `<time>` は ISO 8601（通常 UTC, 末尾 `Z`）。存在しない/日時として
 * 不正な場合は null。タイムゾーン変換（JST 表示）は表示側 (`formatJstTime`) で行う。
 */
const readTime = (el: Element): number | null => {
    const timeEl = el.getElementsByTagName("time")[0];
    const text = timeEl?.textContent?.trim();
    if (!text) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
};

/** `<trkpt>` / `<wpt>` 要素から座標情報を抽出する。lat/lon が数値でなければ null。 */
const readPoint = (el: Element): ParsedGpxPoint | null => {
    const lat = parseFloatOrNull(el.getAttribute("lat"));
    const lon = parseFloatOrNull(el.getAttribute("lon"));
    if (lat === null || lon === null) return null;
    return { lat, lon, ele: readElevation(el), time: readTime(el) };
};

/**
 * GPX (XML) テキストをパースし、描画用データを返す。
 *
 * @throws XML として不正、またはルート要素が `gpx` でない場合 Error
 */
export const parseGpx = (xmlText: string): ParsedGpx => {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");

    if (doc.getElementsByTagName("parsererror").length > 0) {
        throw new Error("Invalid GPX file: XML parse error");
    }
    if (doc.documentElement?.localName?.toLowerCase() !== "gpx") {
        throw new Error("Invalid GPX file: root element is not <gpx>");
    }

    const tracks: ParsedGpxTrack[] = [];
    for (const trkEl of Array.from(doc.documentElement.getElementsByTagName("trk"))) {
        const name = readName(trkEl);
        const segments: ParsedGpxSegment[] = [];
        for (const segEl of Array.from(trkEl.getElementsByTagName("trkseg"))) {
            const points: ParsedGpxPoint[] = [];
            for (const ptEl of Array.from(segEl.getElementsByTagName("trkpt"))) {
                const pt = readPoint(ptEl);
                if (pt) points.push(pt);
            }
            if (points.length > 0) segments.push({ points });
        }
        if (segments.length > 0) tracks.push({ name, segments });
    }

    const waypoints: ParsedGpxWaypoint[] = [];
    for (const wptEl of Array.from(doc.documentElement.getElementsByTagName("wpt"))) {
        const pt = readPoint(wptEl);
        if (!pt) continue;
        waypoints.push({ ...pt, name: readName(wptEl) });
    }

    if (tracks.length === 0 && waypoints.length === 0) {
        throw new Error("Invalid GPX file: no track points or waypoints found");
    }

    return { tracks, waypoints };
};
