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
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
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
}

export interface GlobeMarkerManager {
    /** マーカーを追加し、id を返す。 */
    add(opts: GlobeMarkerOptions): string;
    /** マーカーを削除する。 */
    remove(id: string): void;
    /** 表示/非表示を切り替える。 */
    setEnabled(id: string, enabled: boolean): void;
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

    // 毎フレーム再利用するスクラッチ。
    const pos = new Vector3();
    const up = new Vector3();
    const tmp = new Vector3();
    const quat = new Quaternion();

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
        // ラベルもピック対象から外す（地形ピック等の妨げにしない）。
        if (iconText) iconText.mesh.isPickable = false;

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
        };
        lineMesh.setEnabled(enabled);
        iconText?.mesh.setEnabled(enabled);
        nodes.set(id, node);
        return id;
    };

    const remove = (id: string): void => {
        const node = nodes.get(id);
        if (!node) return;
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
        const node = nodes.get(id);
        if (!node) return;
        node.enabled = enabled;
        node.lineMesh.setEnabled(enabled);
        node.iconText?.mesh.setEnabled(enabled);
    };

    const update = (camEcef: Vector3): void => {
        if (nodes.size === 0) return;
        for (const node of nodes.values()) {
            if (!node.enabled) continue;
            const elev = terrainElevAt(node.lat, node.lon) ?? 0;
            // 地表 ECEF と地心 up。
            groundPlacementToRef(node.lat, node.lon, elev, pos, up);
            // 距離は 1 回だけ算出し、スケールと線高さで再利用（sqrt の二重計算を避ける）。
            const dist = Vector3.Distance(camEcef, pos);
            const distScale = computeOverlayDistanceScaleFromDistance(dist);
            const lineHeight = computeOverlayLineHeight(dist);

            // ポール: 地心 up 沿い、地表から lineHeight。径は距離スケールでスクリーン定。
            orientYToUpToRef(up, quat);
            node.lineMesh.rotationQuaternion!.copyFrom(quat);
            const diameter = node.poleBaseDiameter * distScale;
            node.lineMesh.scaling.set(diameter, lineHeight, diameter);
            // 中点 = 地表 + up*(lineHeight/2)。
            tmp.copyFrom(up).scaleInPlace(lineHeight / 2);
            node.lineMesh.position.copyFrom(pos).addInPlace(tmp);

            // アイコン/ラベル: ポール上端の少し上。BILLBOARDMODE_ALL なので向きは自動。
            if (node.iconText) {
                node.iconText.mesh.scaling.set(distScale, distScale, distScale);
                const textHalf = (node.iconText.heightWorld * distScale) / 2;
                tmp.copyFrom(up).scaleInPlace(lineHeight + textHalf);
                node.iconText.mesh.position.copyFrom(pos).addInPlace(tmp);
            }
        }
    };

    const dispose = (): void => {
        if (disposed) return; // 二重 dispose を安全に無視する
        disposed = true;
        for (const id of [...nodes.keys()]) remove(id);
    };

    return { add, remove, setEnabled, update, dispose };
};
