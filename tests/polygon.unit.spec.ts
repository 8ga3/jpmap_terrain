/**
 * createPolygonNode の単体テスト (Issue #170)。
 *
 * Babylon 実体を立ち上げるとテストが重くなるため、Builders / TransformNode /
 * StandardMaterial を `jest.unstable_mockModule` で軽量スタブに差し替える。
 * Vector3 / Color3 は計算用に実体を使う（外部 I/O を持たない純数学）。
 */

import { jest } from "@jest/globals";

interface StubMaterial {
    name: string;
    disposed: boolean;
    alpha: number;
    backFaceCulling: boolean;
    disableLighting: boolean;
    emissiveColor: { r: number; g: number; b: number } | null;
    dispose(): void;
}

interface StubMesh {
    name: string;
    parent: unknown;
    material: StubMaterial | null;
    renderingGroupId: number;
    isPickable: boolean;
    billboardMode: number;
    position: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void };
    scaling: { x: number; y: number; z: number; setAll: (v: number) => void };
    enabledHistory: boolean[];
    disposed: boolean;
    dispose(): void;
    setEnabled(v: boolean): void;
}

interface StubTransformNode {
    name: string;
    enabledHistory: boolean[];
    setEnabled(value: boolean): void;
    disposed: boolean;
    dispose(): void;
}

const sphereCalls: Array<{ name: string; options: unknown }> = [];
const tubeCalls: Array<{
    name: string;
    options: { path: unknown[]; instance?: StubMesh; updatable?: boolean };
}> = [];
const planeCalls: Array<{ name: string; options: { width: number; height: number } }> = [];
const ribbonCalls: Array<{
    name: string;
    options: { pathArray?: unknown[][]; instance?: StubMesh };
}> = [];
const dynamicTextures: Array<{ name: string; disposed: boolean }> = [];
interface StubMaterialRecord {
    name: string;
    alpha: number;
    needDepthPrePass: boolean;
    emissiveColor: { r: number; g: number; b: number } | null;
}
const materials: StubMaterialRecord[] = [];
const transformNodes: StubTransformNode[] = [];
const allMeshes: StubMesh[] = [];

const buildMesh = (name: string): StubMesh => {
    const mesh: StubMesh = {
        name,
        parent: null,
        material: null,
        renderingGroupId: 0,
        isPickable: true,
        billboardMode: 0,
        position: {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) {
                this.x = x;
                this.y = y;
                this.z = z;
            },
        },
        scaling: {
            x: 1,
            y: 1,
            z: 1,
            setAll(v) {
                this.x = v;
                this.y = v;
                this.z = v;
            },
        },
        enabledHistory: [],
        disposed: false,
        dispose() {
            this.disposed = true;
        },
        setEnabled(v: boolean) {
            this.enabledHistory.push(v);
        },
    };
    allMeshes.push(mesh);
    return mesh;
};

jest.unstable_mockModule(
    "@babylonjs/core/Meshes/Builders/sphereBuilder",
    () => ({
        CreateSphere: (name: string, options: unknown): StubMesh => {
            sphereCalls.push({ name, options });
            return buildMesh(name);
        },
    }),
);

jest.unstable_mockModule(
    "@babylonjs/core/Meshes/Builders/tubeBuilder",
    () => ({
        CreateTube: (
            name: string,
            options: {
                path: unknown[];
                instance?: StubMesh;
                updatable?: boolean;
            },
        ): StubMesh => {
            tubeCalls.push({ name, options });
            // instance 指定時は同じインスタンスを返すのが Babylon の挙動。
            if (options.instance) return options.instance;
            return buildMesh(name);
        },
    }),
);

jest.unstable_mockModule("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: class {
        public name: string;
        public disposed = false;
        public alpha = 1;
        public backFaceCulling = true;
        public disableLighting = false;
        public needDepthPrePass = false;
        public emissiveColor: { r: number; g: number; b: number } | null = null;
        constructor(name: string) {
            this.name = name;
            materials.push(this);
        }
        dispose(): void {
            this.disposed = true;
        }
    },
}));

jest.unstable_mockModule("@babylonjs/core/Meshes/transformNode", () => ({
    TransformNode: class implements StubTransformNode {
        public name: string;
        public enabledHistory: boolean[] = [];
        public disposed = false;
        constructor(name: string) {
            this.name = name;
            transformNodes.push(this);
        }
        setEnabled(value: boolean): void {
            this.enabledHistory.push(value);
        }
        dispose(): void {
            this.disposed = true;
        }
    },
}));

// Mesh は NO_CAP 静的定数のみ参照される。
jest.unstable_mockModule("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: { NO_CAP: 0, DOUBLESIDE: 2 },
}));

jest.unstable_mockModule(
    "@babylonjs/core/Meshes/Builders/planeBuilder",
    () => ({
        CreatePlane: (
            name: string,
            options: { width: number; height: number },
        ): StubMesh => {
            planeCalls.push({ name, options });
            return buildMesh(name);
        },
    }),
);

jest.unstable_mockModule(
    "@babylonjs/core/Meshes/Builders/ribbonBuilder",
    () => ({
        CreateRibbon: (
            name: string,
            options: { pathArray?: unknown[][]; instance?: StubMesh },
        ): StubMesh => {
            ribbonCalls.push({ name, options });
            if (options.instance) return options.instance;
            return buildMesh(name);
        },
    }),
);

jest.unstable_mockModule(
    "@babylonjs/core/Materials/Textures/dynamicTexture",
    () => ({
        DynamicTexture: class {
            public name: string;
            public hasAlpha = false;
            public vScale = 1;
            public vOffset = 0;
            public disposed = false;
            constructor(name: string) {
                this.name = name;
                dynamicTextures.push(this);
            }
            getContext(): unknown {
                // 文字幅 measure をスタブ。長さ * 8 を文字幅とする。
                return {
                    font: "",
                    textBaseline: "",
                    textAlign: "",
                    fillStyle: "",
                    strokeStyle: "",
                    lineWidth: 0,
                    lineJoin: "",
                    miterLimit: 0,
                    measureText: (s: string) => ({ width: s.length * 8 }),
                    fillRect: (): void => {
                        /* noop */
                    },
                    clearRect: (): void => {
                        /* noop */
                    },
                    fillText: (): void => {
                        /* noop */
                    },
                    strokeText: (): void => {
                        /* noop */
                    },
                };
            }
            update(): void {
                /* noop */
            }
            dispose(): void {
                this.disposed = true;
            }
        },
    }),
);

jest.unstable_mockModule("@babylonjs/core/Meshes/abstractMesh", () => ({
    AbstractMesh: { BILLBOARDMODE_ALL: 7 },
}));

const { createPolygonNode } = await import("../src/terrain/polygon");

const sceneStub = {} as unknown as Parameters<typeof createPolygonNode>[0];

beforeEach(() => {
    sphereCalls.length = 0;
    tubeCalls.length = 0;
    planeCalls.length = 0;
    ribbonCalls.length = 0;
    dynamicTextures.length = 0;
    transformNodes.length = 0;
    allMeshes.length = 0;
    materials.length = 0;
});

describe("createPolygonNode 構築", () => {
    it("頂点数分の球と垂線 Tube + 1 本のポリライン Tube を生成する (closed=false)", () => {
        const node = createPolygonNode(sceneStub, "p1", {
            points: [
                { lat: 35.0, lon: 139.0 },
                { lat: 35.1, lon: 139.1 },
                { lat: 35.2, lon: 139.2 },
            ],
        });
        expect(sphereCalls.length).toBe(3);
        // 構築時: 垂線 Tube 3 本 + ポリライン Tube 1 本 = 4
        expect(tubeCalls.length).toBe(4);
        expect(node.id).toBe("p1");
        expect(transformNodes.length).toBe(1);
        expect(transformNodes[0].name).toBe("polygon-p1");
    });

    it("closed=true のとき初期 Tube path に先頭頂点が append される", () => {
        createPolygonNode(sceneStub, "p2", {
            points: [
                { lat: 35.0, lon: 139.0 },
                { lat: 35.1, lon: 139.1 },
                { lat: 35.2, lon: 139.2 },
            ],
            closed: true,
        });
        // 末尾の Tube call がポリライン本体（垂線が先に 3 本構築される）。
        const lineCall = tubeCalls[tubeCalls.length - 1];
        const initialPath = lineCall.options.path as Array<{
            x: number;
            y: number;
            z: number;
        }>;
        // 3 点 + closed の先頭再追加 = 4
        expect(initialPath.length).toBe(4);
        expect(initialPath[0]).not.toBe(initialPath[initialPath.length - 1]);
        expect(initialPath[0].x).toBe(initialPath[initialPath.length - 1].x);
        expect(initialPath[0].y).toBe(initialPath[initialPath.length - 1].y);
        expect(initialPath[0].z).toBe(initialPath[initialPath.length - 1].z);
    });

    it("absolute モードでは elevationResolved が即時 true となる", () => {
        const node = createPolygonNode(sceneStub, "p3", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 10 },
                { lat: 35.1, lon: 139.1, altitude: 20 },
            ],
            altitudeMode: "absolute",
        });
        expect(node.getHandle().elevationResolved).toBe(true);
    });

    it("labels[i] が指定された頂点にのみラベル平面を生成する", () => {
        createPolygonNode(sceneStub, "pL", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
                { lat: 35.2, lon: 139.2, altitude: 0 },
            ],
            altitudeMode: "absolute",
            labels: ["A", "", "C"],
        });
        // 空文字列もラベル対象（明示指定されている）。3 点 → 3 plane。
        expect(planeCalls.length).toBe(3);
    });

    it("labels が一切指定されない場合はラベル平面を作らない", () => {
        createPolygonNode(sceneStub, "pL2", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
            ],
            altitudeMode: "absolute",
        });
        expect(planeCalls.length).toBe(0);
    });
});

describe("createPolygonNode applyTransform", () => {
    it("applyTransform でポリライン Tube が instance 指定で更新される", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "p4", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 5 },
            ],
            altitudeMode: "absolute",
        });
        const beforeLen = tubeCalls.length;
        node.applyTransform(
            [new Vector3(0, 0, 0), new Vector3(100, 5, 200)],
            [0, 0],
            1,
        );
        // 各頂点の垂線更新 (2) + ポリライン更新 (1)
        expect(tubeCalls.length - beforeLen).toBe(3);
        // applyTransform 由来の呼び出しはすべて instance 指定。
        for (let i = beforeLen; i < tubeCalls.length; i++) {
            expect(tubeCalls[i].options.instance).toBeDefined();
        }
    });

    it("absolute モードで applyTransform に渡された Y がそのまま使われる", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "p5", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 200 },
            ],
            altitudeMode: "absolute",
        });
        node.applyTransform(
            [new Vector3(10, 100, 20), new Vector3(30, 200, 40)],
            [0, 0],
            1,
        );
        // 末尾呼び出しがポリライン更新（垂線 2 本の後）。
        const lineUpdate = tubeCalls[tubeCalls.length - 1];
        const path = lineUpdate.options.path as Array<{ y: number }>;
        expect(path[0].y).toBe(100);
        expect(path[1].y).toBe(200);
    });

    it("垂線の終端 Y が groundYs に追従する（null は 0 フォールバック）", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "pV", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
        });
        const beforeLen = tubeCalls.length;
        node.applyTransform(
            [new Vector3(0, 100, 0), new Vector3(50, 100, 0)],
            [25, null],
            1,
        );
        // 構築直後の applyTransform: 垂線 2 本 + ポリライン 1 本 が追加される。
        const drop0 = tubeCalls[beforeLen];
        const drop1 = tubeCalls[beforeLen + 1];
        const drop0Path = drop0.options.path as Array<{ y: number }>;
        const drop1Path = drop1.options.path as Array<{ y: number }>;
        expect(drop0Path[0].y).toBe(100);
        expect(drop0Path[1].y).toBe(25);
        expect(drop1Path[0].y).toBe(100);
        expect(drop1Path[1].y).toBe(0); // null → 0 フォールバック
    });

    it("ラベル位置が球より上 (Y オフセット) に配置される", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "pLpos", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
            labels: ["X", "Y"],
            style: { pointDiameter: 20 },
        });
        node.applyTransform(
            [new Vector3(0, 100, 0), new Vector3(50, 100, 0)],
            [0, 0],
            1,
        );
        // ラベル平面は plane 順序で記録されている。
        // sphere の position(=100) より上にあること。
        // allMeshes のうち polygon-pLpos-label-* を抽出する。
        const labelMeshes = allMeshes.filter((m) =>
            m.name.startsWith("polygon-pLpos-label-"),
        );
        expect(labelMeshes.length).toBe(2);
        for (const lm of labelMeshes) {
            expect(lm.position.y).toBeGreaterThan(100);
        }
    });
});

describe("createPolygonNode enabled / dispose", () => {
    it("setEnabledLogical(false) で root.setEnabled(false) が呼ばれる", () => {
        const node = createPolygonNode(sceneStub, "p6", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
            ],
            altitudeMode: "absolute",
        });
        const root = transformNodes[0];
        const beforeLen = root.enabledHistory.length;
        node.setEnabledLogical(false);
        expect(root.enabledHistory.slice(beforeLen)).toContain(false);
    });

    it("setVerticalsEnabledLogical で垂線メッシュの setEnabled が連動する", () => {
        const node = createPolygonNode(sceneStub, "pVe", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
            ],
            altitudeMode: "absolute",
        });
        const dropMeshes = allMeshes.filter((m) =>
            m.name.startsWith("polygon-pVe-drop-"),
        );
        expect(dropMeshes.length).toBe(2);
        node.setVerticalsEnabledLogical(false);
        for (const dm of dropMeshes) {
            expect(dm.enabledHistory).toContain(false);
        }
        expect(node.getHandle().verticalsEnabled).toBe(false);
        node.setVerticalsEnabledLogical(true);
        expect(node.getHandle().verticalsEnabled).toBe(true);
    });

    it("setLabelsEnabledLogical でラベルメッシュの setEnabled が連動する", () => {
        const node = createPolygonNode(sceneStub, "pLe", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
            ],
            altitudeMode: "absolute",
            labels: ["a", "b"],
        });
        const labelMeshes = allMeshes.filter((m) =>
            m.name.startsWith("polygon-pLe-label-"),
        );
        expect(labelMeshes.length).toBe(2);
        node.setLabelsEnabledLogical(false);
        for (const lm of labelMeshes) {
            expect(lm.enabledHistory).toContain(false);
        }
        expect(node.getHandle().labelsEnabled).toBe(false);
    });

    it("dispose で sphere / drop / label / line / material / texture / root が全て解放される", () => {
        const node = createPolygonNode(sceneStub, "p7", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
                { lat: 35.2, lon: 139.2, altitude: 0 },
            ],
            altitudeMode: "absolute",
            labels: ["a", "b", "c"],
        });
        node.dispose();
        for (const m of allMeshes) {
            expect(m.disposed).toBe(true);
        }
        // probe DT は構築時に dispose 済み、ラベル DT は dispose() で解放される。
        for (const dt of dynamicTextures) {
            expect(dt.disposed).toBe(true);
        }
        expect(transformNodes[0].disposed).toBe(true);
    });
});

describe("createPolygonNode 壁 (#172)", () => {
    it("構築時に壁 Ribbon が 1 本生成される (closed=false)", () => {
        createPolygonNode(sceneStub, "pW1", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
                { lat: 35.2, lon: 139.2, altitude: 100 },
            ],
            altitudeMode: "absolute",
        });
        expect(ribbonCalls.length).toBe(1);
        const initial = ribbonCalls[0].options.pathArray as unknown[][];
        // pathArray = [topRow, groundRow]
        expect(initial.length).toBe(2);
        expect(initial[0].length).toBe(3);
        expect(initial[1].length).toBe(3);
    });

    it("closed=true で壁 Ribbon の各 row 末尾に先頭頂点が append される", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "pW2", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
                { lat: 35.2, lon: 139.2, altitude: 100 },
            ],
            altitudeMode: "absolute",
            closed: true,
        });
        node.applyTransform(
            [
                new Vector3(0, 100, 0),
                new Vector3(50, 100, 0),
                new Vector3(50, 100, 50),
            ],
            [10, 20, 30],
            1,
        );
        // 構築 1 + 更新 1 = 2 回
        expect(ribbonCalls.length).toBe(2);
        const update = ribbonCalls[1].options.pathArray as Array<
            Array<{ x: number; y: number; z: number }>
        >;
        expect(update[0].length).toBe(4); // top row: 3 + 1 (先頭再追加)
        expect(update[1].length).toBe(4);
        // top: y は worldPoints[i].y がそのまま入る
        expect(update[0][0].y).toBe(100);
        expect(update[0][3].y).toBe(100);
        // ground: y は groundYs[i]、末尾は先頭の groundY
        expect(update[1][0].y).toBe(10);
        expect(update[1][3].y).toBe(10);
    });

    it("applyTransform で壁 Ribbon が instance 指定で更新される", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "pW3", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
        });
        const before = ribbonCalls.length;
        node.applyTransform(
            [new Vector3(0, 100, 0), new Vector3(50, 100, 0)],
            [0, 0],
            1,
        );
        expect(ribbonCalls.length - before).toBe(1);
        expect(ribbonCalls[before].options.instance).toBeDefined();
    });

    it("setWallsEnabledLogical(false) で壁メッシュの setEnabled(false) が呼ばれ、その後の更新がスキップされる", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "pW4", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
        });
        const wallMeshes = allMeshes.filter(
            (m) => m.name === "polygon-pW4-walls",
        );
        expect(wallMeshes.length).toBe(1);
        node.setWallsEnabledLogical(false);
        expect(wallMeshes[0].enabledHistory).toContain(false);
        expect(node.getHandle().wallsEnabled).toBe(false);

        const before = ribbonCalls.length;
        node.applyTransform(
            [new Vector3(0, 100, 0), new Vector3(50, 100, 0)],
            [0, 0],
            1,
        );
        // wallsEnabled=false の間は CreateRibbon 更新を行わない。
        expect(ribbonCalls.length).toBe(before);

        node.setWallsEnabledLogical(true);
        node.applyTransform(
            [new Vector3(0, 100, 0), new Vector3(50, 100, 0)],
            [0, 0],
            1,
        );
        // 再 enable 時に直近スナップショットで 1 回 + applyTransform で 1 回 = +2
        expect(ribbonCalls.length).toBe(before + 2);
    });

    it("wallsEnabled は初期値 true、PolygonOptions.wallsEnabled=false で初期 hide になる", () => {
        const node = createPolygonNode(sceneStub, "pW5", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
            wallsEnabled: false,
        });
        expect(node.getHandle().wallsEnabled).toBe(false);
        const wallMesh = allMeshes.find((m) => m.name === "polygon-pW5-walls");
        expect(wallMesh).toBeDefined();
        // 初回 applyVisibility で false が積まれる。
        expect(wallMesh!.enabledHistory).toContain(false);
    });

    it("wallColor / wallOpacity が壁マテリアルへ反映され、半透明時は needDepthPrePass=true となる", () => {
        createPolygonNode(sceneStub, "pW6", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
            style: { wallColor: "#00ff00", wallOpacity: 0.5 },
        });
        const wallMat = materials.find(
            (m) => m.name === "polygon-pW6-walls-mat",
        );
        expect(wallMat).toBeDefined();
        expect(wallMat!.alpha).toBe(0.5);
        expect(wallMat!.needDepthPrePass).toBe(true);
        // emissive: #00ff00 → r=0, g=1, b=0
        expect(wallMat!.emissiveColor!.r).toBe(0);
        expect(wallMat!.emissiveColor!.g).toBe(1);
        expect(wallMat!.emissiveColor!.b).toBe(0);
    });

    it("wallOpacity=1 のときは needDepthPrePass を有効化しない", () => {
        createPolygonNode(sceneStub, "pW7", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
            style: { wallOpacity: 1 },
        });
        const wallMat = materials.find(
            (m) => m.name === "polygon-pW7-walls-mat",
        );
        expect(wallMat).toBeDefined();
        expect(wallMat!.alpha).toBe(1);
        expect(wallMat!.needDepthPrePass).toBe(false);
    });

    it("wallsEnabled を false→true に切り替えた直後に Ribbon が直近 transform で再適用される (stale 回避)", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "pW8", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 100 },
                { lat: 35.1, lon: 139.1, altitude: 100 },
            ],
            altitudeMode: "absolute",
        });
        // 一度 transform を適用して直近スナップショットを保持させる。
        node.applyTransform(
            [new Vector3(10, 100, 0), new Vector3(50, 200, 0)],
            [10, 20],
            1,
        );
        node.setWallsEnabledLogical(false);
        const before = ribbonCalls.length;
        node.setWallsEnabledLogical(true);
        // 再 enable で 1 回 Ribbon 再適用される。
        expect(ribbonCalls.length).toBe(before + 1);
        const lastCall = ribbonCalls[ribbonCalls.length - 1];
        expect(lastCall.options.instance).toBeDefined();
        const path = lastCall.options.pathArray as Array<
            Array<{ y: number }>
        >;
        // 直近 worldPoints の Y が反映されていること。
        expect(path[0][0].y).toBe(100);
        expect(path[0][1].y).toBe(200);
    });
});

describe("createPolygonNode 点編集 API (#173)", () => {
    const basePoints = [
        { lat: 35.0, lon: 139.0, altitude: 100 },
        { lat: 35.1, lon: 139.1, altitude: 200 },
        { lat: 35.2, lon: 139.2, altitude: 300 },
    ];

    it("insertPoint で sphere / drop / line / wall が再構築され、handle.points が伸びる", () => {
        const node = createPolygonNode(sceneStub, "pi", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        const sphereBefore = sphereCalls.length;
        const tubeBefore = tubeCalls.length;
        const ribbonBefore = ribbonCalls.length;
        node.insertPoint(1, { lat: 35.05, lon: 139.05, altitude: 150 });
        // sphere: 新規 1 本、drop: 新規 1 本、line/wall: 1 回 dispose+再生成。
        expect(sphereCalls.length - sphereBefore).toBe(1);
        // 垂線 (drop) 新規 1 + line 再生成 1 = +2 Tube call
        expect(tubeCalls.length - tubeBefore).toBe(2);
        expect(ribbonCalls.length - ribbonBefore).toBe(1);
        const h = node.getHandle();
        expect(h.points.length).toBe(4);
        expect(h.points[1].lat).toBe(35.05);
    });

    it("insertPoint は範囲外 index で RangeError", () => {
        const node = createPolygonNode(sceneStub, "pi2", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        expect(() =>
            node.insertPoint(-1, { lat: 35, lon: 139, altitude: 0 }),
        ).toThrow(RangeError);
        expect(() =>
            node.insertPoint(99, { lat: 35, lon: 139, altitude: 0 }),
        ).toThrow(RangeError);
    });

    it("insertPoint は absolute モードで altitude 未指定なら throw", () => {
        const node = createPolygonNode(sceneStub, "pi3", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        expect(() => node.insertPoint(0, { lat: 35, lon: 139 })).toThrow(
            /absolute/,
        );
    });

    it("removePoint で末尾 sphere / drop が dispose され、line/wall が再生成される", () => {
        const node = createPolygonNode(sceneStub, "pr", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        const tubeBefore = tubeCalls.length;
        const ribbonBefore = ribbonCalls.length;
        const sphereMeshBefore = allMeshes.find(
            (m) => m.name === "polygon-pr-point-2",
        );
        const dropMeshBefore = allMeshes.find(
            (m) => m.name === "polygon-pr-drop-2",
        );
        node.removePoint(2);
        expect(sphereMeshBefore?.disposed).toBe(true);
        expect(dropMeshBefore?.disposed).toBe(true);
        // line/wall 1 回ずつ再生成。
        expect(tubeCalls.length - tubeBefore).toBe(1);
        expect(ribbonCalls.length - ribbonBefore).toBe(1);
        expect(node.getHandle().points.length).toBe(2);
    });

    it("removePoint は残り 2 点未満で throw", () => {
        const node = createPolygonNode(sceneStub, "pr2", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
            ],
            altitudeMode: "absolute",
        });
        expect(() => node.removePoint(0)).toThrow(/at least 2/);
    });

    it("updatePoint は点数同一なので line/wall を dispose しない", () => {
        const node = createPolygonNode(sceneStub, "pu", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        const lineMesh = allMeshes.find((m) => m.name === "polygon-pu-line");
        const wallMesh = allMeshes.find((m) => m.name === "polygon-pu-walls");
        const tubeBefore = tubeCalls.length;
        const ribbonBefore = ribbonCalls.length;
        node.updatePoint(0, { altitude: 999 });
        // 点数不変 → 再生成なし。Tube/Ribbon の追加 call も発生しない。
        expect(lineMesh?.disposed).toBe(false);
        expect(wallMesh?.disposed).toBe(false);
        expect(tubeCalls.length).toBe(tubeBefore);
        expect(ribbonCalls.length).toBe(ribbonBefore);
        expect(node.getHandle().points[0].altitude).toBe(999);
    });

    it("updatePoint(label) は sparse 同期する: 文字列で生成、null で破棄", () => {
        const node = createPolygonNode(sceneStub, "pul", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        // labels 未指定 → handle.labels=undefined。
        expect(node.getHandle().labels).toBeUndefined();

        node.updatePoint(1, { label: "L1" });
        // index=1 にラベル平面が新規生成される。
        const planeAfterAdd = planeCalls.filter((p) =>
            p.name.startsWith("polygon-pul-label-"),
        );
        expect(planeAfterAdd.length).toBe(1);
        const labels1 = node.getHandle().labels;
        expect(labels1).toBeDefined();
        expect(labels1?.[0]).toBeUndefined();
        expect(labels1?.[1]).toBe("L1");

        // null 指定でラベル mesh が dispose される。
        const labelMesh = allMeshes.find(
            (m) => m.name === "polygon-pul-label-1",
        );
        node.updatePoint(1, { label: null });
        expect(labelMesh?.disposed).toBe(true);
        const labels2 = node.getHandle().labels;
        expect(labels2?.[1]).toBeUndefined();
    });

    it("updatePoint は範囲外で RangeError、altitudeMode=absolute では altitude=undefined のままなら throw しない (現状値継承)", () => {
        const node = createPolygonNode(sceneStub, "pu2", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        expect(() => node.updatePoint(99, { lat: 35 })).toThrow(RangeError);
        // partial.altitude 未指定でも、現状の altitude を継承するため throw しない。
        expect(() => node.updatePoint(0, { lat: 35.5 })).not.toThrow();
    });

    it("replacePoints で全 sphere/drop/label が dispose+再生成され、line/wall も再構築される", () => {
        const node = createPolygonNode(sceneStub, "prep", {
            points: [...basePoints],
            altitudeMode: "absolute",
            labels: ["a", "b", "c"],
        });
        const labelDtBefore = dynamicTextures.filter((t) =>
            t.name.startsWith("polygon-prep-label-"),
        );
        const sphereBefore = sphereCalls.length;
        const tubeBefore = tubeCalls.length;
        const ribbonBefore = ribbonCalls.length;
        node.replacePoints([
            { lat: 35.5, lon: 139.5, altitude: 50 },
            { lat: 35.6, lon: 139.6, altitude: 60 },
        ]);
        // sphere 新規 2 本、drop 新規 2 本、line+wall 各 1 回再構築。
        expect(sphereCalls.length - sphereBefore).toBe(2);
        expect(tubeCalls.length - tubeBefore).toBe(2 + 1);
        expect(ribbonCalls.length - ribbonBefore).toBe(1);
        // 旧 label の DT が dispose される。
        for (const dt of labelDtBefore) {
            expect(dt.disposed).toBe(true);
        }
        const h = node.getHandle();
        expect(h.points.length).toBe(2);
        // labels は全 undefined（hasLabels=true は維持）。
        expect(h.labels).toBeDefined();
        expect(h.labels?.[0]).toBeUndefined();
    });

    it("replacePoints は 2 点未満で throw", () => {
        const node = createPolygonNode(sceneStub, "prep2", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        expect(() =>
            node.replacePoints([{ lat: 35, lon: 139, altitude: 0 }]),
        ).toThrow(/at least 2/);
    });

    it("replacePoints は緯度経度範囲外で RangeError", () => {
        const node = createPolygonNode(sceneStub, "prep3", {
            points: [...basePoints],
            altitudeMode: "absolute",
        });
        expect(() =>
            node.replacePoints([
                { lat: 35, lon: 139, altitude: 0 },
                { lat: 999, lon: 139, altitude: 0 },
            ]),
        ).toThrow(RangeError);
    });
});
