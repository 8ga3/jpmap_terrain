/**
 * PIP (Picture-in-Picture) カメラモジュール (Issue #264)
 *
 * 飛行機の腹部に搭載されたカメラの映像を、キャンバス左下に小窓表示する。
 * Babylon.js の `scene.activeCameras` 配列を利用し、メインカメラと
 * PIP カメラの両方を同一フレームで描画する。
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";

/** PIP camera tilt angle below horizontal (radians) */
const PIP_TILT_RAD = (30 * Math.PI) / 180;

/** Initial PIP width as fraction of canvas width */
const PIP_WIDTH_FRACTION = 0.2;

/** PIP aspect ratio (width:height = 3:4) */
const PIP_ASPECT_W = 3;
const PIP_ASPECT_H = 4;

/** Minimum PIP width fraction */
const PIP_MIN_WIDTH_FRACTION = 0.1;

/** Maximum PIP width fraction */
const PIP_MAX_WIDTH_FRACTION = 0.4;

/** Margin from canvas edge in pixels */
const PIP_MARGIN_PX = 12;

/** Offset below the plane for camera placement (Babylon units) */
const CAMERA_Y_OFFSET = -2;

/** Forward offset for the look-at target (Babylon units) */
const LOOK_AT_DISTANCE = 100;

// Re-export constants for testing
export {
    PIP_TILT_RAD,
    PIP_WIDTH_FRACTION,
    PIP_ASPECT_W,
    PIP_ASPECT_H,
    PIP_MIN_WIDTH_FRACTION,
    PIP_MAX_WIDTH_FRACTION,
    PIP_MARGIN_PX,
};

export interface PipState {
    camera: FreeCamera;
    /** Current width fraction (0-1) relative to canvas width */
    widthFraction: number;
    /** Update PIP camera position/orientation from plane's world state */
    update(planePosition: Vector3, headingDeg: number): void;
    /** Recalculate viewport after canvas resize or PIP size change */
    refreshViewport(): void;
    /** Dispose camera and cleanup */
    dispose(): void;
}

/**
 * PIP カメラを生成し、PipState を返す。
 *
 * @param scene - Babylon.js Scene
 * @returns PipState
 */
export function createPipCamera(scene: Scene): PipState {
    const camera = new FreeCamera("pip-camera", Vector3.Zero(), scene);
    camera.minZ = 0.5;
    camera.maxZ = 400000;

    // PIP カメラにはユーザー入力を受け付けない
    camera.inputs.clear();

    let widthFraction = PIP_WIDTH_FRACTION;

    /** 度 → ラジアン */
    const degToRad = (deg: number): number => (deg * Math.PI) / 180;

    const state: PipState = {
        camera,
        get widthFraction(): number {
            return widthFraction;
        },
        set widthFraction(value: number) {
            widthFraction = clampWidthFraction(value);
        },

        update(planePosition: Vector3, headingDeg: number): void {
            // カメラを飛行機の真下に配置
            camera.position.set(
                planePosition.x,
                planePosition.y + CAMERA_Y_OFFSET,
                planePosition.z,
            );

            // headingDeg: 北=0°, 時計回り → Babylon.js Y軸回転に変換
            // Babylon.js は左手座標系: +X=東, +Z=北
            const headingRad = degToRad(headingDeg);
            const forwardX = Math.sin(headingRad);
            const forwardZ = Math.cos(headingRad);

            // 水平前方から PIP_TILT_RAD だけ下を見る
            const tiltDown = -Math.sin(PIP_TILT_RAD);
            const horizontalScale = Math.cos(PIP_TILT_RAD);

            const targetX = camera.position.x + forwardX * horizontalScale * LOOK_AT_DISTANCE;
            const targetY = camera.position.y + tiltDown * LOOK_AT_DISTANCE;
            const targetZ = camera.position.z + forwardZ * horizontalScale * LOOK_AT_DISTANCE;

            camera.setTarget(new Vector3(targetX, targetY, targetZ));
        },

        refreshViewport(): void {
            const engine = scene.getEngine();
            const canvasWidth = engine.getRenderWidth();
            const canvasHeight = engine.getRenderHeight();

            if (canvasWidth <= 0 || canvasHeight <= 0) {
                return;
            }

            const marginX = PIP_MARGIN_PX / canvasWidth;
            const marginY = PIP_MARGIN_PX / canvasHeight;

            const pixelWidth = widthFraction * canvasWidth;
            const pixelHeight = pixelWidth * (PIP_ASPECT_H / PIP_ASPECT_W);
            const viewportHeight = pixelHeight / canvasHeight;

            camera.viewport = new Viewport(
                marginX,
                marginY,
                widthFraction,
                viewportHeight,
            );
        },

        dispose(): void {
            camera.dispose();
        },
    };

    // 初期ビューポートを設定
    state.refreshViewport();

    return state;
}

/**
 * widthFraction を許容範囲にクランプする。
 */
function clampWidthFraction(value: number): number {
    return Math.max(PIP_MIN_WIDTH_FRACTION, Math.min(PIP_MAX_WIDTH_FRACTION, value));
}
