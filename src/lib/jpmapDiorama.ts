/**
 * `JpmapDiorama` クラス本体
 *
 * spec/diorama-api.md §5 の API を提供する。`JpmapTerrain`（`src/lib/jpmapTerrain.ts`）
 * とは独立した公開APIで、`src/terrain/diorama/dioramaTerrain`（正方形グリッド + 実世界
 * DEM/タイル取得 + 縮小スケール）を用いた「箱庭ジオラマ」を任意のマウントポイントへ
 * 埋め込む。既存デモ（`src/demos/diorama/index.ts`）と同じ構成要素
 * （`src/lib/internal/diorama/` 配下の共有状態保持者・入力コントロール・WebXR
 * セッション統合）を、mount〜dispose・入力集約・AR統合を持つ1つのクラスへ組み上げる。
 */

import { Scene } from "@babylonjs/core/scene";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4, Color3 } from "@babylonjs/core/Maths/math.color";

import { createBabylonEngine } from "./internal/engineFactory";
import {
    DioramaArState,
    DioramaArStateChangeListener,
    DioramaCenter,
    DioramaTileMode,
    DioramaTileModeChangeListener,
    JPMAP_DIORAMA_DEFAULTS,
    JpmapDioramaOptions,
    JpmapDioramaViewChangeListener,
} from "./types";
import { createDioramaTerrain, type DioramaTerrain } from "../terrain/diorama/dioramaTerrain";
import {
    createDioramaViewController,
    type DioramaViewController,
} from "./internal/diorama/dioramaViewController";
import {
    createDioramaOrientationController,
    type DioramaOrientationController,
} from "./internal/diorama/dioramaOrientationController";
import {
    createDioramaTileModeController,
    type DioramaTileModeController,
} from "./internal/diorama/dioramaTileModeController";
import { setupDioramaKeyboardControls } from "./internal/diorama/dioramaKeyboardControls";
import { createDioramaArControlHud } from "./internal/diorama/dioramaArControlHud";
import { setupDioramaTouchControls, type DioramaTouchControls } from "./internal/diorama/dioramaTouchControls";
import {
    attachDioramaArButton,
    createDioramaArSessionController,
    isImmersiveArSupported,
    type DioramaArSessionController,
} from "./internal/diorama/webXrArSession";
import type { StickAxes } from "./internal/diorama/dioramaControllerMapping";

/** 何も行わないタッチHUD代替。`enableDefaultControls: false` 時に使う（冒頭のクラスコメント参照）。 */
const NOOP_TOUCH_CONTROLS: DioramaTouchControls = {
    setVisible: () => {
        /* no-op */
    },
    dispose: () => {
        /* no-op */
    },
};

/**
 * 箱庭ジオラマビューア。
 *
 * インスタンスは `JpmapDiorama.create()` 経由でのみ生成する（async 初期化のため）。
 */
export class JpmapDiorama {
    private readonly mountElement: HTMLElement;

    private _canvas: HTMLCanvasElement | null = null;
    private _engine: AbstractEngine | null = null;
    private _scene: Scene | null = null;
    private _camera: ArcRotateCamera | null = null;
    private _dioramaTerrain: DioramaTerrain | null = null;
    private _placementRoot: TransformNode | null = null;
    private _orientationRoot: TransformNode | null = null;

    private _viewController: DioramaViewController | null = null;
    private _orientationController: DioramaOrientationController | null = null;
    private _tileModeController: DioramaTileModeController | null = null;
    private _arController: DioramaArSessionController | null = null;

    private _touchControls: DioramaTouchControls | null = null;
    private _disposeKeyboardControls: (() => void) | null = null;
    private _detachArButton: (() => void) | null = null;
    private _unsubscribeArActiveChange: (() => void) | null = null;
    private _unsubscribeViewChange: (() => void) | null = null;
    private _unsubscribeTileModeChange: (() => void) | null = null;

    /** WebXR (`immersive-ar`) サポート判定結果（`initAsync` で一度だけ確認しキャッシュする）。 */
    private _arSupported = false;

    private _onWindowResize: (() => void) | null = null;
    private _resizeObserver: ResizeObserver | null = null;
    private _disposed = false;

    private _viewListeners: JpmapDioramaViewChangeListener[] = [];
    private _tileModeListeners: DioramaTileModeChangeListener[] = [];
    private _arStateListeners: DioramaArStateChangeListener[] = [];

    private constructor(mountElement: HTMLElement) {
        this.mountElement = mountElement;
    }

    /**
     * 指定したマウント要素にビューアを生成する。
     *
     * @param mountElement キャンバスと UI を配置する DOM 要素
     * @param options 初期化オプション（spec/diorama-api.md §5.2）
     * @returns 初期化済みの `JpmapDiorama` インスタンス
     */
    public static async create(mountElement: HTMLElement, options: JpmapDioramaOptions): Promise<JpmapDiorama> {
        if (!mountElement) {
            throw new TypeError("JpmapDiorama.create: mountElement is required");
        }
        if (!options || options.center === undefined || options.center === null) {
            throw new TypeError("JpmapDiorama.create: options.center is required");
        }
        const instance = new JpmapDiorama(mountElement);
        await instance.initAsync(options);
        return instance;
    }

    /**
     * mountElement に canvas を配置し、Babylon.js Engine/Scene/カメラ/地形/入力/AR統合を
     * 初期化する。初期化途中で例外が発生した場合は、生成済みリソースを `dispose()` と
     * 同等の後始末をしてから再 throw する。
     */
    private async initAsync(options: JpmapDioramaOptions): Promise<void> {
        const footprintHalfSizeM = options.footprintHalfSizeM ?? JPMAP_DIORAMA_DEFAULTS.footprintHalfSizeM;
        const tableRadiusM = options.tableRadiusM ?? JPMAP_DIORAMA_DEFAULTS.tableRadiusM;
        const tileMode = options.tileMode ?? JPMAP_DIORAMA_DEFAULTS.tileMode;
        const engineType = options.engine ?? JPMAP_DIORAMA_DEFAULTS.engine;
        const enableDefaultControls = options.enableDefaultControls ?? JPMAP_DIORAMA_DEFAULTS.enableDefaultControls;
        const showArButton = options.showArButton ?? JPMAP_DIORAMA_DEFAULTS.showArButton;

        const canvas = document.createElement("canvas");
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        canvas.style.outline = "none";
        canvas.style.touchAction = "none";
        this.mountElement.appendChild(canvas);
        this._canvas = canvas;

        try {
            // reverse-Z 深度バッファを無効化する。WebXRカメラはブラウザ提供の生の投影行列を
            // そのまま使う（reverse-Z変換されない）ため、reverse-Z前提の深度クリア値・
            // 比較関数と組み合わせるとAR中の深度テストが破綻する
            // （`createBabylonEngine` の `CreateBabylonEngineOptions.reverseDepthBuffer` 参照）。
            const engine = await createBabylonEngine(canvas, engineType, { reverseDepthBuffer: false });
            this._engine = engine;

            const scene = new Scene(engine);
            scene.clearColor = new Color4(0.05, 0.07, 0.1, 1);
            this._scene = scene;

            // カメラ設定は既存デモ（`src/demos/diorama/index.ts`）と同じ調整値を踏襲する
            // （実機・デスクトップ双方での検証結果に基づく値のため、詳細な理由は同ファイル
            // 冒頭のコメントを参照）。
            const camera = new ArcRotateCamera(
                "jpmap-diorama-camera",
                -Math.PI / 2,
                Math.PI / 3,
                tableRadiusM * 3,
                Vector3.Zero(),
                scene,
            );
            camera.lowerRadiusLimit = tableRadiusM * 1.2;
            camera.upperRadiusLimit = tableRadiusM * 15;
            camera.minZ = 0.01;
            camera.maxZ = 50;
            camera.wheelPrecision = 200;
            camera.useNaturalPinchZoom = true;
            camera.panningSensibility = 0;
            camera.attachControl(canvas, false);
            this._camera = camera;

            new HemisphericLight("jpmap-diorama-ambient-light", new Vector3(0, 1, 0), scene).intensity = 0.6;
            const sunLight = new DirectionalLight("jpmap-diorama-sun-light", new Vector3(-0.4, -1, -0.3), scene);
            sunLight.intensity = 0.8;
            sunLight.diffuse = new Color3(1, 0.98, 0.92);

            const dioramaTerrain = await createDioramaTerrain(scene, {
                // `createDioramaTerrain`（`dioramaTerrain.ts`）は渡された `center` を
                // 参照のまま内部状態（`resolved.center`）として保持するため、呼び出し元が
                // `options.center` オブジェクトを後から書き換えた場合に地形側の状態が
                // 意図せず変化しないよう、コピーして渡す。
                center: { ...options.center },
                footprintHalfSizeM,
                tableRadiusM,
                tileMode,
                gridSegments: options.gridSegments,
                demZoom: options.demZoom,
                textureZoom: options.textureZoom,
                heightScaleFactor: options.heightScaleFactor,
                baseDepthRatio: options.baseDepthRatio,
            });
            this._dioramaTerrain = dioramaTerrain;

            // 箱庭の配置・向き・地形を3階層のTransformNodeへ分離する
            // （`dioramaOrientationController.ts` 冒頭のコメント参照）。
            const placementRoot = new TransformNode("jpmap-diorama-placement-root", scene);
            const orientationRoot = new TransformNode("jpmap-diorama-orientation-root", scene);
            orientationRoot.parent = placementRoot;
            dioramaTerrain.root.parent = orientationRoot;
            this._placementRoot = placementRoot;
            this._orientationRoot = orientationRoot;

            const viewController = createDioramaViewController(dioramaTerrain, options.center, footprintHalfSizeM);
            const orientationController = createDioramaOrientationController(orientationRoot);
            const tileModeController = createDioramaTileModeController(dioramaTerrain, tileMode);
            this._viewController = viewController;
            this._orientationController = orientationController;
            this._tileModeController = tileModeController;
            this._unsubscribeViewChange = viewController.onChange((center, nextFootprintHalfSizeM) => {
                this._notifyViewChange(center, nextFootprintHalfSizeM);
            });
            this._unsubscribeTileModeChange = tileModeController.onChange((nextTileMode) => {
                this._notifyTileModeChange(nextTileMode);
            });

            let touchControls: DioramaTouchControls;
            if (enableDefaultControls) {
                const hud = createDioramaArControlHud({ exitArEnabled: false });
                this.mountElement.appendChild(hud.element);
                const rawTouchControls = setupDioramaTouchControls(
                    scene,
                    camera,
                    hud,
                    viewController,
                    orientationController,
                    tileModeController,
                );
                // `setupDioramaTouchControls().dispose()` はレンダーオブザーバ解除・
                // イベント購読解除のみ行い、HUD自体（DOM要素・内部ウィジェット）は
                // 破棄しない（既存デモはページ終了までdispose自体を呼ばない前提の
                // ため）。`JpmapDiorama.dispose()` ではHUDのDOM残留を防ぐ必要があるため、
                // ここで dispose をラップし、HUDの破棄も合わせて行う。
                touchControls = {
                    setVisible: rawTouchControls.setVisible,
                    dispose: (): void => {
                        rawTouchControls.dispose();
                        hud.dispose();
                    },
                };
                // 例外発生時も後始末（HUD破棄含む）が漏れないよう、生成直後に
                // 即座にフィールドへ反映する（`initAsync` の catch から `dispose()` を
                // 呼ぶため）。
                this._touchControls = touchControls;
                this._disposeKeyboardControls = setupDioramaKeyboardControls(
                    scene,
                    camera,
                    viewController,
                    orientationController,
                    tileModeController,
                );
            } else {
                touchControls = NOOP_TOUCH_CONTROLS;
                this._touchControls = touchControls;
            }

            const arController = createDioramaArSessionController(
                this.mountElement,
                scene,
                placementRoot,
                tableRadiusM,
                viewController,
                orientationController,
                tileModeController,
                touchControls,
            );
            this._arController = arController;
            this._arSupported = await isImmersiveArSupported();
            this._unsubscribeArActiveChange = arController.onActiveChange((active) => {
                this._notifyArStateChange(active ? "active" : "inactive");
            });
            if (this._arSupported && showArButton) {
                this._detachArButton = attachDioramaArButton(this.mountElement, arController);
            }

            engine.runRenderLoop(() => {
                scene.render();
            });

            const onResize = (): void => engine.resize();
            window.addEventListener("resize", onResize);
            this._onWindowResize = onResize;
            if (typeof ResizeObserver !== "undefined") {
                const ro = new ResizeObserver(() => engine.resize());
                ro.observe(this.mountElement);
                this._resizeObserver = ro;
            }
        } catch (err) {
            this.dispose();
            throw err;
        }
    }

    private _requireViewController(): DioramaViewController {
        if (!this._viewController) throw new Error("JpmapDiorama: instance is disposed");
        return this._viewController;
    }

    private _requireOrientationController(): DioramaOrientationController {
        if (!this._orientationController) throw new Error("JpmapDiorama: instance is disposed");
        return this._orientationController;
    }

    private _requireTileModeController(): DioramaTileModeController {
        if (!this._tileModeController) throw new Error("JpmapDiorama: instance is disposed");
        return this._tileModeController;
    }

    private _requireArController(): DioramaArSessionController {
        if (!this._arController) throw new Error("JpmapDiorama: instance is disposed");
        return this._arController;
    }

    // ---- 表示（中心・フットプリント） ----

    /** 現在の実世界中心（読み取り専用スナップショット）。 */
    public get center(): DioramaCenter {
        return this._requireViewController().getCenter();
    }

    /** 現在のフットプリントの半辺長[m]（読み取り専用スナップショット）。 */
    public get footprintHalfSizeM(): number {
        return this._requireViewController().getFootprintHalfSizeM();
    }

    /** 中心を変更する（地形の再構築を伴う非同期処理）。 */
    public setCenter(lat: number, lon: number): Promise<void> {
        return this._requireViewController().setView({ center: { lat, lon } });
    }

    /** フットプリントの半辺長[m]を変更する（地形の再構築を伴う非同期処理）。 */
    public setFootprintHalfSize(halfSizeM: number): Promise<void> {
        return this._requireViewController().setView({ footprintHalfSizeM: halfSizeM });
    }

    /**
     * 中心・フットプリント半辺長の一方または両方を1回の再構築にまとめて適用する。
     * 個別に呼ぶより低遅延（`dioramaTerrain.ts` の `setView` と同じ設計意図）。
     */
    public setView(patch: { center?: DioramaCenter; footprintHalfSizeM?: number }): Promise<void> {
        return this._requireViewController().setView(patch);
    }

    /**
     * 中心・フットプリント半辺長が変化した後に呼ばれるリスナーを登録する。
     * キーボード・タッチHUD・ARコントローラー・本メソッド群のいずれの経路で
     * 変化した場合も呼ばれる。
     * @returns 購読解除関数。
     */
    public onViewChange(listener: JpmapDioramaViewChangeListener): () => void {
        if (this._disposed) {
            return () => {
                /* no-op: instance is already disposed */
            };
        }
        this._viewListeners.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = this._viewListeners.indexOf(listener);
            if (idx !== -1) this._viewListeners.splice(idx, 1);
        };
    }

    private _notifyViewChange(center: DioramaCenter, footprintHalfSizeM: number): void {
        if (this._disposed) return;
        for (const listener of this._viewListeners.slice()) {
            try {
                // 各リスナー呼び出しごとに独立したスナップショット（`center`含む）を渡す。
                // 1つの `event`/`center` オブジェクトを全リスナーで共有すると、あるリスナーが
                // `event.center` を書き換えた場合に後続リスナーが改変後の値を受け取って
                // しまう（`Readonly<DioramaCenter>` は型レベルの保護のみで、実行時の
                // ミューテーションは防げないため）。
                listener({ center: { ...center }, footprintHalfSizeM });
            } catch (err) {
                console.error("[jpmap-terrain diorama] onViewChange listener threw:", err);
            }
        }
    }

    // ---- タイル種別 ----

    /** 現在のタイル種別（読み取り専用スナップショット）。 */
    public get tileMode(): DioramaTileMode {
        return this._requireTileModeController().getTileMode();
    }

    /** タイル種別を明示的に変更する。 */
    public setTileMode(tileMode: DioramaTileMode): Promise<void> {
        return this._requireTileModeController().setTileMode(tileMode);
    }

    /** 巡回順序（std→photo→wireframe→std…）で次のタイル種別へ切り替える。 */
    public cycleTileMode(): void {
        this._requireTileModeController().cycle();
    }

    /**
     * タイル種別が変化した後に呼ばれるリスナーを登録する。
     * @returns 購読解除関数。
     */
    public onTileModeChange(listener: DioramaTileModeChangeListener): () => void {
        if (this._disposed) {
            return () => {
                /* no-op: instance is already disposed */
            };
        }
        this._tileModeListeners.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = this._tileModeListeners.indexOf(listener);
            if (idx !== -1) this._tileModeListeners.splice(idx, 1);
        };
    }

    private _notifyTileModeChange(tileMode: DioramaTileMode): void {
        if (this._disposed) return;
        for (const listener of this._tileModeListeners.slice()) {
            try {
                listener(tileMode);
            } catch (err) {
                console.error("[jpmap-terrain diorama] onTileModeChange listener threw:", err);
            }
        }
    }

    // ---- 向き・高さ ----

    /** 箱庭全体の回転角・度（get / set）。 */
    public get rotationDeg(): number {
        return (this._requireOrientationController().getRotationRad() * 180) / Math.PI;
    }

    public set rotationDeg(value: number) {
        this._requireOrientationController().setRotationRad((value * Math.PI) / 180);
    }

    /** 箱庭の設置高さオフセット[m]（get / set）。 */
    public get heightOffsetM(): number {
        return this._requireOrientationController().getHeightOffsetM();
    }

    public set heightOffsetM(value: number) {
        this._requireOrientationController().setHeightOffsetM(value);
    }

    // ---- 低レベル連続入力API ----

    /**
     * パン軸・ズーム軸（[-1,1]）を1フレーム分適用する。
     * `enableDefaultControls: false` の場合、またはホスト独自の入力（ゲームパッド等）を
     * 内蔵操作に加えて併用したい場合に、host アプリが毎フレーム呼ぶ。
     */
    public feedPanZoomAxes(panAxes: StickAxes, zoomAxisY: number, dtSeconds: number): void {
        this._requireViewController().feedAxes(panAxes, zoomAxisY, dtSeconds);
    }

    /** 回転軸・左右トリガー値（[0,1]）を1フレーム分適用する。 */
    public feedOrientationAxes(
        rotationAxisX: number,
        leftTriggerValue: number,
        rightTriggerValue: number,
        dtSeconds: number,
    ): void {
        this._requireOrientationController().feedAxes(rotationAxisX, leftTriggerValue, rightTriggerValue, dtSeconds);
    }

    // ---- WebXR AR ----

    /** WebXR (`immersive-ar`) にブラウザ/デバイスが対応しているかを判定する。 */
    public isArSupported(): Promise<boolean> {
        return Promise.resolve(this._arSupported);
    }

    /** 現在のARセッション状態（読み取り専用スナップショット）。 */
    public get arState(): DioramaArState {
        if (!this._arSupported) return "unsupported";
        return this._requireArController().isActive() ? "active" : "inactive";
    }

    /** ARセッションへ突入する（`isArSupported()` が `false` の場合は reject）。 */
    public enterAr(): Promise<void> {
        if (!this._arSupported) {
            return Promise.reject(new Error("JpmapDiorama.enterAr: WebXR immersive-ar is not supported"));
        }
        return this._requireArController().enter();
    }

    /** ARセッションから退出する（非AR中は no-op）。 */
    public exitAr(): Promise<void> {
        return this._requireArController().exit();
    }

    /**
     * ARセッション状態が変化した後に呼ばれるリスナーを登録する。
     * @returns 購読解除関数。
     */
    public onArStateChange(listener: DioramaArStateChangeListener): () => void {
        if (this._disposed) {
            return () => {
                /* no-op: instance is already disposed */
            };
        }
        this._arStateListeners.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = this._arStateListeners.indexOf(listener);
            if (idx !== -1) this._arStateListeners.splice(idx, 1);
        };
    }

    private _notifyArStateChange(state: DioramaArState): void {
        if (this._disposed) return;
        for (const listener of this._arStateListeners.slice()) {
            try {
                listener(state);
            } catch (err) {
                console.error("[jpmap-terrain diorama] onArStateChange listener threw:", err);
            }
        }
    }

    // ---- 破棄 ----

    /**
     * シーン・イベントリスナー・DOM要素（HUD/ARボタン）を破棄する。
     * 冪等性: 2 回以上呼んでも例外にならず、何もしない。
     */
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        this._unsubscribeViewChange?.();
        this._unsubscribeViewChange = null;
        this._unsubscribeTileModeChange?.();
        this._unsubscribeTileModeChange = null;
        this._unsubscribeArActiveChange?.();
        this._unsubscribeArActiveChange = null;
        this._viewListeners = [];
        this._tileModeListeners = [];
        this._arStateListeners = [];

        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._onWindowResize) {
            window.removeEventListener("resize", this._onWindowResize);
            this._onWindowResize = null;
        }

        this._detachArButton?.();
        this._detachArButton = null;
        try {
            this._arController?.dispose();
        } catch (err) {
            console.error("[jpmap-terrain diorama] arController.dispose threw:", err);
        }
        this._arController = null;

        this._disposeKeyboardControls?.();
        this._disposeKeyboardControls = null;
        try {
            this._touchControls?.dispose();
        } catch (err) {
            console.error("[jpmap-terrain diorama] touchControls.dispose threw:", err);
        }
        this._touchControls = null;

        this._viewController = null;
        this._orientationController = null;
        this._tileModeController = null;

        try {
            this._dioramaTerrain?.dispose();
        } catch (err) {
            console.error("[jpmap-terrain diorama] dioramaTerrain.dispose threw:", err);
        }
        this._dioramaTerrain = null;
        this._placementRoot = null;
        this._orientationRoot = null;

        if (this._scene) {
            this._scene.dispose();
            this._scene = null;
        }
        if (this._engine) {
            this._engine.dispose();
            this._engine = null;
        }
        if (this._canvas && this._canvas.parentElement === this.mountElement) {
            this.mountElement.removeChild(this._canvas);
        }
        this._canvas = null;
        this._camera = null;
    }

    /**
     * リサイズを通知し Engine を再計測する。
     * 内部は `ResizeObserver` で自動追従しているため、通常は手動呼び出し不要。
     */
    public resize(): void {
        if (this._engine) {
            this._engine.resize();
        }
    }
}
