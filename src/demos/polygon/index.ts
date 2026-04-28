/**
 * ポリゴンデモ (Issue #170 / #171)
 *
 * `JpmapTerrain` の Polygon 公開 API（`addPolygon` / `setPolygonEnabled` /
 * `setVerticalsEnabled` / `setLabelsEnabled` / `removePolygon` / `listPolygons` /
 * `getPolygon`）を目視確認するためのデモ。
 *
 * 仕様 (#170 / #171 範囲):
 * - `altitudeMode: "terrain"` で地形に沿って表示するポリライン
 * - `altitudeMode: "absolute"` で絶対標高 (m) のポリライン
 * - `closed: true` で末尾と先頭を結んだループ
 * - 各頂点から地表へ落とす垂線と頂点ラベル（#171）
 *
 * 操作:
 * - 画面右上のボタンで各ポリゴンの enabled を ON/OFF
 * - 垂線 / ラベル の全体 ON/OFF ボタン
 *
 * 開発デモ層につき `src/lib/**` には依存型のみ依存し、内部実装は触らない。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { JpmapTerrainOptions, PolygonOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";

const DEMO_MOUNT_ID = "root";
const CONTROLS_ID = "polygon-controls-buttons";

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する（viewer デモと同規則）。
 */
const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/**
 * デモ用のポリゴン定義。
 * よみうりランド付近を中心に、地形追従・絶対標高・closed ループの 3 本を配置する。
 *
 * 頂点間隔は数百メートル（緯度 0.0018° ≒ 200m, 経度 0.0022° ≒ 200m を基本ステップ）。
 * 球体は `computeDistanceScale` によりスクリーン安定スケールで描画される（距離不変）。
 */
interface DemoPolygonDef {
    id: string;
    label: string;
    options: PolygonOptions;
}

const buildDemoPolygons = (): readonly DemoPolygonDef[] => [
    {
        id: "yomiuri-terrain",
        label: "terrain (地表+100m)",
        options: {
            // 約 400m × 400m の四角形（地形追従、地表から +100m オフセット）
            points: [
                { lat: 35.6225, lon: 139.5126, altitude: 100 },
                { lat: 35.6261, lon: 139.5126, altitude: 100 },
                { lat: 35.6261, lon: 139.5170, altitude: 100 },
                { lat: 35.6225, lon: 139.5170, altitude: 100 },
            ],
            altitudeMode: "terrain",
            labels: ["NW +100m", "NE +100m", "SE +100m", "SW +100m"],
            style: {
                pointColor: "#ff5252",
                lineColor: "#ff5252",
                pointDiameter: 18,
                lineWidth: 3,
                wallColor: "#ff5252",
                wallOpacity: 0.3,
            },
        },
    },
    {
        id: "yomiuri-absolute",
        label: "absolute (絶対標高 300m)",
        options: {
            // 約 300m サイズの三角形（絶対標高 300m）
            points: [
                { lat: 35.6234, lon: 139.5132, altitude: 300 },
                { lat: 35.6252, lon: 139.5132, altitude: 300 },
                { lat: 35.6243, lon: 139.5165, altitude: 300 },
            ],
            altitudeMode: "absolute",
            labels: ["abs A", "abs B", "abs C"],
            style: {
                pointColor: "#42a5f5",
                lineColor: "#42a5f5",
                pointDiameter: 24,
                lineWidth: 4,
                wallColor: "#42a5f5",
                wallOpacity: 0.4,
            },
        },
    },
    {
        id: "yomiuri-closed",
        label: "closed=true (ループ 500m)",
        options: {
            // 約 200m × 250m の四角形を closed=true でループ表示
            points: [
                { lat: 35.6235, lon: 139.5135, altitude: 500 },
                { lat: 35.6253, lon: 139.5135, altitude: 500 },
                { lat: 35.6253, lon: 139.5161, altitude: 500 },
                { lat: 35.6235, lon: 139.5161, altitude: 500 },
            ],
            altitudeMode: "absolute",
            closed: true,
            labels: ["P1", "P2", "P3", "P4"],
            style: {
                pointColor: "#ffca28",
                lineColor: "#ffca28",
                pointDiameter: 18,
                lineWidth: 3,
                wallColor: "#ffca28",
                wallOpacity: 0.5,
            },
        },
    },
];

/** 操作 UI（enabled トグル + 垂線/ラベル全体トグル）を構築する。 */
const buildControls = (
    container: HTMLElement,
    viewer: JpmapTerrain,
    polygons: readonly DemoPolygonDef[],
): void => {
    container.innerHTML = "";
    for (const def of polygons) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.polygonId = def.id;
        const refreshLabel = (): void => {
            const handle = viewer.getPolygon(def.id);
            const enabled = handle ? handle.enabled : false;
            btn.textContent = `${enabled ? "✔" : "✕"} ${def.label}`;
        };
        btn.addEventListener("click", () => {
            const handle = viewer.getPolygon(def.id);
            if (!handle) return;
            viewer.setPolygonEnabled(def.id, !handle.enabled);
            refreshLabel();
        });
        container.appendChild(btn);
        refreshLabel();
    }

    // 垂線/ラベルの全体トグル (Issue #171)
    const buildToggle = (
        labelOn: string,
        labelOff: string,
        initial: boolean,
        onClick: (next: boolean) => void,
    ): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        let state = initial;
        const refresh = (): void => {
            btn.textContent = state ? labelOn : labelOff;
        };
        btn.addEventListener("click", () => {
            state = !state;
            onClick(state);
            refresh();
        });
        refresh();
        return btn;
    };
    container.appendChild(
        buildToggle("✔ 垂線 ON", "✕ 垂線 OFF", true, (next) => {
            for (const def of polygons) {
                viewer.setVerticalsEnabled(def.id, next);
            }
        }),
    );
    container.appendChild(
        buildToggle("✔ ラベル ON", "✕ ラベル OFF", true, (next) => {
            for (const def of polygons) {
                viewer.setLabelsEnabled(def.id, next);
            }
        }),
    );
    // 壁 ON/OFF (Issue #172)
    container.appendChild(
        buildToggle("✔ 壁 ON", "✕ 壁 OFF", true, (next) => {
            for (const def of polygons) {
                viewer.setWallsEnabled(def.id, next);
            }
        }),
    );
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
    const polygons = buildDemoPolygons();
    for (const def of polygons) {
        try {
            viewer.addPolygon(def.id, def.options);
        } catch (err) {
            console.warn(
                `[jpmap-terrain demo] failed to add polygon "${def.id}":`,
                err,
            );
        }
    }

    const controls = document.getElementById(CONTROLS_ID);
    if (controls instanceof HTMLElement) {
        buildControls(controls, viewer, polygons);
    }

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
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
