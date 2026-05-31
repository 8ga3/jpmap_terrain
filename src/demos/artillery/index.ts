/**
 * Artillery Game デモ (Issue #259)
 *
 * ターン制対戦ゲーム。紅組 vs 青組で大砲の角度・火力を設定し発射。
 * Havok 物理エンジンで砲弾の重力・地形バウンドを再現する。
 *
 * 仕様:
 * - 紅組 vs 青組の 1 vs 1 ターン制
 * - Angle（仰角）・Heading（方位）・Power（火力＝初速）を設定して発射
 * - 命中したら爆発エフェクト、スコア加算、大砲リスポーン
 * - 砲弾はメッシュプールで再利用（物理ボディは発射ごとに生成）
 * - 砲弾飛行・地形バウンドは Havok 物理が担当
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ray } from "@babylonjs/core/Culling/ray";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import {
    createProjectilePool,
    PROJECTILE_LIFETIME_SEC,
    type ProjectilePool,
} from "./projectilePool";
import { powderToSpeed } from "./ballistics";
import { initPhysics } from "./physics";
import { createTerrainCollider, type TerrainCollider } from "./terrainCollider";
import {
    createInitialState,
    nextTurn,
    addScore,
    isHit,
    type GameState,
    type Team,
    type CannonState,
} from "./gameLogic";
import { createExplosion } from "./explosion";
import { createArtilleryShadows } from "./shadows";
import { createAnnounce, createHitBanner } from "./announce";

const DEMO_MOUNT_ID = "root";

/**
 * ステージ: 起伏のある場所を選定
 * 箱根付近（芦ノ湖周辺）— 起伏が多く砲撃戦に適する
 */
const STAGE_CENTER = { lat: 35.22, lon: 139.02 };

/** 紅組の初期位置（西側の丘） */
const RED_CANNON_POS: CannonState = {
    team: "red",
    lat: 35.222,
    lon: 139.012,
    altitude: 0,
    azimuthDeg: 90, // 東向き
};

/** 青組の初期位置（東側の丘） */
const BLUE_CANNON_POS: CannonState = {
    team: "blue",
    lat: 35.218,
    lon: 139.028,
    altitude: 0,
    azimuthDeg: 270, // 西向き
};

/** 大砲モデルのスケール */
const CANNON_SCALE = 40;
/** 大砲の砲身長 */
const BARREL_LENGTH = 150;

const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/**
 * 大砲構造体: pivot(付け根) を中心に砲身が回転する。
 * pivot.position = 大砲設置位置（地面）
 * pivot.rotation.z = 仰角
 */
interface CannonGroup {
    pivot: TransformNode;
    barrel: Mesh;
    base: Mesh;
    /** 砲身・台座で共有するマテリアル（発光ブリンク制御用 #259）。 */
    material: StandardMaterial;
    /** 所属チーム（発光色の決定用）。 */
    team: Team;
}

/** 大砲メッシュ（ピボット + 砲身 + 台座）を作成 */
const createCannonMesh = (
    scene: import("@babylonjs/core/scene").Scene,
    team: Team,
): CannonGroup => {
    // ピボット: 砲身付け根（回転中心）
    const pivot = new TransformNode(`cannon-pivot-${team}`, scene);

    // 砲身: Cylinder は Y 軸中心なので、position.y でオフセットして付け根基準にする
    const barrel = MeshBuilder.CreateCylinder(
        `cannon-barrel-${team}`,
        { height: BARREL_LENGTH, diameter: CANNON_SCALE, tessellation: 12 },
        scene,
    );
    barrel.parent = pivot;
    // 砲身の下端がピボット位置になるよう上にオフセット
    barrel.position.y = BARREL_LENGTH / 2;

    // 台座（ピボット直下に固定、回転しない）
    const base = MeshBuilder.CreateCylinder(
        `cannon-base-${team}`,
        { height: CANNON_SCALE * 1.5, diameter: CANNON_SCALE * 2, tessellation: 12 },
        scene,
    );
    base.position.y = -CANNON_SCALE * 0.75; // ピボットの少し下

    const mat = new StandardMaterial(`cannon-mat-${team}`, scene);
    mat.diffuseColor =
        team === "red" ? new Color3(0.8, 0.2, 0.2) : new Color3(0.2, 0.3, 0.8);
    mat.specularColor = new Color3(0.3, 0.3, 0.3);
    // 発光ブリンクの初期値（消灯）。発射前の攻撃側のみ render loop でパルスさせる。
    mat.emissiveColor = new Color3(0, 0, 0);

    barrel.material = mat;
    base.material = mat;

    return { pivot, barrel, base, material: mat, team };
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) return;

    const camera = parseCameraStateFromUrl(location.href);
    const mapType = parseMapTypeFromUrl(location.href);

    const opts: JpmapTerrainOptions = {
        engine: resolveEngine(location.search),
        lat: camera?.lat ?? STAGE_CENTER.lat,
        lon: camera?.lon ?? STAGE_CENTER.lon,
        altitude: camera?.altitude ?? 2000,
        azimuth: camera?.azimuth,
        tilt: camera?.tilt ?? 50,
        mapType: mapType ?? "photo",
        // Issue #259: 戦場を常に中央へ固定するためマップのパン操作を無効化する。
        // （Ctrl/Cmd+ドラッグの回転・チルト、ホイールズームは有効のまま）
        enablePan: false,
        // Issue #259: 2D/3D 切替ボタンは不要なので非表示にする。
        showViewModeButton: false,
    };

    const viewer = await JpmapTerrain.create(mount, opts);
    // Issue #259: 現在地ボタン（GPS）は砲撃ゲームには不要なので非表示にする。
    viewer.showLocateMe = false;

    // Issue #259: FIRE/Restart ボタン押下後にフォーカスがボタンへ残ると、
    // 以降のキーボード操作（カメラ操作等）がボタンに奪われる。
    // ボタンのフォーカスを外し、マップ canvas へフォーカスを移すためのヘルパー。
    const mapCanvas = mount.querySelector("canvas");
    if (mapCanvas && !mapCanvas.hasAttribute("tabindex")) {
        // canvas は既定でフォーカス不可なので、プログラム的フォーカス用に tabindex を付与。
        mapCanvas.tabIndex = -1;
    }
    const focusMap = (): void => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        mapCanvas?.focus({ preventScroll: true });
    };

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        // 開発時(localhost)は砲弾の軌道デバッグログを自動で有効化する。
        // window.__ARTILLERY_DEBUG = false で無効化可能。
        const host = window.location.hostname;
        if (host === "localhost" || host === "127.0.0.1") {
            const w = window as unknown as { __ARTILLERY_DEBUG?: boolean };
            if (w.__ARTILLERY_DEBUG === undefined) w.__ARTILLERY_DEBUG = true;
        }
    }

    // --- シーン取得 ---
    const scene = viewer.__debugScene;
    if (!scene) return;

    // --- Havok 物理エンジン初期化（砲弾の生成より前に必須） ---
    await initPhysics(scene);

    // --- 影（砲台・砲弾 → 地形）: 真上からの平行光源 ---
    const shadows = createArtilleryShadows(scene);

    // --- 砲弾プール（生成時に影のキャスターとして登録） ---
    const pool: ProjectilePool = createProjectilePool(scene, (mesh) =>
        shadows.addCaster(mesh),
    );

    // --- 地形コリジョン（不可視の静的メッシュ） ---
    const collider: TerrainCollider = createTerrainCollider(scene);

    // --- ゲーム状態 ---
    let gameState: GameState = createInitialState(RED_CANNON_POS, BLUE_CANNON_POS);
    let firing = false;
    /** ターン切替タイマー（命中時にキャンセルするため保持） */
    let turnTimer: ReturnType<typeof setTimeout> | null = null;
    /** 命中時にHIT!表示後へ遅延させる交代告知タイマー（リスタート等でキャンセルするため保持） */
    let announceTimer: ReturnType<typeof setTimeout> | null = null;

    /** チームごとの操作値（赤・青で独立） */
    interface ControlSettings {
        angle: number;
        heading: number;
        power: number;
    }
    const settings: Record<Team, ControlSettings> = {
        red: { angle: 45, heading: 0, power: 50 },
        blue: { angle: 45, heading: 0, power: 50 },
    };

    // --- UI 要素取得 ---
    const angleSlider = document.getElementById("angle-slider") as HTMLInputElement;
    const angleValue = document.getElementById("angle-value")!;
    const headingSlider = document.getElementById("heading-slider") as HTMLInputElement;
    const headingValue = document.getElementById("heading-value")!;
    const powderSlider = document.getElementById("powder-slider") as HTMLInputElement;
    const powderValue = document.getElementById("powder-value")!;
    const fireBtn = document.getElementById("fire-btn")!;
    const restartBtn = document.getElementById("restart-btn")!;
    const scoreRedEl = document.getElementById("score-red")!;
    const scoreBlueEl = document.getElementById("score-blue")!;
    const turnRedEl = document.getElementById("turn-indicator-red")!;
    const turnBlueEl = document.getElementById("turn-indicator-blue")!;

    // --- 中央ターン告知（HAKONE / 攻撃ターン表示） ---
    const announce = createAnnounce({
        root: document.getElementById("turn-announce")!,
        stage: document.getElementById("announce-stage")!,
        turn: document.getElementById("announce-turn")!,
        blocker: document.getElementById("input-blocker")!,
    });
    /** ステージ名（中央告知に表示）。 */
    const STAGE_NAME = "HAKONE";
    // 最初の発射までは内部処理（地形ロード・コリジョン構築）の完了待ちがある。
    // その間、ステージ名と先攻（RED）を中央に表示し続け、準備完了時に爆散させる。
    announce.show({ stage: STAGE_NAME, team: gameState.turn, hold: null });

    // 命中時に表示する HIT! バナー
    const hitBanner = createHitBanner(document.getElementById("hit-banner")!);

    // --- 大砲メッシュ配置 ---
    const redCannon = createCannonMesh(scene, "red");
    const blueCannon = createCannonMesh(scene, "blue");

    // 砲台メッシュを影のキャスターとして登録する。
    for (const cannon of [redCannon, blueCannon]) {
        shadows.addCaster(cannon.barrel);
        shadows.addCaster(cannon.base);
    }

    /**
     * 大砲を相対位置に配置する。
     * 紅は原点西側、青は原点東側に配置。
     * 距離約1500m（ステージスケール）。
     */
    const CANNON_DISTANCE = 750; // 中心からの距離 (m)

    /** レイキャストで地形表面の Y 座標を取得する。ヒットなしの場合 -1 を返す */
    const getTerrainY = (x: number, z: number): number => {
        const pick = castTerrainRay(x, z);
        if (pick?.hit) return pick.pickedPoint!.y;

        // メッシュの辺と重なる場合にヒットしないことがある → わずかにオフセットして再試行
        const OFFSET = 0.5;
        const offsets = [
            [OFFSET, 0], [-OFFSET, 0],
            [0, OFFSET], [0, -OFFSET],
        ];
        for (const [dx, dz] of offsets) {
            const retry = castTerrainRay(x + dx, z + dz);
            if (retry?.hit) return retry.pickedPoint!.y;
        }
        return -1;
    };

    const castTerrainRay = (x: number, z: number) => {
        const ray = new Ray(
            new Vector3(x, 10000, z),
            new Vector3(0, -1, 0),
            20000,
        );
        // 地形タイル (tile-ground-*) のみを対象にする（プロジェクト共通規約）
        return scene.pickWithRay(ray, (mesh) =>
            mesh.name.startsWith("tile-ground-"),
        );
    };

    /** 大砲の姿勢をセットする (Y軸=方位, Z軸=仰角) */
    const setCannonOrientation = (
        cannon: CannonGroup,
        elevDeg: number,
        headingDeg: number,
        team: Team,
    ): void => {
        const elevRad = (elevDeg * Math.PI) / 180;
        const headingRad = (headingDeg * Math.PI) / 180;
        // 紅は東(+X)向き → Z軸負回転で仰角
        // 青は西(-X)向き → Z軸正回転で仰角
        const elevSign = team === "red" ? -1 : 1;
        cannon.pivot.rotation.set(0, headingRad, elevSign * (Math.PI / 2 - elevRad));
    };

    const placeCannonAtOffset = (
        cannon: CannonGroup,
        cannonState: CannonState,
        xOffset: number,
    ): void => {
        const rawY = getTerrainY(xOffset, 0);
        const terrainY = rawY >= 0 ? rawY : 0;
        cannon.pivot.position.set(xOffset, terrainY + CANNON_SCALE, 0);
        cannon.base.position.set(xOffset, terrainY, 0);
        setCannonOrientation(
            cannon,
            Number(angleSlider.value),
            Number(headingSlider.value),
            cannonState.team,
        );
    };

    const placeCannons = (): void => {
        placeCannonAtOffset(redCannon, gameState.redCannon, -CANNON_DISTANCE);
        placeCannonAtOffset(blueCannon, gameState.blueCannon, CANNON_DISTANCE);
    };

    const isDebug = (): boolean =>
        typeof window !== "undefined" &&
        (window as unknown as { __ARTILLERY_DEBUG?: boolean }).__ARTILLERY_DEBUG === true;

    /** 地形コリジョンメッシュを現在の地形からサンプリングして構築する */
    const buildCollider = (): void => {
        const rate = collider.rebuild((x, z) => {
            const y = getTerrainY(x, z);
            return y >= 0 ? y : null;
        });
        if (isDebug()) {
            console.log(
                `[artillery] 地形コリジョン構築: サンプリング成功率 ${(rate * 100).toFixed(0)}%`,
            );
        }
    };

    /** 地形ロード完了 (idle) を待ってから fn を実行する */
    const waitTerrainIdleThen = (fn: () => void): void => {
        const tryRun = (): void => {
            if (viewer.__debugTerrainIdle) {
                fn();
            } else {
                setTimeout(tryRun, 300);
            }
        };
        setTimeout(tryRun, 500);
    };

    // 地形ロード後に大砲を配置し、地形コリジョンを構築。
    // 準備完了で中央告知（HAKONE / RED）を爆散させて消す。
    waitTerrainIdleThen(() => {
        placeCannons();
        buildCollider();
        announce.dismiss();
    });

    const updateUI = (): void => {
        scoreRedEl.textContent = String(gameState.scoreRed);
        scoreBlueEl.textContent = String(gameState.scoreBlue);
        if (gameState.turn === "red") {
            turnRedEl.classList.add("active");
            turnBlueEl.classList.remove("active");
        } else {
            turnRedEl.classList.remove("active");
            turnBlueEl.classList.add("active");
        }
    };

    /** 現在ターンの大砲の姿勢を更新 */
    const updateCannonOrientation = (): void => {
        const cannon = gameState.turn === "red" ? redCannon : blueCannon;
        setCannonOrientation(
            cannon,
            Number(angleSlider.value),
            Number(headingSlider.value),
            gameState.turn,
        );
    };

    /** 現在ターンのチーム設定をスライダー UI に反映 */
    const loadSettingsToUI = (team: Team): void => {
        const s = settings[team];
        angleSlider.value = String(s.angle);
        headingSlider.value = String(s.heading);
        powderSlider.value = String(s.power);
        angleValue.textContent = `${s.angle}°`;
        headingValue.textContent = `${s.heading}°`;
        powderValue.textContent = `${s.power}%`;
    };

    angleSlider.addEventListener("input", () => {
        settings[gameState.turn].angle = Number(angleSlider.value);
        angleValue.textContent = `${angleSlider.value}°`;
        updateCannonOrientation();
    });

    headingSlider.addEventListener("input", () => {
        settings[gameState.turn].heading = Number(headingSlider.value);
        headingValue.textContent = `${headingSlider.value}°`;
        updateCannonOrientation();
    });

    powderSlider.addEventListener("input", () => {
        settings[gameState.turn].power = Number(powderSlider.value);
        powderValue.textContent = `${powderSlider.value}%`;
    });

    /**
     * ターンを終了して相手に交代する（1ショットにつき1回だけ実行）。
     * @param announceDelayMs 交代告知の表示を遅らせる時間 (ms)。命中時に HIT! 表示と
     *   重ならないよう、HIT! アニメ終了後に告知する用途で使う。
     */
    const endTurn = (announceDelayMs = 0): void => {
        if (turnTimer !== null) {
            clearTimeout(turnTimer);
            turnTimer = null;
        }
        // 前ターンの遅延告知が残っていればキャンセルする。
        if (announceTimer !== null) {
            clearTimeout(announceTimer);
            announceTimer = null;
        }
        gameState = nextTurn(gameState);
        firing = false;
        loadSettingsToUI(gameState.turn);
        updateCannonOrientation();
        updateUI();
        // 交代したことを中央に約1秒告知する（ステージ名なし）。
        // 命中時は HIT! 表示と重ならないよう、その分だけ遅延させて順番に出す。
        const newTurn = gameState.turn;
        if (announceDelayMs > 0) {
            announceTimer = setTimeout(() => {
                announceTimer = null;
                announce.show({ team: newTurn, hold: 1000 });
            }, announceDelayMs);
        } else {
            announce.show({ team: newTurn, hold: 1000 });
        }
    };

    // --- 発射ロジック ---
    const fire = (): void => {
        if (firing) return;
        firing = true;

        const powder = Number(powderSlider.value);
        const speed = powderToSpeed(powder);

        const cannon = gameState.turn === "red" ? redCannon : blueCannon;

        // 砲身の実際のワールド方向を取得（砲身ローカル +Y 軸が砲口方向）
        // これにより砲身の向きと砲弾の飛翔方向が完全に一致する
        cannon.pivot.computeWorldMatrix(true);
        const dir = Vector3.TransformNormal(
            new Vector3(0, 1, 0),
            cannon.pivot.getWorldMatrix(),
        ).normalize();

        const pivotPos = cannon.pivot.position;
        // 発射位置: 砲口先端（ピボット + 砲身方向 * 砲身長）
        const launchPos = pivotPos.add(dir.scale(BARREL_LENGTH));
        // 発射速度ベクトル: 砲身方向 * 初速
        const velocity = dir.scale(speed);

        // 砲弾発射（重力・地形バウンドは Havok が計算）
        pool.acquire(launchPos, velocity);

        if (isDebug()) {
            console.log(
                `[artillery] FIRE team=${gameState.turn} pos=(${launchPos.x.toFixed(1)}, ${launchPos.y.toFixed(1)}, ${launchPos.z.toFixed(1)}) ` +
                    `vel=(${velocity.x.toFixed(1)}, ${velocity.y.toFixed(1)}, ${velocity.z.toFixed(1)}) speed=${speed.toFixed(0)}`,
            );
        }

        // 一定時間後にターン交代（命中時は endTurn 内で前倒し）
        turnTimer = setTimeout(endTurn, PROJECTILE_LIFETIME_SEC * 1000 + 500);
    };

    fireBtn.addEventListener("click", () => {
        fire();
        // 発射後はフォーカスをマップへ戻し、ボタンに残らないようにする。
        focusMap();
    });

    restartBtn.addEventListener("click", () => {
        if (turnTimer !== null) {
            clearTimeout(turnTimer);
            turnTimer = null;
        }
        // 命中後の遅延告知が残っていればキャンセルし、誤チーム表示を防ぐ。
        if (announceTimer !== null) {
            clearTimeout(announceTimer);
            announceTimer = null;
        }
        // 進行中の砲弾を全て回収してから状態を初期化する。
        for (const p of pool.getActive()) pool.release(p);
        gameState = createInitialState(RED_CANNON_POS, BLUE_CANNON_POS);
        firing = false;
        settings.red = { angle: 45, heading: 0, power: 50 };
        settings.blue = { angle: 45, heading: 0, power: 50 };
        loadSettingsToUI(gameState.turn);
        placeCannons();
        buildCollider();
        updateUI();
        // リスタート時も先攻（RED）を中央に告知する。
        announce.show({ stage: STAGE_NAME, team: gameState.turn, hold: 1000 });
        // 押下後はフォーカスをマップへ戻す。
        focusMap();
    });

    // 発射前の攻撃側砲台を発光（エミッシブ）でブリンクさせる。
    const BLINK_RED = new Color3(1, 0.25, 0.25);
    const BLINK_BLUE = new Color3(0.3, 0.5, 1);
    const updateCannonBlink = (now: number): void => {
        // 0..1 の sin パルス（約 0.55Hz）
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.0035);
        for (const cannon of [redCannon, blueCannon]) {
            const isActive = !firing && cannon.team === gameState.turn;
            const mat = cannon.material;
            if (isActive) {
                const base = cannon.team === "red" ? BLINK_RED : BLINK_BLUE;
                mat.emissiveColor.copyFrom(base).scaleInPlace(pulse);
            } else if (
                mat.emissiveColor.r !== 0 ||
                mat.emissiveColor.g !== 0 ||
                mat.emissiveColor.b !== 0
            ) {
                mat.emissiveColor.set(0, 0, 0);
            }
        }
    };

    // --- 命中判定ループ（物理積分は Havok が自動で行う） ---
    scene.onBeforeRenderObservable.add(() => {
        const now = performance.now();
        pool.tick(now);
        updateCannonBlink(now);

        // ストリーミングで増える地形タイルを影の受け手として随時設定する。
        shadows.registerTerrainReceivers();

        const activeProjectiles = pool.getActive();
        for (const proj of activeProjectiles) {
            const pos = proj.mesh.position;
            const targetCannon =
                gameState.turn === "red" ? blueCannon : redCannon;
            const targetPos = targetCannon.pivot.position;

            if (
                isHit(
                    pos.x,
                    pos.y,
                    pos.z,
                    targetPos.x,
                    targetPos.y,
                    targetPos.z,
                )
            ) {
                // 命中！
                createExplosion(scene, pos.clone());
                hitBanner.flash();
                pool.release(proj);
                gameState = addScore(gameState, gameState.turn);
                // 被弾側の大砲をリスポーン（仕様: 命中した側の大砲は位置リセット）
                const hitXOffset =
                    gameState.turn === "red" ? CANNON_DISTANCE : -CANNON_DISTANCE;
                const hitCannonState =
                    gameState.turn === "red"
                        ? gameState.blueCannon
                        : gameState.redCannon;
                placeCannonAtOffset(targetCannon, hitCannonState, hitXOffset);
                // ターン交代（turnTimer をキャンセルして二重交代を防ぐ）。
                // HIT! 表示が終わってから ATTACK 告知を出して重なりを防ぐ。
                endTurn(hitBanner.durationMs);
                break;
            }
        }
    });

    loadSettingsToUI(gameState.turn);
    updateUI();
};

start().catch((err: unknown) => {
    console.error("[artillery-demo] Failed to start:", err);
});
