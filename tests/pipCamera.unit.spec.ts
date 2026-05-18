/**
 * `src/demos/flight/pipCamera.ts` の unit test (Issue #264)。
 *
 * Babylon.js の FreeCamera / Scene / Engine をモックし、
 * PIP カメラの生成・更新・ビューポート計算・破棄をテストする。
 */


import { describe, it, expect, beforeEach } from "@jest/globals";
import { jest } from "@jest/globals";

// --- Babylon.js mocks ---

const mockViewport = (jest.fn as any)().mockImplementation(
    (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h }),
) as jest.Mock;

jest.unstable_mockModule("@babylonjs/core/Maths/math.viewport", () => ({
    Viewport: mockViewport,
}));

const mockCameraDispose = jest.fn() as jest.Mock;
const mockInputsClear = jest.fn() as jest.Mock;
const mockSetTarget = jest.fn() as jest.Mock;

jest.unstable_mockModule("@babylonjs/core/Cameras/freeCamera", () => ({
    FreeCamera: (jest.fn as any)().mockImplementation(() => ({
        position: {
            x: 0, y: 0, z: 0,
            set: (jest.fn as any)().mockImplementation(
                function (this: Record<string, number>, x: number, y: number, z: number) {
                    this.x = x; this.y = y; this.z = z;
                },
            ),
        },
        minZ: 0,
        maxZ: 0,
        viewport: null,
        inputs: { clear: mockInputsClear },
        setTarget: mockSetTarget,
        dispose: mockCameraDispose,
    })),
}));

jest.unstable_mockModule("@babylonjs/core/Maths/math.vector", () => ({
    Vector3: Object.assign(
        (jest.fn as any)().mockImplementation(
            (x: number, y: number, z: number) => ({ x, y, z }),
        ),
        { Zero: () => ({ x: 0, y: 0, z: 0, set: jest.fn() }) },
    ),
}));

// Dynamic import after mocks
const { createPipCamera, PIP_TILT_RAD, PIP_WIDTH_FRACTION, PIP_ASPECT_W, PIP_ASPECT_H, PIP_MIN_WIDTH_FRACTION, PIP_MAX_WIDTH_FRACTION, PIP_MARGIN_PX } = await import("../src/demos/flight/pipCamera.js");

// --- Helpers ---

function createMockScene(canvasWidth = 1920, canvasHeight = 1080): any {
    return {
        getEngine: () => ({
            getRenderWidth: () => canvasWidth,
            getRenderHeight: () => canvasHeight,
        }),
    };
}

// --- Tests ---

describe("pipCamera - createPipCamera", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("FreeCamera を生成し inputs.clear() を呼ぶ", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        expect(pip.camera).toBeDefined();
        expect(mockInputsClear).toHaveBeenCalledTimes(1);
    });

    it("minZ=0.5, maxZ=400000 を設定する", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        expect(pip.camera.minZ).toBe(0.5);
        expect(pip.camera.maxZ).toBe(400000);
    });

    it("初期 widthFraction が PIP_WIDTH_FRACTION と一致する", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        expect(pip.widthFraction).toBe(PIP_WIDTH_FRACTION);
    });

    it("初期ビューポートが設定される", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        // refreshViewport is called during creation
        expect(pip.camera.viewport).not.toBeNull();
    });
});

describe("pipCamera - widthFraction clamping", () => {
    it("最小値以下に設定すると PIP_MIN_WIDTH_FRACTION になる", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        pip.widthFraction = 0.01;
        expect(pip.widthFraction).toBe(PIP_MIN_WIDTH_FRACTION);
    });

    it("最大値以上に設定すると PIP_MAX_WIDTH_FRACTION になる", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        pip.widthFraction = 0.9;
        expect(pip.widthFraction).toBe(PIP_MAX_WIDTH_FRACTION);
    });

    it("範囲内の値はそのまま保持される", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        pip.widthFraction = 0.25;
        expect(pip.widthFraction).toBe(0.25);
    });
});

describe("pipCamera - update", () => {
    // update() は planePosition の .x/.y/.z を読むだけなので plain object で十分
    const vec3 = (x: number, y: number, z: number) => ({ x, y, z } as any);

    it("カメラ位置が飛行機の Y-2 に配置される", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);

        pip.update(vec3(100, 500, 200), 0);
        expect(pip.camera.position.set).toHaveBeenCalledWith(100, 498, 200);
    });

    it("heading=0 (北) のとき setTarget の z > camera.z (前方を向く)", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);

        pip.update(vec3(0, 100, 0), 0);

        expect(mockSetTarget).toHaveBeenCalled();
        const targetArg = mockSetTarget.mock.calls[mockSetTarget.mock.calls.length - 1][0] as Record<string, number>;
        // heading=0 → forward is +Z (north)
        expect(targetArg.z).toBeGreaterThan(0);
        // tilt down → target Y < camera Y
        expect(targetArg.y).toBeLessThan(98);
    });

    it("heading=90 (東) のとき setTarget の x > camera.x", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);

        pip.update(vec3(0, 100, 0), 90);

        const targetArg = mockSetTarget.mock.calls[mockSetTarget.mock.calls.length - 1][0] as Record<string, number>;
        expect(targetArg.x).toBeGreaterThan(0);
    });
});

describe("pipCamera - refreshViewport", () => {
    it("3:4 アスペクト比が維持される", () => {
        const canvasW = 1920;
        const canvasH = 1080;
        const scene = createMockScene(canvasW, canvasH);
        const pip = createPipCamera(scene);

        pip.refreshViewport();

        const lastCall = mockViewport.mock.calls[mockViewport.mock.calls.length - 1];
        const vpWidth = lastCall[2] as number;  // widthFraction
        const vpHeight = lastCall[3] as number; // heightFraction

        const pixelW = vpWidth * canvasW;
        const pixelH = vpHeight * canvasH;
        const ratio = pixelW / pixelH;
        expect(ratio).toBeCloseTo(PIP_ASPECT_W / PIP_ASPECT_H, 5);
    });

    it("マージンが含まれる (x > 0, y > 0)", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        pip.refreshViewport();

        const lastCall = mockViewport.mock.calls[mockViewport.mock.calls.length - 1];
        const marginX = lastCall[0] as number;
        const marginY = lastCall[1] as number;
        expect(marginX).toBeGreaterThan(0);
        expect(marginY).toBeGreaterThan(0);
    });

    it("canvas サイズ 0 のとき viewport を更新しない", () => {
        const scene = createMockScene(0, 0);
        mockViewport.mockClear();
        createPipCamera(scene);
        // refreshViewport は createPipCamera 内で呼ばれるが、
        // canvas=0 のときは Viewport コンストラクタが呼ばれない
        expect(mockViewport).not.toHaveBeenCalled();
    });

    it("widthFraction 変更後に refreshViewport すると viewport サイズが変わる", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);

        const callsBefore = mockViewport.mock.calls.length;
        pip.widthFraction = 0.3;
        pip.refreshViewport();

        const lastCall = mockViewport.mock.calls[mockViewport.mock.calls.length - 1];
        expect(lastCall[2]).toBe(0.3);
        expect(mockViewport.mock.calls.length).toBeGreaterThan(callsBefore);
    });
});

describe("pipCamera - dispose", () => {
    it("camera.dispose() が呼ばれる", () => {
        const scene = createMockScene();
        const pip = createPipCamera(scene);
        pip.dispose();
        expect(mockCameraDispose).toHaveBeenCalledTimes(1);
    });
});

describe("pipCamera - constants", () => {
    it("PIP_TILT_RAD は 30° のラジアン値", () => {
        expect(PIP_TILT_RAD).toBeCloseTo((30 * Math.PI) / 180, 10);
    });

    it("PIP_MARGIN_PX は正の値", () => {
        expect(PIP_MARGIN_PX).toBeGreaterThan(0);
    });
});
