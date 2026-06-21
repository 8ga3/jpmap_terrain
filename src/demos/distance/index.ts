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
    resolveTerrainEngine,
} from "../../terrain/urlState";
import {
    DEFAULT_DISTANCE_DEMO_MODE,
    DistanceDemoMode,
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
            // ラベルは「白縁取り + 黒文字 + 透過矩形」（ライブラリ既定）に揃える。
            // labelBackgroundColor / labelColor は POLYGON_DEFAULTS に委ねる。
            labelFontSize: 12,
            wallColor: "#ff5252",
            wallOpacity: 0.2,
        },
    };
};

const rebuildPolygon = (viewer: JpmapTerrain, state: DemoState): void => {
    const existing = viewer.getPolygon(POLYGON_ID);
    if (state.points.length === 0) {
        if (existing) viewer.removePolygon(POLYGON_ID);
        return;
    }
    const options = buildPolygonOptions(state.points, false);
    // 既存ポリゴンが同じ点数なら in-place 更新する。点座標・点ラベル・辺ラベル（距離/高低差）を
    // メッシュ再構築なしで反映できるため、ドラッグ編集中の点ラベルのチラつきを防げる（globe）。
    // updatePolygon は labels/edgeLabels をそのまま渡せるため、add/remove せずに動的更新できる。
    if (existing && existing.points.length === state.points.length) {
        viewer.updatePolygon(POLYGON_ID, {
            points: options.points,
            labels: options.labels,
            edgeLabels: options.edgeLabels,
        });
        return;
    }
    // 点数が変わる追加/削除、または未生成時のみ add/remove で再構築する。
    // 1 点でも `addPolygon` 可能（#186）。そのまま 点 + 垂線 + 点ラベル を描画する。
    if (existing) viewer.removePolygon(POLYGON_ID);
    viewer.addPolygon(POLYGON_ID, options);
};

const updateStatus = (
    state: DemoState,
    statusEl: HTMLElement | null,
    is2d: boolean,
): void => {
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
              : is2d
                ? `編集モード（点 ${n}）。ドラッグで移動`
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
        onChange();
    });
};

/**
 * 矢印 + 記号を組み合わせた SVG カスタムカーソルを data URL として返す (#186)。
 *
 * - 左上 (0, 0) を矢印先端（hot-spot）とする 24x24 SVG
 * - 矢印部はブラウザ既定に近い黒塗り＋白縁
 * - `sign === "+"` で右下に「+」、`sign === "-"` で右下に「-」記号を重ねる
 */
const buildArrowSignCursor = (sign: "+" | "-"): string => {
    const plusPath =
        // 中心 (17, 17)、長さ 4 の十字（縦）
        `M17 13 V21 ` +
        // 中心 (17, 17)、長さ 4 の十字（横）
        `M13 17 H21`;
    const minusPath = `M13 17 H21`;
    const signPath = sign === "+" ? plusPath : minusPath;
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
        // 矢印（白縁）
        `<path d='M1 1 L1 17 L5.5 13 L8.5 19.5 L11 18.3 L8 12 L14 12 Z' ` +
        `fill='black' stroke='white' stroke-width='1.2' stroke-linejoin='round'/>` +
        // 符号の白縁背景
        `<circle cx='17' cy='17' r='5.5' fill='white' stroke='black' stroke-width='1'/>` +
        `<path d='${signPath}' stroke='black' stroke-width='2' stroke-linecap='round' fill='none'/>` +
        `</svg>`;
    const encoded = encodeURIComponent(svg)
        .replace(/'/g, "%27")
        .replace(/"/g, "%22");
    // hot-spot (0, 0) = 矢印の先端
    return `url("data:image/svg+xml;utf8,${encoded}") 0 0, auto`;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }

    const engine = resolveEngine(location.search);
    const terrainEngine = resolveTerrainEngine(location.search);
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
        ...(terrainEngine ? { terrainEngine } : {}),
        ...(cameraState ?? defaultCamera),
        ...(mapType !== null ? { mapType } : {}),
        // ライブラリ内蔵の視点モード切替ボタンは非表示。デモ独自の UI を提供する (Issue #193)。
        showViewModeButton: false,
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    const state: DemoState = {
        mode: DEFAULT_DISTANCE_DEMO_MODE,
        points: [],
        altitudeDragStart: null,
    };

    const statusEl = document.getElementById(STATUS_ID);
    const onStateChange = (): void => {
        rebuildPolygon(viewer, state);
        updateStatus(state, statusEl, viewer.viewMode === "2d");
        // モード切替時はカーソルを既定に戻し、直近位置で再評価する。
        if (renderCanvas) {
            renderCanvas.style.cursor = "";
            if (lastPointerCanvasX !== null && lastPointerCanvasY !== null) {
                applyModeCursor(lastPointerCanvasX, lastPointerCanvasY);
            }
        }
    };

    // ドラッグ中の pointermove ごとに `removePolygon` → `addPolygon` を実行すると
    // 球体・線・壁・ラベルを毎フレーム破棄/再生成することになりコストが大きい。
    // ドラッグハンドラからは `requestAnimationFrame` で 1 フレーム 1 回に
    // まとめた版を呼び出す (#191)。
    let pendingFrameHandle: number | null = null;
    const onStateChangeScheduled = (): void => {
        if (pendingFrameHandle !== null) return;
        pendingFrameHandle = requestAnimationFrame(() => {
            pendingFrameHandle = null;
            onStateChange();
        });
    };
    const flushScheduledStateChange = (): void => {
        if (pendingFrameHandle !== null) {
            cancelAnimationFrame(pendingFrameHandle);
            pendingFrameHandle = null;
        }
        onStateChange();
    };

    const toolbar = document.getElementById(TOOLBAR_ID);
    if (toolbar instanceof HTMLElement) {
        buildToolbar(toolbar, state, onStateChange);
        // 3D / 2D 視点モード切替 (Issue #193)
        // ライブラリ内蔵ボタンは showViewModeButton:false で非表示。
        const viewModeBtn = document.createElement("button");
        viewModeBtn.type = "button";
        viewModeBtn.dataset.distanceAction = "viewMode";
        const refreshViewModeBtn = (): void => {
            viewModeBtn.textContent =
                viewer.viewMode === "3d" ? "2D 表示" : "3D 表示";
            // 2D/3D で編集ヒント（高度操作の可否）が変わるため再描画する。
            updateStatus(state, statusEl, viewer.viewMode === "2d");
        };
        viewModeBtn.addEventListener("click", () => {
            viewer.viewMode = viewer.viewMode === "3d" ? "2d" : "3d";
        });
        viewer.onViewModeChange(() => refreshViewModeBtn());
        refreshViewModeBtn();
        toolbar.appendChild(viewModeBtn);
    }

    // モード別のカーソル表示 (#186)。
    //
    // - add    : 矢印 + 「+」記号（地形クリックで頂点追加できることを示す）
    // - remove : 球体ホバー時のみ 矢印 + 「-」記号
    // - edit   : 球体ホバー時のみ "move"（Shift 押下中は "ns-resize"）
    // - 上記以外 / 球体外 : ライブラリ既定（"pointer" or ""）
    //
    // SVG data URL によるカスタムカーソルを使用する。hot-spot は左上 (0, 0)。
    // ブラウザ既定の矢印に近いシルエットの上に右下へ + / - を重ねている。
    const ARROW_PLUS_CURSOR = buildArrowSignCursor("+");
    const ARROW_MINUS_CURSOR = buildArrowSignCursor("-");

    // ライブラリの hover dispatch（#184）は遷移時のみ cursor を更新するため、
    // 連続 pointermove 中に scene.pick が一瞬外れて hover が解除されると
    // cursor が `""` に戻ってしまう。そこで demo 側で pointermove ごとに
    // 自前でピックし直し、ライブラリ後段で cursor を再適用する。
    //
    // ただし globe バックエンド（#275 P4）では floating origin のため demo 側の
    // `scene.pick` は頂点メッシュをヒットできない。そこでライブラリの hover イベント
    // （pick 非依存の幾何ピックで発火）も併用し、どちらかが hover を示せば hover 扱いに
    // する。planar では従来どおり scene.pick が主、globe ではライブラリ hover が効く。
    let libHoveringPoint = false;
    const scene = viewer.__debugScene;
    const renderCanvas =
        (scene?.getEngine().getRenderingCanvas() as HTMLCanvasElement | null) ??
        null;
    const POLYGON_POINT_NAME_RE = /^polygon-(.+)-point-(\d+)$/;
    let shiftPressed = false;
    let lastPointerCanvasX: number | null = null;
    let lastPointerCanvasY: number | null = null;
    const isHoveringPoint = (sx: number, sy: number): boolean => {
        if (libHoveringPoint) return true;
        if (!scene) return false;
        const pick = scene.pick(sx, sy, (m) =>
            POLYGON_POINT_NAME_RE.test(m.name),
        );
        return Boolean(pick?.hit && pick.pickedMesh);
    };
    const applyModeCursor = (sx: number, sy: number): void => {
        if (!renderCanvas) return;
        const hovering = isHoveringPoint(sx, sy);
        if (state.mode === "add") {
            // add モードは canvas 全域で「+」カーソル。
            renderCanvas.style.cursor = ARROW_PLUS_CURSOR;
            return;
        }
        if (state.mode === "remove") {
            if (hovering) {
                renderCanvas.style.cursor = ARROW_MINUS_CURSOR;
            }
            // hover 解除はライブラリ側に任せる。
            return;
        }
        if (state.mode === "edit" && hovering) {
            // 2D ではドラッグの高度変更を無効化しているため ns-resize は出さない。
            const altitudeEditable = shiftPressed && viewer.viewMode !== "2d";
            renderCanvas.style.cursor = altitudeEditable ? "ns-resize" : "move";
        }
    };
    if (renderCanvas) {
        renderCanvas.addEventListener("pointermove", (e: PointerEvent) => {
            const rect = renderCanvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            lastPointerCanvasX = sx;
            lastPointerCanvasY = sy;
            applyModeCursor(sx, sy);
        });
    }
    // ライブラリ hover（#184, pick 非依存の幾何ピックで発火）を購読し、globe でも
    // remove/edit のモード別カーソルが効くようにする。遷移時にカーソルを再適用する。
    viewer.onPolygonPointHover((e) => {
        libHoveringPoint = e !== null;
        if (lastPointerCanvasX !== null && lastPointerCanvasY !== null) {
            applyModeCursor(lastPointerCanvasX, lastPointerCanvasY);
        }
    });
    const onShiftKey = (down: boolean) => (ev: KeyboardEvent): void => {
        if (ev.key !== "Shift") return;
        shiftPressed = down;
        if (lastPointerCanvasX !== null && lastPointerCanvasY !== null) {
            applyModeCursor(lastPointerCanvasX, lastPointerCanvasY);
        }
    };
    window.addEventListener("keydown", onShiftKey(true));
    window.addEventListener("keyup", onShiftKey(false));

    // 追加: 地形クリック (#183) で末尾追加。`add` モード以外では無視する。
    viewer.onTerrainClick((e: TerrainClickEvent) => {
        if (state.mode !== "add") return;
        state.points.push({
            lat: e.lat,
            lon: e.lon,
            altitude: e.altitude + ADD_POINT_ALTITUDE_OFFSET_M,
        });
        onStateChange();
    });

    // 削除: 頂点クリックで該当点を削除。
    viewer.onPolygonPointClick((e: PolygonPointPointerEvent) => {
        if (state.mode !== "remove") return;
        if (e.polygonId !== POLYGON_ID) return;
        const i = e.index;
        if (i < 0 || i >= state.points.length) return;
        state.points.splice(i, 1);
        onStateChange();
    });

    // 編集: 頂点ドラッグで lat/lon、Shift+ドラッグで altitude を更新。
    viewer.onPolygonPointDragStart((e: PolygonPointDragEvent) => {
        if (state.mode !== "edit") return;
        if (e.polygonId !== POLYGON_ID) return;
        const current = state.points[e.index];
        if (!current) return;
        if (e.pointerEvent.shiftKey && viewer.viewMode !== "2d") {
            // 高度モード: 開始 altitude / clientY / 地表標高を保持。
            // 2D（トップダウン）では高度変化が見えないため無効化し、通常の lat/lon 移動にする。
            state.altitudeDragStart = {
                index: e.index,
                altitude: current.altitude ?? 0,
                clientY: e.pointerEvent.clientY,
                groundAltitude: e.groundAltitude ?? 0,
            };
        } else {
            state.altitudeDragStart = null;
        }
    });

    viewer.onPolygonPointDrag((e: PolygonPointDragEvent) => {
        if (state.mode !== "edit") return;
        if (e.polygonId !== POLYGON_ID) return;
        const i = e.index;
        const current = state.points[i];
        if (!current) return;
        const dragAlt = state.altitudeDragStart;
        if (dragAlt && dragAlt.index === i) {
            // Shift+drag: altitude 移動。頂点の (lat, lon) を通る垂直線とカーソル
            // レイの最近接点 Y (= pointerAltitude) を採用し、ポイントをカーソル
            // 位置に追従させる。地表より下に行かないようクランプ（pointerAltitude
            // が得られない場合は従来のピクセル換算へフォールバック） (#186)。
            const ground = e.groundAltitude ?? dragAlt.groundAltitude;
            let next: number;
            if (e.pointerAltitude !== null) {
                next = e.pointerAltitude;
            } else {
                const dy = dragAlt.clientY - e.pointerEvent.clientY;
                next = dragAlt.altitude + dy / ALTITUDE_PIXELS_PER_METER;
            }
            current.altitude = Math.max(next, ground);
        } else if (e.planeLat !== null && e.planeLon !== null) {
            // 通常ドラッグ: 頂点の現在の altitude を保つ水平面とカーソルレイの
            // 交点 (planeLat/planeLon) を採用する。地形交点 (lat/lon) を使うと
            // 頂点が垂線と地表の交点に張り付いてしまうため不可 (#186)。
            current.lat = e.planeLat;
            current.lon = e.planeLon;
        } else if (e.lat !== null && e.lon !== null) {
            // 水平面交点が得られない場合のフォールバック（カメラがほぼ水平な場合など）
            current.lat = e.lat;
            current.lon = e.lon;
        }
        onStateChangeScheduled();
    });

    viewer.onPolygonPointDragEnd(() => {
        state.altitudeDragStart = null;
        // ドラッグ中に rAF で保留されている再描画があれば必ず反映する。
        flushScheduledStateChange();
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
