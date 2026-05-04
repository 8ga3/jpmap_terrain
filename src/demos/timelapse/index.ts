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
    createUrlUpdater,
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

/** タイムラプスデモ固有のカメラ初期値（日の出が見えるよう真東・最大チルト）。
 *  Arc Rotate Cameraのalphaは反時計回りでターゲットに対し真北を0度としている。
 *  APIのパラメータに対して-Math.PI / 2 = -180度だけずらしてcamera.alphaに代入される
 */
const TIMELAPSE_CAMERA_DEFAULTS = {
    azimuth: 270,
    tilt: 75,
} as const;

/**
 * `@lat,lon[,altitude[,azimuth[,tilt]]]` パターン。
 * azimuth(4番目)・tilt(5番目)トークンが省略されているかを判定するために使う。
 */
const AT_PATTERN =
    /@(-?\d+\.?\d*),(-?\d+\.?\d*)(?:,(-?\d+\.?\d*))?(?:,(-?\d+\.?\d*))?(?:,(-?\d+\.?\d*))?/;

/**
 * URL からカメラ初期値を解決し、タイムラプス固有デフォルトと合成する。
 *
 * - URL にカメラ指定が無い → 空オブジェクトを返す（呼び出し側で TIMELAPSE_CAMERA_DEFAULTS が使われる）
 * - `@lat,lon` / `@lat,lon,altitude` など azimuth・tilt が省略されたURL → lat/lon/altitude のみ返す
 * - `@lat,lon,altitude,azimuth,tilt` など azimuth・tilt まで明示されたURL → 全フィールドを返す
 * - `?lat=&lon=` クエリ形式 → lat/lon/altitude のみ返す（azimuth/tilt は省略扱い）
 *
 * @testable 純粋関数として export しユニットテストで動作を固定する。
 */
export const resolveCameraInit = (
    href: string,
): Partial<JpmapTerrainOptions> => {
    const cameraState = parseCameraStateFromUrl(href);
    if (!cameraState) return {};

    try {
        const parsed = new URL(href, "http://localhost");
        const target = parsed.pathname + parsed.hash;
        const atMatch = target.match(AT_PATTERN);
        if (atMatch) {
            // azimuth・tilt が明示されている場合のみ URL 値を採用する。
            return {
                lat: cameraState.lat,
                lon: cameraState.lon,
                altitude: cameraState.altitude,
                ...(atMatch[4] !== undefined ? { azimuth: cameraState.azimuth } : {}),
                ...(atMatch[5] !== undefined ? { tilt: cameraState.tilt } : {}),
            };
        }
        // ?lat=&lon= 形式: azimuth/tilt は常にタイムラプスデフォルトに委ねる。
        return {
            lat: cameraState.lat,
            lon: cameraState.lon,
            altitude: cameraState.altitude,
        };
    } catch {
        return {};
    }
};

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
    const cameraInit = resolveCameraInit(location.href);
    const mapType = parseMapTypeFromUrl(location.href);
    const showSunShadows = resolveShowSunShadows(location.search);
    const timelapse = parseTimelapseQuery(location.search);

    const opts: JpmapTerrainOptions = {
        // タイムラプス固有のカメラデフォルト（URLで明示指定された値のみ上書きされる）。
        ...TIMELAPSE_CAMERA_DEFAULTS,
        ...(engine ? { engine } : {}),
        ...cameraInit,
        ...(mapType !== null ? { mapType } : {}),
        // タイムラプスでは autoSunPosition は必ず OFF（dateTime を毎フレーム駆動するため）。
        autoSunPosition: false,
        dateTime: timelapse.startUtc,
        showSunShadows,
    };

    const viewer = await JpmapTerrain.create(mount, opts);

    // URL 同期: カメラ変化のたびに `/<demo>@lat,lon,altitude,azimuth,tilt` 形式へ反映する (Issue #155)。
    // 既存クエリ（?engine=, ?start=, ?speed= など）は `createUrlUpdater` 内で保持される。
    const urlUpdater = createUrlUpdater(200);
    viewer.onCameraChange((event) =>
        urlUpdater({
            lat: event.lat,
            lon: event.lon,
            altitude: event.altitude,
            azimuth: event.azimuth,
            tilt: event.tilt,
        }),
    );

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
        if (nowMs - lastApplied >= UPDATE_INTERVAL_MS) {
            viewer.dateTime = simulated;
            clockHandle?.update(simulated);
            lastApplied = nowMs;
        }
        window.requestAnimationFrame(tick);
    };

    // `timelapse` は URL クエリから 1 度だけパースした不変オブジェクトなので、
    // `paused === true` の場合はそもそも RAF ループ自体を起動しない（時計は初期値で固定表示）。
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
