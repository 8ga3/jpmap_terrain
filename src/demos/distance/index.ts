/**
 * 距離計測デモ (#186)
 *
 * 1 本のポリラインを動的に編集し、各頂点の lat/lon/altitude と各辺の水平距離・
 * 高低差をラベル表示する。`altitudeMode: "absolute"` を採用し、`addPolygon` /
 * `insertPolygonPoint` / `removePolygonPoint` / `updatePolygonPoint` /
 * `removePolygon` と、Issue A (`onTerrainClick`) / B (`onPolygonPoint*`) /
 * C (`edgeLabels`) を結合動作で確認する。
 *
 * 操作モード（ツールバーのラジオで排他切替）:
 * - `add` (default): 地形クリックで地表+100m に頂点追加
 * - `remove`: 頂点クリックで当該点を削除（残り 0/1 点も許容、1 点未満時はマーカ表示）
 * - `edit`: 頂点ドラッグで lat/lon 移動、Shift+ドラッグで altitude を ±移動
 *
 * ポイント上 hover は API 既定動作でカーソル `pointer` に切り替わる（#184）。
 * 編集中はカメラ操作が API 側で抑制される（#184）。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type {
    JpmapTerrainOptions,
    PolygonOptions,
    PolygonPointOptions,
    TerrainClickEvent,
    PolygonPointPointerEvent,
    PolygonPointDragEvent,
} from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import {
    DEFAULT_DISTANCE_DEMO_MODE,
    DistanceDemoMode,
    formatAltitudeDelta,
    formatEdgeLabel,
    formatPointLabel,
} from "./utils";

const DEMO_MOUNT_ID = "root";
const TOOLBAR_ID = "distance-toolbar-buttons";
const STATUS_ID = "distance-status";
const POLYGON_ID = "distance-line";

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する（viewer デモと同規則）。
 */
const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/** 頂点クリック時の altitude オフセット (m, 地表から)。 */
const ADD_POINT_ALTITUDE_OFFSET_M = 100;

/** Shift+ドラッグの 1px あたり altitude 変化量 (m/px)。上方向ドラッグで高くする。 */
const ALTITUDE_PIXELS_PER_METER = 0.5;

interface DemoState {
    mode: DistanceDemoMode;
    points: PolygonPointOptions[];
    /**
     * 各 `points[i]` に対応する地表標高 (m)。クリック追加時の `e.altitude` を起点とし、
     * lat/lon 編集ドラッグで `e.groundAltitude` が利用可能なら追従更新する。
     * 1 点目だけが存在するときの「垂線描画」と、編集時の地表クランプに使用する。
     */
    groundAltitudes: number[];
    /**
     * Shift+ドラッグ開始時のスナップショット。`pointermove` ごとに altitude を再計算するため、
     * dragStart の `altitude` と `clientY` を保持する。
     */
    altitudeDragStart: {
        index: number;
        altitude: number;
        clientY: number;
        groundAltitude: number;
    } | null;
}

const buildPolygonOptions = (
    points: readonly PolygonPointOptions[],
    closed: boolean,
): PolygonOptions => {
    const edgeCount = closed
        ? points.length
        : Math.max(0, points.length - 1);
    const edgeLabels: (string | undefined)[] = [];
    for (let i = 0; i < edgeCount; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        edgeLabels.push(formatEdgeLabel(a, b));
    }
    const labels = points.map((p) => formatPointLabel(p));
    return {
        points: points.map((p) => ({ ...p })),
        altitudeMode: "absolute",
        closed,
        labels,
        edgeLabels,
        style: {
            pointColor: "#ff5252",
            lineColor: "#ff5252",
            pointDiameter: 16,
            lineWidth: 2,
            labelBackgroundColor: "rgba(255,255,255,0.85)",
            labelColor: "#222",
            labelFontSize: 12,
            wallColor: "#ff5252",
            wallOpacity: 0.2,
        },
    };
};

/**
 * 1 点しかない場合に、その点と地表の間を結ぶ「垂線」を描画するための合成ポリゴンを構築する。
 * `addPolygon` は points.length >= 2 を要求するため、同一 lat/lon で altitude のみ異なる
 * 2 点（地表側・実点側）を生成し、辺ラベルとして高度オフセットを表示する。
 */
const buildSinglePointPolygonOptions = (
    p: PolygonPointOptions,
    groundAltitude: number,
): PolygonOptions => {
    const top: PolygonPointOptions = { ...p };
    const base: PolygonPointOptions = {
        lat: p.lat,
        lon: p.lon,
        altitude: groundAltitude,
    };
    const delta = (p.altitude ?? 0) - groundAltitude;
    return {
        points: [base, top],
        altitudeMode: "absolute",
        closed: false,
        // 上端のみラベル表示（下端は地表アンカーなので非表示にしたいが
        // public 型上 `labels` は `string[]` のため、空文字でラベルを抑制せず
        // `labelsEnabled` ではなく labels 配列を渡さない＝両端ラベルなし）。
        // 代わりに辺ラベルで lat/lon と高度オフセットを示す。
        edgeLabels: [`${formatPointLabel(top)}\n${formatAltitudeDelta(delta)}`],
        style: {
            pointColor: "#ff5252",
            lineColor: "#ff5252",
            pointDiameter: 16,
            lineWidth: 2,
            labelBackgroundColor: "rgba(255,255,255,0.85)",
            labelColor: "#222",
            labelFontSize: 12,
            wallColor: "#ff5252",
            wallOpacity: 0.2,
        },
    };
};

const rebuildPolygon = (viewer: JpmapTerrain, state: DemoState): void => {
    // 既存ポリゴンを毎回削除→再追加することで edgeLabels をフレッシュに保つ。
    // `replacePolygonPoints` は spec 上 edgeLabels を全 undefined にリセットするため、
    // 距離・高低差の動的更新には add/remove を使うのが最も簡潔（#185）。
    const existing = viewer.getPolygon(POLYGON_ID);
    if (existing) viewer.removePolygon(POLYGON_ID);
    if (state.points.length === 0) return;
    if (state.points.length === 1) {
        // 1 点だけのときは合成 2 点ポリゴン（同一 lat/lon・地表↔実点）で垂線を描画する。
        const ground = state.groundAltitudes[0] ?? 0;
        viewer.addPolygon(
            POLYGON_ID,
            buildSinglePointPolygonOptions(state.points[0], ground),
        );
        return;
    }
    viewer.addPolygon(POLYGON_ID, buildPolygonOptions(state.points, false));
};

const updateStatus = (state: DemoState, statusEl: HTMLElement | null): void => {
    if (!statusEl) return;
    const n = state.points.length;
    const guide =
        state.mode === "add"
            ? n === 0
                ? "地形をクリックして 1 点目を追加してください"
                : n === 1
                  ? "もう 1 点クリックして折れ線を作成してください"
                  : "クリックで点を追加できます"
            : state.mode === "remove"
              ? n <= 2
                  ? `削除モード（点 ${n}）。点をクリックすると削除します`
                  : `削除モード（点 ${n}）`
              : `編集モード（点 ${n}）。ドラッグで移動 / Shift+ドラッグで高度`;
    statusEl.textContent = `モード: ${state.mode}（点 ${n}）／ ${guide}`;
};

const buildToolbar = (
    container: HTMLElement,
    state: DemoState,
    onChange: () => void,
): void => {
    container.innerHTML = "";
    const modes: ReadonlyArray<{ value: DistanceDemoMode; label: string }> = [
        { value: "add", label: "追加" },
        { value: "remove", label: "削除" },
        { value: "edit", label: "編集" },
    ];
    const buttons = new Map<DistanceDemoMode, HTMLButtonElement>();
    const refresh = (): void => {
        for (const [mode, btn] of buttons) {
            btn.dataset.active = state.mode === mode ? "true" : "false";
            btn.setAttribute(
                "aria-pressed",
                state.mode === mode ? "true" : "false",
            );
        }
    };
    for (const m of modes) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = m.label;
        btn.dataset.distanceMode = m.value;
        btn.addEventListener("click", () => {
            state.mode = m.value;
            refresh();
            onChange();
        });
        buttons.set(m.value, btn);
        container.appendChild(btn);
    }
    refresh();

    // クリア（全頂点削除）
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "クリア";
    clearBtn.dataset.distanceAction = "clear";
    container.appendChild(clearBtn);
    clearBtn.addEventListener("click", () => {
        state.points.length = 0;
        state.groundAltitudes.length = 0;
        onChange();
    });
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }

    const engine = resolveEngine(location.search);
    const cameraState = parseCameraStateFromUrl(location.href) ?? undefined;
    const mapType = parseMapTypeFromUrl(location.href);
    // よみうりランド近傍を初期視点（URL 指定がない場合）。
    const defaultCamera = {
        lat: 35.6242625,
        lon: 139.5148162,
        altitude: 1500,
        azimuth: 0,
        tilt: 55,
    };

    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        ...(cameraState ?? defaultCamera),
        ...(mapType !== null ? { mapType } : {}),
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    const state: DemoState = {
        mode: DEFAULT_DISTANCE_DEMO_MODE,
        points: [],
        groundAltitudes: [],
        altitudeDragStart: null,
    };

    const statusEl = document.getElementById(STATUS_ID);
    const onStateChange = (): void => {
        rebuildPolygon(viewer, state);
        updateStatus(state, statusEl);
    };

    const toolbar = document.getElementById(TOOLBAR_ID);
    if (toolbar instanceof HTMLElement) {
        buildToolbar(toolbar, state, onStateChange);
    }

    // hover リスナーを 1 件登録することで、頂点 hover 時のカーソル変更を有効化する (#184)。
    viewer.onPolygonPointHover(() => {
        /* no-op: 既定のカーソル切替のみ利用 */
    });

    // 追加: 地形クリック (#183) で末尾追加。`add` モード以外では無視する。
    viewer.onTerrainClick((e: TerrainClickEvent) => {
        if (state.mode !== "add") return;
        state.points.push({
            lat: e.lat,
            lon: e.lon,
            altitude: e.altitude + ADD_POINT_ALTITUDE_OFFSET_M,
        });
        state.groundAltitudes.push(e.altitude);
        onStateChange();
    });

    // 1 点合成ポリゴンの頂点 index (0=地表, 1=実点) を、論理的な state.points のインデックスに正規化する。
    const toLogicalIndex = (eventIndex: number): number => {
        // points.length === 1 のときは合成ポリゴンの index 0/1 がどちらも論理点 0 を指す。
        if (state.points.length === 1) return 0;
        return eventIndex;
    };

    // 削除: 頂点クリックで該当点を削除。
    viewer.onPolygonPointClick((e: PolygonPointPointerEvent) => {
        if (state.mode !== "remove") return;
        if (e.polygonId !== POLYGON_ID) return;
        const i = toLogicalIndex(e.index);
        if (i < 0 || i >= state.points.length) return;
        state.points.splice(i, 1);
        state.groundAltitudes.splice(i, 1);
        onStateChange();
    });

    // 編集: 頂点ドラッグで lat/lon、Shift+ドラッグで altitude を更新。
    viewer.onPolygonPointDragStart((e: PolygonPointDragEvent) => {
        if (state.mode !== "edit") return;
        if (e.polygonId !== POLYGON_ID) return;
        const i = toLogicalIndex(e.index);
        const current = state.points[i];
        if (!current) return;
        if (e.pointerEvent.shiftKey) {
            // 高度モード: 開始 altitude / clientY / 地表標高を保持。
            state.altitudeDragStart = {
                index: i,
                altitude: current.altitude ?? 0,
                clientY: e.pointerEvent.clientY,
                groundAltitude:
                    e.groundAltitude ?? state.groundAltitudes[i] ?? 0,
            };
        } else {
            state.altitudeDragStart = null;
        }
    });

    viewer.onPolygonPointDrag((e: PolygonPointDragEvent) => {
        if (state.mode !== "edit") return;
        if (e.polygonId !== POLYGON_ID) return;
        const i = toLogicalIndex(e.index);
        const current = state.points[i];
        if (!current) return;
        const dragAlt = state.altitudeDragStart;
        if (dragAlt && dragAlt.index === i) {
            // Shift+drag: altitude 移動。スクリーン上方向に動かすほど altitude が増える。
            const dy = dragAlt.clientY - e.pointerEvent.clientY;
            const next = dragAlt.altitude + dy / ALTITUDE_PIXELS_PER_METER;
            // 地表より下に行かないようクランプ（地形未ヒット時は dragStart 時点の値で代替）。
            const ground = e.groundAltitude ?? dragAlt.groundAltitude;
            current.altitude = Math.max(next, ground);
        } else if (e.lat !== null && e.lon !== null) {
            // 通常ドラッグ: lat/lon を更新（altitude は維持）。
            current.lat = e.lat;
            current.lon = e.lon;
            // 新位置の地表標高が分かれば追従更新（垂線・クランプ用）。
            if (e.groundAltitude !== null && e.groundAltitude !== undefined) {
                state.groundAltitudes[i] = e.groundAltitude;
            }
        }
        onStateChange();
    });

    viewer.onPolygonPointDragEnd(() => {
        state.altitudeDragStart = null;
    });

    onStateChange();

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        (window as unknown as { distanceState: DemoState }).distanceState = state;
    }
};

if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain demo] failed to start:", err);
    });
}
