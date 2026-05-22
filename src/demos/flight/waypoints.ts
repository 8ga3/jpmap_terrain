/**
 * ウェイポイント管理モジュール (Issue #274)。
 *
 * 円軌道上にスライディングウィンドウ方式で魔法陣ディスクを配置。
 * 飛行機が通過するとフェードアウトし、完全消滅後に最後尾の次の位置へ移動して復活。
 * メッシュをプールとして再利用するため create/dispose のオーバーヘッドがない。
 */

import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import { circularOrbitPosition, circularOrbitHeading } from "../avatar/orbit";
import { createWaypointMaterial, updateWaypointMaterialTime } from "./waypointShader";
import { createPassEffect } from "./waypointEffect";

// ─── 定数 ────────────────────────────────────────────────
/** ウェイポイント間の弧長距離 (m) */
const WAYPOINT_SPACING_M = 600;
/** ウィンドウの最大ウェイポイント数 */
const MAX_WAYPOINT_COUNT = 10;
/** 魔法陣ディスクの直径 (m) — 飛行機がくぐれるサイズ */
const DISC_DIAMETER_M = 60;
/** 通過判定の弧長距離 (m) */
const PASS_THRESHOLD_M = 40;
/** フェードアウト速度 (alpha/秒) */
const FADE_SPEED = 3.0;
/** フェード完了時の拡大倍率 */
const FADE_MAX_SCALE = 2.5;
/** 初期配置時に飛行機の前方へずらすオフセット (m) — 即通過を防ぐ */
const INITIAL_OFFSET_M = WAYPOINT_SPACING_M * 0.5;

// ─── 型 ──────────────────────────────────────────────────
export interface WaypointManagerContext {
    scene: Scene;
    centerLat: number;
    centerLon: number;
    radiusM: number;
    altitudeM: number;
    angleDeg: number;
    modelNodeName: string;
}

export interface WaypointManager {
    update(ctx: WaypointManagerContext, time: number): void;
    reset(ctx: WaypointManagerContext): void;
    dispose(): void;
}

interface WaypointState {
    /** 円周上の角度 (度, 単調増加・ラップなし) */
    angleDeg: number;
    mesh: Mesh | null;
    passed: boolean;
    fadeAlpha: number;
}

// ─── ユーティリティ ──────────────────────────────────────

/** 弧長距離→角度差 (度) に変換 */
const metersToDeg = (meters: number, radiusM: number): number =>
    (meters / (2 * Math.PI * radiusM)) * 360;

/**
 * angle2 が angle1 より前方 (進行方向) にあるかを判定。
 * fwdDeg = (angle2 - angle1 + 360) % 360 が 180° 未満なら前方。
 */
const isAhead = (angle1Deg: number, angle2Deg: number): boolean => {
    const fwd = ((angle2Deg - angle1Deg) % 360 + 360) % 360;
    return fwd < 180;
};

/**
 * 2角度間の弧長距離 (m) を返す。最短弧。
 */
const arcDistance = (angle1Deg: number, angle2Deg: number, radiusM: number): number => {
    let diff = ((angle2Deg - angle1Deg) % 360 + 360) % 360;
    if (diff > 180) diff = 360 - diff;
    return (diff * Math.PI / 180) * radiusM;
};

// ─── メイン ──────────────────────────────────────────────

export const createWaypointManager = (scene: Scene): WaypointManager => {
    let waypoints: WaypointState[] = [];
    let materials: ReturnType<typeof createWaypointMaterial>[] = [];
    let lastTime = 0;
    /** 次に復活するウェイポイントを配置する角度 (度, 単調増加) */
    let nextSpawnAngleDeg = 0;
    /** 1ウェイポイント分の角度ステップ (度) */
    let angleStepDeg = 0;

    const disposeAll = (): void => {
        for (const wp of waypoints) {
            if (wp.mesh) {
                wp.mesh.dispose();
                wp.mesh = null;
            }
        }
        for (const mat of materials) {
            mat.dispose();
        }
        waypoints = [];
        materials = [];
    };

    /** 半径から使用するウェイポイント数を算出 */
    const computeCount = (radiusM: number): number => {
        const circumference = 2 * Math.PI * radiusM;
        return Math.max(1, Math.min(MAX_WAYPOINT_COUNT, Math.floor(circumference / WAYPOINT_SPACING_M)));
    };

    /** メッシュの Y 回転をウェイポイント角度に合わせて更新 */
    const applyRingOrientation = (mesh: Mesh, wpAngleDeg: number): void => {
        const heading = circularOrbitHeading(wpAngleDeg);
        mesh.rotation.y = (heading * Math.PI) / 180;
    };

    const reset = (ctx: WaypointManagerContext): void => {
        disposeAll();

        const count = computeCount(ctx.radiusM);
        angleStepDeg = metersToDeg(WAYPOINT_SPACING_M, ctx.radiusM);
        const offsetDeg = metersToDeg(INITIAL_OFFSET_M, ctx.radiusM);

        for (let i = 0; i < count; i++) {
            const wpAngle = ctx.angleDeg + offsetDeg + i * angleStepDeg;
            const mat = createWaypointMaterial(scene, `wp${i}`);
            materials.push(mat);

            const mesh = CreateDisc(
                `waypointDisc_${i}`,
                {
                    radius: DISC_DIAMETER_M / 2,
                    tessellation: 48,
                },
                scene,
            );
            mesh.material = mat;
            mesh.isPickable = false;
            mesh.alwaysSelectAsActiveMesh = true;
            applyRingOrientation(mesh, wpAngle);

            waypoints.push({
                angleDeg: wpAngle,
                mesh,
                passed: false,
                fadeAlpha: 1,
            });
        }

        // 最後のウェイポイントの次の位置が次の復活先
        nextSpawnAngleDeg = ctx.angleDeg + offsetDeg + count * angleStepDeg;
    };

    const update = (ctx: WaypointManagerContext, time: number): void => {
        const dt = lastTime > 0 ? (time - lastTime) * 0.001 : 0.016;
        lastTime = time;

        const timeSec = time * 0.001;

        // 飛行機のワールド座標
        const root = ctx.scene.getTransformNodeByName(ctx.modelNodeName);
        if (!root) return;
        const childMesh = root.getChildMeshes(false)[0];
        if (!childMesh) return;
        childMesh.computeWorldMatrix(true);
        const planeWorldPos = childMesh.absolutePosition;

        const planeGeo = circularOrbitPosition(
            ctx.centerLat, ctx.centerLon, ctx.radiusM, ctx.angleDeg,
        );

        for (let i = 0; i < waypoints.length; i++) {
            const wp = waypoints[i];
            if (!wp.mesh) continue;

            const dist = arcDistance(ctx.angleDeg, wp.angleDeg, ctx.radiusM);
            const ahead = isAhead(ctx.angleDeg, wp.angleDeg);

            // ─── 通過判定: 前方かつ近い ───
            if (!wp.passed && ahead && dist < PASS_THRESHOLD_M) {
                wp.passed = true;
                createPassEffect(ctx.scene, wp.mesh.position.clone());
            }

            // ─── フェードアウト + 拡大アニメーション ───
            if (wp.passed && wp.fadeAlpha > 0) {
                wp.fadeAlpha -= FADE_SPEED * dt;
                if (wp.fadeAlpha <= 0) {
                    wp.fadeAlpha = 0;
                    wp.mesh.setEnabled(false);

                    // ─── 再利用: 最後尾の次の位置へ移動して復活 ───
                    wp.angleDeg = nextSpawnAngleDeg;
                    nextSpawnAngleDeg += angleStepDeg;
                    wp.passed = false;
                    wp.fadeAlpha = 1;
                    wp.mesh.scaling.set(1, 1, 1);
                    applyRingOrientation(wp.mesh, wp.angleDeg);
                    // setEnabled(true) は位置更新後（下部）に実行
                } else {
                    wp.mesh.visibility = wp.fadeAlpha;
                    // fadeAlpha 1→0 にあわせて 1→FADE_MAX_SCALE に拡大
                    const t = 1 - wp.fadeAlpha;
                    const scale = 1 + t * (FADE_MAX_SCALE - 1);
                    wp.mesh.scaling.set(scale, scale, scale);
                }
            }

            // ─── メッシュ位置更新 ───
            const active = !wp.passed || wp.fadeAlpha > 0;
            if (active) {
                const wpGeo = circularOrbitPosition(
                    ctx.centerLat, ctx.centerLon, ctx.radiusM, wp.angleDeg,
                );
                const dLat = wpGeo.lat - planeGeo.lat;
                const dLon = wpGeo.lon - planeGeo.lon;
                const cosLat = Math.cos((planeGeo.lat * Math.PI) / 180);
                const offsetX = dLon * 111320 * cosLat;
                const offsetZ = dLat * 111320;

                wp.mesh.position.set(
                    planeWorldPos.x + offsetX,
                    planeWorldPos.y,
                    planeWorldPos.z + offsetZ,
                );
                wp.mesh.setEnabled(true);

                if (materials[i]) {
                    updateWaypointMaterialTime(materials[i], timeSec);
                }
            }
        }
    };

    return { update, reset, dispose: disposeAll };
};
