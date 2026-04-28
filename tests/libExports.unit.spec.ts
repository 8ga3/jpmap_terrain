/**
 * @jest-environment jsdom
 */
/**
 * パッケージエントリ (`src/lib.ts`) の re-export 検証 (T8 / Issue #122)。
 *
 * 公開 API として spec/package.md §3 に記載した識別子が
 * パッケージのトップレベルから参照できることを保証する。
 *
 * 値 export (`JpmapTerrain`) は実体を import し、
 * 型 export は import 句で参照されることを TS コンパイラに任せる
 * （typecheck が通ればこのテストファイルは成立する）。
 */

import { describe, it, expect } from "@jest/globals";

import * as pkg from "../src/lib";
import type {
    CameraChangeEvent,
    CameraChangeListener,
    EngineType,
    FlyToOptions,
    JpmapTerrainOptions,
    MapType,
    AltitudeMode,
    PolygonPointOptions,
    PolygonStyleOptions,
    PolygonOptions,
    PolygonUpdate,
    PolygonHandle,
} from "../src/lib";

describe("package entry exports (T8)", () => {
    it("JpmapTerrain クラスがトップレベルから export されている", () => {
        expect(typeof pkg.JpmapTerrain).toBe("function");
        // クラスとしての名称
        expect(pkg.JpmapTerrain.name).toBe("JpmapTerrain");
    });

    it("公開型 (EngineType / MapType / JpmapTerrainOptions / FlyToOptions) が import できる（typecheck）", () => {
        // 型は実行時に存在しないため、ダミー変数で参照を持たせる。
        const engine: EngineType = "webgpu";
        const map: MapType = "standard";
        const opts: JpmapTerrainOptions = { engine, mapType: map };
        const fly: FlyToOptions = { lat: 0, lon: 0 };

        expect(engine).toBe("webgpu");
        expect(map).toBe("standard");
        expect(opts.engine).toBe("webgpu");
        expect(fly.lat).toBe(0);
    });

    it("CameraChangeEvent / CameraChangeListener 型が import できる（typecheck）", () => {
        const event: CameraChangeEvent = {
            lat: 35.681236,
            lon: 139.767125,
            altitude: 2000,
            azimuth: 0,
            tilt: 45,
        };
        let received: CameraChangeEvent | null = null;
        const listener: CameraChangeListener = (e) => {
            received = e;
        };
        listener(event);
        expect(received).toEqual(event);
    });

    // #170: ポリゴン公開型 (AltitudeMode / PolygonPointOptions / PolygonStyleOptions /
    // PolygonOptions / PolygonUpdate / PolygonHandle) がパッケージエントリから import 可能であること。
    it("ポリゴン公開型 (Issue #170) がパッケージエントリから import できる（typecheck）", () => {
        const altitudeMode: AltitudeMode = "terrain";
        const point: PolygonPointOptions = { lat: 35.0, lon: 139.0 };
        const style: PolygonStyleOptions = {
            pointColor: "#ff0000",
            lineWidth: 2,
        };
        const opts: PolygonOptions = {
            points: [point, { lat: 35.1, lon: 139.1 }],
            altitudeMode,
            closed: false,
            style,
        };
        const update: PolygonUpdate = { enabled: false };
        // PolygonHandle は実装が返すスナップショット型であり、テストでは形だけ検証する。
        const handleShape: Pick<PolygonHandle, "id" | "altitudeMode"> = {
            id: "p1",
            altitudeMode,
        };

        expect(opts.points.length).toBe(2);
        expect(update.enabled).toBe(false);
        expect(handleShape.id).toBe("p1");
        expect(style.pointColor).toBe("#ff0000");
    });
});
