/**
 * jpmap-terrain 公開型定義
 *
 * spec/package.md §3 (Initial Implementation) に対応する型を提供する。
 */

/** 描画エンジン種別 */
export type EngineType = "webgpu" | "webgl2";

/** 地図種類 */
export type MapType = "standard" | "photo";

/**
 * `JpmapTerrain.create` 初期化オプション。
 * すべて任意指定で、未指定時は spec/package.md §3.2 のデフォルト値が適用される。
 */
export interface JpmapTerrainOptions {
    /** 描画エンジン。WebGPU 非対応時は自動で WebGL2 にフォールバックする */
    engine?: EngineType;
    /** 緯度（度） */
    lat?: number;
    /** 経度（度） */
    lon?: number;
    /** 高度（メートル） */
    altitude?: number;
    /** カメラ方位角（度） */
    azimuth?: number;
    /** カメラチルト角（度） */
    tilt?: number;
    /** 地図種類 */
    mapType?: MapType;
    /**
     * 太陽位置計算に使う日時（UTC として扱う）。
     * 未指定 / `null` の場合は内部の決定的フォールバック（{@link SUN_FALLBACK_DATETIME_ISO}）を使用する。
     * `Invalid Date` が渡された場合は `console.warn` のうえ `null` 同等に倒す（例外は投げない）。
     */
    dateTime?: Date | null;
    /**
     * `true`: 60 秒周期で実時刻に追従して内部更新する。
     * `false`（既定）: `dateTime` を固定値として使用する。
     */
    autoSunPosition?: boolean;
}

/**
 * `JpmapTerrain.flyTo` のオプション。
 * `lat` / `lon` は必須、その他は省略時に現在値を維持する。
 */
export interface FlyToOptions {
    /** 目的地の緯度（度） */
    lat: number;
    /** 目的地の経度（度） */
    lon: number;
    /** 目的地の高度（メートル） */
    altitude?: number;
    /** 目的地の方位角（度） */
    azimuth?: number;
    /** 目的地のチルト角（度） */
    tilt?: number;
    /** 遷移時間（ミリ秒） */
    duration?: number;
}

/**
 * spec/package.md §3.2 で定義されるデフォルト初期値（パッケージ内部用）。
 * 公開 API には含めず、`JpmapTerrain` 内部からのみ参照する。
 */
export const JPMAP_TERRAIN_DEFAULTS = {
    engine: "webgpu" as EngineType,
    lat: 35.681236,
    lon: 139.767125,
    altitude: 2000,
    azimuth: 0,
    tilt: 45,
    mapType: "standard" as MapType,
    dateTime: null as Date | null,
    autoSunPosition: false as boolean,
} as const;

/**
 * `dateTime` 未指定 / `null` 時に使用する決定的フォールバック時刻（ISO 8601 + Z）。
 *
 * 夏至日本時間正午（UTC 03:00）。Skybox / ライト / 太陽メッシュが落ち着いた絵を作るため、
 * Visual Regression テストでも同じ値をクエリで明示し、機械実行時刻に依存しない描画を保証する。
 */
export const SUN_FALLBACK_DATETIME_ISO = "2025-06-21T03:00:00Z";

/**
 * `autoSunPosition === true` のとき、`new Date()` を取り直して太陽位置を再反映する周期 (ms)。
 * spec/package.md §3.3.5 に基づく 60 秒固定。テスト用に export している。
 */
export const SUN_AUTO_UPDATE_INTERVAL_MS = 60_000;

/**
 * カメラ変化通知ペイロード（spec/package.md 追記は別 Issue）。
 * `JpmapTerrain.onCameraChange` のリスナー引数。
 */
export interface CameraChangeEvent {
    readonly lat: number;
    readonly lon: number;
    readonly altitude: number;
    readonly azimuth: number;
    readonly tilt: number;
}

/** `JpmapTerrain.onCameraChange` リスナー */
export type CameraChangeListener = (event: CameraChangeEvent) => void;
