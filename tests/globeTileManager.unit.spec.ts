/**
 * geo/globeTileManager のユニットテスト。
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
import { describe, it, expect, beforeEach, vi, Mock } from "vitest";

// ---- Babylon GPU 系モック（GL コンテキスト不要にする） ----
vi.mock("@babylonjs/core/scene", () => ({ Scene: class {} }));

vi.mock("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: vi.fn<(name: string) => unknown>().mockImplementation(function (name) {
        let disposed = false;
        let enabled = true;
        return {
            name,
            position: { copyFrom: vi.fn() },
            material: null as unknown,
            isDisposed: () => disposed,
            isEnabled: () => enabled,
            setEnabled: vi.fn((v: boolean) => { enabled = v; }),
            dispose: vi.fn(() => {
                disposed = true;
            }),
        };
    }),
}));

vi.mock("@babylonjs/core/Meshes/mesh.vertexData", () => ({
    VertexData: class {
        positions: number[] = [];
        indices: number[] = [];
        normals: number[] = [];
        uvs: number[] = [];
        applyToMesh = vi.fn();
        static ComputeNormals: Mock = vi.fn();
    },
}));

vi.mock("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: vi.fn().mockImplementation(function () {
        return {
            diffuseTexture: null as unknown,
            specularColor: null as unknown,
            backFaceCulling: true,
            dispose: vi.fn(),
        };
    }),
}));

interface CapturedTexture {
    dispose: Mock;
    wrapU: number;
    wrapV: number;
    onLoad?: () => void;
    onError?: (msg?: string, ex?: unknown) => void;
}
const capturedTextures: CapturedTexture[] = [];

vi.mock("@babylonjs/core/Materials/Textures/texture", () => {
    const TextureMock = vi
        .fn()
        .mockImplementation(function (...args: unknown[]) {
            const inst: CapturedTexture = {
                dispose: vi.fn(),
                wrapU: 0,
                wrapV: 0,
                onLoad: args[5] as (() => void) | undefined,
                onError: args[6] as ((msg?: string, ex?: unknown) => void) | undefined,
            };
            capturedTextures.push(inst);
            return inst;
        }) as Mock & { CLAMP_ADDRESSMODE: number; TRILINEAR_SAMPLINGMODE: number };
    TextureMock.CLAMP_ADDRESSMODE = 0;
    TextureMock.TRILINEAR_SAMPLINGMODE = 3;
    return { Texture: TextureMock };
});

vi.mock("@babylonjs/core/Maths/math.color", () => ({
    Color3: vi
        .fn<(r: number, g: number, b: number) => unknown>()
        .mockImplementation(function (r, g, b) {
            return { r, g, b };
        }),
}));

// ---- gsiTile モック（座標は単純な決定的実装、loadElevationTile は制御可能に） ----
// 注: ecef / mapping / math.geospatial.functions / math.vector は実物のまま使う。
// 穴埋め系の純関数（isAllNaN / fillInvalidPixels / isInvalidElev / NO_DATA_SENTINEL 等）や
// 座標定数は本実装をそのまま再利用し（vi.importActual）、テストで差し替えたい DOM 依存・
// 制御対象（loadElevationTile / toTileXY など）だけを最小限モックする。本実装を再実装すると
// 実装変更時にテスト側が取り残されて偽陽性/偽陰性になりやすいため。
vi.mock("../src/terrain/gsiTile", async () => {
    const actual = await vi.importActual(
        "../src/terrain/gsiTile",
    ) as typeof import("../src/terrain/gsiTile");
    return {
        ...actual,
        toTileXY: vi.fn(() => ({ x: 100, y: 100 })),
        tileCenterLatLon: vi.fn(() => ({ lat: 35, lon: 139 })),
        tileEdgeMeters: vi.fn(() => 1000),
        textureUrl: vi.fn(() => "https://example.com/tile.png"),
        loadElevationTile: vi.fn(() => Promise.resolve(new Float32Array(256 * 256))),
    };
});

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
const tile = (x: number, y: number, zoom = 10, distance = 60000): SelTile => ({
    zoom,
    x,
    y,
    tileSizeMeters: 1000,
    distance,
});
let selectedTiles: SelTile[] = [tile(100, 100)];
vi.mock("../src/terrain/geo/globeLod", () => ({
    selectGlobeTiles: vi.fn(() => selectedTiles),
    tileKey: (z: number, x: number, y: number) => `${z}/${x}/${y}`,
}));

// ---- globeMesh スパイ（建築時に渡される geomElev を捕捉して建築標高を検証可能にする） ----
// 実装（純粋関数）はそのまま動かしつつ、404/all-NaN タイルがどの代表標高で平坦建築されたかを
// 観測する。terrainElevAt は elevCache を参照するため、elevCache に載らない 404 タイルの
// 建築標高はメッシュ生成入力（geomElev）でしか検証できない。
const capturedBuilds: { tx: number; ty: number; geomElev: Float32Array }[] = [];
vi.mock("../src/terrain/geo/globeMesh", async () => {
    const actual = await vi.importActual(
        "../src/terrain/geo/globeMesh",
    ) as typeof import("../src/terrain/geo/globeMesh");
    return {
        ...actual,
        buildGlobeTileMeshData: vi.fn(
            (params: Parameters<typeof actual.buildGlobeTileMeshData>[0]) => {
                capturedBuilds.push({ tx: params.tx, ty: params.ty, geomElev: params.geomElev });
                return actual.buildGlobeTileMeshData(params);
            },
        ),
    };
});

const { createGlobeTileManager } = await import("../src/terrain/geo/globeTileManager");
const { geodeticToEcef } = await import("../src/terrain/geo/ecef");
const gsiMock = await import("../src/terrain/gsiTile");
const { Mesh } = await import("@babylonjs/core/Meshes/mesh");
const { StandardMaterial } = await import("@babylonjs/core/Materials/standardMaterial");

const loadElevationTile = gsiMock.loadElevationTile as Mock;
const toTileXY = gsiMock.toTileXY as Mock;
const { TileFetchError } = gsiMock;
const MeshMock = Mesh as unknown as Mock;
const MaterialMock = StandardMaterial as unknown as Mock;

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

const makeManager = () => {
    const mgr = createGlobeTileManager({
        scene: {} as never,
        mapType: "std",
        minZoom: 10,
        geomMaxZoom: 15,
        segments: 2,
        snapEnabled: false,
    });
    // 常時表示ベースレイヤがコンストラクタで生成する 16 枚（全球 z2）のメッシュ／
    // テクスチャは、以降の sync 挙動テストの数え上げ対象外。ここでクリアして、各テストの
    // MeshMock / capturedTextures が sync 由来のみを反映するようにする（ベースレイヤ自体の検証は
    // 専用テストで直接構築して行う）。
    MeshMock.mockClear();
    capturedTextures.length = 0;
    return mgr;
};

beforeEach(() => {
    capturedTextures.length = 0;
    capturedBuilds.length = 0;
    MeshMock.mockClear();
    loadElevationTile.mockReset();
    loadElevationTile.mockImplementation(() => Promise.resolve(new Float32Array(256 * 256)));
    toTileXY.mockReset();
    toTileXY.mockReturnValue({ x: 100, y: 100 });
    selectedTiles = [tile(100, 100)];
});

describe("createGlobeTileManager", () => {
    it("常時表示ベースレイヤを全球 z2=16 枚・深度書き込み無効で構築する", () => {
        // ベースレイヤ自体の検証は makeManager のクリアを通さず直接構築して数える。
        MeshMock.mockClear();
        MaterialMock.mockClear();
        capturedTextures.length = 0;
        createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        // 全球 z2 = 4^2 = 16 枚をコンストラクタで一度だけ生成する。
        expect(MeshMock).toHaveBeenCalledTimes(16);
        expect(capturedTextures.length).toBe(16);
        // 全ベースマテリアルは深度書き込み無効（背景球の手前・LOD の背面に固定する鍵）。
        const baseMats = MaterialMock.mock.results
            .slice(0, 16)
            .map((r) => r.value as { disableDepthWrite?: boolean });
        baseMats.forEach((m) => expect(m.disableDepthWrite).toBe(true));
    });

    it("ベーステクスチャ onLoad で diffuseColor を白に戻しティントを解除する", () => {
        MeshMock.mockClear();
        MaterialMock.mockClear();
        capturedTextures.length = 0;
        createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        const mat0 = MaterialMock.mock.results[0].value as {
            diffuseColor: { r: number; g: number; b: number };
            diffuseTexture: unknown;
        };
        // 到着前は海色ティント（暗め）で、テクスチャは未設定。
        expect(mat0.diffuseColor.r).toBeLessThan(1);
        expect(mat0.diffuseTexture).toBeNull();
        // onLoad でテクスチャ設定＋白へ復帰（diffuseTexture が暗く青くティントされないこと）。
        capturedTextures[0].onLoad?.();
        expect(mat0.diffuseTexture).not.toBeNull();
        expect(mat0.diffuseColor).toEqual({ r: 1, g: 1, b: 1 });
    });

    it("低〜中高度では base に地図テクスチャを適用せず海色のまま（#465 地平線際の緑露出防止）", () => {
        MeshMock.mockClear();
        MaterialMock.mockClear();
        capturedTextures.length = 0;
        const mgr = createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        const baseMat = MaterialMock.mock.results[0].value as {
            diffuseColor: { r: number; g: number; b: number };
            diffuseTexture: unknown;
        };
        // 低高度（60km < 1,200km しきい値）で sync → base は海色充填に切り替わる。
        mgr.sync(syncParams());
        // base テクスチャが到着しても、低高度では適用されず海色のまま（緑の世界地図を貼らない）。
        capturedTextures[0].onLoad?.();
        expect(baseMat.diffuseTexture).toBeNull();
        expect(baseMat.diffuseColor.r).toBeLessThan(1);
    });

    it("高高度（全球表示）では base に地図テクスチャを適用する（#465）", () => {
        MeshMock.mockClear();
        MaterialMock.mockClear();
        capturedTextures.length = 0;
        const mgr = createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        const baseMat = MaterialMock.mock.results[0].value as {
            diffuseColor: { r: number; g: number; b: number };
            diffuseTexture: unknown;
        };
        // 高高度（3,000km ≥ 1,200km しきい値）で sync → base に地図を適用する。
        const highCameraEcef = geodeticToEcef(35, 139, 3_000_000);
        mgr.sync({ ...syncParams(), cameraEcef: highCameraEcef });
        capturedTextures[0].onLoad?.();
        expect(baseMat.diffuseTexture).not.toBeNull();
        expect(baseMat.diffuseColor).toEqual({ r: 1, g: 1, b: 1 });
    });

    it("高度が全球境界を跨ぐと base の見た目を地図↔海色へ再適用する（#465 applyBaseAppearance）", () => {
        MeshMock.mockClear();
        MaterialMock.mockClear();
        capturedTextures.length = 0;
        const mgr = createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        const baseMat = MaterialMock.mock.results[0].value as {
            diffuseColor: { r: number; g: number; b: number };
            diffuseTexture: unknown;
        };
        const highCameraEcef = geodeticToEcef(35, 139, 3_000_000);
        // 高高度で sync → base テクスチャ到着で地図適用。
        mgr.sync({ ...syncParams(), cameraEcef: highCameraEcef });
        capturedTextures[0].onLoad?.();
        expect(baseMat.diffuseTexture).not.toBeNull();
        // 低高度へ跨ぐと海色へ戻る（applyBaseAppearance）。
        mgr.sync(syncParams());
        expect(baseMat.diffuseTexture).toBeNull();
        expect(baseMat.diffuseColor.r).toBeLessThan(1);
        // 再び高高度へ跨ぐと地図が戻る（保持済み baseTex を再適用）。
        mgr.sync({ ...syncParams(), cameraEcef: highCameraEcef });
        expect(baseMat.diffuseTexture).not.toBeNull();
        expect(baseMat.diffuseColor).toEqual({ r: 1, g: 1, b: 1 });
    });

    it("dispose でベースレイヤ 16 枚もテクスチャごと破棄する", () => {
        MeshMock.mockClear();
        const mgr = createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        const baseMeshes = MeshMock.mock.results
            .slice(0, 16)
            .map((r) => r.value as { dispose: Mock });
        mgr.dispose();
        baseMeshes.forEach((m) => expect(m.dispose).toHaveBeenCalledWith(false, true));
    });

    it("標高ロード完了後に初めてメッシュを建築し、テクスチャ onLoad で表示する", async () => {
        const mgr = makeManager();
        const s1 = mgr.sync(syncParams());
        // 標高ロード中はメッシュを建築しない（フラット→実標高のチラつきを防ぐ）。
        expect(s1.selected.length).toBe(1);
        expect(MeshMock).toHaveBeenCalledTimes(0);
        expect(loadElevationTile).toHaveBeenCalledTimes(1);
        expect(s1.loadedCount).toBe(0);

        await flush(); // 標高到着
        // 標高揃い → メッシュ生成（テクスチャ読込開始）。
        const s2 = mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
        expect(s2.loadedCount).toBe(1);

        // onLoad 前: 非表示（白色チラつき防止）。
        const tex = capturedTextures[0];
        const mesh = MeshMock.mock.results[0].value as {
            material: { diffuseTexture: unknown };
            isEnabled: () => boolean;
            setEnabled: Mock;
        };
        expect(mesh.material.diffuseTexture).toBeNull();
        expect(mesh.isEnabled()).toBe(false);
        // onLoad 後: diffuseTexture 設定 + 表示。
        tex.onLoad?.();
        expect(mesh.material.diffuseTexture).toBe(tex);
        expect(mesh.isEnabled()).toBe(true);
    });

    it("isIdle はテクスチャ適用前は false、適用後（readyMeshes 入り）で true になる", async () => {
        const mgr = makeManager();
        // 初回 sync 前は未同期 → false。
        expect(mgr.isIdle()).toBe(false);

        mgr.sync(syncParams());
        // 標高ロード中（loading 有り）→ false。
        expect(mgr.isIdle()).toBe(false);

        await flush(); // 標高到着
        mgr.sync(syncParams()); // メッシュ生成（テクスチャ読込開始）
        expect(MeshMock).toHaveBeenCalledTimes(1);
        // テクスチャ onLoad 前: メッシュは loaded だが readyMeshes 未登録 → false。
        expect(mgr.isIdle()).toBe(false);

        // テクスチャ onLoad 後: readyMeshes に登録され idle。
        capturedTextures[0].onLoad?.();
        expect(mgr.isIdle()).toBe(true);
    });

    it("setMapType は実行時にロード済み LOD・ベースレイヤを新 mapType で再テクスチャする", async () => {
        const textureUrlMock = gsiMock.textureUrl as Mock;
        const mgr = makeManager();
        expect(mgr.getMapType()).toBe("std");

        mgr.sync(syncParams());
        await flush(); // 標高到着
        mgr.sync(syncParams()); // LOD メッシュ 1 枚生成
        expect(MeshMock).toHaveBeenCalledTimes(1);

        textureUrlMock.mockClear();
        const before = capturedTextures.length;
        mgr.setMapType("photo");

        expect(mgr.getMapType()).toBe("photo");
        // 再テクスチャの URL はすべて新 mapType("photo")。
        expect(textureUrlMock).toHaveBeenCalled();
        expect(textureUrlMock.mock.calls.every((c) => c[0] === "photo")).toBe(
            true,
        );
        // ロード済み LOD(1) + 常時表示ベースレイヤ(z2=16) = 17 枚を再テクスチャする。
        expect(capturedTextures.length - before).toBe(17);
        // 新テクスチャ onLoad で旧テクスチャを破棄しても例外を投げない。
        expect(() => capturedTextures[before].onLoad?.()).not.toThrow();

        // 同値再 set は no-op（再テクスチャしない）。
        textureUrlMock.mockClear();
        mgr.setMapType("photo");
        expect(textureUrlMock).not.toHaveBeenCalled();
    });

    it("setMapType 連打時、追い越された旧種別テクスチャは適用せず破棄し最後の選択を保つ", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush(); // 標高到着
        mgr.sync(syncParams()); // LOD メッシュ 1 枚生成
        expect(MeshMock).toHaveBeenCalledTimes(1);

        const lodMesh = MeshMock.mock.results[0].value as {
            material: { diffuseTexture: unknown };
        };
        // 初回テクスチャ（std）を適用しておく。
        capturedTextures[0].onLoad?.();

        // std → photo → std を素早く切り替える（テクスチャは非同期ロードで未適用）。
        const beforePhoto = capturedTextures.length;
        mgr.setMapType("photo"); // T_photo 生成（builtFor=photo）
        const lodPhotoTex = capturedTextures[beforePhoto];
        const beforeStd = capturedTextures.length;
        mgr.setMapType("std"); // T_std 生成（builtFor=std）
        const lodStdTex = capturedTextures[beforeStd];

        // 到着順が逆転しても（photo が後着）、現在選択(std)と不一致なら適用せず破棄する。
        lodStdTex.onLoad?.();
        expect(lodMesh.material.diffuseTexture).toBe(lodStdTex);
        lodPhotoTex.onLoad?.();
        expect(lodPhotoTex.dispose).toHaveBeenCalled();
        // 追い越された photo テクスチャは適用されない（誤表示しない）。
        expect(lodMesh.material.diffuseTexture).toBe(lodStdTex);
        expect(mgr.getMapType()).toBe("std");
    });

    it("初回テクスチャ in-flight 中の setMapType: 旧種別 onLoad は無視し再テクスチャ側が描画可能化する", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush(); // 標高到着
        mgr.sync(syncParams()); // LOD メッシュ生成、初回テクスチャ in-flight
        expect(MeshMock).toHaveBeenCalledTimes(1);
        const lodMesh = MeshMock.mock.results[0].value as {
            material: { diffuseTexture: unknown };
            isEnabled: () => boolean;
        };
        // 初回テクスチャ未到着: 非表示・未 idle。
        expect(lodMesh.isEnabled()).toBe(false);
        expect(mgr.isIdle()).toBe(false);

        const initialTex = capturedTextures[0]; // std, in-flight
        const before = capturedTextures.length;
        mgr.setMapType("photo"); // loaded を最初に再テクスチャ
        const retexTex = capturedTextures[before]; // LOD photo

        // 旧種別(std)の初回 onLoad が遅れて発火 → currentMapType(photo) と不一致で破棄・非適用。
        initialTex.onLoad?.();
        expect(initialTex.dispose).toHaveBeenCalled();
        expect(lodMesh.isEnabled()).toBe(false);
        expect(mgr.isIdle()).toBe(false);

        // 再テクスチャ(photo) onLoad で未 ready メッシュを描画可能化（タイル欠け・idle 永続 false 防止）。
        retexTex.onLoad?.();
        expect(lodMesh.material.diffuseTexture).toBe(retexTex);
        expect(lodMesh.isEnabled()).toBe(true);
        expect(mgr.isIdle()).toBe(true);
    });

    it("ベースレイヤ初回テクスチャ in-flight 中の setMapType: 旧種別 onLoad は適用しない", () => {
        // ベースレイヤはコンストラクタで生成されるため、makeManager のクリアを通さず直接構築する。
        MeshMock.mockClear();
        MaterialMock.mockClear();
        capturedTextures.length = 0;
        const mgr = createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 10,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        // 全球 z2 = 16 枚のベース初回テクスチャが in-flight。
        expect(capturedTextures.length).toBe(16);
        const baseInitial = capturedTextures[0]; // std, in-flight
        const baseMat = MaterialMock.mock.results[0].value as {
            diffuseTexture: unknown;
        };
        expect(baseMat.diffuseTexture).toBeNull();

        mgr.setMapType("photo"); // 16 枚を photo で再テクスチャ

        // 旧種別(std)のベース初回 onLoad が遅れて発火 → 不一致で破棄・非適用（切り戻り防止）。
        baseInitial.onLoad?.();
        expect(baseInitial.dispose).toHaveBeenCalled();
        expect(baseMat.diffuseTexture).toBeNull();
    });

    it("前景タイルを非ピッカブルにする（内蔵パンとの二重操作=ガタつきを防ぐ, #337）", async () => {
        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush(); // 標高到着
        mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
        const mesh = MeshMock.mock.results[0].value as { isPickable?: boolean };
        // ピッカブルだと GeospatialCamera 内蔵パンの scene.pick がヒットし、独自パンと二重に
        // カメラを動かして水平方向にガタつく。基準タイル同様に非ピッカブルへ固定する。
        expect(mesh.isPickable).toBe(false);
    });

    it("不要になったタイルのメッシュを dispose する", async () => {
        const mgr = makeManager();
        selectedTiles = [tile(100, 100)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // メッシュ A 生成
        const meshA = MeshMock.mock.results[0].value as { dispose: Mock };
        expect(MeshMock).toHaveBeenCalledTimes(1);

        // 別タイルへ移動 → A は不要に。
        selectedTiles = [tile(200, 200)];
        mgr.sync(syncParams());
        expect(meshA.dispose).toHaveBeenCalledWith(false, true);
    });

    it("一時的な取得失敗はバックオフし再取得せず、失敗確定後にフラット建築する", async () => {
        // 一時障害（TileFetchError 以外 / status≠404）は粗ズームへ倒さず即座に再 throw する。
        loadElevationTile.mockImplementation(() => Promise.reject(new Error("fetch failed")));
        const mgr = makeManager();
        mgr.sync(syncParams());
        // loadGeomElevation は geom zoom を同期的に 1 回試行する。一時障害は粗ズーム fallback せず再 throw。
        expect(loadElevationTile).toHaveBeenCalledTimes(1);
        // 標高ロード中: まだ失敗が確定していないのでメッシュ未生成。
        expect(MeshMock).toHaveBeenCalledTimes(0);
        await flush(); // geom zoom 失敗（粗ズーム fallback なし）→ failedRetryAt 記録（バックオフへ）
        loadElevationTile.mockClear(); // 以降の sync が再取得しないことを fallback 深さに依らず検証
        // 失敗確定後の sync: フラット(海面 0m)でメッシュ生成（恒久欠けを防ぐ）。
        mgr.sync(syncParams());
        expect(loadElevationTile).toHaveBeenCalledTimes(0); // バックオフ中、再取得なし
        expect(MeshMock).toHaveBeenCalledTimes(1);
        // バックオフ中の再 sync でもメッシュを再生成しない。
        mgr.sync(syncParams());
        expect(MeshMock).toHaveBeenCalledTimes(1);
    });

    it("geom zoom が全 DEM 404 でも粗ズーム DEM を切り出して実標高で建築する", async () => {
        // DEM5 非整備領域: z15 geom は全レイヤー 404(決定的未配信) だが、粗ズーム z14 dem_png には実標高がある。
        const PARENT_ELEV = 900;
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const zoom = args[0] as number;
            // 決定的な 404 のみ粗ズームフォールバックを発動するため TileFetchError(status=404) で reject。
            if (zoom >= 15) return Promise.reject(new TileFetchError("404", 404));
            return Promise.resolve(new Float32Array(256 * 256).fill(PARENT_ELEV));
        });
        toTileXY.mockReturnValue({ x: 24000, y: 12000 });
        selectedTiles = [tile(24000, 12000, 15)];

        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // 標高確定後に建築

        // geom zoom(15) は 404、粗ズーム(14)へフォールバックして取得している。
        const zooms = loadElevationTile.mock.calls.map((c: unknown[]) => c[0]);
        expect(zooms).toContain(15);
        expect(zooms).toContain(14);

        // 建築標高は 0m(海面フラット)ではなく粗ズーム DEM の実標高で埋まる。
        const built = capturedBuilds.find((b) => b.tx === 24000 && b.ty === 12000);
        expect(built).toBeDefined();
        expect(built?.geomElev[0]).toBeCloseTo(PARENT_ELEV);
    });

    it("粗ズームフォールバック中の一時障害は握りつぶさずバックオフへ倒す", async () => {
        // geom zoom(15) は 404 → 粗ズーム(14)へフォールバックするが、そこで一時障害(非404)が起きる。
        // 一時障害は握りつぶさず再 throw し、誤って粗ズーム平坦化へ倒さずバックオフ再取得に委ねる。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const zoom = args[0] as number;
            if (zoom >= 15) return Promise.reject(new TileFetchError("404", 404));
            // 粗ズーム z14 で一時障害（TileFetchError 以外）。
            return Promise.reject(new Error("network down"));
        });
        toTileXY.mockReturnValue({ x: 24000, y: 12000 });
        selectedTiles = [tile(24000, 12000, 15)];

        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush(); // geom(15) 404 → 粗ズーム(14) 一時障害で再 throw → failedRetryAt 記録
        capturedBuilds.length = 0;
        mgr.sync(syncParams()); // バックオフ中: 建築されても粗ズーム実標高ではなくフラット（未取得）

        // 一時障害なので粗ズーム実標高での建築は行われない（バックオフ後の再取得に委ねる）。
        const built = capturedBuilds.find((b) => b.tx === 24000 && b.ty === 12000);
        expect(built?.geomElev[0] ?? 0).not.toBeCloseTo(900);
    });

    it("同一粗ズーム親を共有する子タイルのフォールバックは親フェッチを重複させない", async () => {
        // z15 の 4 枚（2x2）は同一の z14 親 (x>>1,y>>1)=(12000,6000) を共有する。全枚が 404 で
        // 粗ズームフォールバックしても、親 DEM の取得は in-flight 共有で 1 回に集約される。
        const PARENT_ELEV = 900;
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const zoom = args[0] as number;
            if (zoom >= 15) return Promise.reject(new TileFetchError("404", 404));
            return Promise.resolve(new Float32Array(256 * 256).fill(PARENT_ELEV));
        });
        selectedTiles = [
            tile(24000, 12000, 15),
            tile(24001, 12000, 15),
            tile(24000, 12001, 15),
            tile(24001, 12001, 15),
        ];

        const mgr = makeManager();
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams()); // 標高確定後に建築

        // 4 枚とも粗ズーム親 (z14, 12000, 6000) を参照するが、親フェッチは 1 回に集約される。
        const z14ParentCalls = loadElevationTile.mock.calls.filter(
            (c: unknown[]) => c[0] === 14 && c[1] === 12000 && c[2] === 6000,
        );
        expect(z14ParentCalls).toHaveLength(1);

        // 各子タイルは共有した親から自領域を切り出して実標高で建築される。
        for (const [tx, ty] of [[24000, 12000], [24001, 12000], [24000, 12001], [24001, 12001]]) {
            const built = capturedBuilds.find((b) => b.tx === tx && b.ty === ty);
            expect(built?.geomElev[0]).toBeCloseTo(PARENT_ELEV);
        }
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
            setEnabled: Mock;
        };
        expect(mesh.isEnabled()).toBe(false); // onLoad/onError 前は非表示
        tex.onError?.("load error");
        expect(tex.dispose).toHaveBeenCalled();
        expect(mesh.isEnabled()).toBe(true); // onError 後は表示（白でもホールより良い）
    });

    it("zoom < minZoom でも近距離（距離閾値 ELEVATION_RELEVANT_MAX_DISTANCE_M 未満）なら標高ロード完了を待って建築する", async () => {
        // minZoom=10・zoom=9 でも distance=60000（ELEVATION_RELEVANT_MAX_DISTANCE_M=150000 未満）
        // なら標高が視覚的に意味を持つとみなし、ロード中は建築をスキップする（#457）。
        selectedTiles = [tile(50, 50, 9, 60_000)];
        const mgr = makeManager();
        mgr.sync(syncParams());
        // 標高ロード中は建築されない。
        expect(MeshMock).toHaveBeenCalledTimes(0);
        await flush();
        mgr.sync(syncParams());
        // 実標高到着後に建築される。
        expect(MeshMock).toHaveBeenCalledTimes(1);
    });

    it("zoom < minZoom かつ遠距離（全球視点相当）は標高ロード中でも即時建築する", async () => {
        // distance=500000（ELEVATION_RELEVANT_MAX_DISTANCE_M=150000 超）は全球視点相当として、
        // 従来どおり標高ロードを待たずに即時建築する（高高度では標高が視覚的に無意味）。
        selectedTiles = [tile(50, 50, 9, 500_000)];
        const mgr = makeManager();
        mgr.sync(syncParams());
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
        const mesh = MeshMock.mock.results[0].value as { dispose: Mock };
        mgr.dispose();
        expect(mesh.dispose).toHaveBeenCalledWith(false, true);
    });

    // ===== LOD シームレス遷移（平面版同等） =====

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
            (i) => MeshMock.mock.results[i].value as { isEnabled: () => boolean; dispose: Mock },
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
        const parent = MeshMock.mock.results[0].value as { isEnabled: () => boolean; dispose: Mock };
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

    it("zoom-in: 子のテクスチャが onError でも非表示待機を維持し原子スワップする", async () => {
        // 祖先 pending 中の hiddenChild が onError で即表示されると、親と子が同時に見えて
        // 原子スワップが壊れる。onError も onLoad 同様に hiddenChild は表示を抑止し、
        // readyMeshes 登録のみ行う → スワップ時に enableDescendants 経由で表示される。
        const mgr = makeManager();
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        const parent = MeshMock.mock.results[0].value as {
            isEnabled: () => boolean;
            dispose: Mock;
        };
        capturedTextures[0].onLoad?.();
        expect(parent.isEnabled()).toBe(true);

        selectedTiles = [
            tile(200, 200, 11), tile(201, 200, 11),
            tile(200, 201, 11), tile(201, 201, 11),
        ];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        const children = [1, 2, 3, 4].map(
            (i) => MeshMock.mock.results[i].value as { isEnabled: () => boolean },
        );
        children.forEach((m) => expect(m.isEnabled()).toBe(false));

        // 1 枚目が onError（テクスチャ取得失敗）→ 即表示せず非表示待機を維持・親保持。
        capturedTextures[1].onError?.();
        expect(children[0].isEnabled()).toBe(false);
        expect(parent.dispose).not.toHaveBeenCalled();

        // 残り 3 枚到着 → 4 枚すべて描画可能になり原子スワップ：onError の子も含め一斉表示、親解放。
        capturedTextures.slice(2, 5).forEach((t) => t.onLoad?.());
        children.forEach((m) => expect(m.isEnabled()).toBe(true));
        expect(parent.dispose).toHaveBeenCalledWith(false, true);
    });

    it("zoom-in: minZoom 未満の親(粗タイル)でも子が揃うまで保持し原子スワップする", async () => {
        // minZoom=10。親 z8・子 z9 はいずれも minZoom 未満。祖先探索の下限を minZoom に
        // すると hasZoomRelation/visibleAncestorKeys が空になり、親が即破棄されて背景球が
        // 露出した。SEAMLESS_FLOOR_ZOOM=0 で全 zoom を橋渡し。
        // distance=500000（全球視点相当）にして標高ロード待ちを起こさず、原子スワップのみ検証する。
        const mgr = makeManager();
        selectedTiles = [tile(50, 50, 8, 500_000)];
        mgr.sync(syncParams()); // zoom<minZoom かつ遠距離は標高待ちせず即建築。
        expect(MeshMock).toHaveBeenCalledTimes(1);
        const parent = MeshMock.mock.results[0].value as {
            isEnabled: () => boolean;
            dispose: Mock;
        };
        capturedTextures[0].onLoad?.();
        expect(parent.isEnabled()).toBe(true);

        // zoom-in: z9 の子 4 枚（親 50/50@z8 を完全カバー）。
        selectedTiles = [
            tile(100, 100, 9, 500_000), tile(101, 100, 9, 500_000),
            tile(100, 101, 9, 500_000), tile(101, 101, 9, 500_000),
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
        const meshA = MeshMock.mock.results[0].value as { dispose: Mock };
        capturedTextures[0].onLoad?.(); // 表示・描画可能に

        // 同 zoom の無関係タイルへ横パン → 即破棄（フレーム落ち対策）。
        selectedTiles = [tile(500, 500, 10)];
        mgr.sync(syncParams());
        expect(meshA.dispose).toHaveBeenCalledWith(false, true);
    });

    // ===== 標高タイルの穴埋め（平面版相当） =====

    it("部分欠測タイルの内部 NaN を周囲の有効標高で穴埋めする", async () => {
        const mgr = makeManager();
        // 1 ピクセルだけ有効(70m)で残りは全て NaN のタイル。fillInvalidPixels の BFS で
        // タイル全体が 70m に伝播するため、どこをサンプルしても 70m になる（NaN→0 沈み無し）。
        loadElevationTile.mockImplementation(() => {
            const a = new Float32Array(256 * 256).fill(NaN);
            a[0] = 70;
            return Promise.resolve(a);
        });
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        await flush(); // 標高到着 → loadTile で穴埋め
        mgr.sync(syncParams());

        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        expect(elev as number).toBeCloseTo(70, 3);
    });

    it("all-NaN タイルを同 zoom 隣接の補間結果をシードに穴埋めする", async () => {
        const mgr = makeManager();
        // 対象タイル(gx=100)は全面 no-data(all-NaN)、右隣(gx=101)は一様 60m。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const gx = args[1] as number;
            if (gx === 100) return Promise.resolve(new Float32Array(256 * 256).fill(NaN));
            return Promise.resolve(new Float32Array(256 * 256).fill(60));
        });
        selectedTiles = [tile(100, 100, 10), tile(101, 100, 10)];
        mgr.sync(syncParams());
        await flush(); // 両タイル到着。100 は allNanGeom 入り、101 は穴埋め済み
        // 1 回目: refineAllNaNTiles が隣接 60m をシードに 100 を補間する。
        mgr.sync(syncParams());

        // terrainElevAt は toTileXY モックで常に (100,100) を参照する。補間後は 60m。
        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        expect(elev as number).toBeCloseTo(60, 3);
    });

    it("粗ズーム祖先が no-data でも視界内に有効タイルがあれば代表標高でレスキューする", async () => {
        const mgr = makeManager();
        // 対象タイル(gx=100)は全面 no-data(all-NaN)で、粗ズーム祖先(toTileXY モックで gx=100)も
        // no-data。別位置(gx=105)に有効標高 300m のタイルがあり、これが視界内代表標高の供給源になる。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const gx = args[1] as number;
            if (gx === 100) return Promise.resolve(new Float32Array(256 * 256).fill(NaN));
            return Promise.resolve(new Float32Array(256 * 256).fill(300));
        });
        selectedTiles = [tile(100, 100, 10), tile(105, 105, 10)];
        mgr.sync(syncParams());
        await flush(); // 両タイル到着。loading は空。100 は allNanGeom 入り
        mgr.sync(syncParams()); // refine: 粗ズーム祖先の取得を起動（100 は確定見送り）
        await flush(); // 粗ズーム祖先も no-data → coarseSeedDone（coarseSeed 無し）
        mgr.sync(syncParams()); // 粗ズーム不可 → 視界内代表標高 300m でフォールバック平坦化

        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        // 海面 0m へ沈まず、視界内代表標高 300m で平坦化されること（中心の沈み込み解消）。
        expect(elev as number).toBeCloseTo(300, 3);
    });

    it("視界が全面水面の all-NaN タイルを粗ズーム祖先 DEM の代表標高で平坦化する", async () => {
        const mgr = makeManager();
        // geom zoom(=10) は全タイル全面 no-data（all-NaN: 湖面のみ）。
        // 粗ズーム祖先(<10)は湖岸（陸地）を含むため一様 900m を返す（湖面標高近似の供給源）。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const z = args[0] as number;
            if (z < 10) return Promise.resolve(new Float32Array(256 * 256).fill(900));
            return Promise.resolve(new Float32Array(256 * 256).fill(NaN));
        });
        // 3x3 の全面水面ブロック（視界内に有効タイルが一切無い ＝ 大きな湖の接写）。
        selectedTiles = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                selectedTiles.push(tile(100 + dx, 100 + dy, 10));
            }
        }
        mgr.sync(syncParams());
        await flush(); // geom タイル到着（全 all-NaN）
        mgr.sync(syncParams()); // Step2b: 粗ズーム祖先の取得を起動
        await flush(); // 粗ズームタイル到着 → coarseSeed に 900m
        mgr.sync(syncParams()); // 粗ズーム代表標高で平坦化

        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        // 海面 0m へ沈まず、粗ズーム祖先の代表標高 900m で平坦化されること。
        expect(elev as number).toBeCloseTo(900, 3);
    });

    // ===== 同一ズーム隣接辺スティッチング（平面版相当） =====

    it("同一ズーム隣接の実標高タイル辺を平均化してタイル境界の段差を解消する", async () => {
        const mgr = makeManager();
        // 左タイル(gx=100)は一様 100m、右隣(gx=101)は一様 200m の実標高。
        // 縫合無しでは境界で 100m→200m の段差（陰影シーム）になる。縫合後は両者の接辺が
        // 平均 150m に揃い、境界が連続する（planar の applyStitchedElevation 相当）。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const gx = args[1] as number;
            const fill = gx === 100 ? 100 : 200;
            return Promise.resolve(new Float32Array(256 * 256).fill(fill));
        });
        selectedTiles = [tile(100, 100, 10), tile(101, 100, 10)];
        mgr.sync(syncParams());
        await flush(); // 両タイルの実標高が到着し elevCache へ格納される
        mgr.sync(syncParams()); // 両隣接が揃った状態で縫合・建築

        const mid = 128 * 256; // 中央行の先頭
        const lastBuild = (tx: number) => {
            const arr = capturedBuilds.filter((b) => b.tx === tx);
            return arr[arr.length - 1];
        };
        const left = lastBuild(100);
        const right = lastBuild(101);
        expect(left).toBeDefined();
        expect(right).toBeDefined();
        // 左タイルの右辺（col=255）は右隣 200m と平均され 150m。内部は 100m のまま。
        expect((left as { geomElev: Float32Array }).geomElev[mid + 255]).toBeCloseTo(150, 3);
        expect((left as { geomElev: Float32Array }).geomElev[mid + 128]).toBeCloseTo(100, 3);
        // 右タイルの左辺（col=0）は左隣 100m と平均され 150m。内部は 200m のまま。
        expect((right as { geomElev: Float32Array }).geomElev[mid + 0]).toBeCloseTo(150, 3);
        expect((right as { geomElev: Float32Array }).geomElev[mid + 128]).toBeCloseTo(200, 3);
    });

    it("同一ズーム隣接が無い実標高タイルは縫合せず原本標高で建築する", async () => {
        const mgr = makeManager();
        loadElevationTile.mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256).fill(100)),
        );
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());

        const builtArr = capturedBuilds.filter((b) => b.tx === 100);
        const built = builtArr[builtArr.length - 1];
        expect(built).toBeDefined();
        const mid = 128 * 256;
        // 隣接が無いので辺も内部も原本 100m のまま（縫合 no-op）。
        expect((built as { geomElev: Float32Array }).geomElev[mid + 255]).toBeCloseTo(100, 3);
        expect((built as { geomElev: Float32Array }).geomElev[mid + 0]).toBeCloseTo(100, 3);
    });

    it("日付変更線をまたぐ x=0 と x=limit-1 の同一ズーム隣接を wrap して縫合する", async () => {
        const mgr = makeManager();
        // gz=10 の軸方向タイル数 limit=1024。x=0 と x=1023 は日付変更線で隣接する。
        // x=0 のタイルは一様 100m、x=1023 は一様 200m。wrap 探索が無いと x=0 の左隣
        // (x=-1) が拾えず縫合されないが、wrap すれば x=1023 が左隣として縫合される。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const gx = args[1] as number;
            const fill = gx === 0 ? 100 : 200;
            return Promise.resolve(new Float32Array(256 * 256).fill(fill));
        });
        selectedTiles = [tile(0, 100, 10), tile(1023, 100, 10)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());

        const mid = 128 * 256;
        const lastBuild = (tx: number) => {
            const arr = capturedBuilds.filter((b) => b.tx === tx);
            return arr[arr.length - 1];
        };
        const west = lastBuild(0); // x=0（左隣は wrap で x=1023）
        const east = lastBuild(1023); // x=1023（右隣は wrap で x=0）
        expect(west).toBeDefined();
        expect(east).toBeDefined();
        // x=0 の左辺（col=0）は wrap 隣接 x=1023 の 200m と平均され 150m。
        expect((west as { geomElev: Float32Array }).geomElev[mid + 0]).toBeCloseTo(150, 3);
        // x=1023 の右辺（col=255）は wrap 隣接 x=0 の 100m と平均され 150m。
        expect((east as { geomElev: Float32Array }).geomElev[mid + 255]).toBeCloseTo(150, 3);
    });

    it("同一ズーム縫合は原本 elevCache を破壊しない", async () => {
        const mgr = makeManager();
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const gx = args[1] as number;
            const fill = gx === 100 ? 100 : 200;
            return Promise.resolve(new Float32Array(256 * 256).fill(fill));
        });
        selectedTiles = [tile(100, 100, 10), tile(101, 100, 10)];
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());

        // terrainElevAt は elevCache（縫合前の原本）を参照する。toTileXY モックは常に (100,100) を
        // 返すため左タイル中心の 100m が得られ、縫合コピーで上書きされていないことを確認する。
        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        expect(elev as number).toBeCloseTo(100, 3);
    });

    it("未解決 all-NaN タイル上では terrainElevAt が 0m でなく null を返す（代表標高の循環崩壊防止, #339）", async () => {
        const mgr = makeManager();
        // 全タイル全面 no-data（all-NaN）。粗ズーム祖先取得が完了するまで未解決状態が続く。
        loadElevationTile.mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256).fill(NaN)),
        );
        selectedTiles = [tile(100, 100, 10)];
        mgr.sync(syncParams());
        await flush(); // all-NaN 到着 → allNanGeom 入り（未解決）

        // 未解決 all-NaN を生 NaN(bilinear=0m) として採用すると、湖上で centerElevation→0→
        // referenceAltitude→0 と循環し暫定代表標高まで 0m に崩れる。これを防ぐため null を返す。
        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).toBeNull();
    });

    // ===== #459: gz<minZoom（遠景の距離適応タイル）の terrainElevAt 距離ゲート =====

    /** minZoom=12 の manager（選択タイル zoom=10 は minZoom 未満になる）。 */
    const makeFarViewManager = () =>
        createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 12,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });

    it("gz<minZoom でも近距離(<=150km)でロード済みなら terrainElevAt が標高を返す（#459）", async () => {
        // 東京駅→富士山 約100.5km 相当。distCapZoom で root zoom が minZoom(12) を下回り zoom=10 が
        // 選ばれるが、実 DEM はロード完了している。旧実装は探索下限 min(minZoom,geomMaxZoom)=12 の
        // ため gz=10 を探索できず常に null だった。修正後は距離ゲート付きで採用し標高を返す。
        const mgr = makeFarViewManager();
        loadElevationTile.mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256).fill(3000)),
        );
        selectedTiles = [tile(100, 100, 10, 100_500)]; // zoom=10 < minZoom=12, 100.5km <= 150km
        mgr.sync(syncParams());
        await flush(); // 実標高到着 → elevCache へ格納
        mgr.sync(syncParams()); // buildReadyTiles が elevRelevantGeom へ登録

        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        expect(elev as number).toBeCloseTo(3000, 3);
    });

    it("gz<minZoom かつ遠距離(>150km)では terrainElevAt が null を返す（#459 の距離ゲート）", async () => {
        // 全球視点相当の遠距離。DEM はロードされ elevCache に載るが、標高が視覚的に無意味な距離帯
        // なので elevRelevantGeom に載らず、terrainElevAt は超粗タイルの誤った標高を返さない。
        const mgr = makeFarViewManager();
        loadElevationTile.mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256).fill(3000)),
        );
        selectedTiles = [tile(100, 100, 10, 200_000)]; // zoom=10 < minZoom=12, 200km > 150km
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());

        expect(mgr.terrainElevAt(35, 139)).toBeNull();
    });

    it("近距離→遠距離へ移動すると terrainElevAt は再び null を返す（距離ゲートの解除, #459）", async () => {
        // 一度近距離(<=150km)で採用対象になった gz<minZoom タイルが、カメラが離れて無意味化した
        // 後は採用対象から外れること（elevRelevantGeom の削除経路）を検証する。
        const mgr = makeFarViewManager();
        loadElevationTile.mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256).fill(3000)),
        );
        selectedTiles = [tile(100, 100, 10, 100_500)]; // 近距離
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());
        expect(mgr.terrainElevAt(35, 139)).not.toBeNull();

        selectedTiles = [tile(100, 100, 10, 200_000)]; // 同一タイルが遠距離化
        mgr.sync(syncParams());
        expect(mgr.terrainElevAt(35, 139)).toBeNull();
    });

    it("minZoom > geomMaxZoom（?zoom=18 等）では gz=geomMaxZoom を距離ゲート無しで返す（#459 レビュー対応）", async () => {
        // 最も細かい実タイルは gz=geomMaxZoom(15) で minZoom(18) 未満。これを一律 gz<minZoom として
        // 距離ゲートで弾くと terrainElevAt が常に null になり seat-on-terrain が壊れる。ゲート基準を
        // min(minZoom,geomMaxZoom) にして gz=geomMaxZoom は無条件採用する。遠距離(>150km)で
        // elevRelevantGeom に載らないタイルでも返ることを確認する。
        const mgr = createGlobeTileManager({
            scene: {} as never,
            mapType: "std",
            minZoom: 18,
            geomMaxZoom: 15,
            segments: 2,
            snapEnabled: false,
        });
        loadElevationTile.mockImplementation(() =>
            Promise.resolve(new Float32Array(256 * 256).fill(1234)),
        );
        selectedTiles = [tile(100, 100, 15, 200_000)]; // gz=geomMaxZoom=15, 200km>150km（非 relevant）
        mgr.sync(syncParams());
        await flush();
        mgr.sync(syncParams());

        const elev = mgr.terrainElevAt(35, 139);
        expect(elev).not.toBeNull();
        expect(elev as number).toBeCloseTo(1234, 3);
    });

    it("取得失敗(404)の湖面タイルを 0m でなく隣接タイルの接線標高で平坦建築する", async () => {
        const mgr = makeManager();
        // 中央 geom タイル(gx=100,gy=100)は全レイヤ 404（決定的未配信）かつ粗ズーム祖先も 404＝本栖湖 z15
        // 湖面タイルの実挙動（湖面は dem_png でも未配信）。粗ズームフォールバックも尽きて failedRetryAt へ。
        // 上下左右の隣接タイルは一様 900m（本栖湖の湖面標高 ≒ 湖岸標高）。
        loadElevationTile.mockImplementation((...args: unknown[]) => {
            const zoom = args[0] as number;
            const gx = args[1] as number;
            const gy = args[2] as number;
            // 中央タイル(z10)も粗ズーム祖先(z<10)も 404。決定的 404 なので粗ズームを試すが全滅 → 再 throw。
            if ((gx === 100 && gy === 100) || zoom < 10) {
                return Promise.reject(new TileFetchError("HTTP 404", 404));
            }
            return Promise.resolve(new Float32Array(256 * 256).fill(900));
        });
        selectedTiles = [
            tile(100, 100, 10),
            tile(100, 99, 10),
            tile(100, 101, 10),
            tile(99, 100, 10),
            tile(101, 100, 10),
        ];
        mgr.sync(syncParams());
        await flush(); // 中央 404→failedRetryAt、隣接 900m ロード完了
        capturedBuilds.length = 0;
        mgr.sync(syncParams()); // 隣接到着後、中央を隣接接線 900m で平坦建築

        // 中央タイル(404)は FLAT_SEA_ELEV(0m) ではなく隣接接線標高 900m で平坦建築されること。
        // これが「湖中央が 0m に沈む（≒900m クレーター）」の根本修正。
        const centerBuilds = capturedBuilds.filter((b) => b.tx === 100 && b.ty === 100);
        expect(centerBuilds.length).toBeGreaterThan(0);
        const built = centerBuilds[centerBuilds.length - 1].geomElev;
        const mean = built.reduce((a, b) => a + b, 0) / built.length;
        expect(mean).toBeCloseTo(900, 0);
    });

    describe("continuous モード / drainBuildQueue（連続カメラ移動時のフレーム分散）", () => {
        it("continuous 未指定（既定）では従来通り sync 内で即座に実ビルドする", async () => {
            const mgr = makeManager();
            mgr.sync(syncParams());
            await flush(); // 標高到着
            mgr.sync(syncParams());
            // continuous を渡していないので、sync 呼び出し内で同期的にビルドされる。
            expect(MeshMock).toHaveBeenCalledTimes(1);
        });

        it("continuous: true では実ビルドを sync 内で行わず、drainBuildQueue で消化するまで遅延する", async () => {
            const mgr = makeManager();
            mgr.sync({ ...syncParams(), continuous: true });
            await flush(); // 標高到着

            mgr.sync({ ...syncParams(), continuous: true });
            // 判定は済んでいるが実ビルドはキューへ積まれるのみ → まだ Mesh は作られない。
            expect(MeshMock).toHaveBeenCalledTimes(0);
            // pendingBuilds が残っている間は idle にならない。
            expect(mgr.isIdle()).toBe(false);

            mgr.drainBuildQueue();
            expect(MeshMock).toHaveBeenCalledTimes(1);
        });

        it("drainBuildQueue は実測時間予算(既定4ms)を超えたら打ち切り、残りは次回へ持ち越す", async () => {
            const mgr = makeManager();
            selectedTiles = [
                tile(100, 100, 10),
                tile(100, 99, 10),
                tile(100, 101, 10),
                tile(99, 100, 10),
                tile(101, 100, 10),
                tile(102, 100, 10),
            ];
            mgr.sync({ ...syncParams(), continuous: true });
            await flush(); // 標高到着（全タイル共通の決定的モックで到着）

            mgr.sync({ ...syncParams(), continuous: true });
            expect(MeshMock).toHaveBeenCalledTimes(0);

            // performance.now() を決定的にモックし、4件目のビルド後に予算(4ms)超過となるよう
            // 制御する（固定件数ではなく実測時間で打ち切ることを検証するため）。
            let callCount = 0;
            const perfSpy = vi
                .spyOn(performance, "now")
                .mockImplementation(() => ++callCount);
            try {
                mgr.drainBuildQueue();
                expect(MeshMock).toHaveBeenCalledTimes(4); // 予算超過で打ち切り
                expect(mgr.isIdle()).toBe(false); // まだ 2 件残っている

                mgr.drainBuildQueue();
                expect(MeshMock).toHaveBeenCalledTimes(6); // 残り2件を消化
            } finally {
                perfSpy.mockRestore();
            }
        });

        it("1件目のビルド直後に予算超過が判明しても、そのフレームで最低1件は必ず処理する（進捗保証）", async () => {
            const mgr = makeManager();
            selectedTiles = [
                tile(100, 100, 10),
                tile(100, 99, 10),
                tile(100, 101, 10),
            ];
            mgr.sync({ ...syncParams(), continuous: true });
            await flush();
            mgr.sync({ ...syncParams(), continuous: true });

            // 1 件目のビルド後、時刻が大きく飛んで即座に予算超過となるケースでも、
            // 0 件のまま停止（＝キューが永遠に進まない）ことがないことを検証する。
            let callCount = 0;
            const perfSpy = vi
                .spyOn(performance, "now")
                .mockImplementation(() => (++callCount === 1 ? 0 : 1000));
            try {
                mgr.drainBuildQueue();
                expect(MeshMock).toHaveBeenCalledTimes(1);
            } finally {
                perfSpy.mockRestore();
            }
        });

        it("drainBuildQueue 消化前に選択から外れたタイルはビルドされずキューから捨てられる", async () => {
            const mgr = makeManager();
            mgr.sync({ ...syncParams(), continuous: true });
            await flush(); // 標高到着

            mgr.sync({ ...syncParams(), continuous: true }); // キューへ積むのみ

            // ドレイン前にカメラが移動し、当該タイルが選択から外れたケースを模す。
            // desiredKeys は sync() 呼び出し時にのみ更新されるため、再 sync してから drain する。
            selectedTiles = [tile(200, 200, 10)];
            mgr.sync({ ...syncParams(), continuous: true });

            mgr.drainBuildQueue();
            // 既に不要になったタイルは無視してビルドしない（無駄な GPU リソース生成を避ける）。
            expect(MeshMock).toHaveBeenCalledTimes(0);
        });

        it("continuous: true でも空のキューに対する drainBuildQueue は何もしない（コスト最小）", () => {
            const mgr = makeManager();
            expect(() => mgr.drainBuildQueue()).not.toThrow();
            expect(MeshMock).toHaveBeenCalledTimes(0);
        });
    });

    describe("continuous モード / geom 標高フェッチの同時実行数制限（Japan/GSI タイル同時完了によるガタつき対策）", () => {
        it("continuous: true では geom 標高フェッチの同時実行数を上限（既定4）に制限し、超過分は完了ごとに繰り上げて起動する", async () => {
            const resolvers: Array<(v: Float32Array) => void> = [];
            loadElevationTile.mockImplementation(
                () => new Promise<Float32Array>((resolve) => { resolvers.push(resolve); }),
            );
            selectedTiles = [
                tile(100, 100, 10),
                tile(101, 100, 10),
                tile(102, 100, 10),
                tile(103, 100, 10),
                tile(104, 100, 10),
                tile(105, 100, 10),
            ];
            const mgr = makeManager();
            mgr.sync({ ...syncParams(), continuous: true });

            // 6 タイル desired でも、同時実行数上限（4）までしかフェッチを開始しない。
            expect(loadElevationTile).toHaveBeenCalledTimes(4);

            // 1 件 resolve すると、待機中の 5 件目が繰り上がって起動する。
            resolvers[0](new Float32Array(256 * 256));
            await flush();
            expect(loadElevationTile).toHaveBeenCalledTimes(5);

            resolvers[1](new Float32Array(256 * 256));
            await flush();
            expect(loadElevationTile).toHaveBeenCalledTimes(6);
        });

        it("continuous 未指定（既定）では同時実行数を制限せず、選択タイル全件を即座にフェッチする", () => {
            const resolvers: Array<(v: Float32Array) => void> = [];
            loadElevationTile.mockImplementation(
                () => new Promise<Float32Array>((resolve) => { resolvers.push(resolve); }),
            );
            selectedTiles = [
                tile(100, 100, 10),
                tile(101, 100, 10),
                tile(102, 100, 10),
                tile(103, 100, 10),
                tile(104, 100, 10),
                tile(105, 100, 10),
            ];
            const mgr = makeManager();
            mgr.sync(syncParams()); // continuous 未指定 → 従来通り無制限に即時フェッチ

            expect(loadElevationTile).toHaveBeenCalledTimes(6);
        });

        it("待機キューに積まれた後、視界外化して不要になったタイルは繰り上げ時にフェッチせず捨てられる", async () => {
            const resolvers: Array<(v: Float32Array) => void> = [];
            loadElevationTile.mockImplementation(
                () => new Promise<Float32Array>((resolve) => { resolvers.push(resolve); }),
            );
            selectedTiles = [
                tile(100, 100, 10),
                tile(101, 100, 10),
                tile(102, 100, 10),
                tile(103, 100, 10),
                tile(104, 100, 10), // 上限超過で待機キュー行き
            ];
            const mgr = makeManager();
            mgr.sync({ ...syncParams(), continuous: true });
            expect(loadElevationTile).toHaveBeenCalledTimes(4);

            // カメラが移動し、待機中だった 5 件目のタイルが選択から外れたケースを模す。
            selectedTiles = [
                tile(100, 100, 10),
                tile(101, 100, 10),
                tile(102, 100, 10),
                tile(103, 100, 10),
            ];
            mgr.sync({ ...syncParams(), continuous: true });

            // 実行中の 1 件が完了しても、不要になった待機タイルは起動されない
            // （新たな loadElevationTile 呼び出しが発生しない）。
            resolvers[0](new Float32Array(256 * 256));
            await flush();
            expect(loadElevationTile).toHaveBeenCalledTimes(4);
        });
    });
});
