/**
 * アフターバーナーエフェクト (Issue #276)。
 *
 * Babylon.js `TrailMesh` を使用し、飛行機の左右エンジン位置から
 * 後方に短く伸びるアフターバーナーの炎を表現する。
 *
 * 実装方針:
 * - 飛行機の TransformNode 配下に左右エンジン位置の TransformNode を作成
 * - 各 TransformNode を generator として TrailMesh を生成
 * - TrailMesh は内部の `beforeRender` で自動更新
 * - Follow モード開始時に start()、終了時に stop() を呼ぶ
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Constants } from "@babylonjs/core/Engines/constants";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

// ─── 調整可能な定数 ─────────────────────────────────────
/** 左右エンジンの横方向オフセット (m)。中央寄せで2本が近い位置に */
const ENGINE_LATERAL_OFFSET_M = 1.4;
/** エンジン位置の後方オフセット (m)。機体中心から後方 */
const ENGINE_REAR_OFFSET_M = 4.5;
/** エンジン位置の垂直オフセット (m)。機体中心から上方向 */
const ENGINE_VERTICAL_OFFSET_M = 1.5;

/** TrailMesh のリボン直径 (m)。アフターバーナーの炎幅 */
const TRAIL_DIAMETER_M = 0.5;
/** TrailMesh の長さ（セグメント数）。約30m相当（60fps / 100m/s で≈18フレーム） */
const TRAIL_LENGTH = 10;
/** 断面の多角形頂点数。8+で円柱状に滑らか */
const TRAIL_SECTIONS = 8;

// ─── 型 ─────────────────────────────────────────────────
export interface ContrailContext {
    scene: Scene;
    /** model の TransformNode 名（generator の親に使う） */
    modelNodeName: string;
}

export interface Contrail {
    /** トレイル生成を開始（Follow モード ON 時に呼ぶ） */
    start(ctx: ContrailContext): void;
    /** トレイル生成を停止（Follow モード OFF 時に呼ぶ） */
    stop(): void;
    /** トレイルの頂点をリセット（グリッド原点ジャンプ後の折れ線防止） */
    reset(): void;
    /** 表示/非表示切替 */
    setVisible(visible: boolean): void;
    /** リソース解放 */
    dispose(): void;
}

/**
 * アフターバーナー用 StandardMaterial を作成する。
 * emissive オレンジ〜青のグラデーション感を出すため、明るいオレンジの emissive に
 * ALPHA_ADD ブレンドで重なりが強く光る炎っぽい表現にする。
 */
const createContrailMaterial = (scene: Scene): StandardMaterial => {
    const mat = new StandardMaterial("afterburner-mat", scene);
    mat.disableLighting = true;
    // アフターバーナーの炎色: 明るいオレンジ〜黄（高輝度で GlowLayer に反応）
    mat.emissiveColor = new Color3(1.0, 0.7, 0.2);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.alpha = 0.7;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.backFaceCulling = false;
    return mat;
};

/**
 * コントレイルエフェクトを作成する。
 * 初期化時には TrailMesh は作らず、start() で実際の generator を取得して構築する
 * （飛行機モデルの非同期ロード完了後に呼ばれるため）。
 */
export const createContrail = (scene: Scene): Contrail => {
    const material = createContrailMaterial(scene);

    // GlowLayer: TrailMesh のみに発光を適用（他メッシュに影響なし）
    const glow = new GlowLayer("afterburner-glow", scene, {
        blurKernelSize: 64,
    });
    glow.intensity = 1.5;

    let leftGen: TransformNode | null = null;
    let rightGen: TransformNode | null = null;
    let leftTrail: TrailMesh | null = null;
    let rightTrail: TrailMesh | null = null;
    let running = false;
    let visible = true;

    const buildTrails = (ctx: ContrailContext): boolean => {
        const root = ctx.scene.getTransformNodeByName(ctx.modelNodeName);
        if (!root) return false;

        // 既存があれば一度破棄してから作り直す（連続 start でのリーク防止）
        leftTrail?.dispose();
        rightTrail?.dispose();
        leftGen?.dispose();
        rightGen?.dispose();
        leftTrail = null;
        rightTrail = null;
        leftGen = null;
        rightGen = null;

        // generator となる TransformNode を **root** TransformNode に親付け。
        // root は updateModel() で明示的に lat/lon に従って位置・回転が更新されるため、
        // 子メッシュ (childMesh) よりも安定して飛行機の動きに追従する。
        // Babylon.js 左手座標系: X=右, Y=上, Z=前方。後方は -Z。
        leftGen = new TransformNode("contrail-left-gen", ctx.scene);
        leftGen.parent = root;
        leftGen.position.set(
            -ENGINE_LATERAL_OFFSET_M,
            ENGINE_VERTICAL_OFFSET_M,
            -ENGINE_REAR_OFFSET_M,
        );

        rightGen = new TransformNode("contrail-right-gen", ctx.scene);
        rightGen.parent = root;
        rightGen.position.set(
            ENGINE_LATERAL_OFFSET_M,
            ENGINE_VERTICAL_OFFSET_M,
            -ENGINE_REAR_OFFSET_M,
        );

        // generator のワールド行列を即時確定させてから TrailMesh を作る
        // (_createMesh が generator.absolutePosition を読むため)
        leftGen.computeWorldMatrix(true);
        rightGen.computeWorldMatrix(true);

        leftTrail = new TrailMesh("contrail-left", leftGen, ctx.scene, {
            diameter: TRAIL_DIAMETER_M,
            length: TRAIL_LENGTH,
            sections: TRAIL_SECTIONS,
            doNotTaper: false,
            autoStart: false,
        });
        leftTrail.material = material;
        leftTrail.isPickable = false;
        leftTrail.alwaysSelectAsActiveMesh = true;
        leftTrail.renderingGroupId = 1;

        rightTrail = new TrailMesh("contrail-right", rightGen, ctx.scene, {
            diameter: TRAIL_DIAMETER_M,
            length: TRAIL_LENGTH,
            sections: TRAIL_SECTIONS,
            doNotTaper: false,
            autoStart: false,
        });
        rightTrail.material = material;
        rightTrail.isPickable = false;
        rightTrail.alwaysSelectAsActiveMesh = true;
        rightTrail.renderingGroupId = 1;

        leftTrail.setEnabled(visible);
        rightTrail.setEnabled(visible);

        // GlowLayer にトレイルメッシュを登録（これらのみ発光する）
        glow.addIncludedOnlyMesh(leftTrail);
        glow.addIncludedOnlyMesh(rightTrail);

        return true;
    };

    const start = (ctx: ContrailContext): void => {
        if (running) return;
        // 毎回作り直すことで、前回 Follow セッションの残骸軌跡を完全に排除する
        if (!buildTrails(ctx)) return;
        if (visible) {
            leftTrail?.start();
            rightTrail?.start();
        }
        running = true;
    };

    const stop = (): void => {
        if (!running) return;
        leftTrail?.stop();
        rightTrail?.stop();
        // 停止時に TrailMesh と generator を破棄して、次回 start で完全に新規構築する
        leftTrail?.dispose();
        rightTrail?.dispose();
        leftGen?.dispose();
        rightGen?.dispose();
        leftTrail = null;
        rightTrail = null;
        leftGen = null;
        rightGen = null;
        running = false;
    };

    /** グリッド原点がジャンプした後に呼ぶ。全頂点を現在位置にリセットして折れ線を防ぐ */
    const reset = (): void => {
        if (!running) return;
        leftTrail?.reset();
        rightTrail?.reset();
    };

    const setVisible = (v: boolean): void => {
        visible = v;
        leftTrail?.setEnabled(v);
        rightTrail?.setEnabled(v);
        if (!v && running) {
            leftTrail?.stop();
            rightTrail?.stop();
        } else if (v && running) {
            leftTrail?.start();
            rightTrail?.start();
        }
    };

    const dispose = (): void => {
        leftTrail?.dispose();
        rightTrail?.dispose();
        leftGen?.dispose();
        rightGen?.dispose();
        glow.dispose();
        material.dispose();
        leftTrail = null;
        rightTrail = null;
        leftGen = null;
        rightGen = null;
    };

    return { start, stop, reset, setVisible, dispose };
};
