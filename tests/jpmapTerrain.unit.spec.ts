/**
 * @vitest-environment jsdom
 */
/**
 * `JpmapTerrain` クラス公開 API のユニットテスト
 *
 * - デフォルト値の適用
 * - get/set による状態保持
 * - flyTo による状態更新
 * - mountElement 必須チェック
 * - mountElement 配下に canvas が追加されること
 * - dispose で canvas が除去されること
 *
 * Babylon.js Engine / Scene は jsdom で動かないためモックする。
 * `engineFactory` の `vi.mock` ファクトリはトップレベルの `createEngineMock` を
 * 参照するため、対象モジュールは `vi.mock` 登録後（＝ここまでの const 初期化後）に
 * 動的 import で読み込む。静的 import に変えると、ホイストされた `vi.mock` が
 * 他の import 解決時に先走って実行され、`createEngineMock` の TDZ エラーになる。
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";
import {
    CIRCLE_DEFAULTS,
    CIRCLE_RADIUS_MAX_M,
    CIRCLE_SEGMENTS_MAX,
    CIRCLE_SEGMENTS_MIN,
    type CircleHandle,
    type CircleOptions,
    type CircleUpdate,
    MARKER_DEFAULTS,
    type MarkerHandle,
    type MarkerOptions,
    type MarkerUpdate,
    MODEL_DEFAULTS,
    type ModelHandle,
    type ModelOptions,
    type ModelUpdate,
    POLYGON_DEFAULTS,
    type PolygonHandle,
    type PolygonOptions,
    type PolygonPointOptions,
    type PolygonPointPartial,
    type PolygonUpdate,
} from "../src/lib/types";
import type { CircleManager } from "../src/terrain/circleManager";
import type { MarkerManager } from "../src/terrain/markerManager";
import type { ModelManager } from "../src/terrain/modelManager";
import { assertLatLonInBounds } from "../src/terrain/overlayCoords";
import type { PolygonManager } from "../src/terrain/polygonManager";

// Engine / Scene 生成はテスト対象外（Babylon.js に委譲）。
// jsdom では WebGPU/WebGL2 を提供できないため、最低限のスタブで差し替える。
const engineDispose = vi.fn();
// engine.resize 呼び出し回数をテストで検証できるよう、最後に作った engine の resize を保持する。
let lastEngineResize: Mock = vi.fn();
// 実際の `createBabylonEngine(canvas, preferred, options)` のシグネチャに合わせる。
// 関数本体では未使用だが、`createEngineMock.mock.calls[i][1]`（engine 種別）や
// `[i][2]`（high precision matrix オプション）を検証する用途があるため、可変引数ではなく
// 明示的なパラメータとして宣言する。
const createEngineMock = vi.fn(
    async (
        _canvas: unknown,
        _preferred?: "webgpu" | "webgl2",
        _options?: { highPrecisionMatrix?: boolean },
    ) => {
        const resize = vi.fn();
        lastEngineResize = resize;
        return {
            runRenderLoop: vi.fn(),
            resize,
            dispose: engineDispose,
        };
    },
);

vi.mock("../src/lib/internal/engineFactory", () => ({
    createBabylonEngine: createEngineMock,
}));

// jsdom には ResizeObserver が無いため、テスト用に簡易実装を注入する。
// 観測対象 → 観測コールバックを覚えておき、テストから手動で trigger できる。
type RoCallback = (entries: unknown[], observer: unknown) => void;
const resizeObservers: Array<{
    callback: RoCallback;
    targets: Set<Element>;
    disconnect: Mock;
}> = [];
class TestResizeObserver {
    public disconnect: Mock;
    private targets: Set<Element> = new Set();
    constructor(callback: RoCallback) {
        this.disconnect = vi.fn(() => {
            this.targets.clear();
        });
        resizeObservers.push({
            callback,
            targets: this.targets,
            disconnect: this.disconnect,
        });
    }
    observe(target: Element): void {
        this.targets.add(target);
    }
    unobserve(target: Element): void {
        this.targets.delete(target);
    }
}
(
    globalThis as unknown as { ResizeObserver: typeof TestResizeObserver }
).ResizeObserver = TestResizeObserver;
const triggerResizeObservers = (): void => {
    for (const ro of resizeObservers) {
        if (ro.targets.size === 0) continue;
        const entries = Array.from(ro.targets).map((t) => ({ target: t }));
        ro.callback(entries, ro);
    }
};

// Polygon API テストでは実際の Polygon ノード（Babylon 実体に依存）ではなく、
// 振る舞いのみを再現した軽量スタブファクトリを用いる。
const createPolygonNode = (
    _scene: unknown,
    id: string,
    options: {
        points: readonly { lat: number; lon: number; altitude?: number }[];
        closed?: boolean;
        altitudeMode?: "terrain" | "absolute";
        enabled?: boolean;
        pointsEnabled?: boolean;
        verticalsEnabled?: boolean;
        labelsEnabled?: boolean;
        wallsEnabled?: boolean;
    },
) => {
    let enabled = options.enabled ?? true;
    let pointsEnabled = options.pointsEnabled ?? true;
    let verticalsEnabled = options.verticalsEnabled ?? true;
    let labelsEnabled = options.labelsEnabled ?? true;
    let wallsEnabled = options.wallsEnabled ?? true;
    const altitudeMode = options.altitudeMode ?? "terrain";
    let elevationResolved = altitudeMode === "absolute";
    const points = options.points.map((p) => ({ ...p }));
    return {
        id,
        altitudeMode,
        closed: options.closed ?? false,
        points,
        applyTransform: () => {
            /* no-op */
        },
        setEnabledLogical: (v: boolean) => {
            enabled = v;
        },
        setPointsEnabledLogical: (v: boolean) => {
            pointsEnabled = v;
        },
        setVerticalsEnabledLogical: (v: boolean) => {
            verticalsEnabled = v;
        },
        setLabelsEnabledLogical: (v: boolean) => {
            labelsEnabled = v;
        },
        setWallsEnabledLogical: (v: boolean) => {
            wallsEnabled = v;
        },
        setElevationResolved: (v: boolean) => {
            elevationResolved = v;
        },
        getHandle: (): PolygonHandle => ({
            id,
            points: points.map((p) => ({ ...p })),
            closed: options.closed ?? false,
            altitudeMode,
            labels: undefined,
            edgeLabels: undefined,
            style: {} as unknown as PolygonHandle["style"],
            enabled,
            pointsEnabled,
            verticalsEnabled,
            labelsEnabled,
            wallsEnabled,
            elevationResolved,
        }),
        dispose: () => {
            /* no-op */
        },
        insertPoint: (
            index: number,
            point: { lat: number; lon: number; altitude?: number },
        ) => {
            points.splice(index, 0, { ...point });
        },
        removePoint: (index: number) => {
            points.splice(index, 1);
        },
        updatePoint: (
            index: number,
            partial: {
                lat?: number;
                lon?: number;
                altitude?: number;
                label?: string | null;
            },
        ) => {
            const cur = points[index];
            if (!cur) return;
            if (partial.lat !== undefined) cur.lat = partial.lat;
            if (partial.lon !== undefined) cur.lon = partial.lon;
            if (partial.altitude !== undefined) cur.altitude = partial.altitude;
        },
        replacePoints: (
            next: readonly { lat: number; lon: number; altitude?: number }[],
        ) => {
            points.length = 0;
            for (const p of next) points.push({ ...p });
        },
    };
};

// Circle API テストでは実際の Circle ノード（Babylon 実体に依存）ではなく、
// 振る舞いのみを再現した軽量スタブファクトリを用いる。
const createCircleNode = (
    _scene: unknown,
    id: string,
    options: {
        center: { lat: number; lon: number; altitude?: number };
        radius: number;
        segments?: number;
        altitudeMode?: "terrain" | "absolute";
        enabled?: boolean;
        pointEnabled?: boolean;
        lineEnabled?: boolean;
        wallEnabled?: boolean;
        labelEnabled?: boolean;
    },
) => {
    let enabled = options.enabled ?? true;
    let pointEnabled = options.pointEnabled ?? true;
    let lineEnabled = options.lineEnabled ?? true;
    let wallEnabled = options.wallEnabled ?? true;
    let labelEnabled = options.labelEnabled ?? true;
    const altitudeMode = options.altitudeMode ?? "terrain";
    let elevationResolved = altitudeMode === "absolute";
    let _center = { ...options.center };
    let _radius = options.radius;
    const segments = options.segments ?? 64;
    return {
        id,
        altitudeMode,
        get center() {
            return _center;
        },
        set center(v: { lat: number; lon: number; altitude?: number }) {
            _center = { ...v };
        },
        get radius() {
            return _radius;
        },
        set radius(v: number) {
            _radius = v;
        },
        get segments() {
            return segments;
        },
        applyTransform: () => {
            /* no-op */
        },
        setEnabledLogical: (v: boolean) => {
            enabled = v;
        },
        setPointEnabledLogical: (v: boolean) => {
            pointEnabled = v;
        },
        setLineEnabledLogical: (v: boolean) => {
            lineEnabled = v;
        },
        setWallEnabledLogical: (v: boolean) => {
            wallEnabled = v;
        },
        setLabelEnabledLogical: (v: boolean) => {
            labelEnabled = v;
        },
        setElevationResolved: (v: boolean) => {
            elevationResolved = v;
        },
        getHandle: (): CircleHandle => ({
            id,
            center: { ..._center },
            radius: _radius,
            segments,
            altitudeMode,
            label: null,
            style: {} as unknown as CircleHandle["style"],
            enabled,
            pointEnabled,
            lineEnabled,
            wallEnabled,
            labelEnabled,
            elevationResolved,
        }),
        dispose: () => {
            /* no-op */
        },
    };
};

const createMarkerManagerStub = (): MarkerManager => {
    const markers = new Map<string, MarkerHandle>();
    let disposed = false;
    return {
        add(id: string, options: MarkerOptions): MarkerHandle {
            if (disposed) throw new Error("MarkerManager has been disposed");
            if (markers.has(id)) throw new Error(`id "${id}" already exists`);
            assertLatLonInBounds(options.lat, options.lon, "marker");
            const handle: MarkerHandle = {
                id,
                lat: options.lat,
                lon: options.lon,
                enabled: options.enabled ?? MARKER_DEFAULTS.enabled,
                icon: options.icon ? { ...options.icon } : null,
                text: options.text ? { ...options.text } : null,
                line: { ...MARKER_DEFAULTS.line, ...options.line },
                elevationResolved: true,
            };
            markers.set(id, handle);
            return handle;
        },
        get: (id: string): MarkerHandle | null => markers.get(id) ?? null,
        update(id: string, partial: MarkerUpdate): MarkerHandle {
            if (disposed) throw new Error("MarkerManager has been disposed");
            const current = markers.get(id);
            if (!current) throw new Error(`Marker id "${id}" not found`);
            const lat = partial.lat ?? current.lat;
            const lon = partial.lon ?? current.lon;
            assertLatLonInBounds(lat, lon, "marker");
            const next: MarkerHandle = {
                ...current,
                lat,
                lon,
                enabled: partial.enabled ?? current.enabled,
                icon:
                    partial.icon !== undefined
                        ? { ...partial.icon }
                        : current.icon,
                text:
                    partial.text !== undefined
                        ? { ...partial.text }
                        : current.text,
                line:
                    partial.line !== undefined
                        ? { ...current.line, ...partial.line }
                        : current.line,
            };
            markers.set(id, next);
            return next;
        },
        remove: (id: string): void => {
            markers.delete(id);
        },
        setEnabled: (id: string, enabled: boolean): void => {
            const current = markers.get(id);
            if (current) markers.set(id, { ...current, enabled });
        },
        list: (): readonly string[] => [...markers.keys()],
        dispose: (): void => {
            disposed = true;
            markers.clear();
        },
    };
};

const validatePolygonOptions = (options: PolygonOptions): void => {
    if (!options.points || options.points.length < 1) {
        throw new Error(
            "JpmapTerrain.addPolygon: points must contain at least 1 entry",
        );
    }
    const altitudeMode = options.altitudeMode ?? POLYGON_DEFAULTS.altitudeMode;
    options.points.forEach((point, index) => {
        assertLatLonInBounds(
            point.lat,
            point.lon,
            `JpmapTerrain.addPolygon[${index}]`,
        );
        if (altitudeMode === "absolute" && point.altitude === undefined) {
            throw new Error(
                `JpmapTerrain.addPolygon: altitudeMode="absolute" requires altitude on every point (missing at index ${index})`,
            );
        }
    });
};

const createPolygonManagerStub = (): PolygonManager => {
    const nodes = new Map<string, ReturnType<typeof createPolygonNode>>();
    let disposed = false;
    const requireNode = (id: string): ReturnType<typeof createPolygonNode> => {
        const node = nodes.get(id);
        if (!node) throw new Error(`Polygon id "${id}" not found`);
        return node;
    };
    const assertActive = (): void => {
        if (disposed) throw new Error("PolygonManager has been disposed");
    };
    const validatePointForNode = (
        node: ReturnType<typeof createPolygonNode>,
        point: PolygonPointOptions,
        prefix: string,
    ): void => {
        assertLatLonInBounds(point.lat, point.lon, prefix);
        if (node.altitudeMode === "absolute" && point.altitude === undefined) {
            throw new Error(
                `${prefix}: altitudeMode="absolute" requires altitude`,
            );
        }
    };
    return {
        add(id: string, options: PolygonOptions) {
            assertActive();
            if (nodes.has(id)) throw new Error(`id "${id}" already exists`);
            validatePolygonOptions(options);
            const node = createPolygonNode({} as never, id, options);
            node.setElevationResolved(true);
            nodes.set(id, node);
            return node.getHandle();
        },
        get: (id: string) => nodes.get(id)?.getHandle() ?? null,
        update(id: string, partial: PolygonUpdate) {
            assertActive();
            const prev = requireNode(id);
            const current = prev.getHandle();
            const merged: PolygonOptions = {
                points: (partial.points ?? current.points).map((p) => ({
                    ...p,
                })),
                closed: partial.closed ?? current.closed,
                altitudeMode: partial.altitudeMode ?? current.altitudeMode,
                labels: ("labels" in partial
                    ? partial.labels
                    : current.labels) as PolygonOptions["labels"],
                edgeLabels:
                    "edgeLabels" in partial
                        ? partial.edgeLabels
                        : current.edgeLabels,
                style: "style" in partial ? partial.style : current.style,
                enabled: partial.enabled ?? current.enabled,
                verticalsEnabled:
                    partial.verticalsEnabled ?? current.verticalsEnabled,
                labelsEnabled: partial.labelsEnabled ?? current.labelsEnabled,
                wallsEnabled: partial.wallsEnabled ?? current.wallsEnabled,
            };
            validatePolygonOptions(merged);
            const node = createPolygonNode({} as never, id, merged);
            node.setElevationResolved(true);
            prev.dispose();
            nodes.set(id, node);
            return node.getHandle();
        },
        remove(id: string): void {
            const node = nodes.get(id);
            node?.dispose();
            nodes.delete(id);
        },
        setEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            const node = nodes.get(id);
            node?.setEnabledLogical(enabled);
        },
        setVerticalsEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setVerticalsEnabledLogical(enabled);
        },
        setPointsEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setPointsEnabledLogical(enabled);
        },
        setLabelsEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setLabelsEnabledLogical(enabled);
        },
        setWallsEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setWallsEnabledLogical(enabled);
        },
        insertPoint(id: string, index: number, point: PolygonPointOptions) {
            assertActive();
            const node = requireNode(id);
            validatePointForNode(
                node,
                point,
                `JpmapTerrain.insertPolygonPoint[${id}]`,
            );
            node.insertPoint(index, point);
            return node.getHandle();
        },
        removePoint(id: string, index: number) {
            assertActive();
            const node = requireNode(id);
            node.removePoint(index);
            return node.getHandle();
        },
        updatePoint(id: string, index: number, partial: PolygonPointPartial) {
            assertActive();
            const node = requireNode(id);
            const current = node.points[index];
            if (!current)
                throw new Error(`Polygon point index "${index}" not found`);
            const next = { ...current, ...partial };
            validatePointForNode(
                node,
                next,
                `JpmapTerrain.updatePolygonPoint[${id}][${index}]`,
            );
            node.updatePoint(index, partial);
            return node.getHandle();
        },
        replacePoints(id: string, points: readonly PolygonPointOptions[]) {
            assertActive();
            const node = requireNode(id);
            if (!points || points.length < 1) {
                throw new Error("points must contain at least 1 entry");
            }
            points.forEach((point, index) => {
                validatePointForNode(
                    node,
                    point,
                    `JpmapTerrain.replacePolygonPoints[${id}][${index}]`,
                );
            });
            node.replacePoints(points);
            return node.getHandle();
        },
        list: (): readonly string[] => [...nodes.keys()],
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const node of nodes.values()) node.dispose();
            nodes.clear();
        },
    };
};

const validateCircleOptions = (
    options: CircleOptions,
    prefix = "JpmapTerrain.addCircle",
): void => {
    assertLatLonInBounds(options.center.lat, options.center.lon, prefix);
    if (
        !Number.isFinite(options.radius) ||
        options.radius <= 0 ||
        options.radius > CIRCLE_RADIUS_MAX_M
    ) {
        throw new Error(`${prefix}: radius is out of range`);
    }
    if (
        options.segments !== undefined &&
        (!Number.isInteger(options.segments) ||
            options.segments < CIRCLE_SEGMENTS_MIN ||
            options.segments > CIRCLE_SEGMENTS_MAX)
    ) {
        throw new Error(`${prefix}: segments is out of range`);
    }
    const altitudeMode = options.altitudeMode ?? CIRCLE_DEFAULTS.altitudeMode;
    if (altitudeMode === "absolute" && options.center.altitude === undefined) {
        throw new Error(
            `${prefix}: altitudeMode="absolute" requires center.altitude`,
        );
    }
};

const createCircleManagerStub = (): CircleManager => {
    const nodes = new Map<string, ReturnType<typeof createCircleNode>>();
    const optionsById = new Map<string, CircleOptions>();
    let disposed = false;
    const requireNode = (id: string): ReturnType<typeof createCircleNode> => {
        const node = nodes.get(id);
        if (!node) throw new Error(`Circle id "${id}" not found`);
        return node;
    };
    const assertActive = (): void => {
        if (disposed) throw new Error("CircleManager has been disposed");
    };
    return {
        add(id: string, options: CircleOptions) {
            assertActive();
            if (nodes.has(id)) throw new Error(`id "${id}" already exists`);
            validateCircleOptions(options);
            const node = createCircleNode({} as never, id, options);
            node.setElevationResolved(true);
            nodes.set(id, node);
            optionsById.set(id, { ...options, center: { ...options.center } });
            return node.getHandle();
        },
        update(id: string, partial: CircleUpdate) {
            assertActive();
            const node = requireNode(id);
            const current = optionsById.get(id) ?? node.getHandle();
            const merged: CircleOptions = {
                ...current,
                center: partial.center
                    ? { ...partial.center }
                    : { ...current.center },
                radius: partial.radius ?? current.radius,
                segments: partial.segments ?? current.segments,
                altitudeMode: partial.altitudeMode ?? current.altitudeMode,
                label: partial.label ?? current.label,
                style: partial.style
                    ? { ...current.style, ...partial.style }
                    : current.style,
                enabled: partial.enabled ?? current.enabled,
                pointEnabled: partial.pointEnabled ?? current.pointEnabled,
                lineEnabled: partial.lineEnabled ?? current.lineEnabled,
                wallEnabled: partial.wallEnabled ?? current.wallEnabled,
                labelEnabled: partial.labelEnabled ?? current.labelEnabled,
            };
            validateCircleOptions(merged, "JpmapTerrain.updateCircle");
            const needsRebuild =
                partial.segments !== undefined ||
                partial.altitudeMode !== undefined ||
                partial.label !== undefined ||
                partial.style !== undefined;
            const nextNode = needsRebuild
                ? createCircleNode({} as never, id, merged)
                : node;
            if (partial.center !== undefined) nextNode.center = partial.center;
            if (partial.radius !== undefined) nextNode.radius = partial.radius;
            if (partial.enabled !== undefined)
                nextNode.setEnabledLogical(partial.enabled);
            if (partial.pointEnabled !== undefined)
                nextNode.setPointEnabledLogical(partial.pointEnabled);
            if (partial.lineEnabled !== undefined)
                nextNode.setLineEnabledLogical(partial.lineEnabled);
            if (partial.wallEnabled !== undefined)
                nextNode.setWallEnabledLogical(partial.wallEnabled);
            if (partial.labelEnabled !== undefined)
                nextNode.setLabelEnabledLogical(partial.labelEnabled);
            nextNode.setElevationResolved(true);
            if (needsRebuild) {
                node.dispose();
                nodes.set(id, nextNode);
            }
            optionsById.set(id, { ...merged, center: { ...merged.center } });
            return nextNode.getHandle();
        },
        get: (id: string) => nodes.get(id)?.getHandle() ?? null,
        remove(id: string): void {
            nodes.get(id)?.dispose();
            nodes.delete(id);
            optionsById.delete(id);
        },
        setEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setEnabledLogical(enabled);
        },
        setPointEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setPointEnabledLogical(enabled);
        },
        setLineEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setLineEnabledLogical(enabled);
        },
        setWallEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setWallEnabledLogical(enabled);
        },
        setLabelEnabled(id: string, enabled: boolean): void {
            if (disposed) return;
            nodes.get(id)?.setLabelEnabledLogical(enabled);
        },
        list: (): readonly string[] => [...nodes.keys()],
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const node of nodes.values()) node.dispose();
            nodes.clear();
            optionsById.clear();
        },
    };
};

const createModelManagerStub = (): ModelManager => {
    const models = new Map<string, ModelHandle>();
    let disposed = false;
    const toHandle = (m: ModelHandle): ModelHandle => ({
        ...m,
        rotation: { ...m.rotation },
        scaling: { ...m.scaling },
        animationNames: [...m.animationNames],
    });
    return {
        add(id: string, options: ModelOptions) {
            if (disposed) throw new Error("ModelManager has been disposed");
            if (models.has(id)) throw new Error(`id "${id}" already exists`);
            assertLatLonInBounds(
                options.lat,
                options.lon,
                "JpmapTerrain.addModel",
            );
            if (
                (options.altitudeMode ?? MODEL_DEFAULTS.altitudeMode) ===
                    "absolute" &&
                options.altitude === undefined
            ) {
                throw new Error(
                    'JpmapTerrain.addModel: altitudeMode="absolute" requires altitude',
                );
            }
            const entry: ModelHandle = {
                id,
                url: options.url,
                lat: options.lat,
                lon: options.lon,
                altitude: options.altitude ?? MODEL_DEFAULTS.altitude,
                altitudeMode:
                    options.altitudeMode ?? MODEL_DEFAULTS.altitudeMode,
                rotation: { ...MODEL_DEFAULTS.rotation, ...options.rotation },
                scaling: { ...MODEL_DEFAULTS.scaling, ...options.scaling },
                enabled: options.enabled ?? MODEL_DEFAULTS.enabled,
                gravity: options.gravity ?? MODEL_DEFAULTS.gravity,
                loaded: false,
                elevationResolved: false,
                animationNames: [],
            };
            models.set(id, entry);
            return toHandle(entry);
        },
        get(id: string) {
            const model = models.get(id);
            return model ? toHandle(model) : null;
        },
        update(id: string, partial: ModelUpdate) {
            if (disposed) throw new Error("ModelManager has been disposed");
            const current = models.get(id);
            if (!current) throw new Error(`id "${id}" not found`);
            const next: ModelHandle = {
                ...current,
                lat: partial.lat ?? current.lat,
                lon: partial.lon ?? current.lon,
                altitude: partial.altitude ?? current.altitude,
                altitudeMode: partial.altitudeMode ?? current.altitudeMode,
                rotation: partial.rotation
                    ? { ...current.rotation, ...partial.rotation }
                    : current.rotation,
                scaling: partial.scaling
                    ? { ...current.scaling, ...partial.scaling }
                    : current.scaling,
                enabled: partial.enabled ?? current.enabled,
                gravity: partial.gravity ?? current.gravity,
            };
            assertLatLonInBounds(
                next.lat,
                next.lon,
                "JpmapTerrain.updateModel",
            );
            models.set(id, next);
            return toHandle(next);
        },
        remove: (id: string): void => {
            models.delete(id);
        },
        setEnabled: (id: string, enabled: boolean): void => {
            const model = models.get(id);
            if (model) models.set(id, { ...model, enabled });
        },
        list: (): readonly string[] => [...models.keys()],
        playAnimation: (): void => {
            /* no-op */
        },
        stopAnimation: (): void => {
            /* no-op */
        },
        dispose: (): void => {
            disposed = true;
            models.clear();
        },
    };
};

vi.mock("../src/scenes/globeSceneController", () => {
    // モック内で refreshTerrain 相当の呼び出し回数を記録し、
    // テストから検証できるよう getter を export する（バッチ refresh 検証用）。
    let refreshCallCount = 0;
    // setMapType / setUiVisibility の記録もテストから検証できるよう保持する。
    let lastMapType: "standard" | "photo" = "standard";
    const setMapTypeCalls: Array<"standard" | "photo"> = [];
    // viewMode の状態と setViewMode 呼び出し履歴。
    let lastViewMode: "3d" | "2d" = "3d";
    const setViewModeCalls: Array<"3d" | "2d"> = [];
    // controller.dispose の呼び出し回数も検証する。
    let controllerDisposeCount = 0;
    // onCameraInteractionEnd コールバック参照（テストから __triggerCameraInteractionEnd で疑似発火）。
    let latestOnCameraInteractionEnd: (() => void) | null = null;
    // setSunState 呼び出し履歴を保持する。
    const sunStateCalls: Array<{ dateTime: Date | null }> = [];
    // setSunShadows 呼び出し履歴を保持する。
    const sunShadowsCalls: boolean[] = [];
    // subscribeTerrainClick の登録リスナー一覧（テストから __triggerTerrainClick で疑似発火）。
    type TerrainClickEventLike = {
        readonly lat: number;
        readonly lon: number;
        readonly altitude: number;
        readonly world: {
            readonly x: number;
            readonly y: number;
            readonly z: number;
        };
        readonly pointerEvent: PointerEvent;
    };
    const terrainClickListeners: Array<(e: TerrainClickEventLike) => void> = [];
    // 頂点インタラクション API のリスナー一覧。
    type PolygonPointPointerEventLike = {
        readonly polygonId: string;
        readonly index: number;
        readonly pointerEvent: PointerEvent;
    };
    type PolygonPointDragEventLike = PolygonPointPointerEventLike & {
        readonly lat: number | null;
        readonly lon: number | null;
        readonly groundAltitude: number | null;
        readonly planeLat: number | null;
        readonly planeLon: number | null;
        readonly pointerAltitude: number | null;
    };
    const polygonPointHoverListeners: Array<
        (e: PolygonPointPointerEventLike | null) => void
    > = [];
    const polygonPointClickListeners: Array<
        (e: PolygonPointPointerEventLike) => void
    > = [];
    const polygonPointDragStartListeners: Array<
        (e: PolygonPointDragEventLike) => void
    > = [];
    const polygonPointDragListeners: Array<
        (e: PolygonPointDragEventLike) => void
    > = [];
    const polygonPointDragEndListeners: Array<
        (e: PolygonPointDragEventLike) => void
    > = [];
    const subscribeStub = <T>(arr: T[], listener: T): (() => void) => {
        arr.push(listener);
        let removed = false;
        return (): void => {
            if (removed) return;
            removed = true;
            const idx = arr.indexOf(listener);
            if (idx !== -1) arr.splice(idx, 1);
        };
    };
    // scene.onBeforeRenderObservable のテスト用簡易実装。
    // jpmapTerrain.ts は `add(callback)` の戻り値を `Observer` として保持し、
    // dispose 時に `remove(observer)` する。テストからは `__triggerSceneRender` で
    // 全 observer を疑似発火させる。
    type SceneObserver = { callback: () => void };
    const sceneObservables: Array<{
        observers: SceneObserver[];
        add: (cb: () => void) => SceneObserver;
        remove: (obs: SceneObserver) => boolean;
    }> = [];
    const createSceneObservable = (): {
        add: (cb: () => void) => SceneObserver;
        addOnce: (cb: () => void) => SceneObserver;
        remove: (obs: SceneObserver) => boolean;
    } => {
        const observers: SceneObserver[] = [];
        const obs = {
            observers,
            add: (cb: () => void): SceneObserver => {
                const o: SceneObserver = { callback: cb };
                observers.push(o);
                return o;
            },
            addOnce: (cb: () => void): SceneObserver => {
                const wrapper = (): void => {
                    cb();
                    obs.remove(o);
                };
                const o: SceneObserver = { callback: wrapper };
                observers.push(o);
                return o;
            },
            remove: (target: SceneObserver): boolean => {
                const idx = observers.indexOf(target);
                if (idx === -1) return false;
                observers.splice(idx, 1);
                return true;
            },
        };
        sceneObservables.push(obs);
        return obs;
    };
    const triggerSceneRender = (): void => {
        for (const obs of sceneObservables) {
            // iterate 中の add/remove 安全のため slice
            for (const o of obs.observers.slice()) {
                o.callback();
            }
        }
    };
    type UiTarget =
        | "compass"
        | "zoomButtons"
        | "locateMe"
        | "scaleBar"
        | "mapToggle"
        | "viewModeButton"
        | "attribution";
    const uiVisibility: Record<UiTarget, boolean> = {
        compass: true,
        zoomButtons: true,
        locateMe: true,
        scaleBar: true,
        mapToggle: true,
        viewModeButton: true,
        attribution: true,
    };
    type ViewValues = {
        lat?: number;
        lon?: number;
        altitude?: number;
        azimuth?: number;
        tilt?: number;
    };
    class GlobeSceneAdapter {
        createScene = vi.fn(
            async (
                _engine: unknown,
                _canvas: unknown,
                opts?: {
                    lat?: number;
                    lon?: number;
                    altitude?: number;
                    azimuth?: number;
                    tilt?: number;
                    mapType?: "standard" | "photo";
                    onMapTypeChange?: (mapType: "standard" | "photo") => void;
                    viewMode?: "3d" | "2d";
                    onViewModeChange?: (viewMode: "3d" | "2d") => void;
                    onCameraInteractionEnd?: () => void;
                    onReady?: (controller: unknown) => void;
                },
            ) => {
                // pointerup 後のスナップショット無効化テスト用
                latestOnCameraInteractionEnd =
                    opts?.onCameraInteractionEnd ?? null;
                // コントローラのインメモリ実装をテスト用に提供する。
                let lat = opts?.lat ?? 0;
                let lon = opts?.lon ?? 0;
                let altitude = opts?.altitude ?? 0;
                let azimuth = opts?.azimuth ?? 0;
                let tilt = opts?.tilt ?? 0;
                if (opts?.mapType) lastMapType = opts.mapType;
                if (opts?.viewMode) lastViewMode = opts.viewMode;
                let savedTilt = tilt;
                const refresh = (): void => {
                    refreshCallCount++;
                };
                const applyView = (
                    values: ViewValues,
                    shouldRefresh: boolean,
                ): void => {
                    let centerChanged = false;
                    if (values.lat !== undefined) {
                        lat = values.lat;
                        centerChanged = true;
                    }
                    if (values.lon !== undefined) {
                        lon = values.lon;
                        centerChanged = true;
                    }
                    if (values.altitude !== undefined)
                        altitude = values.altitude;
                    if (values.azimuth !== undefined) azimuth = values.azimuth;
                    if (values.tilt !== undefined) {
                        // 2D 中は tilt を反映しない（復帰時の値だけ更新）
                        if (lastViewMode === "3d") {
                            tilt = values.tilt;
                            savedTilt = values.tilt;
                        } else {
                            savedTilt = values.tilt;
                        }
                    }
                    if (shouldRefresh && centerChanged) refresh();
                };
                opts?.onReady?.({
                    getLat: () => lat,
                    getLon: () => lon,
                    getAltitude: () => altitude,
                    getAzimuth: () => azimuth,
                    getTilt: () => (lastViewMode === "2d" ? 0 : tilt),
                    getZoomLevel: () =>
                        lastViewMode === "2d" ? 14.0 : undefined,
                    setLat: (v: number) => applyView({ lat: v }, true),
                    setLon: (v: number) => applyView({ lon: v }, true),
                    setAltitude: (v: number) =>
                        applyView({ altitude: v }, true),
                    setAzimuth: (v: number) => applyView({ azimuth: v }, true),
                    setTilt: (v: number) => applyView({ tilt: v }, true),
                    setView: (
                        values: ViewValues,
                        options?: { refreshTerrain?: boolean },
                    ) => applyView(values, options?.refreshTerrain ?? true),
                    getMapType: () => lastMapType,
                    setMapType: (value: "standard" | "photo") => {
                        const prev = lastMapType;
                        lastMapType = value;
                        setMapTypeCalls.push(value);
                        if (prev !== value) {
                            opts?.onMapTypeChange?.(value);
                        }
                    },
                    getViewMode: () => lastViewMode,
                    setViewMode: (value: "3d" | "2d") => {
                        const prev = lastViewMode;
                        if (prev === value) return;
                        if (value === "2d") {
                            savedTilt = tilt;
                            tilt = 0;
                        } else {
                            tilt = savedTilt;
                        }
                        lastViewMode = value;
                        setViewModeCalls.push(value);
                        opts?.onViewModeChange?.(value);
                    },
                    setUiVisibility: (target: UiTarget, visible: boolean) => {
                        uiVisibility[target] = visible;
                    },
                    setSunState: (_dateTime: Date | null) => {
                        // テスト用: 受信を記録するだけで Babylon 描画は伴わない
                        sunStateCalls.push({ dateTime: _dateTime });
                    },
                    setSunShadows: (enabled: boolean) => {
                        sunShadowsCalls.push(enabled);
                    },
                    getMarkerManager: createMarkerManagerStub,
                    getPolygonManager: createPolygonManagerStub,
                    getCircleManager: createCircleManagerStub,
                    getModelManager: createModelManagerStub,
                    subscribeTerrainClick: (
                        listener: (e: TerrainClickEventLike) => void,
                    ) => {
                        terrainClickListeners.push(listener);
                        let removed = false;
                        return (): void => {
                            if (removed) return;
                            removed = true;
                            const idx = terrainClickListeners.indexOf(listener);
                            if (idx !== -1)
                                terrainClickListeners.splice(idx, 1);
                        };
                    },
                    subscribePolygonPointHover: (
                        listener: (
                            e: PolygonPointPointerEventLike | null,
                        ) => void,
                    ) => subscribeStub(polygonPointHoverListeners, listener),
                    subscribePolygonPointClick: (
                        listener: (e: PolygonPointPointerEventLike) => void,
                    ) => subscribeStub(polygonPointClickListeners, listener),
                    subscribePolygonPointDragStart: (
                        listener: (e: PolygonPointDragEventLike) => void,
                    ) =>
                        subscribeStub(polygonPointDragStartListeners, listener),
                    subscribePolygonPointDrag: (
                        listener: (e: PolygonPointDragEventLike) => void,
                    ) => subscribeStub(polygonPointDragListeners, listener),
                    subscribePolygonPointDragEnd: (
                        listener: (e: PolygonPointDragEventLike) => void,
                    ) => subscribeStub(polygonPointDragEndListeners, listener),
                    dispose: () => {
                        controllerDisposeCount++;
                    },
                });
                return {
                    render: vi.fn(),
                    dispose: vi.fn(),
                    onBeforeRenderObservable: createSceneObservable(),
                    onAfterRenderObservable: createSceneObservable(),
                };
            },
        );
    }
    return {
        GlobeSceneAdapter,
        __getRefreshCount: (): number => refreshCallCount,
        __resetRefreshCount: (): void => {
            refreshCallCount = 0;
        },
        __getUiVisibility: (): Record<UiTarget, boolean> => ({
            ...uiVisibility,
        }),
        __resetUiVisibility: (): void => {
            uiVisibility.compass = true;
            uiVisibility.zoomButtons = true;
            uiVisibility.locateMe = true;
            uiVisibility.scaleBar = true;
            uiVisibility.mapToggle = true;
            uiVisibility.viewModeButton = true;
            uiVisibility.attribution = true;
        },
        __getSetMapTypeCalls: (): Array<"standard" | "photo"> => [
            ...setMapTypeCalls,
        ],
        __resetSetMapTypeCalls: (): void => {
            setMapTypeCalls.length = 0;
        },
        __getLastMapType: (): "standard" | "photo" => lastMapType,
        __setLastMapType: (v: "standard" | "photo"): void => {
            lastMapType = v;
        },
        __getSetViewModeCalls: (): Array<"3d" | "2d"> => [...setViewModeCalls],
        __resetSetViewModeCalls: (): void => {
            setViewModeCalls.length = 0;
        },
        __getLastViewMode: (): "3d" | "2d" => lastViewMode,
        __setLastViewMode: (v: "3d" | "2d"): void => {
            lastViewMode = v;
        },
        __getControllerDisposeCount: (): number => controllerDisposeCount,
        __resetControllerDisposeCount: (): void => {
            controllerDisposeCount = 0;
        },
        __getSunStateCalls: (): Array<{ dateTime: Date | null }> => [
            ...sunStateCalls,
        ],
        __resetSunStateCalls: (): void => {
            sunStateCalls.length = 0;
        },
        __getSunShadowsCalls: (): boolean[] => [...sunShadowsCalls],
        __resetSunShadowsCalls: (): void => {
            sunShadowsCalls.length = 0;
        },
        __triggerSceneRender: (): void => triggerSceneRender(),
        __triggerCameraInteractionEnd: (): void => {
            latestOnCameraInteractionEnd?.();
        },
        __getTerrainClickListenerCount: (): number =>
            terrainClickListeners.length,
        __triggerTerrainClick: (event: TerrainClickEventLike): void => {
            for (const listener of terrainClickListeners.slice()) {
                listener(event);
            }
        },
        __resetTerrainClickListeners: (): void => {
            terrainClickListeners.length = 0;
        },
        __triggerPolygonPointHover: (
            event: PolygonPointPointerEventLike | null,
        ): void => {
            for (const l of polygonPointHoverListeners.slice()) l(event);
        },
        __triggerPolygonPointClick: (
            event: PolygonPointPointerEventLike,
        ): void => {
            for (const l of polygonPointClickListeners.slice()) l(event);
        },
        __triggerPolygonPointDragStart: (
            event: PolygonPointDragEventLike,
        ): void => {
            for (const l of polygonPointDragStartListeners.slice()) l(event);
        },
        __triggerPolygonPointDrag: (event: PolygonPointDragEventLike): void => {
            for (const l of polygonPointDragListeners.slice()) l(event);
        },
        __triggerPolygonPointDragEnd: (
            event: PolygonPointDragEventLike,
        ): void => {
            for (const l of polygonPointDragEndListeners.slice()) l(event);
        },
        __resetPolygonPointListeners: (): void => {
            polygonPointHoverListeners.length = 0;
            polygonPointClickListeners.length = 0;
            polygonPointDragStartListeners.length = 0;
            polygonPointDragListeners.length = 0;
            polygonPointDragEndListeners.length = 0;
        },
    };
});

// `vi.mock` はファイル先頭へ自動 hoist されるが、上記ファクトリが参照する
// `createEngineMock` はここまでの const 宣言で初期化されるため、
// 対象モジュールはここで動的 import する。
const { JpmapTerrain } = await import("../src/lib/jpmapTerrain");

type UiTarget =
    | "compass"
    | "zoomButtons"
    | "locateMe"
    | "scaleBar"
    | "mapToggle"
    | "viewModeButton"
    | "attribution";
const sceneMockModule = (await import(
    "../src/scenes/globeSceneController"
)) as unknown as {
    __getRefreshCount: () => number;
    __resetRefreshCount: () => void;
    __getUiVisibility: () => Record<UiTarget, boolean>;
    __resetUiVisibility: () => void;
    __getSetMapTypeCalls: () => Array<"standard" | "photo">;
    __resetSetMapTypeCalls: () => void;
    __getLastMapType: () => "standard" | "photo";
    __setLastMapType: (v: "standard" | "photo") => void;
    __getSetViewModeCalls: () => Array<"3d" | "2d">;
    __resetSetViewModeCalls: () => void;
    __getLastViewMode: () => "3d" | "2d";
    __setLastViewMode: (v: "3d" | "2d") => void;
    __getControllerDisposeCount: () => number;
    __resetControllerDisposeCount: () => void;
    __getSunStateCalls: () => Array<{ dateTime: Date | null }>;
    __resetSunStateCalls: () => void;
    __getSunShadowsCalls: () => boolean[];
    __resetSunShadowsCalls: () => void;
    __triggerSceneRender: () => void;
    __triggerCameraInteractionEnd: () => void;
    __getTerrainClickListenerCount: () => number;
    __triggerTerrainClick: (event: {
        lat: number;
        lon: number;
        altitude: number;
        world: { x: number; y: number; z: number };
        pointerEvent: PointerEvent;
    }) => void;
    __resetTerrainClickListeners: () => void;
    __triggerPolygonPointHover: (
        event: {
            polygonId: string;
            index: number;
            pointerEvent: PointerEvent;
        } | null,
    ) => void;
    __triggerPolygonPointClick: (event: {
        polygonId: string;
        index: number;
        pointerEvent: PointerEvent;
    }) => void;
    __triggerPolygonPointDragStart: (event: {
        polygonId: string;
        index: number;
        pointerEvent: PointerEvent;
        lat: number | null;
        lon: number | null;
        groundAltitude: number | null;
        planeLat: number | null;
        planeLon: number | null;
        pointerAltitude: number | null;
    }) => void;
    __triggerPolygonPointDrag: (event: {
        polygonId: string;
        index: number;
        pointerEvent: PointerEvent;
        lat: number | null;
        lon: number | null;
        groundAltitude: number | null;
        planeLat: number | null;
        planeLon: number | null;
        pointerAltitude: number | null;
    }) => void;
    __triggerPolygonPointDragEnd: (event: {
        polygonId: string;
        index: number;
        pointerEvent: PointerEvent;
        lat: number | null;
        lon: number | null;
        groundAltitude: number | null;
        planeLat: number | null;
        planeLon: number | null;
        pointerAltitude: number | null;
    }) => void;
    __resetPolygonPointListeners: () => void;
};

describe("JpmapTerrain (skeleton)", () => {
    const createMountElement = (): HTMLElement => document.createElement("div");

    // 生成したビューアを記録し、テスト終了時にまとめて dispose してリスナー残留を防ぐ。
    type Viewer = Awaited<ReturnType<typeof JpmapTerrain.create>>;
    const createdViewers: Viewer[] = [];
    const create: typeof JpmapTerrain.create = async (mount, opts) => {
        // 本スイートは globe の `scenes/globeSceneController` をモックしている。
        // 既定が globe のためそのまま globe 経路を通る。
        const viewer = await JpmapTerrain.create(mount, {
            ...opts,
        });
        createdViewers.push(viewer);
        return viewer;
    };
    afterEach(() => {
        while (createdViewers.length > 0) {
            const viewer = createdViewers.pop();
            try {
                viewer?.dispose();
            } catch {
                /* dispose の副作用テストでは事前に呼ばれている可能性があり、無視 */
            }
        }
        // テスト間でモック内のリスナー残留が副作用にならないよう毎回クリアする。
        sceneMockModule.__resetTerrainClickListeners();
        // 頂点インタラクションのリスナーも同様にクリアする。
        sceneMockModule.__resetPolygonPointListeners();
    });

    describe("create", () => {
        it("オプション未指定時に spec/terrain-api.md §3.2 のデフォルト値が適用される", async () => {
            const viewer = await create(createMountElement());

            expect(viewer.lat).toBeCloseTo(35.681236);
            expect(viewer.lon).toBeCloseTo(139.767125);
            expect(viewer.altitude).toBe(2000);
            expect(viewer.azimuth).toBe(0);
            expect(viewer.tilt).toBe(45);
            expect(viewer.mapType).toBe("standard");
        });

        it("UI 表示フラグはデフォルトで全て true", async () => {
            const viewer = await create(createMountElement());

            expect(viewer.showCompass).toBe(true);
            expect(viewer.showZoomButtons).toBe(true);
            expect(viewer.showScaleBar).toBe(true);
            expect(viewer.showMapToggle).toBe(true);
            expect(viewer.showAttribution).toBe(true);
        });

        it("オプション指定値が反映される", async () => {
            const viewer = await create(createMountElement(), {
                lat: 36.2333,
                lon: 137.6167,
                altitude: 5000,
                azimuth: 90,
                tilt: 30,
                mapType: "photo",
            });

            expect(viewer.lat).toBe(36.2333);
            expect(viewer.lon).toBe(137.6167);
            expect(viewer.altitude).toBe(5000);
            expect(viewer.azimuth).toBe(90);
            expect(viewer.tilt).toBe(30);
            expect(viewer.mapType).toBe("photo");
        });

        it("mountElement が falsy の場合 TypeError を投げる", async () => {
            await expect(
                JpmapTerrain.create(null as unknown as HTMLElement),
            ).rejects.toThrow(TypeError);
        });
    });

    describe("getter / setter", () => {
        it("位置・カメラ系プロパティが set した値を保持する", async () => {
            const viewer = await create(createMountElement());

            viewer.lat = 40.0;
            viewer.lon = 140.0;
            viewer.altitude = 1234;
            viewer.azimuth = 180;
            viewer.tilt = 60;

            expect(viewer.lat).toBe(40.0);
            expect(viewer.lon).toBe(140.0);
            expect(viewer.altitude).toBe(1234);
            expect(viewer.azimuth).toBe(180);
            expect(viewer.tilt).toBe(60);
        });

        it("UI 表示フラグが set した値を保持する", async () => {
            const viewer = await create(createMountElement());

            viewer.showCompass = false;
            viewer.showZoomButtons = false;
            viewer.showScaleBar = false;
            viewer.showMapToggle = false;
            viewer.showAttribution = false;

            expect(viewer.showCompass).toBe(false);
            expect(viewer.showZoomButtons).toBe(false);
            expect(viewer.showScaleBar).toBe(false);
            expect(viewer.showMapToggle).toBe(false);
            expect(viewer.showAttribution).toBe(false);
        });

        it("mapType が set した値を保持する", async () => {
            const viewer = await create(createMountElement());

            viewer.mapType = "photo";
            expect(viewer.mapType).toBe("photo");

            viewer.mapType = "standard";
            expect(viewer.mapType).toBe("standard");
        });
    });

    describe("flyTo", () => {
        it("lat / lon を必ず更新する", async () => {
            const viewer = await create(createMountElement());

            await viewer.flyTo({ lat: 35.3606, lon: 138.7274 });

            expect(viewer.lat).toBe(35.3606);
            expect(viewer.lon).toBe(138.7274);
        });

        it("省略可能パラメータが渡された場合のみ更新する", async () => {
            const viewer = await create(createMountElement(), {
                altitude: 1000,
                azimuth: 10,
                tilt: 20,
            });

            await viewer.flyTo({ lat: 0, lon: 0, altitude: 9999 });

            expect(viewer.altitude).toBe(9999);
            expect(viewer.azimuth).toBe(10);
            expect(viewer.tilt).toBe(20);
        });

        it("altitude / azimuth / tilt が省略された場合は現在値を維持する", async () => {
            const viewer = await create(createMountElement(), {
                altitude: 3000,
                azimuth: 45,
                tilt: 50,
            });

            await viewer.flyTo({ lat: 1, lon: 2 });

            expect(viewer.altitude).toBe(3000);
            expect(viewer.azimuth).toBe(45);
            expect(viewer.tilt).toBe(50);
        });
    });

    describe("lifecycle stubs", () => {
        it("dispose / resize 呼び出しは例外を投げない", async () => {
            const viewer = await create(createMountElement());

            expect(() => viewer.resize()).not.toThrow();
            expect(() => viewer.dispose()).not.toThrow();
        });
    });

    describe("mount canvas", () => {
        it("create 時に mountElement 配下へ canvas が追加される", async () => {
            const mount = createMountElement();
            await create(mount);

            const canvases = mount.querySelectorAll("canvas");
            expect(canvases.length).toBe(1);
        });

        it("dispose 時に canvas が mountElement から取り除かれる", async () => {
            const mount = createMountElement();
            const viewer = await create(mount);
            expect(mount.querySelectorAll("canvas").length).toBe(1);

            viewer.dispose();

            expect(mount.querySelectorAll("canvas").length).toBe(0);
        });

        it("生成した canvas に固定 id を付与しない（複数インスタンス共存可）", async () => {
            const mount = createMountElement();
            await create(mount);

            const canvas = mount.querySelector("canvas");
            expect(canvas).not.toBeNull();
            if (canvas === null) throw new Error("unreachable");
            expect(canvas.id).toBe("");
        });

        it("canvas 上の touchmove で preventDefault される（ブラウザ既定スクロール抑止）", async () => {
            const mount = createMountElement();
            await create(mount);

            const canvas = mount.querySelector("canvas");
            expect(canvas).not.toBeNull();
            if (canvas === null) throw new Error("unreachable");
            const ev = new Event("touchmove", {
                bubbles: true,
                cancelable: true,
            });
            canvas.dispatchEvent(ev);

            expect(ev.defaultPrevented).toBe(true);
        });

        it("canvas 上の ctrl+wheel（トラックパッドのピンチ）で preventDefault される", async () => {
            const mount = createMountElement();
            await create(mount);

            const canvas = mount.querySelector("canvas");
            expect(canvas).not.toBeNull();
            if (canvas === null) throw new Error("unreachable");
            const pinch = new Event("wheel", {
                bubbles: true,
                cancelable: true,
            });
            Object.assign(pinch, { ctrlKey: true, deltaY: -10 });
            canvas.dispatchEvent(pinch);
            expect(pinch.defaultPrevented).toBe(true);

            // ctrlKey なしの通常 wheel には干渉しない（地図ズーム/スクロール用）。
            const normal = new Event("wheel", {
                bubbles: true,
                cancelable: true,
            });
            Object.assign(normal, { ctrlKey: false, deltaY: -10 });
            canvas.dispatchEvent(normal);
            expect(normal.defaultPrevented).toBe(false);
        });

        it("同一ページで複数インスタンスを共存できる", async () => {
            const mountA = createMountElement();
            const mountB = createMountElement();
            await create(mountA);
            await create(mountB);

            expect(mountA.querySelectorAll("canvas").length).toBe(1);
            expect(mountB.querySelectorAll("canvas").length).toBe(1);
        });

        it("初期化途中で例外が発生した場合 canvas を mountElement から除去する", async () => {
            const mount = createMountElement();
            createEngineMock.mockRejectedValueOnce(
                new Error("engine init failed"),
            );

            await expect(JpmapTerrain.create(mount)).rejects.toThrow(
                "engine init failed",
            );

            expect(mount.querySelectorAll("canvas").length).toBe(0);
        });
    });

    describe("camera controller wiring", () => {
        it("set した位置・カメラ系プロパティはコントローラ経由で取得しても同じ値になる", async () => {
            const viewer = await create(createMountElement(), {
                lat: 1,
                lon: 2,
                altitude: 100,
                azimuth: 10,
                tilt: 20,
            });

            viewer.lat = 35.0;
            viewer.lon = 140.0;
            viewer.altitude = 1500;
            viewer.azimuth = 90;
            viewer.tilt = 60;

            // get はコントローラから取得される
            expect(viewer.lat).toBe(35.0);
            expect(viewer.lon).toBe(140.0);
            expect(viewer.altitude).toBe(1500);
            expect(viewer.azimuth).toBe(90);
            expect(viewer.tilt).toBe(60);
        });

        it("flyTo は Promise を返し、完了時に最終値へ到達する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
                azimuth: 0,
                tilt: 30,
            });

            await viewer.flyTo({
                lat: 35.3606,
                lon: 138.7274,
                altitude: 8000,
                azimuth: 45,
                tilt: 60,
                duration: 50,
            });

            expect(viewer.lat).toBeCloseTo(35.3606);
            expect(viewer.lon).toBeCloseTo(138.7274);
            expect(viewer.altitude).toBeCloseTo(8000);
            expect(viewer.azimuth).toBeCloseTo(45);
            expect(viewer.tilt).toBeCloseTo(60);
        });

        it("duration=0 では即時に最終値が反映される", async () => {
            const viewer = await create(createMountElement());

            await viewer.flyTo({
                lat: 10,
                lon: 20,
                altitude: 3000,
                duration: 0,
            });

            expect(viewer.lat).toBe(10);
            expect(viewer.lon).toBe(20);
            expect(viewer.altitude).toBe(3000);
        });

        it("連続 flyTo では後勝ちになり、双方の Promise が解決される", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
            });

            const first = viewer.flyTo({
                lat: 50,
                lon: 50,
                altitude: 5000,
                duration: 200,
            });
            // 即座に上書き
            const second = viewer.flyTo({
                lat: 1,
                lon: 2,
                altitude: 1234,
                duration: 30,
            });

            await Promise.all([first, second]);

            // 後勝ちの second が最終値
            expect(viewer.lat).toBeCloseTo(1);
            expect(viewer.lon).toBeCloseTo(2);
            expect(viewer.altitude).toBeCloseTo(1234);
        });

        it("flyTo 中の中間フレームではタイル refresh を発火させず、最終フレームでまとめて refresh する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
            });
            // 初期化中の refresh は対象外。flyTo 開始時点でリセット。
            sceneMockModule.__resetRefreshCount();

            await viewer.flyTo({
                lat: 35,
                lon: 139,
                altitude: 2000,
                duration: 50,
            });

            // バッチ refresh 設計により、中間フレームでは refresh されず、
            // 最終フレーム（または完了相当）で 1 回のみ呼ばれる想定。
            // jsdom 上の RAF タイミングに揺れがあっても 2 回以下に収まることを保証する。
            const count = sceneMockModule.__getRefreshCount();
            expect(count).toBeGreaterThanOrEqual(1);
            expect(count).toBeLessThanOrEqual(2);
        });

        it("単体 setter（lat/lon）はその都度 refresh を発火する", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetRefreshCount();

            viewer.lat = 35;
            viewer.lon = 139;

            // lat/lon それぞれで 1 回ずつ。
            expect(sceneMockModule.__getRefreshCount()).toBe(2);
        });

        it("altitude/azimuth/tilt の単体 setter は refresh を発火しない", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetRefreshCount();

            viewer.altitude = 5000;
            viewer.azimuth = 90;
            viewer.tilt = 45;

            expect(sceneMockModule.__getRefreshCount()).toBe(0);
        });
    });

    describe("UI visibility / mapType", () => {
        beforeEach(() => {
            sceneMockModule.__resetUiVisibility();
            sceneMockModule.__resetSetMapTypeCalls();
            sceneMockModule.__setLastMapType("standard");
        });

        it("create 直後は controller に各 UI の初期表示状態（既定すべて true）が反映される", async () => {
            await create(createMountElement());
            expect(sceneMockModule.__getUiVisibility()).toEqual({
                compass: true,
                zoomButtons: true,
                locateMe: true,
                scaleBar: true,
                mapToggle: true,
                viewModeButton: true,
                attribution: true,
            });
        });

        it("showXxx setter は対応する UI の表示状態を controller に反映する", async () => {
            const viewer = await create(createMountElement());

            viewer.showCompass = false;
            viewer.showZoomButtons = false;
            viewer.showLocateMe = false;
            viewer.showScaleBar = false;
            viewer.showMapToggle = false;
            viewer.showViewModeButton = false;
            viewer.showAttribution = false;

            expect(sceneMockModule.__getUiVisibility()).toEqual({
                compass: false,
                zoomButtons: false,
                locateMe: false,
                scaleBar: false,
                mapToggle: false,
                viewModeButton: false,
                attribution: false,
            });

            // get は内部状態を返す
            expect(viewer.showCompass).toBe(false);
            expect(viewer.showZoomButtons).toBe(false);
            expect(viewer.showScaleBar).toBe(false);
            expect(viewer.showMapToggle).toBe(false);
            expect(viewer.showViewModeButton).toBe(false);
            expect(viewer.showAttribution).toBe(false);

            viewer.showCompass = true;
            expect(sceneMockModule.__getUiVisibility().compass).toBe(true);
            expect(viewer.showCompass).toBe(true);
        });

        it("create に mapType を渡すと controller 経由で getter が返す値も反映される", async () => {
            // モック内 lastMapType は createScene の opts.mapType で初期化される。
            const viewer = await create(createMountElement(), {
                mapType: "photo",
            });
            expect(viewer.mapType).toBe("photo");
        });

        it("mapType setter は controller.setMapType を呼び、getter にも反映される", async () => {
            const viewer = await create(createMountElement());
            expect(viewer.mapType).toBe("standard");

            viewer.mapType = "photo";

            expect(sceneMockModule.__getSetMapTypeCalls()).toEqual(["photo"]);
            expect(viewer.mapType).toBe("photo");

            viewer.mapType = "standard";
            expect(sceneMockModule.__getSetMapTypeCalls()).toEqual([
                "photo",
                "standard",
            ]);
            expect(viewer.mapType).toBe("standard");
        });
    });

    describe("dispose / resize", () => {
        it("ResizeObserver の通知で engine.resize が呼ばれる", async () => {
            await create(createMountElement());
            const resize = lastEngineResize;
            // 初期化時の resize 呼び出しはまだ無い（runRenderLoop と resize 紐付けは window.resize と RO トリガ経由）。
            expect(resize).toHaveBeenCalledTimes(0);

            triggerResizeObservers();

            expect(resize).toHaveBeenCalledTimes(1);
        });

        it("dispose 後は ResizeObserver / window.resize の通知でも engine.resize が呼ばれない", async () => {
            const viewer = await create(createMountElement());
            const resize = lastEngineResize;
            viewer.dispose();

            triggerResizeObservers();
            window.dispatchEvent(new Event("resize"));

            expect(resize).toHaveBeenCalledTimes(0);
        });

        it("dispose は冪等で、複数回呼んでも例外にならず engine.dispose は 1 回だけ呼ばれる", async () => {
            const viewer = await create(createMountElement());
            engineDispose.mockClear();

            viewer.dispose();
            viewer.dispose();
            viewer.dispose();

            expect(engineDispose).toHaveBeenCalledTimes(1);
        });

        it("dispose 後に同一 mountElement で再 create しても例外にならず canvas が再配置される", async () => {
            const mount = createMountElement();
            const first = await create(mount);
            first.dispose();

            // dispose 後は canvas が外れている
            expect(mount.querySelectorAll("canvas").length).toBe(0);

            const second = await create(mount);

            expect(mount.querySelectorAll("canvas").length).toBe(1);
            // 再度 dispose しても問題ない
            expect(() => second.dispose()).not.toThrow();
            expect(mount.querySelectorAll("canvas").length).toBe(0);
        });

        it("resize() を明示的に呼ぶと engine.resize が呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const resize = lastEngineResize;

            viewer.resize();

            expect(resize).toHaveBeenCalledTimes(1);
        });

        it("dispose で controller.dispose が 1 回呼ばれる（UI 残留対策）", async () => {
            sceneMockModule.__resetControllerDisposeCount();
            const viewer = await create(createMountElement());

            viewer.dispose();
            // 冪等呼び出しでは増えない
            viewer.dispose();

            expect(sceneMockModule.__getControllerDisposeCount()).toBe(1);
        });
    });

    describe("public API surface", () => {
        it("JpmapTerrain.create は JpmapTerrain インスタンスを返す", async () => {
            const viewer = await create(createMountElement());
            expect(viewer).toBeInstanceOf(JpmapTerrain);
        });

        it("create に engine オプションを渡すと engineFactory に伝播する", async () => {
            createEngineMock.mockClear();
            await create(createMountElement(), { engine: "webgl2" });
            expect(createEngineMock).toHaveBeenCalledTimes(1);
            // createBabylonEngine(canvas, preferredEngine, options) のシグネチャ
            const callArgs = createEngineMock.mock.calls[0];
            expect(callArgs[1]).toBe("webgl2");
            // globe 経路では high precision matrix が必須。
            expect(callArgs[2]).toEqual({ highPrecisionMatrix: true });
        });

        it("engine 未指定時はデフォルト (webgpu) で engineFactory を呼ぶ", async () => {
            createEngineMock.mockClear();
            await create(createMountElement());
            expect(createEngineMock.mock.calls[0][1]).toBe("webgpu");
        });

        it("dispose 後の getter は最後に保持していた値を返す（コントローラ非経由）", async () => {
            const viewer = await create(createMountElement(), {
                lat: 35,
                lon: 139,
                altitude: 1500,
                azimuth: 30,
                tilt: 60,
                mapType: "photo",
            });
            viewer.dispose();

            // controller が解放された後はキャッシュ値を返す
            expect(viewer.lat).toBe(35);
            expect(viewer.lon).toBe(139);
            expect(viewer.altitude).toBe(1500);
            expect(viewer.azimuth).toBe(30);
            expect(viewer.tilt).toBe(60);
            // mapType の getter は controller 不在で内部値を返す
            expect(viewer.mapType).toBe("photo");
        });

        it("dispose 後の setter は内部値だけ更新し例外にならない", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();

            expect(() => {
                viewer.lat = 10;
                viewer.lon = 20;
                viewer.altitude = 3000;
                viewer.azimuth = 90;
                viewer.tilt = 45;
                viewer.showCompass = false;
                viewer.mapType = "photo";
            }).not.toThrow();

            expect(viewer.lat).toBe(10);
            expect(viewer.lon).toBe(20);
            expect(viewer.altitude).toBe(3000);
            expect(viewer.mapType).toBe("photo");
            expect(viewer.showCompass).toBe(false);
        });

        it("dispose 中に進行中の flyTo はキャンセルされ Promise が resolve する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
            });

            const flying = viewer.flyTo({
                lat: 35,
                lon: 139,
                altitude: 5000,
                duration: 200,
            });
            // 即座に dispose してキャンセル
            viewer.dispose();

            await expect(flying).resolves.toBeUndefined();
        });

        it("flyTo で altitude / azimuth / tilt を省略した場合は現在値を維持する（実反映）", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 2500,
                azimuth: 45,
                tilt: 60,
            });

            await viewer.flyTo({ lat: 1, lon: 2, duration: 0 });

            expect(viewer.altitude).toBe(2500);
            expect(viewer.azimuth).toBe(45);
            expect(viewer.tilt).toBe(60);
        });
    });

    describe("onCameraChange", () => {
        it("初回登録時には即時発火しない", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();

            viewer.onCameraChange(listener);

            expect(listener).not.toHaveBeenCalled();
        });

        it("カメラ値変更後の onBeforeRender でリスナーが呼ばれる", async () => {
            const viewer = await create(createMountElement(), {
                lat: 0,
                lon: 0,
                altitude: 1000,
                azimuth: 0,
                tilt: 30,
            });
            const listener = vi.fn();
            viewer.onCameraChange(listener);

            // 1 度目の発火: 値未変更だが初回スナップショット作成のみ。
            sceneMockModule.__triggerSceneRender();
            expect(listener).not.toHaveBeenCalled();

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(1);
            const event = listener.mock.calls[0][0] as {
                lat: number;
                lon: number;
                altitude: number;
                azimuth: number;
                tilt: number;
            };
            expect(event.lat).toBe(35);
            expect(event.lon).toBe(0);
            expect(event.altitude).toBe(1000);
        });

        it("値が変化しなければ発火しない（連続 render でも 1 回のみ）", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender(); // snapshot 初期化

            viewer.lon = 140;
            sceneMockModule.__triggerSceneRender();
            sceneMockModule.__triggerSceneRender();
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("unsubscribe 後は呼ばれず、複数回呼んでも安全", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            const unsubscribe = viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender(); // snapshot 初期化

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();
            expect(listener).toHaveBeenCalledTimes(1);

            unsubscribe();
            unsubscribe(); // 多重呼び出しでも例外にならない
            viewer.lat = 36;
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("同一リスナーを複数回登録した場合は登録回数だけ呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onCameraChange(listener);
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender();

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();

            expect(listener).toHaveBeenCalledTimes(2);
        });

        it("リスナーが throw しても他リスナーへの伝播が継続する", async () => {
            const viewer = await create(createMountElement());
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});
            const failing = vi.fn(() => {
                throw new Error("listener failure");
            });
            const ok = vi.fn();
            viewer.onCameraChange(failing);
            viewer.onCameraChange(ok);
            sceneMockModule.__triggerSceneRender();

            viewer.lat = 35;
            sceneMockModule.__triggerSceneRender();

            expect(failing).toHaveBeenCalledTimes(1);
            expect(ok).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();

            errorSpy.mockRestore();
        });

        it("dispose 後の onCameraChange は no-op の unsubscribe を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();

            const listener = vi.fn();
            const unsubscribe = viewer.onCameraChange(listener);

            expect(typeof unsubscribe).toBe("function");
            expect(() => unsubscribe()).not.toThrow();
            // dispose 後は scene observer が外れているのでそもそも発火しない
            expect(listener).not.toHaveBeenCalled();
        });

        it("dispose 後はリスナーも発火しない（既登録ぶん）", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender();
            viewer.dispose();

            // dispose 済みの scene observer は除去されているため発火しない
            sceneMockModule.__triggerSceneRender();

            expect(listener).not.toHaveBeenCalled();
        });

        it("onCameraInteractionEnd 後、値が変化した次のフレームで発火する", async () => {
            const viewer = await create(createMountElement(), {
                lat: 35,
                lon: 139,
                altitude: 1000,
            });
            const listener = vi.fn();
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender(); // snapshot 初期化

            // カメラ状態を変えてリスナーを 1 回発火させる
            viewer.lat = 36;
            sceneMockModule.__triggerSceneRender();
            expect(listener).toHaveBeenCalledTimes(1);

            // onCameraInteractionEnd → スナップショット無効化
            sceneMockModule.__triggerCameraInteractionEnd();

            // 無効化直後のフレームはベースライン記録のみ（発火しない）
            sceneMockModule.__triggerSceneRender();
            expect(listener).toHaveBeenCalledTimes(1);

            // ベースライン記録後に値を変更 → 次フレームで発火
            viewer.lon = 140;
            sceneMockModule.__triggerSceneRender();
            expect(listener).toHaveBeenCalledTimes(2);
        });

        it("onCameraInteractionEnd 後、値が不変なら発火しない", async () => {
            const viewer = await create(createMountElement(), {
                lat: 35,
                lon: 139,
                altitude: 1000,
            });
            const listener = vi.fn();
            viewer.onCameraChange(listener);
            sceneMockModule.__triggerSceneRender(); // snapshot 初期化

            // onCameraInteractionEnd → スナップショット無効化
            sceneMockModule.__triggerCameraInteractionEnd();

            // 値が変わっていないので何フレーム回しても発火しない
            sceneMockModule.__triggerSceneRender(); // ベースライン記録
            sceneMockModule.__triggerSceneRender(); // 比較 → 不変
            sceneMockModule.__triggerSceneRender();

            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe("onMapTypeChange", () => {
        beforeEach(() => {
            sceneMockModule.__resetSetMapTypeCalls();
            sceneMockModule.__setLastMapType("standard");
        });

        it("初回登録時には即時発火しない", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onMapTypeChange(listener);
            expect(listener).not.toHaveBeenCalled();
        });

        it("mapType setter で値が変化したらリスナーが呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onMapTypeChange(listener);

            viewer.mapType = "photo";

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("photo");
        });

        it("同値再 set では発火しない", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onMapTypeChange(listener);

            viewer.mapType = "standard"; // 既定値と同値
            viewer.mapType = "photo";
            viewer.mapType = "photo"; // 同値再 set

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("photo");
        });

        it("unsubscribe 後は呼ばれず、複数回呼んでも安全", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            const unsubscribe = viewer.onMapTypeChange(listener);

            viewer.mapType = "photo";
            expect(listener).toHaveBeenCalledTimes(1);

            unsubscribe();
            unsubscribe(); // 多重呼び出しでも例外にならない
            viewer.mapType = "standard";

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("複数リスナーを登録すると全て呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const a = vi.fn();
            const b = vi.fn();
            viewer.onMapTypeChange(a);
            viewer.onMapTypeChange(b);

            viewer.mapType = "photo";

            expect(a).toHaveBeenCalledTimes(1);
            expect(b).toHaveBeenCalledTimes(1);
        });

        it("リスナーが throw しても他リスナーへの伝播が継続する", async () => {
            const viewer = await create(createMountElement());
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});
            const failing = vi.fn(() => {
                throw new Error("listener failure");
            });
            const ok = vi.fn();
            viewer.onMapTypeChange(failing);
            viewer.onMapTypeChange(ok);

            viewer.mapType = "photo";

            expect(failing).toHaveBeenCalledTimes(1);
            expect(ok).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();

            errorSpy.mockRestore();
        });

        it("dispose 後の onMapTypeChange は no-op の unsubscribe を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();

            const listener = vi.fn();
            const unsubscribe = viewer.onMapTypeChange(listener);

            expect(typeof unsubscribe).toBe("function");
            expect(() => unsubscribe()).not.toThrow();
            expect(listener).not.toHaveBeenCalled();
        });

        it("初期 options.mapType の反映では発火しない", async () => {
            // create 時に listener はまだ登録されていないため発火対象にはなり得ないが、
            // 念のため「初期化直後にリスナーを付け、その後の操作で初めて発火する」ことを確認する。
            const viewer = await create(createMountElement(), {
                mapType: "photo",
            });
            const listener = vi.fn();
            viewer.onMapTypeChange(listener);

            // 初期 photo に同値再 set → 発火しない
            viewer.mapType = "photo";
            expect(listener).not.toHaveBeenCalled();

            viewer.mapType = "standard";
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("standard");
        });
    });

    describe("viewMode", () => {
        beforeEach(() => {
            sceneMockModule.__resetSetViewModeCalls();
            sceneMockModule.__setLastViewMode("3d");
        });

        it("デフォルト viewMode は '3d'", async () => {
            const viewer = await create(createMountElement());
            expect(viewer.viewMode).toBe("3d");
        });

        it("options.viewMode === '2d' を渡すと初期から '2d' になる", async () => {
            const viewer = await create(createMountElement(), {
                viewMode: "2d",
            });
            expect(viewer.viewMode).toBe("2d");
        });

        it("setter で '2d' に切替後 getter が '2d' を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.viewMode = "2d";
            expect(viewer.viewMode).toBe("2d");
            viewer.viewMode = "3d";
            expect(viewer.viewMode).toBe("3d");
        });

        it("2D 中の tilt getter は 0、3D 復帰時に元 tilt が復元される", async () => {
            const viewer = await create(createMountElement(), { tilt: 45 });
            expect(viewer.tilt).toBe(45);

            viewer.viewMode = "2d";
            expect(viewer.tilt).toBe(0);

            viewer.viewMode = "3d";
            expect(viewer.tilt).toBe(45);
        });

        it("2D 中の tilt setter / flyTo({tilt}) は反映されないが lat/lon/altitude/azimuth は適用される", async () => {
            const viewer = await create(createMountElement(), { tilt: 45 });
            viewer.viewMode = "2d";

            viewer.tilt = 60;
            expect(viewer.tilt).toBe(0); // 2D は常に 0

            await viewer.flyTo({
                lat: 36.0,
                lon: 138.0,
                altitude: 3000,
                azimuth: 90,
                tilt: 30,
                duration: 0,
            });
            expect(viewer.lat).toBe(36.0);
            expect(viewer.lon).toBe(138.0);
            expect(viewer.altitude).toBe(3000);
            expect(viewer.azimuth).toBe(90);
            expect(viewer.tilt).toBe(0); // 2D 中は tilt は 0 のまま

            // 3D 復帰時に flyTo で渡された tilt 30 が復元される
            viewer.viewMode = "3d";
            expect(viewer.tilt).toBe(30);
        });

        it("onViewModeChange は値変化時のみ発火、同値 set は no-op", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            viewer.onViewModeChange(listener);

            viewer.viewMode = "3d"; // 同値
            expect(listener).not.toHaveBeenCalled();

            viewer.viewMode = "2d";
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith("2d");

            viewer.viewMode = "2d"; // 同値
            expect(listener).toHaveBeenCalledTimes(1);

            viewer.viewMode = "3d";
            expect(listener).toHaveBeenCalledTimes(2);
        });

        it("onViewModeChange unsubscribe は冪等で、解除後は呼ばれない", async () => {
            const viewer = await create(createMountElement());
            const listener = vi.fn();
            const unsubscribe = viewer.onViewModeChange(listener);
            viewer.viewMode = "2d";
            expect(listener).toHaveBeenCalledTimes(1);
            unsubscribe();
            unsubscribe(); // 多重呼び出しでも例外にならない
            viewer.viewMode = "3d";
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("リスナーが throw しても他リスナーへ伝播し console.error が記録される", async () => {
            const viewer = await create(createMountElement());
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});
            const failing = vi.fn(() => {
                throw new Error("vm listener failure");
            });
            const ok = vi.fn();
            viewer.onViewModeChange(failing);
            viewer.onViewModeChange(ok);

            viewer.viewMode = "2d";

            expect(failing).toHaveBeenCalledTimes(1);
            expect(ok).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });

        it("dispose 後の onViewModeChange は no-op の unsubscribe を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            const listener = vi.fn();
            const unsubscribe = viewer.onViewModeChange(listener);
            expect(typeof unsubscribe).toBe("function");
            expect(() => unsubscribe()).not.toThrow();
            expect(listener).not.toHaveBeenCalled();
        });

        it("CameraChangeEvent.viewMode が含まれる", async () => {
            const viewer = await create(createMountElement());
            const events: Array<{ viewMode: "3d" | "2d" }> = [];
            viewer.onCameraChange((e) => events.push({ viewMode: e.viewMode }));
            // 初回スナップショット確立
            sceneMockModule.__triggerSceneRender();
            // 2D に切替 → 次フレームで camera change 通知（tilt 変化 + viewMode 変化）
            viewer.viewMode = "2d";
            sceneMockModule.__triggerSceneRender();

            expect(events.length).toBeGreaterThan(0);
            expect(events[events.length - 1].viewMode).toBe("2d");
        });

        it("showViewModeButton=false で UI が非表示になる", async () => {
            await create(createMountElement(), {
                showViewModeButton: false,
            });
            expect(sceneMockModule.__getUiVisibility().viewModeButton).toBe(
                false,
            );
        });

        it("showViewModeButton 既定は true", async () => {
            const viewer = await create(createMountElement());
            expect(viewer.showViewModeButton).toBe(true);
            expect(sceneMockModule.__getUiVisibility().viewModeButton).toBe(
                true,
            );
        });
    });

    describe("sun position", () => {
        beforeEach(() => {
            sceneMockModule.__resetSunStateCalls();
        });

        it("固定モード（autoSunPosition=false）の初期化で options.dateTime が controller.setSunState に渡る", async () => {
            const dt = new Date("2025-06-21T03:00:00Z");
            await create(createMountElement(), {
                dateTime: dt,
                autoSunPosition: false,
            });
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBeGreaterThanOrEqual(1);
            expect(calls[0].dateTime?.getTime()).toBe(dt.getTime());
        });

        it("autoSunPosition=true で起動した場合、初期化で setSunState が現在時刻で 1 回呼ばれる", async () => {
            const before = Date.now();
            await create(createMountElement(), { autoSunPosition: true });
            const after = Date.now();
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const t = calls[0].dateTime?.getTime() ?? 0;
            expect(t).toBeGreaterThanOrEqual(before);
            expect(t).toBeLessThanOrEqual(after);
        });

        it("autoSunPosition=true 中は 60 秒経過ごとに setSunState が呼ばれる", async () => {
            vi.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: true,
                });
                sceneMockModule.__resetSunStateCalls();
                vi.advanceTimersByTime(60_000);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(1);
                vi.advanceTimersByTime(60_000);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(2);
                viewer.dispose();
                // dispose 後はタイマーが解放され、それ以上呼ばれない
                vi.advanceTimersByTime(60_000 * 5);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it("dateTime setter は固定モード中に setSunState を再呼出する", async () => {
            const viewer = await create(createMountElement(), {
                autoSunPosition: false,
            });
            sceneMockModule.__resetSunStateCalls();
            const dt = new Date("2025-12-21T03:00:00Z");
            viewer.dateTime = dt;
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBe(1);
            expect(calls[0].dateTime?.getTime()).toBe(dt.getTime());
        });

        it("autoSunPosition=true 中の dateTime setter は setSunState を呼ばない（auto 優先）", async () => {
            const viewer = await create(createMountElement(), {
                autoSunPosition: true,
            });
            sceneMockModule.__resetSunStateCalls();
            viewer.dateTime = new Date("2025-12-21T03:00:00Z");
            expect(sceneMockModule.__getSunStateCalls().length).toBe(0);
        });

        it("autoSunPosition=false→true 切替で 1 回反映され、true→false 切替で保持値が再反映される", async () => {
            const fixed = new Date("2025-06-21T03:00:00Z");
            const viewer = await create(createMountElement(), {
                dateTime: fixed,
                autoSunPosition: false,
            });
            sceneMockModule.__resetSunStateCalls();

            viewer.autoSunPosition = true;
            // auto 切替直後の即時反映 1 回
            expect(sceneMockModule.__getSunStateCalls().length).toBe(1);

            sceneMockModule.__resetSunStateCalls();
            viewer.autoSunPosition = false;
            // false 復帰時に保持していた dateTime で再反映
            const calls = sceneMockModule.__getSunStateCalls();
            expect(calls.length).toBe(1);
            expect(calls[0].dateTime?.getTime()).toBe(fixed.getTime());
        });

        it("dateTime getter は auto モード中に最後に内部反映した実時刻を返す", async () => {
            vi.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: true,
                });
                const first = viewer.dateTime;
                expect(first).toBeInstanceOf(Date);
                expect(first).not.toBeNull();
                if (first === null) throw new Error("unreachable");
                vi.advanceTimersByTime(60_000);
                const second = viewer.dateTime;
                expect(second).toBeInstanceOf(Date);
                expect(second).not.toBeNull();
                if (second === null) throw new Error("unreachable");
                expect(second.getTime()).toBeGreaterThanOrEqual(
                    first.getTime(),
                );
            } finally {
                vi.useRealTimers();
            }
        });

        it("Invalid Date を options.dateTime に渡すと console.warn のうえ null フォールバック", async () => {
            const warnSpy = vi
                .spyOn(console, "warn")
                .mockImplementation(() => undefined);
            try {
                const viewer = await create(createMountElement(), {
                    dateTime: new Date("not-a-date"),
                    autoSunPosition: false,
                });
                expect(warnSpy).toHaveBeenCalled();
                expect(viewer.dateTime).toBeNull();
                const calls = sceneMockModule.__getSunStateCalls();
                expect(calls[0].dateTime).toBeNull();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("Invalid Date を dateTime setter に渡しても例外を投げず null フォールバック", async () => {
            const viewer = await create(createMountElement(), {
                autoSunPosition: false,
            });
            const warnSpy = vi
                .spyOn(console, "warn")
                .mockImplementation(() => undefined);
            try {
                viewer.dateTime = new Date("nope");
                expect(warnSpy).toHaveBeenCalled();
                expect(viewer.dateTime).toBeNull();
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("dispose 後の自動更新タイマーは停止しており setSunState は呼ばれない", async () => {
            vi.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: true,
                });
                viewer.dispose();
                sceneMockModule.__resetSunStateCalls();
                vi.advanceTimersByTime(60_000 * 10);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it("dispose 後の autoSunPosition setter / dateTime setter はタイマーを再起動しない（リーク防止）", async () => {
            vi.useFakeTimers();
            try {
                const viewer = await create(createMountElement(), {
                    autoSunPosition: false,
                });
                viewer.dispose();
                sceneMockModule.__resetSunStateCalls();
                // dispose 後に setter を呼んでも setInterval は新規起動されない
                viewer.autoSunPosition = true;
                viewer.dateTime = new Date("2025-06-21T03:00:00Z");
                vi.advanceTimersByTime(60_000 * 10);
                expect(sceneMockModule.__getSunStateCalls().length).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("sun shadows", () => {
        beforeEach(() => {
            sceneMockModule.__resetSunShadowsCalls();
        });

        it("既定値は false。初期化時に setSunShadows(true) は呼ばれない", async () => {
            const viewer = await create(createMountElement());
            expect(viewer.showSunShadows).toBe(false);
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);
        });

        it("options.showSunShadows=true で初期化すると setSunShadows(true) が 1 回呼ばれる", async () => {
            const viewer = await create(createMountElement(), {
                showSunShadows: true,
            });
            expect(viewer.showSunShadows).toBe(true);
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([true]);
        });

        it("setter で値を切り替えると controller.setSunShadows が呼ばれる", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetSunShadowsCalls();

            viewer.showSunShadows = true;
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([true]);

            viewer.showSunShadows = false;
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([
                true,
                false,
            ]);
        });

        it("同値の再 set は controller.setSunShadows を呼ばない", async () => {
            const viewer = await create(createMountElement());
            sceneMockModule.__resetSunShadowsCalls();
            viewer.showSunShadows = false; // 既定 false への再 set
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);

            viewer.showSunShadows = true;
            sceneMockModule.__resetSunShadowsCalls();
            viewer.showSunShadows = true; // 再 set
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);
        });

        it("dispose 後の setter は no-op", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            sceneMockModule.__resetSunShadowsCalls();
            viewer.showSunShadows = true;
            expect(viewer.showSunShadows).toBe(false);
            expect(sceneMockModule.__getSunShadowsCalls()).toEqual([]);
        });
    });

    describe("Polygon API", () => {
        const validPoints = [
            { lat: 35.681, lon: 139.767 },
            { lat: 35.682, lon: 139.768 },
        ];

        it("addPolygon → getPolygon / listPolygons で参照できる", async () => {
            const viewer = await create(createMountElement());
            const handle = viewer.addPolygon("p1", { points: validPoints });
            expect(handle.id).toBe("p1");
            expect(viewer.getPolygon("p1")?.id).toBe("p1");
            expect(viewer.listPolygons()).toEqual(["p1"]);
        });

        it("removePolygon で消える", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            viewer.removePolygon("p1");
            expect(viewer.getPolygon("p1")).toBeNull();
            expect(viewer.listPolygons()).toEqual([]);
        });

        it("setPolygonEnabled は存在する id に対して有効/無効を切り替えても throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            // 正常系: 登録済み id に対する切り替えは例外にならない
            expect(() => viewer.setPolygonEnabled("p1", false)).not.toThrow();
        });

        it("setVerticalsEnabled / setLabelsEnabled は存在する id に対して throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            expect(() => viewer.setVerticalsEnabled("p1", false)).not.toThrow();
            expect(() => viewer.setVerticalsEnabled("p1", true)).not.toThrow();
            expect(() => viewer.setLabelsEnabled("p1", false)).not.toThrow();
            expect(() => viewer.setLabelsEnabled("p1", true)).not.toThrow();
        });

        it("setWallsEnabled は存在する id に対して throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            expect(() => viewer.setWallsEnabled("p1", false)).not.toThrow();
            expect(() => viewer.setWallsEnabled("p1", true)).not.toThrow();
        });

        it("dispose 後の addPolygon は throw、その他 API は no-op / null / [] を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            expect(() =>
                viewer.addPolygon("p1", { points: validPoints }),
            ).toThrow();
            expect(viewer.getPolygon("p1")).toBeNull();
            expect(viewer.listPolygons()).toEqual([]);
            expect(() => viewer.removePolygon("p1")).not.toThrow();
            expect(() => viewer.setPolygonEnabled("p1", false)).not.toThrow();
            expect(() => viewer.setVerticalsEnabled("p1", false)).not.toThrow();
            expect(() => viewer.setLabelsEnabled("p1", false)).not.toThrow();
            expect(() => viewer.setWallsEnabled("p1", false)).not.toThrow();
        });
    });

    describe("Polygon point edit API", () => {
        const validPoints = [
            { lat: 35.681, lon: 139.767 },
            { lat: 35.682, lon: 139.768 },
            { lat: 35.683, lon: 139.769 },
        ];

        it("insertPolygonPoint で頂点が増える", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            const handle = viewer.insertPolygonPoint("p1", 1, {
                lat: 35.6815,
                lon: 139.7675,
            });
            expect(handle.points.length).toBe(4);
            expect(handle.points[1].lat).toBeCloseTo(35.6815);
        });

        it("removePolygonPoint で頂点が減る", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            const handle = viewer.removePolygonPoint("p1", 0);
            expect(handle.points.length).toBe(2);
        });

        it("updatePolygonPoint は partial を反映する", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", {
                points: validPoints.map((p) => ({ ...p, altitude: 0 })),
                altitudeMode: "absolute",
            });
            const handle = viewer.updatePolygonPoint("p1", 0, {
                altitude: 123,
            });
            expect(handle.points[0].altitude).toBe(123);
        });

        it("replacePolygonPoints で全置換される", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            const next = [
                { lat: 35.7, lon: 139.7 },
                { lat: 35.71, lon: 139.71 },
            ];
            const handle = viewer.replacePolygonPoints("p1", next);
            expect(handle.points.length).toBe(2);
            expect(handle.points[0].lat).toBeCloseTo(35.7);
        });

        it("未存在 id の点編集 API は throw", async () => {
            const viewer = await create(createMountElement());
            expect(() =>
                viewer.insertPolygonPoint("nope", 0, {
                    lat: 35.681,
                    lon: 139.767,
                }),
            ).toThrow();
            expect(() => viewer.removePolygonPoint("nope", 0)).toThrow();
            expect(() =>
                viewer.updatePolygonPoint("nope", 0, { lat: 35.681 }),
            ).toThrow();
            expect(() =>
                viewer.replacePolygonPoints("nope", [
                    { lat: 35.681, lon: 139.767 },
                    { lat: 35.682, lon: 139.768 },
                ]),
            ).toThrow();
        });

        it("dispose 後の点編集 API は throw", async () => {
            const viewer = await create(createMountElement());
            viewer.addPolygon("p1", { points: validPoints });
            viewer.dispose();
            expect(() =>
                viewer.insertPolygonPoint("p1", 0, {
                    lat: 35.681,
                    lon: 139.767,
                }),
            ).toThrow();
            expect(() => viewer.removePolygonPoint("p1", 0)).toThrow();
            expect(() =>
                viewer.updatePolygonPoint("p1", 0, { lat: 35.681 }),
            ).toThrow();
            expect(() =>
                viewer.replacePolygonPoints("p1", [
                    { lat: 35.681, lon: 139.767 },
                    { lat: 35.682, lon: 139.768 },
                ]),
            ).toThrow();
        });
    });

    describe("onTerrainClick", () => {
        // jsdom には PointerEvent が無いため、必要な形だけスタブする。
        const stubPointerEvent = (): PointerEvent =>
            ({ shiftKey: false, ctrlKey: false }) as unknown as PointerEvent;
        const buildEvent = (
            overrides?: Partial<{
                lat: number;
                lon: number;
                altitude: number;
                world: { x: number; y: number; z: number };
                pointerEvent: PointerEvent;
            }>,
        ): {
            lat: number;
            lon: number;
            altitude: number;
            world: { x: number; y: number; z: number };
            pointerEvent: PointerEvent;
        } => ({
            lat: 35.5,
            lon: 139.5,
            altitude: 123,
            world: { x: 1, y: 123, z: -2 },
            pointerEvent: stubPointerEvent(),
            ...overrides,
        });

        it("登録したリスナーへクリック情報が通知される", async () => {
            const viewer = await create(createMountElement());
            const received: Array<{ lat: number; altitude: number }> = [];
            viewer.onTerrainClick((e) => {
                received.push({ lat: e.lat, altitude: e.altitude });
            });
            sceneMockModule.__triggerTerrainClick(buildEvent());
            expect(received).toEqual([{ lat: 35.5, altitude: 123 }]);
        });

        it("unsubscribe 後はリスナーが呼ばれない", async () => {
            const viewer = await create(createMountElement());
            const calls: number[] = [];
            const off = viewer.onTerrainClick(() => {
                calls.push(1);
            });
            sceneMockModule.__triggerTerrainClick(buildEvent());
            off();
            sceneMockModule.__triggerTerrainClick(buildEvent());
            expect(calls.length).toBe(1);
            // 二重解除しても安全
            expect(() => off()).not.toThrow();
        });

        it("dispose 後の onTerrainClick は no-op", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            const calls: number[] = [];
            const off = viewer.onTerrainClick(() => calls.push(1));
            sceneMockModule.__triggerTerrainClick(buildEvent());
            expect(calls.length).toBe(0);
            // 戻り値の解除関数も no-op で throw しない
            expect(() => off()).not.toThrow();
        });
    });

    // ポリゴン頂点インタラクション API
    describe("onPolygonPoint*", () => {
        const stubPointerEvent = (): PointerEvent =>
            ({ shiftKey: false, ctrlKey: false }) as unknown as PointerEvent;
        const buildPointer = (
            overrides?: Partial<{ polygonId: string; index: number }>,
        ) => ({
            polygonId: "p1",
            index: 0,
            pointerEvent: stubPointerEvent(),
            ...overrides,
        });
        const buildDrag = (
            overrides?: Partial<{
                polygonId: string;
                index: number;
                lat: number | null;
                lon: number | null;
                groundAltitude: number | null;
                planeLat: number | null;
                planeLon: number | null;
                pointerAltitude: number | null;
            }>,
        ) => ({
            polygonId: "p1",
            index: 0,
            pointerEvent: stubPointerEvent(),
            lat: 35.5,
            lon: 139.5,
            groundAltitude: 100,
            planeLat: 35.5,
            planeLon: 139.5,
            pointerAltitude: 100,
            ...overrides,
        });

        it("hover リスナーが頂点情報および null（離脱）を受け取る", async () => {
            const viewer = await create(createMountElement());
            const received: Array<string | null> = [];
            viewer.onPolygonPointHover((e) => {
                received.push(e ? `${e.polygonId}#${e.index}` : null);
            });
            sceneMockModule.__triggerPolygonPointHover(
                buildPointer({ polygonId: "a", index: 2 }),
            );
            sceneMockModule.__triggerPolygonPointHover(null);
            expect(received).toEqual(["a#2", null]);
        });

        it("click リスナーが頂点クリックを受け取る", async () => {
            const viewer = await create(createMountElement());
            const ids: string[] = [];
            viewer.onPolygonPointClick((e) => {
                ids.push(`${e.polygonId}#${e.index}`);
            });
            sceneMockModule.__triggerPolygonPointClick(
                buildPointer({ polygonId: "p", index: 1 }),
            );
            expect(ids).toEqual(["p#1"]);
        });

        it("drag start/move/end のリスナーが順に呼ばれる", async () => {
            const viewer = await create(createMountElement());
            const log: string[] = [];
            viewer.onPolygonPointDragStart(() => log.push("start"));
            viewer.onPolygonPointDrag((e) =>
                log.push(`drag:${e.lat ?? "null"}`),
            );
            viewer.onPolygonPointDragEnd(() => log.push("end"));
            sceneMockModule.__triggerPolygonPointDragStart(buildDrag());
            sceneMockModule.__triggerPolygonPointDrag(buildDrag({ lat: 36 }));
            sceneMockModule.__triggerPolygonPointDrag(
                buildDrag({ lat: null, lon: null, groundAltitude: null }),
            );
            sceneMockModule.__triggerPolygonPointDragEnd(buildDrag());
            expect(log).toEqual(["start", "drag:36", "drag:null", "end"]);
        });

        it("unsubscribe 後はリスナーが呼ばれない", async () => {
            const viewer = await create(createMountElement());
            const calls: number[] = [];
            const off = viewer.onPolygonPointHover(() => calls.push(1));
            sceneMockModule.__triggerPolygonPointHover(buildPointer());
            off();
            sceneMockModule.__triggerPolygonPointHover(buildPointer());
            expect(calls.length).toBe(1);
            expect(() => off()).not.toThrow();
        });

        it("dispose 後の onPolygonPoint* は no-op", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            const calls: number[] = [];
            const offs = [
                viewer.onPolygonPointHover(() => calls.push(1)),
                viewer.onPolygonPointClick(() => calls.push(1)),
                viewer.onPolygonPointDragStart(() => calls.push(1)),
                viewer.onPolygonPointDrag(() => calls.push(1)),
                viewer.onPolygonPointDragEnd(() => calls.push(1)),
            ];
            sceneMockModule.__triggerPolygonPointHover(buildPointer());
            sceneMockModule.__triggerPolygonPointClick(buildPointer());
            sceneMockModule.__triggerPolygonPointDragStart(buildDrag());
            sceneMockModule.__triggerPolygonPointDrag(buildDrag());
            sceneMockModule.__triggerPolygonPointDragEnd(buildDrag());
            expect(calls.length).toBe(0);
            expect(() => {
                offs.forEach((o) => {
                    o();
                });
            }).not.toThrow();
        });
    });

    describe("Circle API", () => {
        const validCenter = { lat: 35.681, lon: 139.767 };

        it("addCircle → getCircle / listCircles で参照できる", async () => {
            const viewer = await create(createMountElement());
            const handle = viewer.addCircle("c1", {
                center: validCenter,
                radius: 100,
            });
            expect(handle.id).toBe("c1");
            expect(viewer.getCircle("c1")?.id).toBe("c1");
            expect(viewer.listCircles()).toEqual(["c1"]);
        });

        it("removeCircle で消える", async () => {
            const viewer = await create(createMountElement());
            viewer.addCircle("c1", { center: validCenter, radius: 100 });
            viewer.removeCircle("c1");
            expect(viewer.getCircle("c1")).toBeNull();
            expect(viewer.listCircles()).toEqual([]);
        });

        it("setCircleEnabled は登録済み id に対して throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addCircle("c1", { center: validCenter, radius: 100 });
            expect(() => viewer.setCircleEnabled("c1", false)).not.toThrow();
        });

        it("setCircle{Point,Line,Wall,Label}Enabled は登録済み id に対して throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addCircle("c1", { center: validCenter, radius: 100 });
            expect(() =>
                viewer.setCirclePointEnabled("c1", false),
            ).not.toThrow();
            expect(() =>
                viewer.setCircleLineEnabled("c1", false),
            ).not.toThrow();
            expect(() =>
                viewer.setCircleWallEnabled("c1", false),
            ).not.toThrow();
            expect(() =>
                viewer.setCircleLabelEnabled("c1", false),
            ).not.toThrow();
        });

        it("dispose 後の addCircle は throw、その他 API は no-op / null / [] を返す", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            expect(() =>
                viewer.addCircle("c1", { center: validCenter, radius: 100 }),
            ).toThrow();
            expect(() => viewer.updateCircle("c1", { radius: 200 })).toThrow();
            expect(viewer.getCircle("c1")).toBeNull();
            expect(viewer.listCircles()).toEqual([]);
            expect(() => viewer.removeCircle("c1")).not.toThrow();
            expect(() => viewer.setCircleEnabled("c1", false)).not.toThrow();
            expect(() =>
                viewer.setCirclePointEnabled("c1", false),
            ).not.toThrow();
            expect(() =>
                viewer.setCircleLineEnabled("c1", false),
            ).not.toThrow();
            expect(() =>
                viewer.setCircleWallEnabled("c1", false),
            ).not.toThrow();
            expect(() =>
                viewer.setCircleLabelEnabled("c1", false),
            ).not.toThrow();
        });

        it("updateCircle で既存円の radius を変更できる", async () => {
            const viewer = await create(createMountElement());
            viewer.addCircle("c1", { center: validCenter, radius: 100 });
            const updated = viewer.updateCircle("c1", { radius: 300 });
            expect(updated.radius).toBe(300);
            viewer.dispose();
        });
    });

    describe("Model API", () => {
        const validPos = { lat: 35.681, lon: 139.767 };
        const validOpts = { url: "test.glb", ...validPos };

        it("addModel → getModel / listModels で参照できる", async () => {
            const viewer = await create(createMountElement());
            const handle = viewer.addModel("m1", validOpts);
            expect(handle.id).toBe("m1");
            expect(viewer.getModel("m1")?.id).toBe("m1");
            expect(viewer.listModels()).toEqual(["m1"]);
        });

        it("removeModel で消える", async () => {
            const viewer = await create(createMountElement());
            viewer.addModel("m1", validOpts);
            viewer.removeModel("m1");
            expect(viewer.getModel("m1")).toBeNull();
            expect(viewer.listModels()).toEqual([]);
        });

        it("updateModel で位置を変更できる", async () => {
            const viewer = await create(createMountElement());
            viewer.addModel("m1", validOpts);
            const updated = viewer.updateModel("m1", { lat: 35.0 });
            expect(updated.lat).toBe(35.0);
        });

        it("setModelEnabled は登録済み id に対して throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addModel("m1", validOpts);
            expect(() => viewer.setModelEnabled("m1", false)).not.toThrow();
        });

        it("playModelAnimation / stopModelAnimation は throw しない", async () => {
            const viewer = await create(createMountElement());
            viewer.addModel("m1", validOpts);
            expect(() => viewer.playModelAnimation("m1")).not.toThrow();
            expect(() => viewer.stopModelAnimation("m1")).not.toThrow();
        });

        it("dispose 後の addModel / updateModel は throw、その他は no-op / null / []", async () => {
            const viewer = await create(createMountElement());
            viewer.dispose();
            expect(() => viewer.addModel("m1", validOpts)).toThrow();
            expect(() => viewer.updateModel("m1", { lat: 35.0 })).toThrow();
            expect(viewer.getModel("m1")).toBeNull();
            expect(viewer.listModels()).toEqual([]);
            expect(() => viewer.removeModel("m1")).not.toThrow();
            expect(() => viewer.setModelEnabled("m1", false)).not.toThrow();
            expect(() => viewer.playModelAnimation("m1")).not.toThrow();
            expect(() => viewer.stopModelAnimation("m1")).not.toThrow();
        });
    });
});
