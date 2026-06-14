import { describe, expect, it, jest } from "@jest/globals";
import {
    parseLatLonFromUrl,
    parseCameraStateFromUrl,
    toAtPath,
    createUrlUpdater,
    clampAltitude,
    clampTilt,
    clampZoomLevel,
    normalizeAzimuth,
    extractDemoPathPrefix,
    radiusToZoomLevel,
    zoomLevelToRadius,
    CAMERA_URL_DEFAULTS,
    CAMERA_URL_LIMITS,
    MAP_TYPE_QUERY_KEY,
    parseMapTypeFromUrl,
    withMapTypeInUrl,
    updateMapTypeInUrl,
    VIEW_MODE_QUERY_KEY,
    parseViewModeFromUrl,
    withViewModeInUrl,
    updateViewModeInUrl,
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
            globalThis.location = { pathname: "/", search: "" } as unknown as Location;
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
            globalThis.location = { pathname: "/", search: "?engine=webgl" } as unknown as Location;
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

        it("pathname にデモ識別子（/viewer）が含まれる場合は保持される (Issue #155)", () => {
            globalThis.location = { pathname: "/viewer", search: "" } as unknown as Location;
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
                "/viewer/@35.681236,139.767125,2000,0.00,45.00"
            );
        });

        it("pathname に `.html` 付きデモ識別子がある場合は剥がして書き戻す (Issue #155)", () => {
            globalThis.location = { pathname: "/viewer.html", search: "" } as unknown as Location;
            const updater = createUrlUpdater(200);
            updater({
                lat: 35.0,
                lon: 139.0,
                altitude: CAMERA_URL_DEFAULTS.altitude,
                azimuth: CAMERA_URL_DEFAULTS.azimuth,
                tilt: CAMERA_URL_DEFAULTS.tilt,
            });
            jest.advanceTimersByTime(200);
            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/viewer/@35.000000,139.000000,2000,0.00,45.00"
            );
        });

        it("pathname に既に `@lat,lon` が含まれる場合は新しい値で置き換える (Issue #155)", () => {
            globalThis.location = {
                pathname: "/timelapse/@10.0,20.0,1000,0,30",
                search: "?speed=60",
            } as unknown as Location;
            const updater = createUrlUpdater(200);
            updater({
                lat: 35.0,
                lon: 139.0,
                altitude: 1500,
                azimuth: 90,
                tilt: 60,
            });
            jest.advanceTimersByTime(200);
            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/timelapse/@35.000000,139.000000,1500,90.00,60.00?speed=60"
            );
        });
    });

    describe("extractDemoPathPrefix (Issue #155)", () => {
        it("ルート pathname は空文字を返す", () => {
            expect(extractDemoPathPrefix("/")).toBe("");
        });

        it("`/viewer` はそのまま返す", () => {
            expect(extractDemoPathPrefix("/viewer")).toBe("/viewer");
        });

        it("`/viewer.html` は `.html` を剥がす", () => {
            expect(extractDemoPathPrefix("/viewer.html")).toBe("/viewer");
        });

        it("`/timelapse/@lat,lon,...` は `/timelapse` を返す", () => {
            expect(extractDemoPathPrefix("/timelapse/@35.0,139.0,1500,0,45")).toBe("/timelapse");
        });

        it("`/viewer.html@lat,lon` も `.html` を剥がして `/viewer` を返す", () => {
            expect(extractDemoPathPrefix("/viewer.html@35.0,139.0")).toBe("/viewer");
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
                `http://localhost/@35.0,139.0,${CAMERA_URL_LIMITS.altitude.max + 1},0,45`
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

        // #375: globe では JAPAN_BOUNDS でクランプせず全球の緯度経度を許容する。
        it("terrainEngine=globe では日本域外の緯度経度をクランプしない (#375)", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/viewer/@17.316969,38.639148,18396200,0.00,49.68",
                { terrainEngine: "globe" }
            );
            expect(result).not.toBeNull();
            expect(result!.lat).toBeCloseTo(17.316969, 6);
            expect(result!.lon).toBeCloseTo(38.639148, 6);
        });

        it("terrainEngine=globe でも全球範囲外は WORLD_BOUNDS でクランプされる (#375)", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/viewer/@-120.0,200.0",
                { terrainEngine: "globe" }
            );
            expect(result!.lat).toBe(-90);
            expect(result!.lon).toBe(180);
        });

        it("terrainEngine=planar / 未指定では従来どおり JAPAN_BOUNDS でクランプする (#375)", () => {
            const planar = parseCameraStateFromUrl(
                "http://localhost/viewer/@17.316969,38.639148",
                { terrainEngine: "planar" }
            );
            expect(planar!.lat).toBe(20);
            expect(planar!.lon).toBe(122);

            const noEngine = parseCameraStateFromUrl(
                "http://localhost/viewer/@17.316969,38.639148"
            );
            expect(noEngine!.lat).toBe(20);
            expect(noEngine!.lon).toBe(122);
        });

        // #375: options 未指定でも URL クエリ ?terrainEngine=globe をフォールバック解決する。
        it("options 未指定でも URL の ?terrainEngine=globe でクランプ範囲が全球になる (#375)", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/viewer/@17.316969,38.639148?terrainEngine=globe"
            );
            expect(result!.lat).toBeCloseTo(17.316969, 6);
            expect(result!.lon).toBeCloseTo(38.639148, 6);
        });

        it("options.terrainEngine は URL クエリより優先される (#375)", () => {
            // URL は globe だが options で planar を明示 → JAPAN_BOUNDS でクランプ。
            const result = parseCameraStateFromUrl(
                "http://localhost/viewer/@17.316969,38.639148?terrainEngine=globe",
                { terrainEngine: "planar" }
            );
            expect(result!.lat).toBe(20);
            expect(result!.lon).toBe(122);
        });
    });

    describe("clampAltitude / clampTilt / normalizeAzimuth", () => {
        it("clampAltitude は範囲外をクランプし整数化する", () => {
            expect(clampAltitude(0)).toBe(CAMERA_URL_LIMITS.altitude.min);
            expect(clampAltitude(CAMERA_URL_LIMITS.altitude.max + 1)).toBe(
                CAMERA_URL_LIMITS.altitude.max
            );
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

    describe("parseMapTypeFromUrl (Issue #149)", () => {
        it("?mapType=standard を読み取る", () => {
            expect(parseMapTypeFromUrl("http://localhost/?mapType=standard")).toBe(
                "standard"
            );
        });

        it("?mapType=photo を読み取る", () => {
            expect(parseMapTypeFromUrl("http://localhost/?mapType=photo")).toBe(
                "photo"
            );
        });

        it("大小文字混在も許容して小文字へ正規化する", () => {
            expect(parseMapTypeFromUrl("http://localhost/?mapType=Photo")).toBe(
                "photo"
            );
            expect(parseMapTypeFromUrl("http://localhost/?mapType=STANDARD")).toBe(
                "standard"
            );
        });

        it("空値は null を返す", () => {
            expect(parseMapTypeFromUrl("http://localhost/?mapType=")).toBeNull();
        });

        it("不正値は null を返す", () => {
            expect(parseMapTypeFromUrl("http://localhost/?mapType=satellite")).toBeNull();
        });

        it("欠落は null を返す", () => {
            expect(parseMapTypeFromUrl("http://localhost/")).toBeNull();
        });

        it("不正 URL は null を返す", () => {
            expect(parseMapTypeFromUrl("not a url")).toBeNull();
        });

        it("MAP_TYPE_QUERY_KEY が 'mapType' であること", () => {
            expect(MAP_TYPE_QUERY_KEY).toBe("mapType");
        });
    });

    describe("withMapTypeInUrl (Issue #149)", () => {
        it("既存クエリ (engine 等) を保持して mapType を追記する", () => {
            const result = withMapTypeInUrl(
                "http://localhost/?engine=webgl",
                "photo"
            );
            expect(result).toBe("/?engine=webgl&mapType=photo");
        });

        it("ハッシュを保持する", () => {
            const result = withMapTypeInUrl(
                "http://localhost/path#section",
                "standard"
            );
            expect(result).toBe("/path?mapType=standard#section");
        });

        it("既存の mapType は上書きする", () => {
            const result = withMapTypeInUrl(
                "http://localhost/?mapType=standard",
                "photo"
            );
            expect(result).toBe("/?mapType=photo");
        });

        it("パス（@lat,lon 形式含む）を保持する", () => {
            const result = withMapTypeInUrl(
                "http://localhost/@35.681236,139.767125",
                "photo"
            );
            expect(result).toBe("/@35.681236,139.767125?mapType=photo");
        });
    });

    describe("parseMapTypeFromUrl(withMapTypeInUrl(...)) ラウンドトリップ", () => {
        it.each(["standard", "photo"] as const)(
            "%s を再パースして同値が得られる",
            (value) => {
                const next = withMapTypeInUrl(
                    "http://localhost/?engine=webgl",
                    value
                );
                expect(parseMapTypeFromUrl(`http://localhost${next}`)).toBe(value);
            }
        );
    });

    describe("updateMapTypeInUrl (Issue #149)", () => {
        const originalWindow = (globalThis as { window?: unknown }).window;

        afterEach(() => {
            if (originalWindow === undefined) {
                delete (globalThis as { window?: unknown }).window;
            } else {
                (globalThis as { window?: unknown }).window = originalWindow;
            }
        });

        it("history.replaceState を呼び、?mapType=<value> を含む URL を渡す", () => {
            const replaceSpy = jest.fn();
            (globalThis as { window?: unknown }).window = {
                history: { replaceState: replaceSpy },
                location: { href: "http://localhost/?engine=webgl" },
            };

            updateMapTypeInUrl("photo");

            expect(replaceSpy).toHaveBeenCalledTimes(1);
            const args = replaceSpy.mock.calls[0];
            expect(args[0]).toBeNull();
            expect(args[1]).toBe("");
            expect(args[2]).toBe("/?engine=webgl&mapType=photo");
        });

        it("既存の mapType を上書きする", () => {
            const replaceSpy = jest.fn();
            (globalThis as { window?: unknown }).window = {
                history: { replaceState: replaceSpy },
                location: { href: "http://localhost/?mapType=standard" },
            };

            updateMapTypeInUrl("photo");

            expect(replaceSpy).toHaveBeenCalledWith(
                null,
                "",
                "/?mapType=photo"
            );
        });

        it("typeof window が undefined の環境では何もしない", () => {
            delete (globalThis as { window?: unknown }).window;
            // 例外を投げないことだけ確認
            expect(() => updateMapTypeInUrl("photo")).not.toThrow();
        });
    });

    describe("既存 parseCameraStateFromUrl への mapType の影響なし (Issue #149)", () => {
        it("?mapType=photo が混入してもカメラ状態は解析される", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.681236,139.767125,1500,90,60?mapType=photo"
            );
            expect(result).toEqual({
                lat: 35.681236,
                lon: 139.767125,
                altitude: 1500,
                azimuth: 90,
                tilt: 60,
            });
        });
    });

    describe("parseViewModeFromUrl / withViewModeInUrl (Issue #193)", () => {
        it("?viewMode=3d / 2d を解析できる", () => {
            expect(parseViewModeFromUrl("http://localhost/?viewMode=3d")).toBe(
                "3d",
            );
            expect(parseViewModeFromUrl("http://localhost/?viewMode=2d")).toBe(
                "2d",
            );
        });

        it("大小文字無視で受理する", () => {
            expect(parseViewModeFromUrl("http://localhost/?viewMode=3D")).toBe(
                "3d",
            );
            expect(parseViewModeFromUrl("http://localhost/?viewMode=2D")).toBe(
                "2d",
            );
        });

        it("欠落 / 不正値は null", () => {
            expect(parseViewModeFromUrl("http://localhost/")).toBeNull();
            expect(
                parseViewModeFromUrl("http://localhost/?viewMode=foo"),
            ).toBeNull();
        });

        it("withViewModeInUrl はパス・他クエリ・ハッシュを保持して上書きする", () => {
            expect(
                withViewModeInUrl(
                    "http://localhost/path?engine=webgl2#section",
                    "2d",
                ),
            ).toBe("/path?engine=webgl2&viewMode=2d#section");
            expect(
                withViewModeInUrl(
                    "http://localhost/?viewMode=3d&engine=webgl2",
                    "2d",
                ),
            ).toBe("/?viewMode=2d&engine=webgl2");
        });

        it("VIEW_MODE_QUERY_KEY === 'viewMode'", () => {
            expect(VIEW_MODE_QUERY_KEY).toBe("viewMode");
        });

        it("updateViewModeInUrl は history.replaceState に渡す", () => {
            const originalWindow = (globalThis as { window?: unknown }).window;
            const replaceSpy = jest.fn();
            (globalThis as { window?: unknown }).window = {
                history: { replaceState: replaceSpy },
                location: { href: "http://localhost/?engine=webgl" },
            };
            try {
                updateViewModeInUrl("2d");
                expect(replaceSpy).toHaveBeenCalledTimes(1);
                expect(replaceSpy.mock.calls[0][2]).toBe(
                    "/?engine=webgl&viewMode=2d",
                );
            } finally {
                if (originalWindow === undefined) {
                    delete (globalThis as { window?: unknown }).window;
                } else {
                    (globalThis as { window?: unknown }).window = originalWindow;
                }
            }
        });
    });

    // ---- ズームレベル (Issue #254) ----

    describe("clampZoomLevel", () => {
        it("範囲内はそのまま返す", () => {
            expect(clampZoomLevel(14.5)).toBe(14.5);
        });
        it("下限クランプ", () => {
            expect(clampZoomLevel(3)).toBe(CAMERA_URL_LIMITS.zoomLevel.min);
        });
        it("上限クランプ", () => {
            expect(clampZoomLevel(30)).toBe(CAMERA_URL_LIMITS.zoomLevel.max);
        });
    });

    describe("radiusToZoomLevel / zoomLevelToRadius", () => {
        const H = 800;
        const LAT = 35.681;
        const FOV = 0.8;

        it("往復変換で元の radius に戻る", () => {
            const radius = 5000;
            const z = radiusToZoomLevel(radius, H, LAT, FOV);
            const recovered = zoomLevelToRadius(z, H, LAT, FOV);
            expect(recovered).toBeCloseTo(radius, 4);
        });

        it("radius が小さいほどズームレベルが大きい", () => {
            const z1 = radiusToZoomLevel(50, H, LAT, FOV);
            const z2 = radiusToZoomLevel(75000, H, LAT, FOV);
            expect(z1).toBeGreaterThan(z2);
        });

        it("canvas が高いほど同じ radius で大きなズームレベル", () => {
            const z1 = radiusToZoomLevel(1000, 600, LAT, FOV);
            const z2 = radiusToZoomLevel(1000, 1200, LAT, FOV);
            expect(z2).toBeGreaterThan(z1);
        });
    });

    describe("parseCameraStateFromUrl – ズームレベル形式", () => {
        it("@lat,lon,14.50z をパースできる", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.681236,139.767125,14.50z",
            );
            expect(result).not.toBeNull();
            expect(result!.zoomLevel).toBeCloseTo(14.5, 2);
            expect(result!.azimuth).toBe(CAMERA_URL_DEFAULTS.azimuth);
            expect(result!.tilt).toBe(CAMERA_URL_DEFAULTS.tilt);
        });

        it("整数ズームレベル @lat,lon,12z をパースできる", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,12z",
            );
            expect(result).not.toBeNull();
            expect(result!.zoomLevel).toBe(12);
        });

        it("ズームレベルが上限を超える場合はクランプされる", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,99z",
            );
            expect(result).not.toBeNull();
            expect(result!.zoomLevel).toBe(CAMERA_URL_LIMITS.zoomLevel.max);
        });

        it("ズームレベルが下限未満の場合はクランプされる", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,1z",
            );
            expect(result).not.toBeNull();
            expect(result!.zoomLevel).toBe(CAMERA_URL_LIMITS.zoomLevel.min);
        });

        it("通常の altitude 形式では zoomLevel が undefined", () => {
            const result = parseCameraStateFromUrl(
                "http://localhost/@35.0,139.0,2000,0,45",
            );
            expect(result).not.toBeNull();
            expect(result!.zoomLevel).toBeUndefined();
            expect(result!.altitude).toBe(2000);
        });
    });

    describe("toAtPath – ズームレベル形式", () => {
        it("zoomLevel が指定されている場合、@lat,lon,Xz を出力する", () => {
            const path = toAtPath({
                lat: 35.681236,
                lon: 139.767125,
                zoomLevel: 14.5,
            });
            expect(path).toBe("/@35.681236,139.767125,14.50z");
        });

        it("zoomLevel がクランプされる", () => {
            const path = toAtPath({
                lat: 35.0,
                lon: 139.0,
                zoomLevel: 99,
            });
            expect(path).toContain(`${CAMERA_URL_LIMITS.zoomLevel.max}.00z`);
        });

        it("zoomLevel 未指定で altitude がある場合は従来形式", () => {
            const path = toAtPath({
                lat: 35.0,
                lon: 139.0,
                altitude: 2000,
                azimuth: 0,
                tilt: 45,
            });
            expect(path).toBe("/@35.000000,139.000000,2000,0.00,45.00");
        });

        it("prefix 付きズームレベル形式", () => {
            const path = toAtPath(
                {
                    lat: 35.681236,
                    lon: 139.767125,
                    zoomLevel: 12.0,
                },
                "/viewer",
            );
            expect(path).toBe("/viewer/@35.681236,139.767125,12.00z");
        });
    });
});
