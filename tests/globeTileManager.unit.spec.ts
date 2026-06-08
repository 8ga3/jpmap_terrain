/**
 * geo/globeTileManager のユニットテスト (Issue #275 Phase 1)。
 *
 * Babylon の GPU 系（Scene/Mesh/VertexData/StandardMaterial/Texture/Color3）はモックし、
 * 座標計算（ecef/mapping/globeLod/globeMesh）は実物のまま動かして、マネージャの状態遷移を検証する:
 * - geom 標高が揃うとメッシュを 1 枚生成する（テクスチャ onLoad で diffuseTexture を設定）
 * - 不要になったタイルのメッシュを dispose する
 * - 取得失敗はバックオフし、直後の sync では再取得しない（連打しない）
 * - アンロード後に遅延 resolve した結果は無視され、再選択時に再取得される
 * - テクスチャ onError でテクスチャを dispose する
 * - 選択が不変なら既存メッシュを再構築しない
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ---- Babylon GPU 系モック（GL コンテキスト不要にする） ----
jest.unstable_mockModule("@babylonjs/core/scene", () => ({ Scene: class {} }));

jest.unstable_mockModule("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: jest.fn<(name: string) => unknown>().mockImplementation((name) => {
        let disposed = false;
        return {
            name,
            position: { copyFrom: jest.fn() },
            material: null as unknown,
            isDisposed: () => disposed,
            dispose: jest.fn(() => {
                disposed = true;
            }),
        };
    }),
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/mesh.vertexData", () => ({
    VertexData: class {
        positions: number[] = [];
        indices: number[] = [];
        normals: number[] = [];
        uvs: number[] = [];
        applyToMesh = jest.fn();
        static ComputeNormals: jest.Mock = jest.fn();
    },
}));

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: jest.fn().mockImplementation(() => ({
        diffuseTexture: null as unknown,
        specularColor: null as unknown,
        backFaceCulling: true,
        dispose: jest.fn(),
    })),
}));

interface CapturedTexture {
    dispose: jest.Mock;
    wrapU: number;
    wrapV: number;
    onLoad?: () => void;
    onError?: (msg?: string, ex?: unknown) => void;
}
const capturedTextures: CapturedTexture[] = [];

jest.unstable_mockModule("@babylonjs/core/Materials/Textures/texture", () => {
    const TextureMock = jest
        .fn()
        .mockImplementation((...args: unknown[]) => {
            const inst: CapturedTexture = {
                dispose: jest.fn(),
                wrapU: 0,
                wrapV: 0,
                onLoad: args[5] as (() => void) | undefined,
                onError: args[6] as ((msg?: string, ex?: unknown) => void) | undefined,
            };
            capturedTextures.push(inst);
            return inst;
        }) as jest.Mock & { CLAMP_ADDRESSMODE: number; TRILINEAR_SAMPLINGMODE: number };
    TextureMock.CLAMP_ADDRESSMODE = 0;
    TextureMock.TRILINEAR_SAMPLINGMODE = 3;
    return { Texture: TextureMock };
});

jest.unstable_mockModule("@babylonjs/core/Maths/math.color", () => ({
    Color3: jest
        .fn<(r: number, g: number, b: number) => unknown>()
        .mockImplementation((r, g, b) => ({ r, g, b })),
}));

// ---- gsiTile モック（座標は単純な決定的実装、loadElevationTile は制御可能に） ----
// 注: ecef / mapping / math.geospatial.functions / math.vector は実物のまま使う。
jest.unstable_mockModule("../src/terrain/gsiTile", () => ({
    TILE_SIZE: 256,
    clamp: (v: number, min: number, max: number) => Math.min(Math.max(v, min), max),
    toTileXY: jest.fn(() => ({ x: 100, y: 100 })),
    tileCenterLatLon: jest.fn(() => ({ lat: 35, lon: 139 })),
    tileEdgeMeters: jest.fn(() => 1000),
    textureUrl: jest.fn(() => "https://example.com/tile.png"),
    loadElevationTile: jest.fn(() => Promise.resolve(new Float32Array(256 * 256))),
}));

const { createGlobeTileManager } = await import("../src/terrain/geo/globeTileManager");
const { geodeticToEcef } = await import("../src/terrain/geo/ecef");
const gsiMock = await import("../src/terrain/gsiTile");
const { Mesh } = await import("@babylonjs/core/Meshes/mesh");

const loadElevationTile = gsiMock.loadElevationTile as jest.Mock;
const toTileXY = gsiMock.toTileXY as jest.Mock;
const MeshMock = Mesh as unknown as jest.Mock;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const centerEcef = geodeticToEcef(35, 139, 0);
const cameraEcef = geodeticToEcef(35, 139, 60000);

/** root 1 タイル・分割なしの決定的な sync パラメータ。 */
const syncParams = () => ({
    cameraEcef,
    centerEcef,
    maxZoom: 10, // minZoom と同じにして分割を起こさない
    viewportHeight: 1080,
    verticalFov: 0.8,
    sseThreshold: 1e9, // 必ず root で受容
    maxTiles: 10,
    rootSearchRadius: 0, // root 1 タイルのみ
    maxRootTiles: 10,
    horizonDotThreshold: -1, // 地平線カリング無効
    referenceAltitude: 0,
});

const makeManager = () =>
    createGlobeTileManager({
        scene: {} as never,
        mapType: "std",
        minZoom: 10,
        geomMaxZoom: 15,
        segments: 2,
        snapEnabled: false,
    });

beforeEach(() => {
    capturedTextures.length = 0;
    MeshMock.mockClear();
    loadElevationTile.mockReset();
    loadElevationTile.mockImplementation(() => Promise.resolve(new Float32Array(256 * 256)));
    toTileXY.mockReset();
    toTileXY.mockReturnValue({ x: 100, y: 100 });
});

describe("createGlobeTileManager", () => {
    it("geom 標高が揃うとメッシュを 1 枚生成し、テクスチャ onLoad で diffuseTexture を設定", async () => {
        const mgr = makeManager();
        const s1 = mgr.sync(syncParams());
        // 1 タイル選択、まだロード中でメッシュ未生成。
        expect(s1.selected.length).toBe(1);
        expect(MeshMock).toHaveBeenCalledTimes(0);
        expect(loadElevationTile).toHaveBeenCalledTimes(1);

        await flush();
        const s2 = mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
        expect(s2.loadedCount).toBe(1);

        // onLoad 前は diffuseTexture 未設定、onLoad 後に設定される。
        const tex = capturedTextures[0];
        const mesh = MeshMock.mock.results[0].value as { material: { diffuseTexture: unknown } };
        expect(mesh.material.diffuseTexture).toBeNull();
        tex.onLoad?.();
        expect(mesh.material.diffuseTexture).toBe(tex);
    });

    it("不要になったタイルのメッシュを dispose する", async () => {
        const mgr = makeManager();
        toTileXY.mockReturnValue({ x: 100, y: 100 });
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // メッシュ A 生成
        const meshA = MeshMock.mock.results[0].value as { dispose: jest.Mock };
        expect(MeshMock).toHaveBeenCalledTimes(1);

        // 別タイルへ移動 → A は不要に。
        toTileXY.mockReturnValue({ x: 200, y: 200 });
        mgr.sync(syncParams());
        expect(meshA.dispose).toHaveBeenCalledWith(false, true);
    });

    it("取得失敗はバックオフし、直後の sync では再取得しない", async () => {
        loadElevationTile.mockImplementation(() => Promise.reject(new Error("fetch failed")));
        const mgr = makeManager();
        mgr.sync(syncParams());
        expect(loadElevationTile).toHaveBeenCalledTimes(1);
        await flush();
        // 直後の sync ではバックオフ中なので再取得しない。
        mgr.sync(syncParams());
        expect(loadElevationTile).toHaveBeenCalledTimes(1);
        expect(MeshMock).toHaveBeenCalledTimes(0);
    });

    it("アンロード後に遅延 resolve した結果は無視され、再選択時に再取得する", async () => {
        // resolve を保留できる deferred。
        let resolveFn: (v: Float32Array) => void = () => {};
        loadElevationTile.mockImplementationOnce(
            () => new Promise<Float32Array>((res) => { resolveFn = res; }),
        );
        const mgr = makeManager();
        toTileXY.mockReturnValue({ x: 100, y: 100 });
        const s1 = mgr.sync(syncParams()); // タイル100 をロード中（保留）
        expect(s1.loadingCount).toBe(1);
        expect(loadElevationTile).toHaveBeenCalledTimes(1);

        // 別タイルへ移動 → 100 は loading から外れる。
        toTileXY.mockReturnValue({ x: 200, y: 200 });
        mgr.sync(syncParams());

        // 保留していた 100 の取得を今 resolve（アンロード後）→ ゲートで無視されキャッシュされない。
        resolveFn(new Float32Array(256 * 256));
        await flush();

        // 100 に戻ると、キャッシュされていないので再取得が発生する。
        toTileXY.mockReturnValue({ x: 100, y: 100 });
        mgr.sync(syncParams());
        // 呼び出し: タイル100(1回目) + タイル200 + タイル100(再取得) = 3 回。
        expect(loadElevationTile).toHaveBeenCalledTimes(3);
    });

    it("テクスチャ onError でテクスチャを dispose する", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        const tex = capturedTextures[0];
        tex.onError?.("load error");
        expect(tex.dispose).toHaveBeenCalled();
    });

    it("選択が不変なら既存メッシュを再構築しない", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // 1 枚生成
        expect(MeshMock).toHaveBeenCalledTimes(1);
        // 同じ選択で再 sync しても再構築しない。
        mgr.sync(syncParams());
        mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
    });

    it("dispose で全メッシュを破棄する", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        const mesh = MeshMock.mock.results[0].value as { dispose: jest.Mock };
        mgr.dispose();
        expect(mesh.dispose).toHaveBeenCalledWith(false, true);
    });
});
