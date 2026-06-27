/**
 * @jest-environment jsdom
 *
 * globe バックエンドの 2D/3D 視点モード 統合テスト。
 *
 * NullEngine + jsdom で `GlobeScene.createSceneWithController` を実体構築し、
 * GeospatialCamera の ORTHOGRAPHIC 切替・pitch=0 トップダウン・ortho フラスタム・
 * zoomLevel 整合・3D⇄2D 往復での lat/lon/azimuth 保存・onViewModeChange の発火条件・
 * タイルマネージャ共有（同一インスタンス維持）を検証する。3DCG の見た目は別ゲート（HITL）。
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Camera } from "@babylonjs/core/Cameras/camera";

import { GlobeScene, type GlobeSceneController } from "../src/scenes/globe";
import { ecefToGeodetic, geodeticToEcef } from "../src/terrain/geo/ecef";
import { radiusToZoomLevel, zoomLevelToRadius } from "../src/terrain/urlState";

const RENDER_W = 800;
const RENDER_H = 600;

const makeEngine = (): NullEngine =>
    new NullEngine({
        renderWidth: RENDER_W,
        renderHeight: RENDER_H,
        deterministicLockstep: false,
        lockstepMaxSteps: 1,
        textureSize: 512,
    });

interface Built {
    gc: GlobeSceneController;
    teardown: () => void;
}

// 構築済みインスタンスの teardown を登録し、afterEach で必ず回収する。expect 失敗で個別
// teardown が呼ばれず例外終了しても Engine/Scene を残さない（テスト間副作用・リーク防止）。
const activeTeardowns: Array<() => void> = [];

const build = (
    options: Parameters<GlobeScene["createSceneWithController"]>[2] = {},
): Built => {
    const engine = makeEngine();
    const canvas = document.createElement("canvas");
    const gc = new GlobeScene().createSceneWithController(engine, canvas, options);
    // teardown は idempotent。手動呼び出しと afterEach の二重実行でも一度だけ dispose する。
    let torn = false;
    const teardown = (): void => {
        if (torn) return;
        torn = true;
        gc.dispose();
        engine.dispose();
    };
    activeTeardowns.push(teardown);
    return { gc, teardown };
};

afterEach(() => {
    for (const teardown of activeTeardowns.splice(0)) teardown();
});

describe("globe 視点モード 2D/3D", () => {
    it("既定は 3d（perspective）で getZoomLevel は undefined", () => {
        const { gc, teardown } = build();
        expect(gc.getViewMode()).toBe("3d");
        expect(gc.camera.mode).toBe(Camera.PERSPECTIVE_CAMERA);
        expect(gc.getZoomLevel()).toBeUndefined();
        teardown();
    });

    it("setViewMode('2d') で ORTHOGRAPHIC + pitch=0 + ortho フラスタムになる", () => {
        const { gc, teardown } = build({ lat: 35.36, lon: 138.73, radius: 60000 });
        gc.setViewMode("2d");
        expect(gc.getViewMode()).toBe("2d");
        expect(gc.camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
        // GeospatialCamera は pitch を limits.pitchMin（極小値）でクランプする（≈0=トップダウン）。
        expect(gc.camera.pitch).toBeLessThan(0.01);
        // ortho フラスタムが radius・アスペクトから設定される。
        const aspect = RENDER_W / RENDER_H;
        const halfH = gc.camera.radius * Math.tan(gc.camera.fov / 2);
        expect(gc.camera.orthoTop).toBeCloseTo(halfH, 3);
        expect(gc.camera.orthoBottom).toBeCloseTo(-halfH, 3);
        expect(gc.camera.orthoRight).toBeCloseTo(halfH * aspect, 3);
        expect(gc.camera.orthoLeft).toBeCloseTo(-halfH * aspect, 3);
        teardown();
    });

    it("getZoomLevel は 2D 時のみ radiusToZoomLevel と整合する", () => {
        const { gc, teardown } = build({ lat: 35.36, lon: 138.73, radius: 60000 });
        // 3D 時は undefined。
        expect(gc.getZoomLevel()).toBeUndefined();
        gc.setViewMode("2d");
        const g = ecefToGeodetic(gc.camera.center);
        const expected = radiusToZoomLevel(
            gc.camera.radius,
            RENDER_H,
            g.latDeg,
            gc.camera.fov,
        );
        expect(gc.getZoomLevel()).toBeCloseTo(expected, 6);
        teardown();
    });

    it("3D⇄2D 往復で lat/lon/azimuth(yaw) と pitch が保存される", () => {
        const { gc, teardown } = build({
            lat: 35.36,
            lon: 138.73,
            radius: 60000,
            azimuth: 30,
            tilt: 55,
        });
        const before = ecefToGeodetic(gc.camera.center);
        const yawBefore = gc.camera.yaw;
        const pitchBefore = gc.camera.pitch;

        gc.setViewMode("2d");
        // 2D 中は yaw（方位）を保持しつつ pitch はトップダウンへ。
        expect(gc.camera.yaw).toBeCloseTo(yawBefore, 6);

        gc.setViewMode("3d");
        const after = ecefToGeodetic(gc.camera.center);
        expect(after.latDeg).toBeCloseTo(before.latDeg, 6);
        expect(after.lonDeg).toBeCloseTo(before.lonDeg, 6);
        expect(gc.camera.yaw).toBeCloseTo(yawBefore, 6);
        // pitch（tilt）は 3D 復帰時に復元される。
        expect(gc.camera.pitch).toBeCloseTo(pitchBefore, 6);
        expect(gc.camera.mode).toBe(Camera.PERSPECTIVE_CAMERA);
        teardown();
    });

    it("onViewModeChange は実変化時のみ発火する", () => {
        const onViewModeChange = jest.fn();
        const { gc, teardown } = build({ onViewModeChange });
        // 同値（3d→3d）は発火しない。
        gc.setViewMode("3d");
        expect(onViewModeChange).not.toHaveBeenCalled();
        // 3d→2d で 1 回。
        gc.setViewMode("2d");
        expect(onViewModeChange).toHaveBeenCalledTimes(1);
        expect(onViewModeChange).toHaveBeenLastCalledWith("2d");
        // 2d→2d は発火しない。
        gc.setViewMode("2d");
        expect(onViewModeChange).toHaveBeenCalledTimes(1);
        // 2d→3d で 1 回。
        gc.setViewMode("3d");
        expect(onViewModeChange).toHaveBeenCalledTimes(2);
        expect(onViewModeChange).toHaveBeenLastCalledWith("3d");
        teardown();
    });

    it("初期 viewMode='2d' + zoomLevel で radius が zoomLevelToRadius と整合する", () => {
        const zoomLevel = 14.5;
        const { gc, teardown } = build({
            lat: 35.36,
            lon: 138.73,
            viewMode: "2d",
            zoomLevel,
        });
        expect(gc.getViewMode()).toBe("2d");
        expect(gc.camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
        const g = ecefToGeodetic(gc.camera.center);
        const expectedRadius = zoomLevelToRadius(
            zoomLevel,
            RENDER_H,
            g.latDeg,
            gc.camera.fov,
        );
        expect(gc.camera.radius).toBeCloseTo(expectedRadius, 3);
        // radius 更新後に ortho フラスタムが再同期され、新 radius と整合する（初期化直後の
        // 1 フレーム不整合を防ぐ）。
        const aspect = RENDER_W / RENDER_H;
        const halfH = expectedRadius * Math.tan(gc.camera.fov / 2);
        expect(gc.camera.orthoTop).toBeCloseTo(halfH, 3);
        expect(gc.camera.orthoBottom).toBeCloseTo(-halfH, 3);
        expect(gc.camera.orthoRight).toBeCloseTo(halfH * aspect, 3);
        expect(gc.camera.orthoLeft).toBeCloseTo(-halfH * aspect, 3);
        // 往復しても zoomLevel が整合する。
        expect(gc.getZoomLevel()).toBeCloseTo(zoomLevel, 6);
        teardown();
    });

    it("初期 viewMode='2d' でも onViewModeChange は初期化では発火しない（silent）", () => {
        const onViewModeChange = jest.fn();
        const { gc, teardown } = build({ viewMode: "2d", onViewModeChange });
        expect(gc.getViewMode()).toBe("2d");
        expect(onViewModeChange).not.toHaveBeenCalled();
        teardown();
    });

    it("タイルマネージャは 2D/3D 切替で同一インスタンスを共有する（再生成しない）", () => {
        const { gc, teardown } = build({ lat: 35.36, lon: 138.73 });
        const tm = gc.tileManager;
        gc.setViewMode("2d");
        expect(gc.tileManager).toBe(tm);
        gc.setViewMode("3d");
        expect(gc.tileManager).toBe(tm);
        teardown();
    });

    it("setViewMode('2d') 直後（描画フレーム前）にオーバーレイを再アンカーして接地する", () => {
        const { gc, teardown } = build({ lat: 35.36, lon: 138.73, radius: 60000 });
        const pts = [
            { lat: 35.36, lon: 138.73 },
            { lat: 35.37, lon: 138.74 },
            { lat: 35.36, lon: 138.75 },
        ];
        // 3D で absolute 高度 1000m のポリゴンを追加（この時点では elevs=1000）。
        gc.polygonManager.add({
            points: pts.map((p) => ({ ...p, altitude: 1000 })),
            altitudeMode: "absolute",
        });
        // 描画フレームを進めずに 2D へ切替。切替直後の再アンカーで pick 点が接地(elev≈0)している
        // ことを確認する（再アンカーが無いと次フレームまで elev=1000 のままで 1 フレーム不整合）。
        gc.setViewMode("2d");
        const picks: {
            polygonId: string;
            index: number;
            x: number;
            y: number;
            z: number;
            radius: number;
        }[] = [];
        const n = gc.polygonManager.getPickablePoints(picks);
        expect(n).toBe(pts.length);
        for (let i = 0; i < n; i++) {
            const p = pts[picks[i].index];
            const e = geodeticToEcef(p.lat, p.lon, 0);
            const d = Math.hypot(picks[i].x - e.x, picks[i].y - e.y, picks[i].z - e.z);
            // 接地済みなら elev=0 の楕円体表面とほぼ一致（未接地なら高度 1000m ぶんずれる）。
            expect(d).toBeLessThan(1);
        }
        teardown();
    });
});
