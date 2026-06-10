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
        let enabled = true;
        return {
            name,
            position: { copyFrom: jest.fn() },
            material: null as unknown,
            isDisposed: () => disposed,
            isEnabled: () => enabled,
            setEnabled: jest.fn((v: boolean) => { enabled = v; }),
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

// ---- globeLod モック（タイル選択を決定的に制御） ----
// マネージャはライフサイクル（ロード/ビルド/破棄）の責務を持つ。選択ロジック（高度/距離適応
// SSE）は globeLod 側の単体テスト（globeLod.unit.spec）でカバーするため、ここでは
// `selectGlobeTiles` をモックし、テストごとに選択タイル集合を直接差し替えて状態遷移を検証する。
interface SelTile {
    zoom: number;
    x: number;
    y: number;
    tileSizeMeters: number;
    distance: number;
}
const tile = (x: number, y: number, zoom = 10): SelTile => ({
    zoom,
    x,
    y,
    tileSizeMeters: 1000,
    distance: 60000,
});
let selectedTiles: SelTile[] = [tile(100, 100)];
jest.unstable_mockModule("../src/terrain/geo/globeLod", () => ({
    selectGlobeTiles: jest.fn(() => selectedTiles),
    tileKey: (z: number, x: number, y: number) => `${z}/${x}/${y}`,
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
    viewportWidth: 1920,
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
    selectedTiles = [tile(100, 100)];
});

describe("createGlobeTileManager", () => {
    it("標高ロード完了後に初めてメッシュを建築し、テクスチャ onLoad で表示する", async () => {
        const mgr = makeManager();
        const s1 = mgr.sync(syncParams());
        // 標高ロード中はメッシュを建築しない（フラット→実標高のチラつきを防ぐ, #330）。
        expect(s1.selected.length).toBe(1);
        expect(MeshMock).toHaveBeenCalledTimes(0);
        expect(loadElevationTile).toHaveBeenCalledTimes(1);
        expect(s1.loadedCount).toBe(0);

        await flush(); // 標高到着
        // 標高揃い → メッシュ生成（テクスチャ読込開始）。
        const s2 = mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
        expect(s2.loadedCount).toBe(1);

        // onLoad 前: 非表示（白色チラつき防止 #330）。
        const tex = capturedTextures[0];
        const mesh = MeshMock.mock.results[0].value as {
            material: { diffuseTexture: unknown };
            isEnabled: () => boolean;
            setEnabled: jest.Mock;
        };
        expect(mesh.material.diffuseTexture).toBeNull();
        expect(mesh.isEnabled()).toBe(false);
        // onLoad 後: diffuseTexture 設定 + 表示。
        tex.onLoad?.();
        expect(mesh.material.diffuseTexture).toBe(tex);
        expect(mesh.isEnabled()).toBe(true);
    });

    it("不要になったタイルのメッシュを dispose する", async () => {
        const mgr = makeManager();
        selectedTiles = [tile(100, 100)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // メッシュ A 生成
        const meshA = MeshMock.mock.results[0].value as { dispose: jest.Mock };
        expect(MeshMock).toHaveBeenCalledTimes(1);

        // 別タイルへ移動 → A は不要に。
        selectedTiles = [tile(200, 200)];
        mgr.sync(syncParams());
        expect(meshA.dispose).toHaveBeenCalledWith(false, true);
    });

    it("取得失敗(no-data)はバックオフし再取得せず、no-data 確定後にフラット建築する", async () => {
        loadElevationTile.mockImplementation(() => Promise.reject(new Error("fetch failed")));
        const mgr = makeManager();
        mgr.sync(syncParams());
        expect(loadElevationTile).toHaveBeenCalledTimes(1);
        // 標高ロード中: まだ失敗が確定していないのでメッシュ未生成。
        expect(MeshMock).toHaveBeenCalledTimes(0);
        await flush(); // 失敗 → failedRetryAt 記録（no-data 確定）
        // no-data 確定後の sync: フラット(海面 0m)でメッシュ生成（恒久欠けを防ぐ）。
        mgr.sync(syncParams());
        expect(loadElevationTile).toHaveBeenCalledTimes(1); // バックオフ中、再取得なし
        expect(MeshMock).toHaveBeenCalledTimes(1);
        // バックオフ中の再 sync でもメッシュを再生成しない。
        mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
    });

    it("アンロード後に遅延 resolve した結果は無視され、再選択時に再取得する", async () => {
        // resolve を保留できる deferred。
        let resolveFn: (v: Float32Array) => void = () => {};
        loadElevationTile.mockImplementationOnce(
            () => new Promise<Float32Array>((res) => { resolveFn = res; }),
        );
        const mgr = makeManager();
        selectedTiles = [tile(100, 100)];
        const s1 = mgr.sync(syncParams()); // タイル100 をロード中（保留）
        expect(s1.loadingCount).toBe(1);
        expect(loadElevationTile).toHaveBeenCalledTimes(1);

        // 別タイルへ移動 → 100 は loading から外れる。
        selectedTiles = [tile(200, 200)];
        mgr.sync(syncParams());

        // 保留していた 100 の取得を今 resolve（アンロード後）→ ゲートで無視されキャッシュされない。
        resolveFn(new Float32Array(256 * 256));
        await flush();

        // 100 に戻ると、キャッシュされていないので再取得が発生する。
        selectedTiles = [tile(100, 100)];
        mgr.sync(syncParams());
        // 呼び出し: タイル100(1回目) + タイル200 + タイル100(再取得) = 3 回。
        expect(loadElevationTile).toHaveBeenCalledTimes(3);
    });

    it("テクスチャ onError でテクスチャを dispose しメッシュを表示する", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        const tex = capturedTextures[0];
        const mesh = MeshMock.mock.results[0].value as {
            isEnabled: () => boolean;
            setEnabled: jest.Mock;
        };
        expect(mesh.isEnabled()).toBe(false); // onLoad/onError 前は非表示
        tex.onError?.("load error");
        expect(tex.dispose).toHaveBeenCalled();
        expect(mesh.isEnabled()).toBe(true); // onError 後は表示（白でもホールより良い）
    });

    it("zoom < minZoom の高高度タイルは標高ロード中でも即時建築する (#330)", async () => {
        // minZoom=10 なので zoom=9 は「高高度・標高不要」扱い。
        selectedTiles = [tile(50, 50, 9)];
        const mgr = makeManager();
        mgr.sync(syncParams());
        // 標高ロード前でも即時建築（高高度では標高が視覚的に無意味）。
        expect(MeshMock).toHaveBeenCalledTimes(1);
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

    // ===== LOD シームレス遷移（Issue #330 / 平面版 #281 同等） =====

    it("zoom-out: 低レベル(親)タイルが描画可能になるまで高レベル(子)タイルを保持する", async () => {
        const mgr = makeManager();
        // zoom 11 の子 4 枚（親 100/100@z10 を完全カバー）。
        selectedTiles = [
            tile(200, 200, 11), tile(201, 200, 11),
            tile(200, 201, 11), tile(201, 201, 11),
        ];
        mgr.sync(syncParams()); // 子の標高ロード
        await flush();
        mgr.sync(syncParams()); // 子 4 枚を建築
        expect(MeshMock).toHaveBeenCalledTimes(4);
        const childMeshes = [0, 1, 2, 3].map(
            (i) => MeshMock.mock.results[i].value as { isEnabled: () => boolean; dispose: jest.Mock },
        );
        // 子のテクスチャ到着 → 表示。
        capturedTextures.slice(0, 4).forEach((t) => t.onLoad?.());
        childMeshes.forEach((m) => expect(m.isEnabled()).toBe(true));

        // zoom-out: 親 z10 へ。親の標高はまだロード中なので親は建築されない。
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        // 子は pendingRelease で保持され、まだ破棄されない（背景球が見えない）。
        childMeshes.forEach((m) => expect(m.dispose).not.toHaveBeenCalled());

        await flush(); // 親の標高到着
        mgr.sync(syncParams()); // 親メッシュ建築（非表示で待機）
        expect(MeshMock).toHaveBeenCalledTimes(5);
        const parentMesh = MeshMock.mock.results[4].value as { isEnabled: () => boolean };
        // 親が描画可能になる前は子をまだ保持。
        childMeshes.forEach((m) => expect(m.dispose).not.toHaveBeenCalled());

        // 親のテクスチャ到着 → 親表示 + 旧子タイルを一斉解放。
        capturedTextures[4].onLoad?.();
        expect(parentMesh.isEnabled()).toBe(true);
        childMeshes.forEach((m) => expect(m.dispose).toHaveBeenCalledWith(false, true));
    });

    it("zoom-in: 新レベル(子)が全て揃うまで旧(親)を保持し、原子的にスワップする", async () => {
        const mgr = makeManager();
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // 親 1 枚を建築
        expect(MeshMock).toHaveBeenCalledTimes(1);
        const parent = MeshMock.mock.results[0].value as { isEnabled: () => boolean; dispose: jest.Mock };
        capturedTextures[0].onLoad?.();
        expect(parent.isEnabled()).toBe(true);

        // zoom-in: 子 4 枚へ。
        selectedTiles = [
            tile(200, 200, 11), tile(201, 200, 11),
            tile(200, 201, 11), tile(201, 201, 11),
        ];
        mgr.sync(syncParams()); // 親 → pendingRelease、子の標高ロード
        expect(parent.dispose).not.toHaveBeenCalled();

        await flush();
        mgr.sync(syncParams()); // 子 4 枚を建築（祖先が pending なので非表示待機）
        expect(MeshMock).toHaveBeenCalledTimes(5);
        const children = [1, 2, 3, 4].map(
            (i) => MeshMock.mock.results[i].value as { isEnabled: () => boolean },
        );
        // 子はテクスチャ前は非表示。親も継続表示（穴を作らない）。
        children.forEach((m) => expect(m.isEnabled()).toBe(false));
        expect(parent.dispose).not.toHaveBeenCalled();

        // 子のうち 3 枚だけ到着 → まだ非表示・親保持（レベル違いの重なりを防ぐ）。
        capturedTextures.slice(1, 4).forEach((t) => t.onLoad?.());
        children.slice(0, 3).forEach((m) => expect(m.isEnabled()).toBe(false));
        expect(parent.dispose).not.toHaveBeenCalled();

        // 4 枚目到着 → 原子的スワップ：子を一斉表示し、親を解放。
        capturedTextures[4].onLoad?.();
        children.forEach((m) => expect(m.isEnabled()).toBe(true));
        expect(parent.dispose).toHaveBeenCalledWith(false, true);
    });

    it("zoom-in: minZoom 未満の親(粗タイル)でも子が揃うまで保持し原子スワップする (#330 回帰)", async () => {
        // minZoom=10。親 z8・子 z9 はいずれも minZoom 未満。祖先探索の下限を minZoom に
        // すると hasZoomRelation/visibleAncestorKeys が空になり、親が即破棄されて背景球が
        // 露出した（#330 のズームアップちらつき）。SEAMLESS_FLOOR_ZOOM=0 で全 zoom を橋渡し。
        const mgr = makeManager();
        selectedTiles = [tile(50, 50, 8)];
        mgr.sync(syncParams()); // zoom<minZoom は標高待ちせず即建築。
        expect(MeshMock).toHaveBeenCalledTimes(1);
        const parent = MeshMock.mock.results[0].value as {
            isEnabled: () => boolean;
            dispose: jest.Mock;
        };
        capturedTextures[0].onLoad?.();
        expect(parent.isEnabled()).toBe(true);

        // zoom-in: z9 の子 4 枚（親 50/50@z8 を完全カバー）。
        selectedTiles = [
            tile(100, 100, 9), tile(101, 100, 9),
            tile(100, 101, 9), tile(101, 101, 9),
        ];
        mgr.sync(syncParams()); // 親 → pendingRelease、子を即建築（祖先 pending で非表示待機）。
        // 親は保持され破棄されない（穴を作らない）。
        expect(parent.dispose).not.toHaveBeenCalled();
        expect(MeshMock).toHaveBeenCalledTimes(5);
        const children = [1, 2, 3, 4].map(
            (i) => MeshMock.mock.results[i].value as { isEnabled: () => boolean },
        );
        // 子はテクスチャ前は非表示。
        children.forEach((m) => expect(m.isEnabled()).toBe(false));

        // 3 枚到着 → まだ非表示・親保持。
        capturedTextures.slice(1, 4).forEach((t) => t.onLoad?.());
        children.slice(0, 3).forEach((m) => expect(m.isEnabled()).toBe(false));
        expect(parent.dispose).not.toHaveBeenCalled();

        // 4 枚目到着 → 原子的スワップ：子を一斉表示し、親を解放。
        capturedTextures[4].onLoad?.();
        children.forEach((m) => expect(m.isEnabled()).toBe(true));
        expect(parent.dispose).toHaveBeenCalledWith(false, true);
    });

    it("zoom 階層関係のない横パンでは旧タイルを pending せず即破棄する", async () => {
        const mgr = makeManager();
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        const meshA = MeshMock.mock.results[0].value as { dispose: jest.Mock };
        capturedTextures[0].onLoad?.(); // 表示・描画可能に

        // 同 zoom の無関係タイルへ横パン → 即破棄（フレーム落ち対策）。
        selectedTiles = [tile(500, 500, 10)];
        mgr.sync(syncParams());
        expect(meshA.dispose).toHaveBeenCalledWith(false, true);
    });
});
