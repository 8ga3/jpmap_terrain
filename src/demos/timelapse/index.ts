/**
 * タイムラプスデモ (Issue #147)
 *
 * `JpmapTerrain` を起動し、24h を `?speed` 秒（既定 60s）に圧縮して
 * `viewer.dateTime` を毎フレーム更新する。アナログ時計 SVG オーバーレイが
 * シミュレーション時刻と同期して回転する。
 *
 * URL 規約:
 * - `?engine=webgpu|webgl|webgl2`（既存と互換）
 * - `?lat=`, `?lon=` 等のカメラ初期値（viewer デモと共通の `parseCameraStateFromUrl`）
 * - `?start=<ISO8601>`: シミュレーション開始時刻（UTC として解釈）
 * - `?speed=<秒>`: 24h を何秒に圧縮するか（0 以下は 60s にフォールバック）
 * - `?paused` または `?paused=true`: 一時停止（テスト用）
 *
 * 注意:
 * - `autoSunPosition` は強制 OFF（`dateTime` を直接駆動するため）。
 * - `showSunShadows` は既定 ON（シーンが暗くて影が出るほうがダイナミクスが伝わる）。
 *   `?showSunShadows=false` で OFF にできる。
 * - 開発デモ層につき `src/lib/**`（公開ライブラリ層）は変更しない。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { EngineType, JpmapTerrainOptions } from "../../lib/types";
import {
    parseCameraStateFromUrl,
    parseMapTypeFromUrl,
} from "../../terrain/urlState";
import { mountClock } from "./clockOverlay";
import {
    computeSimulatedDate,
    parseTimelapseQuery,
} from "./timelapseClock";

const DEMO_MOUNT_ID = "root";
const CLOCK_ELEMENT_ID = "timelapse-clock";
const CLOCK_LABEL_ID = "timelapse-clock-label";
/** `dateTime` setter 連打を抑えるためのフレーム間隔（ms） */
const UPDATE_INTERVAL_MS = 200;

/** `?engine=` 解決（viewer 側と同じ規則） */
export const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/** `?showSunShadows=false` のときのみ false を返す。それ以外は既定 true。 */
export const resolveShowSunShadows = (search: string): boolean => {
    const raw = new URLSearchParams(search).get("showSunShadows");
    return raw !== "false";
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }

    const engine = resolveEngine(location.search);
    const cameraState = parseCameraStateFromUrl(location.href) ?? undefined;
    const mapType = parseMapTypeFromUrl(location.href);
    const showSunShadows = resolveShowSunShadows(location.search);
    const timelapse = parseTimelapseQuery(location.search);

    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        ...(cameraState ?? {}),
        ...(mapType !== null ? { mapType } : {}),
        // タイムラプスでは autoSunPosition は必ず OFF（dateTime を毎フレーム駆動するため）。
        autoSunPosition: false,
        dateTime: timelapse.startUtc,
        showSunShadows,
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    // 時計オーバーレイをマウント。
    const clockSvg = document.getElementById(CLOCK_ELEMENT_ID);
    const clockLabel = document.getElementById(CLOCK_LABEL_ID);
    let clockHandle: ReturnType<typeof mountClock> | null = null;
    if (clockSvg instanceof SVGSVGElement) {
        clockHandle = mountClock(
            clockSvg,
            clockLabel instanceof HTMLElement ? clockLabel : null,
        );
        clockHandle.update(timelapse.startUtc);
    }

    // タイムラプスループ。
    const startedAt = performance.now();
    let lastApplied = -Infinity;
    let stopped = false;

    const tick = (): void => {
        if (stopped) return;
        const elapsedSec = (performance.now() - startedAt) / 1000;
        const simulated = computeSimulatedDate(elapsedSec, timelapse);
        const nowMs = performance.now();
        // setter 連打を避けるため UPDATE_INTERVAL_MS 周期に間引く。
        if (timelapse.paused) {
            // pause のときは初期値で 1 度だけ反映済み。RAF は止める。
            return;
        }
        if (nowMs - lastApplied >= UPDATE_INTERVAL_MS) {
            viewer.dateTime = simulated;
            clockHandle?.update(simulated);
            lastApplied = nowMs;
        }
        window.requestAnimationFrame(tick);
    };

    if (!timelapse.paused) {
        window.requestAnimationFrame(tick);
    }

    // ページ離脱時のクリーンアップ。
    window.addEventListener("beforeunload", () => {
        stopped = true;
    });

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する（Playwright 互換）。
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
        console.error("[jpmap-terrain timelapse demo] failed to start:", err);
    });
}
