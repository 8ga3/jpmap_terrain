/**
 * サークルデモ (Issue #201 / #206)
 *
 * `JpmapTerrain` の Circle 公開 API（`addCircle` / `updateCircle` /
 * `removeCircle` / `setCircleEnabled` / `setCirclePointEnabled` /
 * `setCircleLineEnabled` / `setCircleWallEnabled` / `setCircleLabelEnabled` /
 * `getCircle` / `listCircles`）を目視確認するためのデモ。
 *
 * 仕様:
 * - `altitudeMode: "terrain"` で地形に沿った円
 * - `altitudeMode: "absolute"` で絶対標高の円
 * - 各円の enabled / point / line / wall / label トグル
 * - `updateCircle` による半径・中心・スタイルの動的更新
 *
 * 開発デモ層につき `src/lib/**` には依存型のみ依存し、内部実装は触らない。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { CircleOptions, JpmapTerrainOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
    resolveTerrainEngine,
} from "../../terrain/urlState";

const DEMO_MOUNT_ID = "root";
const CONTROLS_ID = "circle-controls-buttons";

const resolveEngine = (search: string): "webgpu" | "webgl2" | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

interface DemoCircleDef {
    id: string;
    label: string;
    options: CircleOptions;
}

/**
 * デモ用の円定義。
 * よみうりランド付近を中心に、terrain / absolute / カスタムスタイルの 3 つを配置する。
 */
const buildDemoCircles = (): readonly DemoCircleDef[] => [
    {
        id: "yomiuri-terrain",
        label: "terrain (地表+50m, r=300m)",
        options: {
            center: { lat: 35.6242, lon: 139.5100, altitude: 50 },
            radius: 300,
            altitudeMode: "terrain",
            style: {
                pointColor: "#ff5252",
                lineColor: "#ff5252",
                lineWidth: 3,
                wallColor: "#ff5252",
                wallOpacity: 0.3,
            },
        },
    },
    {
        id: "yomiuri-absolute",
        label: "absolute (標高400m, r=200m)",
        options: {
            center: { lat: 35.6242, lon: 139.5148, altitude: 400 },
            radius: 200,
            altitudeMode: "absolute",
            style: {
                pointColor: "#42a5f5",
                lineColor: "#42a5f5",
                lineWidth: 4,
                wallColor: "#42a5f5",
                wallOpacity: 0.4,
            },
        },
    },
    {
        id: "yomiuri-custom",
        label: "custom (segments=16, r=150m)",
        options: {
            center: { lat: 35.6242, lon: 139.5200, altitude: 300 },
            radius: 150,
            segments: 16,
            altitudeMode: "absolute",
            label: "16角形\nradius=150m",
            style: {
                pointColor: "#ffca28",
                pointDiameter: 30,
                lineColor: "#ffca28",
                lineWidth: 2,
                wallColor: "#ffca28",
                wallOpacity: 0.5,
            },
        },
    },
];

/** 操作 UI を構築する。 */
const buildControls = (
    container: HTMLElement,
    viewer: JpmapTerrain,
    circles: readonly DemoCircleDef[],
): void => {
    container.innerHTML = "";

    // 各円の enabled トグル
    for (const def of circles) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.circleId = def.id;
        const refreshLabel = (): void => {
            const handle = viewer.getCircle(def.id);
            const enabled = handle ? handle.enabled : false;
            btn.textContent = `${enabled ? "✔" : "✕"} ${def.label}`;
        };
        btn.addEventListener("click", () => {
            const handle = viewer.getCircle(def.id);
            if (!handle) return;
            viewer.setCircleEnabled(def.id, !handle.enabled);
            refreshLabel();
        });
        container.appendChild(btn);
        refreshLabel();
    }

    // 全体トグルヘルパー
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
        buildToggle("✔ 中心点 ON", "✕ 中心点 OFF", true, (next) => {
            for (const def of circles) {
                viewer.setCirclePointEnabled(def.id, next);
            }
        }),
    );
    container.appendChild(
        buildToggle("✔ 円周 ON", "✕ 円周 OFF", true, (next) => {
            for (const def of circles) {
                viewer.setCircleLineEnabled(def.id, next);
            }
        }),
    );
    container.appendChild(
        buildToggle("✔ 壁 ON", "✕ 壁 OFF", true, (next) => {
            for (const def of circles) {
                viewer.setCircleWallEnabled(def.id, next);
            }
        }),
    );
    container.appendChild(
        buildToggle("✔ ラベル ON", "✕ ラベル OFF", true, (next) => {
            for (const def of circles) {
                viewer.setCircleLabelEnabled(def.id, next);
            }
        }),
    );

    // 3D / 2D 視点モード切替
    {
        const btn = document.createElement("button");
        btn.type = "button";
        const refresh = (): void => {
            btn.textContent = viewer.viewMode === "3d" ? "2D 表示" : "3D 表示";
        };
        btn.addEventListener("click", () => {
            viewer.viewMode = viewer.viewMode === "3d" ? "2d" : "3d";
        });
        viewer.onViewModeChange(() => refresh());
        refresh();
        container.appendChild(btn);
    }

    // updateCircle デモ: 半径を段階的に変更
    const editTargetId = "yomiuri-terrain";
    let radiusStep = 0;
    const radiusValues = [300, 500, 100, 300];
    const buildEditButton = (
        label: string,
        onClick: () => void,
    ): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.addEventListener("click", () => {
            try {
                onClick();
            } catch (err) {
                console.warn(
                    `[jpmap-terrain demo] circle edit "${label}" failed:`,
                    err,
                );
            }
        });
        return btn;
    };

    container.appendChild(
        buildEditButton("半径変更", () => {
            radiusStep = (radiusStep + 1) % radiusValues.length;
            viewer.updateCircle(editTargetId, {
                radius: radiusValues[radiusStep],
            });
        }),
    );

    container.appendChild(
        buildEditButton("スタイル変更", () => {
            const handle = viewer.getCircle(editTargetId);
            if (!handle) return;
            const isRed = handle.style.lineColor === "#ff5252";
            viewer.updateCircle(editTargetId, {
                style: {
                    pointColor: isRed ? "#4caf50" : "#ff5252",
                    lineColor: isRed ? "#4caf50" : "#ff5252",
                    wallColor: isRed ? "#4caf50" : "#ff5252",
                },
            });
        }),
    );

    container.appendChild(
        buildEditButton("中心移動", () => {
            const handle = viewer.getCircle(editTargetId);
            if (!handle) return;
            viewer.updateCircle(editTargetId, {
                center: {
                    lat: handle.center.lat + 0.001,
                    lon: handle.center.lon,
                    altitude: handle.center.altitude,
                },
            });
        }),
    );
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
        showViewModeButton: false,
    };

    const viewer = await JpmapTerrain.create(mount, opts);
    const circles = buildDemoCircles();
    for (const def of circles) {
        try {
            viewer.addCircle(def.id, def.options);
        } catch (err) {
            console.warn(
                `[jpmap-terrain demo] failed to add circle "${def.id}":`,
                err,
            );
        }
    }

    const controls = document.getElementById(CONTROLS_ID);
    if (controls instanceof HTMLElement) {
        buildControls(controls, viewer, circles);
    }

    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        (window as unknown as { scene: unknown }).scene = viewer.__debugScene;
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
