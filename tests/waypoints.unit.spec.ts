/**
 * `src/demos/flight/waypoints.ts` の unit test (Issue #274)。
 *
 * ウェイポイント管理ロジック（arcDistance 等）をテストする。
 * Babylon.js の Scene/Mesh 依存部分はモック化。
 *
 * ESM + jest.unstable_mockModule で完全にモジュールを分離して
 * 他テストとのキャッシュ衝突を回避する。
 */
import { describe, it, expect, jest, beforeAll } from "@jest/globals";
import type { Scene } from "@babylonjs/core/scene";

// ESM環境のモック: jest.unstable_mockModule を使い、動的 import でテスト対象を取得

jest.unstable_mockModule("@babylonjs/core/Meshes/Builders/discBuilder", () => ({
    CreateDisc: jest.fn(() => {
        const scaling = { x: 1, y: 1, z: 1, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } };
        return {
            material: null,
            isPickable: false,
            alwaysSelectAsActiveMesh: false,
            rotation: { x: 0, y: 0, z: 0 },
            position: { x: 0, y: 0, z: 0, set: jest.fn(), copyFrom: jest.fn(), clone: jest.fn(() => ({ x: 0, y: 0, z: 0 })) },
            visibility: 1,
            scaling,
            enabled: true,
            dispose: jest.fn(),
            setEnabled(v: boolean) { this.enabled = v; },
        };
    }),
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: class {},
}));

jest.unstable_mockModule("@babylonjs/core/Materials/shaderMaterial", () => ({
    ShaderMaterial: jest.fn(() => ({
        setFloat: jest.fn(), dispose: jest.fn(), backFaceCulling: false, alpha: 1,
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/effect", () => ({
    Effect: { ShadersStore: {} },
}));

jest.unstable_mockModule("@babylonjs/core/Particles/particleSystem", () => ({
    ParticleSystem: jest.fn(() => ({
        particleTexture: null, emitter: null,
        minEmitBox: null, maxEmitBox: null,
        color1: null, color2: null, colorDead: null,
        minSize: 0, maxSize: 0, minLifeTime: 0, maxLifeTime: 0,
        minEmitPower: 0, maxEmitPower: 0, emitRate: 0,
        gravity: null, targetStopDuration: 0, disposeOnStop: false,
        start: jest.fn(),
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color4: jest.fn(),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.vector", () => ({
    Vector3: jest.fn((x = 0, y = 0, z = 0) => ({ x, y, z })),
    Quaternion: jest.fn(() => ({ copyFrom: jest.fn(), clone: jest.fn(() => ({ _quat: true, copyFrom: jest.fn() })) })),
}));

jest.unstable_mockModule("../src/terrain/geo/ecef", () => ({
    geodeticToEcefToRef: jest.fn(),
    DEG2RAD: Math.PI / 180,
}));

jest.unstable_mockModule("../src/terrain/geo/overlayPlacement", () => ({
    surfaceOrientationToRef: jest.fn(() => false),
}));

jest.unstable_mockModule("@babylonjs/core/Materials/Textures/texture", () => ({
    Texture: jest.fn(),
}));

jest.unstable_mockModule("../src/demos/flight/waypointShader", () => ({
    createWaypointMaterial: jest.fn(() => ({
        setFloat: jest.fn(), dispose: jest.fn(), backFaceCulling: false, alpha: 1,
    })),
    updateWaypointMaterialTime: jest.fn(),
}));

jest.unstable_mockModule("../src/demos/flight/waypointEffect", () => ({
    createPassEffect: jest.fn(),
}));

const createMockScene = (): Scene => ({
    getTransformNodeByName: jest.fn((): unknown => ({
        getChildMeshes: jest.fn(() => [
            {
                computeWorldMatrix: jest.fn(),
                absolutePosition: { x: 0, y: 100, z: 0 },
            },
        ]),
    })),
}) as unknown as Scene;

describe("createWaypointManager", () => {
    let createWaypointManager: typeof import("../src/demos/flight/waypoints").createWaypointManager;
    let CreateDiscMock: jest.Mock;
    let geodeticToEcefToRefMock: jest.Mock;
    let surfaceOrientationToRefMock: jest.Mock;

    beforeAll(async () => {
        const waypoints = await import("../src/demos/flight/waypoints");
        createWaypointManager = waypoints.createWaypointManager;

        const discModule = await import("@babylonjs/core/Meshes/Builders/discBuilder");
        CreateDiscMock = discModule.CreateDisc as unknown as jest.Mock;

        const ecefModule = await import("../src/terrain/geo/ecef");
        geodeticToEcefToRefMock = ecefModule.geodeticToEcefToRef as unknown as jest.Mock;

        const overlayModule = await import("../src/terrain/geo/overlayPlacement");
        surfaceOrientationToRefMock = overlayModule.surfaceOrientationToRef as unknown as jest.Mock;
    });

    it("creates a WaypointManager with update/reset/dispose", () => {
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        expect(mgr).toBeDefined();
        expect(typeof mgr.update).toBe("function");
        expect(typeof mgr.reset).toBe("function");
        expect(typeof mgr.dispose).toBe("function");
    });

    it("reset creates waypoints based on radius", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
        });

        // 2000m 半径 → 周長 ≈ 12566m → 12566/600 ≈ 20 → cap at MAX_WAYPOINT_COUNT=10
        const expectedCount = Math.min(
            Math.floor((2 * Math.PI * 2000) / 600),
            10,
        );
        expect(CreateDiscMock).toHaveBeenCalledTimes(expectedCount);
    });

    it("reset caps waypoints at MAX_WAYPOINTS", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 50000,
            altitudeM: 2000,
            angleDeg: 0,
        });
        expect(CreateDiscMock).toHaveBeenCalledTimes(10);
    });

    it("dispose cleans up without error", () => {
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
        });
        expect(() => mgr.dispose()).not.toThrow();
    });

    it("update does not throw when no model node found", () => {
        const scene = createMockScene();
        scene.getTransformNodeByName = jest.fn(() => null);
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
        });
        expect(() =>
            mgr.update(
                {
                    centerLat: 35.68,
                    centerLon: 139.77,
                    radiusM: 2000,
                    altitudeM: 2000,
                    angleDeg: 10,
                },
                1000,
            ),
        ).not.toThrow();
    });

    // Issue #274 PR #277 レビュー指摘: 通過 → フェード → 復活で state がリセットされることを検証
    it("regenerates waypoint after pass: passed/fadeAlpha/visibility/scaling reset", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        const radiusM = 2000;
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM,
            altitudeM: 2000,
            angleDeg: 0,
        });

        // CreateDisc が返した最初のメッシュインスタンス（先頭ウェイポイント）
        const firstMesh = CreateDiscMock.mock.results[0].value as {
            visibility: number;
            scaling: { x: number; y: number; z: number };
            enabled: boolean;
        };

        // 先頭ウェイポイントは ctx.angleDeg + offsetDeg ≈ 8.594° (radius=2000, offset=300m)
        // 通過判定: |dist| < PASS_THRESHOLD_M(40m) かつ ahead=true
        // 飛行機角度を 8.594° の少し手前 (8.5°) に置き、約 3.3m 手前 → ahead+dist<40m で通過
        const passingAngle = 8.5;

        // 第1フレーム: lastTime=0 のため dt=0.016 既定。通過判定発火。
        mgr.update(
            {
                centerLat: 35.68,
                centerLon: 139.77,
                radiusM,
                altitudeM: 2000,
                angleDeg: passingAngle,
            },
            1000,
        );

        // フェードが完了するまで update を回す (FADE_SPEED=3/sec → ~340ms で完了)
        for (let i = 1; i <= 30; i++) {
            mgr.update(
                {
                    centerLat: 35.68,
                    centerLon: 139.77,
                    radiusM,
                    altitudeM: 2000,
                    angleDeg: passingAngle,
                },
                1000 + i * 20, // 20ms 刻み × 30 = 600ms
            );
        }

        // 復活後の検証: visibility=1, scaling=1, mesh 再有効化されている (フレーム末 setEnabled(true))
        expect(firstMesh.visibility).toBe(1);
        expect(firstMesh.scaling.x).toBe(1);
        expect(firstMesh.scaling.y).toBe(1);
        expect(firstMesh.scaling.z).toBe(1);
        expect(firstMesh.enabled).toBe(true);
    });

    // Issue #269: onPass コールバックが通過時に呼ばれること
    it("calls onPass callback when waypoint is passed", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const onPass = jest.fn();
        const mgr = createWaypointManager(scene, { onPass });
        const radiusM = 2000;
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM,
            altitudeM: 2000,
            angleDeg: 0,
        });

        // 先頭ウェイポイントの角度付近まで飛行機を進めて通過判定を発火
        const passingAngle = 8.5;
        mgr.update(
            {
                centerLat: 35.68,
                centerLon: 139.77,
                radiusM,
                altitudeM: 2000,
                angleDeg: passingAngle,
            },
            1000,
        );

        expect(onPass).toHaveBeenCalledTimes(1);
    });

    // Issue #349 P4-3 レビュー指摘: 真 ECEF 配置 + ENU 姿勢の回帰検知。
    // geodeticToEcefToRef が呼ばれ、surfaceOrientationToRef の結果に応じて
    // rotationQuaternion が設定される/されないことを検証する。
    it("globe: geodeticToEcefToRef を呼び、姿勢成功時に rotationQuaternion を設定する", () => {
        CreateDiscMock.mockClear();
        geodeticToEcefToRefMock.mockClear();
        // 姿勢計算が成功するケース
        surfaceOrientationToRefMock.mockReturnValue(true);

        const scene = createMockScene();
        // globe 経路は機体ノードを参照しないため、ノード未取得でも配置されることを保証する。
        scene.getTransformNodeByName = jest.fn(() => null);
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
        });

        const firstMesh = CreateDiscMock.mock.results[0].value as {
            position: { copyFrom: jest.Mock };
            rotationQuaternion?: unknown;
        };

        mgr.update(
            {
                centerLat: 35.68,
                centerLon: 139.77,
                radiusM: 2000,
                altitudeM: 2000,
                angleDeg: 10,
            },
            1000,
        );

        // globe 分岐: 各ウェイポイントの ECEF 変換が呼ばれている
        expect(geodeticToEcefToRefMock).toHaveBeenCalled();
        // mesh.position は ECEF アンカーへ copyFrom される
        expect(firstMesh.position.copyFrom).toHaveBeenCalled();
        // 姿勢成功時は rotationQuaternion が設定される（clone のセンチネルが入る）
        expect(firstMesh.rotationQuaternion).toBeDefined();
    });

    it("globe: surfaceOrientationToRef が失敗すると rotationQuaternion を設定しない", () => {
        CreateDiscMock.mockClear();
        geodeticToEcefToRefMock.mockClear();
        // 姿勢計算が退化（極など）で失敗するケース
        surfaceOrientationToRefMock.mockReturnValue(false);

        const scene = createMockScene();
        scene.getTransformNodeByName = jest.fn(() => null);
        const mgr = createWaypointManager(scene);
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM: 2000,
            altitudeM: 2000,
            angleDeg: 0,
        });

        const firstMesh = CreateDiscMock.mock.results[0].value as {
            rotationQuaternion?: unknown;
        };

        mgr.update(
            {
                centerLat: 35.68,
                centerLon: 139.77,
                radiusM: 2000,
                altitudeM: 2000,
                angleDeg: 10,
            },
            1000,
        );

        // ECEF 配置は行われるが、姿勢失敗時は rotationQuaternion 未設定のまま
        expect(geodeticToEcefToRefMock).toHaveBeenCalled();
        expect(firstMesh.rotationQuaternion).toBeUndefined();
    });

    it("does not call onPass if options not provided", () => {
        CreateDiscMock.mockClear();
        const scene = createMockScene();
        const mgr = createWaypointManager(scene);
        const radiusM = 2000;
        mgr.reset({
            centerLat: 35.68,
            centerLon: 139.77,
            radiusM,
            altitudeM: 2000,
            angleDeg: 0,
        });

        // 通過しても例外が発生しないこと（コールバックなし）
        expect(() =>
            mgr.update(
                {
                    centerLat: 35.68,
                    centerLon: 139.77,
                    radiusM,
                    altitudeM: 2000,
                    angleDeg: 8.5,
                },
                1000,
            ),
        ).not.toThrow();
    });
});
