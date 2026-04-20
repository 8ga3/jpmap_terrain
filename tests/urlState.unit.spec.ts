import { describe, expect, it, jest } from "@jest/globals";
import { parseLatLonFromUrl, toAtPath, createUrlUpdater } from "../src/terrain/urlState";

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

        it("負の経度を含むパスをパースできる", () => {
            const result = parseLatLonFromUrl("http://localhost/@35.0,-139.0");
            expect(result).toEqual({ lat: 35.0, lon: expect.closeTo(122, 0) });
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
            updater(35.681236, 139.767125);

            expect(history.replaceState).not.toHaveBeenCalled();

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledTimes(1);
            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@35.681236,139.767125"
            );
        });

        it("既存のクエリパラメータが保持される", () => {
            globalThis.location = { search: "?engine=webgl" } as unknown as Location;
            const updater = createUrlUpdater(200);
            updater(35.681236, 139.767125);

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@35.681236,139.767125?engine=webgl"
            );
        });

        it("連続呼び出しは最後の値のみ反映される", () => {
            const updater = createUrlUpdater(200);
            updater(35.0, 139.0);
            updater(36.0, 140.0);
            updater(37.0, 141.0);

            jest.advanceTimersByTime(200);

            expect(history.replaceState).toHaveBeenCalledTimes(1);
            expect(history.replaceState).toHaveBeenCalledWith(
                null,
                "",
                "/@37.000000,141.000000"
            );
        });
    });
});
