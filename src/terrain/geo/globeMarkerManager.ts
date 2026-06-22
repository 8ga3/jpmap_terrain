/**
 * グローブ用マーカーマネージャ (Issue #275 Phase 3, marker 先行スライス)。
 *
 * 平面版（`markerManager` + `marker`）に対する **並行構築** のグローブ実装。緯度経度に
 * 地形標高で接地し、地心 up 方向へドロップ線（ポール）を立て、アイコン/ラベルは
 * `marker.createIconTextMesh`（BILLBOARDMODE_ALL = カメラ正対）を再利用して表示する。
 * 配置は ECEF + 地心 up（`overlayPlacement`）で、`scene.pick` には依存しない。
 *
 * 平面版 `markerManager` には手を加えない（再利用するのは座標系非依存の描画部のみ）。
 */
import type { Scene } from "@babylonjs/core/scene";
import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import type {
    MarkerIconOptions,
    MarkerTextOptions,
    MarkerLineOptions,
} from "../../lib/types";
import {
    createIconTextMesh,
    resolveIcon,
    resolveText,
    validateIconUrl,
    RENDERING_GROUP_ID,
    type IconTextMeshes,
} from "../marker";
import {
    groundPlacementToRef,
    computeOverlayDistanceScaleFromDistance,
    computeOverlayLineHeight,
    OVERLAY_REF_DISTANCE_M,
} from "./overlayPlacement";

/** グローブマーカーの既定値（線の色・基準ポール径[m]）。 */
const GLOBE_MARKER_DEFAULTS = {
    lineColor: "#ff3030",
    /** 基準距離でのポール径[m]。距離スケールに比例させてスクリーン定にする。 */
    poleBaseDiameter: 2,
} as const;

export interface GlobeMarkerOptions {
    /** 緯度 [deg]。 */
    lat: number;
    /** 経度 [deg]。 */
    lon: number;
    icon?: MarkerIconOptions;
    text?: MarkerTextOptions;
    line?: MarkerLineOptions;
    /** 既定 true。 */
    enabled?: boolean;
}

export interface GlobeMarkerManagerDeps {
    scene: Scene;
    /** 緯度経度の地形標高[m]（無ければ null）。`globeTileManager.terrainElevAt` を渡す。 */
    terrainElevAt: (latDeg: number, lonDeg: number) => number | null;
}

interface GlobeMarkerNode {
    id: string;
    lat: number;
    lon: number;
    poleBaseDiameter: number;
    iconText: IconTextMeshes | null;
    lineMesh: Mesh;
    lineMat: StandardMaterial;
    enabled: boolean;
    /**
     * 直近に取得できた地形標高[m]（未取得は null）。前景タイルが一時的に未ロードで
     * `terrainElevAt` が null を返したとき、これを保持してマーカーが楕円体表面（elev=0）へ
     * 落ちるのを防ぐ（被覆の根本改善は #329）。
     */
    lastElev: number | null;
}

export interface GlobeMarkerManager {
    /** マーカーを追加し、id を返す。 */
    add(opts: GlobeMarkerOptions): string;
    /** マーカーを削除する。 */
    remove(id: string): void;
    /** 表示/非表示を切り替える。 */
    setEnabled(id: string, enabled: boolean): void;
    /**
     * 2D（トップダウン正射）縮退の有効/無効を切り替える (#395)。`true` で全マーカーの
     * ドロップ線（ポール）を無効化し、アイコン/ラベルを地表へアンカーする。`false` で復元する。
     */
    setFlatten(flat: boolean): void;
    /**
     * 毎フレーム: 地形標高へ接地・距離スケール・ポール向き（地心 up）を更新する。
     * `cameraEcef` は呼び出し側がフレーム単位で 1 回計算した値を渡す（再計算回避）。
     */
    update(cameraEcef: Vector3): void;
    /** 全マーカーを破棄する。 */
    dispose(): void;
}

/** local +Y（シリンダ軸）/ 180°フォールバック軸の定数（再利用・不変）。 */
const LOCAL_Y = new Vector3(0, 1, 0);
const FLIP_AXIS = new Vector3(1, 0, 0);
/** orientYToUpToRef の回転軸スクラッチ（毎フレーム・マーカー数ぶん呼ばれるため割当回避）。 */
const orientAxis = new Vector3();

/** local +Y（シリンダ軸）を up へ向ける回転を ref に書き込む。割当なし（CrossToRef + 再利用軸）。 */
const orientYToUpToRef = (up: Vector3, ref: Quaternion): void => {
    const cos = Vector3.Dot(LOCAL_Y, up);
    Vector3.CrossToRef(LOCAL_Y, up, orientAxis);
    const sin = orientAxis.length();
    if (sin < 1e-9) {
        // up が +Y とほぼ平行。同方向なら無回転、逆向きなら 180°（任意軸 X）。
        if (cos >= 0) ref.copyFromFloats(0, 0, 0, 1);
        else Quaternion.RotationAxisToRef(FLIP_AXIS, Math.PI, ref);
        return;
    }
    orientAxis.scaleInPlace(1 / sin);
    Quaternion.RotationAxisToRef(orientAxis, Math.atan2(sin, cos), ref);
};

/**
 * グローブ用マーカーマネージャを生成する。
 */
export const createGlobeMarkerManager = (
    deps: GlobeMarkerManagerDeps,
): GlobeMarkerManager => {
    const { scene, terrainElevAt } = deps;
    const nodes = new Map<string, GlobeMarkerNode>();
    let seq = 0;
    // dispose 後の use-after-dispose を防ぐフラグ（平面版 MarkerManager と同様）。
    let disposed = false;
    // 2D（トップダウン正射）縮退フラグ (#395)。true の間はポールを無効化し、
    // アイコン/ラベルを地表へアンカーする。3D 復帰（false）で元の表示へ戻る。
    let flat = false;

    // 毎フレーム再利用するスクラッチ。
    const pos = new Vector3();
    const up = new Vector3();
    const tmp = new Vector3();
    const quat = new Quaternion();

    /**
     * 1 マーカーを地形へ接地し、ポール（高さ/径/向き）とラベル位置を更新する。
     * `camEcef` 省略時（add の初期配置）は基準距離でスケール/高さを仮置きし、原点 (0,0,0)
     * 表示のチラつきを防ぐ（次フレームの update で camEcef ベースに補正される）。
     */
    const placeNode = (node: GlobeMarkerNode, camEcef?: Vector3): void => {
        // 取得できた標高は保持し、null（前景タイル未ロード等）は直前値へフォールバック
        // して楕円体表面へ落ちるのを防ぐ（初回ロード前のみ 0=楕円体面）。被覆の根本改善は #329。
        const queried = terrainElevAt(node.lat, node.lon);
        if (queried !== null) node.lastElev = queried;
        const elev = node.lastElev ?? 0;
        // 地表 ECEF と地心 up。
        groundPlacementToRef(node.lat, node.lon, elev, pos, up);
        // 距離は 1 回だけ算出し、スケールと線高さで再利用（sqrt の二重計算を避ける）。
        // camEcef なし（初期配置）は基準距離で仮置き。
        const dist = camEcef ? Vector3.Distance(camEcef, pos) : OVERLAY_REF_DISTANCE_M;
        // 2D（flat）正射では下限スケール（MIN_SCALE）を外す。下限が残ると最大ズーム時に
        // ワールドサイズが下限固定され、ortho フラスタム（radius 比例）だけが縮小して
        // アイコンが不自然に大きく見える。下限なし（0）で全ズーム画面上一定にする。
        // 3D 透視は近接時の過小化を防ぐ既定の下限を維持する。
        const distScale = computeOverlayDistanceScaleFromDistance(
            dist,
            undefined,
            flat ? 0 : undefined,
        );
        const lineHeight = computeOverlayLineHeight(dist);

        // ポール: 地心 up 沿い、地表から lineHeight。径は距離スケールでスクリーン定。
        // 2D（flat）ではポールを描かず、アイコン/ラベルを地表へアンカーする (#395)。
        if (flat) {
            if (node.iconText) {
                node.iconText.mesh.scaling.set(distScale, distScale, distScale);
                node.iconText.mesh.position.copyFrom(pos);
            }
            return;
        }
        orientYToUpToRef(up, quat);
        node.lineMesh.rotationQuaternion!.copyFrom(quat);
        const diameter = node.poleBaseDiameter * distScale;
        node.lineMesh.scaling.set(diameter, lineHeight, diameter);
        // 中点 = 地表 + up*(lineHeight/2)。
        tmp.copyFrom(up).scaleInPlace(lineHeight / 2);
        node.lineMesh.position.copyFrom(pos).addInPlace(tmp);

        // アイコン/ラベル: ポール先端 (lineTop = 地表 + up*lineHeight) をアンカーにする。
        // BILLBOARDMODE_ALL はメッシュの局所原点を中心にカメラへ正対するため、原点がアンカーから
        // 外れると視線角度によって投影位置がずれる（真上視点で顕著）。add 時にプレーン下端が局所原点へ
        // 来るよう頂点を平行移動済みなので、原点をポール先端へ置けば、円形/ラベルがポールの上に乗り
        // （重なりによるチラつきを回避）、どの角度でも下端が先端に固定される。
        if (node.iconText) {
            node.iconText.mesh.scaling.set(distScale, distScale, distScale);
            tmp.copyFrom(up).scaleInPlace(lineHeight);
            node.iconText.mesh.position.copyFrom(pos).addInPlace(tmp);
        }
    };

    const add = (opts: GlobeMarkerOptions): string => {
        if (disposed) throw new Error("GlobeMarkerManager.add: called after dispose");
        const id = `globe-marker-${seq++}`;
        const icon = resolveIcon(opts.icon);
        // 平面版 addMarker と同様、icon.url の危険なスキーム（javascript: 等）を拒否する。
        // validateIconUrl は "addMarker:" 始まりのメッセージで投げるため、発生箇所（このマネージャ
        // と marker id）を含めて投げ直し、デバッグしやすくする。
        if (icon) {
            try {
                validateIconUrl(icon.url);
            } catch (e) {
                throw new Error(
                    `GlobeMarkerManager.add (${id}): ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }
        const text = resolveText(opts.text);
        const iconText = createIconTextMesh(scene, id, icon, text);
        if (iconText) {
            // ラベルもピック対象から外す（地形ピック等の妨げにしない）。
            iconText.mesh.isPickable = false;
            // BILLBOARDMODE_ALL は局所原点を中心にカメラへ正対するため、プレーン下端を局所原点へ
            // 移す。プレーン構成は上→下に textHeightWorld / iconHeightWorld で、最下端（アイコン下端、
            // アイコン無しならテキスト下端）の局所 y = -heightWorld/2。これを原点へ寄せると、原点を
            // ポール先端へ置いたとき円形/ラベルがポール（実体シリンダ）の上に乗り、重なりによる
            // z-fighting のチラつきを避けつつ、どの視線角度でも下端が先端に固定される。
            iconText.mesh.bakeTransformIntoVertices(
                Matrix.Translation(0, iconText.heightWorld / 2, 0),
            );
        }

        const lineColor = opts.line?.color ?? GLOBE_MARKER_DEFAULTS.lineColor;
        // ドロップ線は地心 up 沿いの細いシリンダ（ポール）。高さ/径は update で毎フレーム決める。
        const lineMesh = MeshBuilder.CreateCylinder(
            `${id}-line`,
            { height: 1, diameter: 1, tessellation: 8 },
            scene,
        );
        lineMesh.rotationQuaternion = new Quaternion();
        // ポールはピック対象外＋ラベル/平面マーカーと同じ描画レイヤーに揃える。
        lineMesh.isPickable = false;
        lineMesh.renderingGroupId = RENDERING_GROUP_ID;
        const lineMat = new StandardMaterial(`${id}-line-mat`, scene);
        // MarkerLineOptions.color は CSS color も許容するが Color3.FromHexString は hex 専用。
        // 非 hex 指定では例外になるため try/catch で既定色にフォールバックする
        // （将来的に CSS color → Color3 変換を追加予定）。
        let lineColor3: Color3;
        try {
            lineColor3 = Color3.FromHexString(lineColor);
        } catch {
            lineColor3 = Color3.FromHexString(GLOBE_MARKER_DEFAULTS.lineColor);
        }
        lineMat.emissiveColor = lineColor3;
        lineMat.disableLighting = true;
        lineMesh.material = lineMat;

        const enabled = opts.enabled ?? true;
        const node: GlobeMarkerNode = {
            id,
            lat: opts.lat,
            lon: opts.lon,
            poleBaseDiameter: opts.line?.width ?? GLOBE_MARKER_DEFAULTS.poleBaseDiameter,
            iconText,
            lineMesh,
            lineMat,
            enabled,
            lastElev: null,
        };
        // 初期配置（camEcef なし）。update が走る前の原点 (0,0,0) 表示チラつきを防ぐ。
        placeNode(node);
        // 2D（flat）中はポールを描かない (#395)。
        lineMesh.setEnabled(enabled && !flat);
        iconText?.mesh.setEnabled(enabled);
        nodes.set(id, node);
        return id;
    };

    const remove = (id: string): void => {
        const node = nodes.get(id);
        if (!node) {
            // 平面版 MarkerManager/CircleManager と同様、未存在 id は warn + no-op にして
            // 呼び出し側のバグを検知しやすくする。
            console.warn(`[globe-marker] remove: id "${id}" not found`);
            return;
        }
        node.lineMesh.dispose();
        node.lineMat.dispose();
        if (node.iconText && !node.iconText.disposed) {
            node.iconText.disposed = true;
            node.iconText.texture.dispose();
            node.iconText.material.dispose();
            node.iconText.mesh.dispose();
        }
        nodes.delete(id);
    };

    const setEnabled = (id: string, enabled: boolean): void => {
        // 平面版と同様、dispose 後・未存在 id は throw して呼び出しミスを早期検出する。
        if (disposed) throw new Error("GlobeMarkerManager.setEnabled: called after dispose");
        const node = nodes.get(id);
        if (!node) throw new Error(`GlobeMarkerManager.setEnabled: id "${id}" not found`);
        node.enabled = enabled;
        node.lineMesh.setEnabled(enabled && !flat);
        node.iconText?.mesh.setEnabled(enabled);
    };

    const setFlatten = (next: boolean): void => {
        if (disposed) throw new Error("GlobeMarkerManager.setFlatten: called after dispose");
        if (next === flat) return;
        flat = next;
        // ポールの有効可否は flat と node.enabled で決まる。アイコン/ラベルの位置は次回 update
        // （placeNode）が flat を参照して地表/ポール先端へ再アンカーする。
        for (const node of nodes.values()) {
            node.lineMesh.setEnabled(node.enabled && !flat);
        }
    };

    const update = (camEcef: Vector3): void => {
        // 平面版 MarkerManager.update と同様、dispose 後の呼び出しは throw して検知する。
        if (disposed) throw new Error("GlobeMarkerManager.update: called after dispose");
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            if (!node.enabled) continue;
            placeNode(node, camEcef);
        }
    };

    const dispose = (): void => {
        if (disposed) return; // 二重 dispose を安全に無視する
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return { add, remove, setEnabled, setFlatten, update, dispose };
};
