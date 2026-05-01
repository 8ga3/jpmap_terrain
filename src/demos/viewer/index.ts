/**
 * 開発用デモエントリ (T9 / Issue #123, #136)
 *
 * パッケージ公開 API である `JpmapTerrain` を直接利用してデモを起動する。
 * - URL 形式: `/@lat,lon[,altitude,azimuth,tilt]?engine=webgpu|webgl|webgl2`
 *   （`webgl`/`webgl2` は `webgl2` に正規化、既定: 自動。altitude/azimuth/tilt は省略可、Issue #64）
 * - `#root` 要素にビューアをマウントする。
 * - URL ↔ カメラ同期はパッケージ層から切り離し、デモ層 (本ファイル) で
 *   `parseCameraStateFromUrl` で初期値を解決し、`onCameraChange` で URL を更新する。
 *
 * Playwright (tests/validation.spec.ts) と既存の手動デバッグ手段を保つため、
 * NODE_ENV !== "production" のときだけ `window.scene` / `window.viewer` /
 * `window.showToast` を露出する。これらは公開 API ではない。
 */
import { JpmapTerrain } from "../../lib/jpmapTerrain";
import type { EngineType, JpmapTerrainOptions } from "../../lib/types";
import { showToast } from "../../terrain/controlPanel";
import {
    parseCameraStateFromUrl,
    createUrlUpdater,
    parseMapTypeFromUrl,
    updateMapTypeInUrl,
    parseViewModeFromUrl,
    updateViewModeInUrl,
    type CameraUrlState,
} from "../../terrain/urlState";

const DEMO_MOUNT_ID = "root";

/**
 * `?engine=` クエリ文字列から描画エンジン種別を解決する。
 * - `webgpu` → `"webgpu"`
 * - `webgl` / `webgl2` → `"webgl2"`（旧表記との互換のため正規化）
 * - 上記以外 / 未指定 → `undefined`（自動判定にフォールバック）
 *
 * @param search `location.search` 等のクエリ文字列（先頭 `?` 任意）
 */
export const resolveEngine = (search: string): EngineType | undefined => {
    const value = new URLSearchParams(search).get("engine");
    if (value === "webgpu") return "webgpu";
    if (value === "webgl" || value === "webgl2") return "webgl2";
    return undefined;
};

/**
 * URL からカメラ状態（緯度経度＋altitude/azimuth/tilt）を解決する (Issue #64)。
 * 内部的に {@link parseCameraStateFromUrl} を再利用する薄いラッパー。
 *
 * @param url 解析対象 URL（`location.href` 等）
 * @returns 取得できた場合は `CameraUrlState`、取得できない場合は `undefined`
 */
export const resolveCameraState = (
    url: string,
): CameraUrlState | undefined => parseCameraStateFromUrl(url) ?? undefined;

/**
 * URL から初期表示の緯度経度を解決する。
 * @deprecated Issue #64 以降は {@link resolveCameraState} を利用すること。
 */
export const resolveLatLon = (
    url: string,
): { lat: number; lon: number } | undefined => {
    const state = resolveCameraState(url);
    return state ? { lat: state.lat, lon: state.lon } : undefined;
};

/**
 * `?dateTime=` クエリ文字列から太陽位置計算用の日時を解決する (Issue #35, #143)。
 * - ISO 8601 を受け付ける。`Z` に加えてローカルタイムオフセット (`+09:00`, `-05:00` 等) も
 *   `Z` と等価に解釈する。
 * - 未指定 / パース失敗時は `undefined` を返し、デモ起動時の `opts` には含めない（既存挙動維持）。
 * - パース失敗は `console.warn` のみ。例外は投げない（silent ignore ポリシー）。
 *
 * 実装メモ: `URLSearchParams` は仕様により `+` を空白にデコードするため、
 * `+09:00` 等のオフセット表記が壊れる。これを避けるため正規表現で raw 値を抽出し、
 * `decodeURIComponent` で復元する (Issue #143)。
 *
 * @param search `location.search` 等のクエリ文字列（先頭 `?` 任意）
 */
export const resolveDateTime = (search: string): Date | undefined => {
    // 先頭 `?` 任意の仕様に合わせ、`(?:^|[?&])` で文字列先頭での `dateTime=` も許容する。
    const match = /(?:^|[?&])dateTime=([^&#]*)/.exec(search);
    if (!match) return undefined;
    // ログ汚染対策: 制御文字 (CR/LF/ESC 等) を `?` に置換し、長さも 64 文字に制限する。
    const sanitize = (value: string): string =>
        value.replace(/[\r\n\x1B\x00-\x1F\x7F]/g, "?").slice(0, 64);
    let raw: string;
    try {
        // `decodeURIComponent` は `+` をリテラルのまま残すため、`%2B09:00` 形式とも等価になる。
        raw = decodeURIComponent(match[1]);
    } catch {
        // 不正な `%` シーケンス等のデコード失敗もパース失敗として扱い、警告を出す。
        console.warn(
            `[jpmap-terrain demo] invalid dateTime param: ${sanitize(match[1])}`,
        );
        return undefined;
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
        console.warn(`[jpmap-terrain demo] invalid dateTime param: ${sanitize(raw)}`);
        return undefined;
    }
    return d;
};

/**
 * `?autoSunPosition=` クエリ文字列から太陽位置自動更新フラグを解決する (Issue #35)。
 * - `"true"` / `"false"` のみを許容し、それ以外は `undefined`（既定挙動を維持）。
 */
export const resolveAutoSunPosition = (
    search: string,
): boolean | undefined => {
    const raw = new URLSearchParams(search).get("autoSunPosition");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return undefined;
};

/**
 * `?showSunShadows=` クエリ文字列から太陽影描画フラグを解決する (Issue #39)。
 * - `"true"` / `"false"` のみを許容し、それ以外は `undefined`（既定 OFF を維持）。
 */
export const resolveShowSunShadows = (
    search: string,
): boolean | undefined => {
    const raw = new URLSearchParams(search).get("showSunShadows");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return undefined;
};

const start = async (): Promise<void> => {
    const mount = document.getElementById(DEMO_MOUNT_ID);
    if (!mount) {
        throw new Error(`#${DEMO_MOUNT_ID} mount element not found`);
    }
    const engine = resolveEngine(location.search);
    const cameraState = resolveCameraState(location.href);
    const dateTime = resolveDateTime(location.search);
    const autoSunPosition = resolveAutoSunPosition(location.search);
    const showSunShadows = resolveShowSunShadows(location.search);
    const mapType = parseMapTypeFromUrl(location.href);
    const viewMode = parseViewModeFromUrl(location.href);
    const opts: JpmapTerrainOptions = {
        ...(engine ? { engine } : {}),
        ...(cameraState ?? {}),
        ...(dateTime !== undefined ? { dateTime } : {}),
        ...(autoSunPosition !== undefined ? { autoSunPosition } : {}),
        ...(showSunShadows !== undefined ? { showSunShadows } : {}),
        ...(mapType !== null ? { mapType } : {}),
        ...(viewMode !== null ? { viewMode } : {}),
    };
    const viewer = await JpmapTerrain.create(mount, opts);

    // URL 同期: カメラ変化のたびに `/@lat,lon,altitude,azimuth,tilt` 形式へ反映する（既存クエリは保持）。
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

    // URL 同期: mapType 変化のたびに `?mapType=` を反映する (Issue #149)。
    viewer.onMapTypeChange((next) => updateMapTypeInUrl(next));
    // 起動完了直後に一度書き込み、`?mapType=Photo` のような大小混在の値を小文字に揃える。
    updateMapTypeInUrl(viewer.mapType);

    // URL 同期: viewMode 変化のたびに `?viewMode=` を反映する (Issue #193)。
    viewer.onViewModeChange((next) => updateViewModeInUrl(next));
    updateViewModeInUrl(viewer.viewMode);

    // デモ用マーカー: 東京駅・皇居・都庁 (Issue #167)
    // マーカーはカメラ距離に応じてスクリーン空間サイズが一定になるよう自動スケールされる。
    // アイコン: WebGPU の ImageBitmap デコーダは SVG を扱えないため、
    // Canvas API で「丸 + グリフ」を描画して PNG data URL に変換する。
    type IconGlyph = "letter-s" | "house" | "building";
    const buildCircleIconUrl = (glyph: IconGlyph): string => {
        const size = 64;
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        if (!ctx) return "";
        ctx.clearRect(0, 0, size, size);
        // 円本体（赤地・白縁）
        ctx.beginPath();
        ctx.arc(32, 32, 28, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = "#e53935";
        ctx.fill();
        ctx.lineJoin = "round";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();

        // グリフ（白）
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#ffffff";
        if (glyph === "letter-s") {
            // 東京駅: 丸に "S"
            ctx.font = "bold 38px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("S", 32, 34);
        } else if (glyph === "house") {
            // 皇居: 丸に家
            // 屋根 (三角)
            ctx.beginPath();
            ctx.moveTo(32, 16);
            ctx.lineTo(52, 32);
            ctx.lineTo(12, 32);
            ctx.closePath();
            ctx.fill();
            // 壁 (四角)
            ctx.fillRect(18, 32, 28, 18);
            // ドア (赤抜き)
            ctx.fillStyle = "#e53935";
            ctx.fillRect(28, 38, 8, 12);
        } else {
            // 都庁: 丸にビル (高さ違いの 3 棟)
            ctx.fillRect(14, 32, 10, 20); // 左 (低)
            ctx.fillRect(27, 22, 10, 30); // 中央 (高)
            ctx.fillRect(40, 28, 10, 24); // 右 (中)
            // 窓 (赤抜き) — 中央棟のみ
            ctx.fillStyle = "#e53935";
            ctx.fillRect(30, 26, 4, 4);
            ctx.fillRect(30, 34, 4, 4);
            ctx.fillRect(30, 42, 4, 4);
        }
        return c.toDataURL("image/png");
    };
    try {
        viewer.addMarker("tokyo-station", {
            lat: 35.681236,
            lon: 139.767125,
            icon: { url: buildCircleIconUrl("letter-s") },
            text: { value: "東京駅" },
        });
        viewer.addMarker("imperial-palace", {
            lat: 35.685175,
            lon: 139.7528,
            icon: { url: buildCircleIconUrl("house") },
            text: { value: "皇居" },
        });
        viewer.addMarker("tokyo-metropolitan-government", {
            lat: 35.6896,
            lon: 139.6917,
            icon: { url: buildCircleIconUrl("building") },
            text: { value: "東京都庁\n(新宿)" },
        });
    } catch (err) {
        console.warn("[jpmap-terrain demo] failed to add demo markers:", err);
    }

    // 開発/テストビルドでのみデバッグ用に内部状態を露出する。
    // （Playwright の `window.scene.isReady()` 等が依存しているため）
    // `__debugScene` は @internal 扱いの公式デバッグアクセサ（spec/package.md には未記載）。
    if (process.env.NODE_ENV !== "production") {
        (window as unknown as { viewer: JpmapTerrain }).viewer = viewer;
        (window as unknown as { scene: unknown }).scene = viewer.__debugScene;
        (window as unknown as { showToast: typeof showToast }).showToast = showToast;
    }
};

// テスト環境（jest）では副作用としてのデモ起動をスキップする。
// jsdom 環境でも `#root` が無ければ `start()` 内で例外になるため、明示的にガードする。
if (
    typeof document !== "undefined" &&
    document.getElementById(DEMO_MOUNT_ID) !== null
) {
    start().catch((err) => {
        console.error("[jpmap-terrain demo] failed to start:", err);
    });
}
