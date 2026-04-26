import { describe, expect, it, jest } from "@jest/globals";
import {
    parseLatLonFromUrl,
    parseCameraStateFromUrl,
    toAtPath,
    createUrlUpdater,
    clampAltitude,
    clampTilt,
    normalizeAzimuth,
    CAMERA_URL_DEFAULTS,
    CAMERA_URL_LIMITS,
} from "../src/terrain/urlState";

describe("urlState", () => {
    describe("parseLatLonFromUrl", () => {
        it("パス内の @lat,lon をパースできる", () => {
            const result = parseLatLonFromUrl("http://localhost/@35.681236,139.767125");
            expect(result).toEqual({ lat: 35.681236, lon: 139.767125 });
        });

        it("クエリパラメータ付きのパスをパースできる", () => {
            const result = parseLatLonFromUrl(
                "http://localhost/@35.681236,139.767125?engine=webgl"
            );
            expect(result).toEqual({ lat: 35.681236, lon: 139.767125 });
        });

        it("クエリパラメータ ?lat=&lon= をフォールバックでパースできる", () => {
            const result = parseLatLonFromUrl("http://localhost/?lat=35.681236&lon=139.767125");
            expect(result).toEqual({ lat: 35.681236, lon: 139.767125 });
        });

        it("@lat,lon がクエリより優先される", () => {
            const result = parseLatLonFromUrl(
                "http://localhost/@35.0,139.0?lat=36.0&lon=140.0"
            );
            expect(result).toEqual({ lat: 35.0, lon: 139.0 });
        });

        it("パラメータが無い場合は null を返す", () => {
            expect(parseLatLonFromUrl("http://localhost/")).toBeNull();
        });

        it("不正な数値の場合は null を返す", () => {
            expect(parseLatLonFromUrl("http://localhost/@abc,def")).toBeNull();
        });

        it("JAPAN_BOUNDS を超える緯度はクランプされる", () => {
            const result = parseLatLonFromUrl("http://localhost/@50.0,139.0");
            expect(result).not.toBeNull();
            expect(result!.lat).toBe(46);
            expect(result!.lon).toBe(139.0);
        });

        it("JAPAN_BOUNDS を下回る経度はクランプされる", () => {
            const result = parseLatLonFromUrl("http://localhost/@35.0,100.0");
            expect(result).not.toBeNull();
            expect(result!.lon).toBe(122);
        });

        it("lat のみ指定の場合は null を返す", () => {
            expect(parseLatLonFromUrl("http://localhost/?lat=35.0")).toBeNull();
        });

        it("lon のみ指定の場合は null を返す", () => {
            expect(parseLatLonFromUrl("http://localhost/?lon=139.0")).toBeNull();
        });

        it("userinfo 内の @ を座標として誤検出しない", () => {
            expect(parseLatLonFromUrl("http://user@host/path")).toBeNull();
        });

        it("クエリ値内の @lat,lon を座標として誤検出しない", () => {
            expect(parseLatLonFromUrl("http://localhost/?ref=@35.0,139.0")).toBeNull();
        });

        it("ハッシュ内の @lat,lon をパースできる", () => {
            const result = parseLatLonFromUrl("http://localhost/#/@35.681236,139.767125");
            expect(result).toEqual({ lat: 35.681236, lon: 139.767125 });
        });
    });

    describe("toAtPath", () => {
        it("パスセグメント文字列を生成する", () => {
            const result = toAtPath(35.681236, 139.767125);
            expect(result).toBe("/@35.681236,139.767125");
        });

        it("小数6桁に丸められる", () => {
            const result = toAtPath(35.6812361234, 139.7671259999);
            expect(result).toBe("/@35.681236,139.767126");
        });
    });

    describe("toAtPath → parseLatLonFromUrl ラウンドトリップ", () => {
        it("生成したパスをパースすると元の座標が復元される", () => {
            const lat = 35.681236;
            const lon = 139.767125;
            const path = toAtPath(lat, lon);
            const parsed = parseLatLonFromUrl(`http://localhost${path}`);
            expect(parsed).toEqual({ lat, lon });
        });

        it("クエリ付きでもラウンドトリップできる", () => {
            const lat = 35.681236;
            const lon = 139.767125;
            const path = toAtPath(lat, lon);
            const parsed = parseLatLonFromUrl(`http://localhost${path}?engine=webgl`);
            expect(parsed).toEqual({ lat, lon });
        });
    });

    describe("createUrlUpdater", () => {
        const originalHistory = globalThis.history;
        const originalLocation = globalThis.location;

        beforeEach(() => {
            jest.useFakeTimers();
            globalThis.history = { replaceState: jest.fn() } as unknown as History;
            globalThis.location = { search: "" } as unknown as Location;
        });

        afterEach(() => {
            jest.useRealTimers();
            globalThis.history = originalHistory;
            globalThis.location = originalLocation;
        });

        it("デバウンス後に history.replaceState が呼ばれる", () => {
            const updater = createUrlUpdater(200);
            updater({
                lat: 35.681236,
                lon: 139.767125,
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });

            expect(history.replaceState).not.toHaveBeenCalled();

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledTimes(1);
            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@35.681236,139.767125,2000,0.00,45.00"
            );
        });

        it("既存のクエリパラメータが保持される", () => {
            globalThis.location = { search: "?engine=webgl" } as unknown as Location;
            const updater = createUrlUpdater(200);
            updater({
                lat: 35.681236,
                lon: 139.767125,
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@35.681236,139.767125,2000,0.00,45.00?engine=webgl"
            );
        });

        it("連続呼び出しは最後の値のみ反映される", () => {
            const updater = createUrlUpdater(200);
            const base = {
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            };
            updater({ lat: 35.0, lon: 139.0, ...base });
            updater({ lat: 36.0, lon: 140.0, ...base });
            updater({ lat: 37.0, lon: 141.0, ...base });

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledTimes(1);
            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@37.000000,141.000000,2000,0.00,45.00"
            );
        });

        it("altitude/azimuth/tilt を含む 5要素 URL を replaceState する (Issue #64)", () => {
            const updater = createUrlUpdater(200);
            updater({
                lat: 35.681236,
                lon: 139.767125,
                altitude: 1500,
                azimuth: 90,
                tilt: 60,
            });

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@35.681236,139.767125,1500,90.00,60.00"
            );
        });
    });

    describe("parseCameraStateFromUrl (Issue #64)", () => {
        it("5要素（lat,lon,alt,az,tilt）をパースできる", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.681236,139.767125,1500,90,60"
            );
            expect(result).toEqual({
                lat: 35.681236,
                lon: 139.767125,
                altitude: 1500,
                azimuth: 90,
                tilt: 60,
            });
        });

        it("4要素（tilt 欠損）はデフォルトの tilt で補完される", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.681236,139.767125,1500,90"
            );
            expect(result).toEqual({
                lat: 35.681236,
                lon: 139.767125,
                altitude: 1500,
                azimuth: 90,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });
        });

        it("3要素（azimuth/tilt 欠損）はデフォルトで補完される", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.681236,139.767125,1500"
            );
            expect(result).toEqual({
                lat: 35.681236,
                lon: 139.767125,
                altitude: 1500,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });
        });

        it("2要素（lat,lon のみ）はカメラ姿勢デフォルトで補完される", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.681236,139.767125"
            );
            expect(result).toEqual({
                lat: 35.681236,
                lon: 139.767125,
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });
        });

        it("クエリフォールバック (?lat=&lon=) もカメラ姿勢デフォルトで補完される", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/?lat=35.681236&lon=139.767125"
            );
            expect(result).toEqual({
                lat: 35.681236,
                lon: 139.767125,
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });
        });

        it("altitude が範囲外の場合はクランプして整数化される", () => {
            const tooHigh = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,999999,0,45"
            );
            expect(tooHigh!.altitude).toBe(CAMERA_URL_LIMITS.altitude.max);

            const tooLow = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,10,0,45"
            );
            expect(tooLow!.altitude).toBe(CAMERA_URL_LIMITS.altitude.min);

            const fractional = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,1234.7,0,45"
            );
            expect(fractional!.altitude).toBe(1235);
        });

        it("tilt が範囲外の場合はクランプされる", () => {
            const tooHigh = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,2000,0,90"
            );
            expect(tooHigh!.tilt).toBe(CAMERA_URL_LIMITS.tilt.max);

            const tooLow = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,2000,0,0"
            );
            expect(tooLow!.tilt).toBe(CAMERA_URL_LIMITS.tilt.min);
        });

        it("azimuth は [0, 360) に正規化される", () => {
            const r720 = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,2000,720,45"
            );
            expect(r720!.azimuth).toBe(0);

            const rNeg = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,2000,-90,45"
            );
            expect(rNeg!.azimuth).toBe(270);
        });

        it("数値以外の altitude/azimuth/tilt が入っても regex 不一致でデフォルト経由で補完される", () => {
            // regex は数値以外にマッチしないため、最初の数値2要素のみがマッチする想定。
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,abc,def,ghi"
            );
            // regex 全体は @lat,lon までしかマッチしないため atMatch[3..5] は undefined
            // → altitude/azimuth/tilt はデフォルト補完される。
            expect(result).toEqual({
                lat: 35.0,
                lon: 139.0,
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });
        });
    });

    describe("clampAltitude / clampTilt / normalizeAzimuth", () => {
        it("clampAltitude は範囲外をクランプし整数化する", () => {
            expect(clampAltitude(0)).toBe(CAMERA_URL_LIMITS.altitude.min);
            expect(clampAltitude(1_000_000)).toBe(CAMERA_URL_LIMITS.altitude.max);
            expect(clampAltitude(1234.7)).toBe(1235);
        });

        it("clampTilt は範囲外をクランプする", () => {
            expect(clampTilt(0)).toBe(CAMERA_URL_LIMITS.tilt.min);
            expect(clampTilt(1000)).toBe(CAMERA_URL_LIMITS.tilt.max);
            expect(clampTilt(45)).toBe(45);
        });

        it("normalizeAzimuth は [0, 360) に畳み込み、NaN は 0 に倒す", () => {
            expect(normalizeAzimuth(720)).toBe(0);
            expect(normalizeAzimuth(-90)).toBe(270);
            expect(normalizeAzimuth(450)).toBe(90);
            expect(normalizeAzimuth(NaN)).toBe(0);
        });
    });

    describe("toAtPath オーバーロード", () => {
        it("数値2引数は 2要素を返す", () => {
            expect(toAtPath(35.681236, 139.767125)).toBe(
                "/@35.681236,139.767125"
            );
        });

        it("LatLon のみのオブジェクトは 2要素を返す", () => {
            expect(toAtPath({ lat: 35.681236, lon: 139.767125 })).toBe(
                "/@35.681236,139.767125"
            );
        });

        it("altitude/azimuth/tilt が含まれる場合は 5要素を返す", () => {
            expect(
                toAtPath({
                    lat: 35.681236,
                    lon: 139.767125,
                    altitude: 1500,
                    azimuth: 90,
                    tilt: 60,
                })
            ).toBe("/@35.681236,139.767125,1500,90.00,60.00");
        });

        it("一部のみ指定された場合も他はデフォルトで補完して 5要素を返す", () => {
            expect(
                toAtPath({ lat: 35.0, lon: 139.0, altitude: 3000 })
            ).toBe("/@35.000000,139.000000,3000,0.00,45.00");
        });
    });
});
