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
    position: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void };
    scaling: { x: number; y: number; z: number; setAll: (v: number) => void };
    disposed: boolean;
    dispose(): void;
    setEnabled?: (v: boolean) => void;
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
const transformNodes: StubTransformNode[] = [];
const allMeshes: StubMesh[] = [];

const buildMesh = (name: string): StubMesh => {
    const mesh: StubMesh = {
        name,
        parent: null,
        material: null,
        renderingGroupId: 0,
        isPickable: true,
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
        disposed: false,
        dispose() {
            this.disposed = true;
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
        public emissiveColor: { r: number; g: number; b: number } | null = null;
        constructor(name: string) {
            this.name = name;
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
    Mesh: { NO_CAP: 0 },
}));

const { createPolygonNode } = await import("../src/terrain/polygon");

const sceneStub = {} as unknown as Parameters<typeof createPolygonNode>[0];

beforeEach(() => {
    sphereCalls.length = 0;
    tubeCalls.length = 0;
    transformNodes.length = 0;
    allMeshes.length = 0;
});

describe("createPolygonNode 構築", () => {
    it("頂点数分の球と 1 本の Tube を生成する (closed=false)", () => {
        const node = createPolygonNode(sceneStub, "p1", {
            points: [
                { lat: 35.0, lon: 139.0 },
                { lat: 35.1, lon: 139.1 },
                { lat: 35.2, lon: 139.2 },
            ],
        });
        expect(sphereCalls.length).toBe(3);
        // 初期構築の Tube 1 回 + 即時 applyTransform は呼ばれていないので 1 回のみ
        expect(tubeCalls.length).toBe(1);
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
        const initialPath = tubeCalls[0].options.path as Array<{
            x: number;
            y: number;
            z: number;
        }>;
        // 3 点 + closed の先頭再追加 = 4
        expect(initialPath.length).toBe(4);
        // 先頭と末尾は別オブジェクト（参照分離）かつ同値。
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
});

describe("createPolygonNode applyTransform", () => {
    it("applyTransform で Tube が instance 指定で更新される", async () => {
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const node = createPolygonNode(sceneStub, "p4", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 5 },
            ],
            altitudeMode: "absolute",
        });
        node.applyTransform(
            [new Vector3(0, 0, 0), new Vector3(100, 5, 200)],
            1,
        );
        // 構築時 1 回 + applyTransform 1 回
        expect(tubeCalls.length).toBe(2);
        expect(tubeCalls[1].options.instance).toBeDefined();
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
            1,
        );
        const path = tubeCalls[1].options.path as Array<{ y: number }>;
        expect(path[0].y).toBe(100);
        expect(path[1].y).toBe(200);
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
        // 構築時の applyVisibility 呼び出しを差し引いて、明示的な false 切替を確認する
        const beforeLen = root.enabledHistory.length;
        node.setEnabledLogical(false);
        expect(root.enabledHistory.slice(beforeLen)).toContain(false);
    });

    it("dispose で全 sphere / Tube / material / root が dispose される", () => {
        const node = createPolygonNode(sceneStub, "p7", {
            points: [
                { lat: 35.0, lon: 139.0, altitude: 0 },
                { lat: 35.1, lon: 139.1, altitude: 0 },
                { lat: 35.2, lon: 139.2, altitude: 0 },
            ],
            altitudeMode: "absolute",
        });
        node.dispose();
        // 構築時の全 mesh が dispose 済み
        for (const m of allMeshes) {
            expect(m.disposed).toBe(true);
        }
        expect(transformNodes[0].disposed).toBe(true);
    });
});
