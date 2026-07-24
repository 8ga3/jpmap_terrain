/**
 * WebXR セッション対応状況の判定ユーティリティ（公開API）。
 *
 * @remarks
 * `src/demos/diorama/webXrArSession.ts` の `isImmersiveArSupported`（`immersive-ar` 固定）を
 * 一般化し、`immersive-vr` も含む任意の `XRSessionMode` に対応させたもの。
 * `WebXRSessionManager.IsSessionSupportedAsync` は環境によっては（実デバイス無し等）
 * Promise がいつまでも解決しないことがあるため、一定時間で諦めて「非対応」扱いにする。
 */
import { WebXRSessionManager } from "@babylonjs/core/XR/webXRSessionManager";

/** {@link isWebXrSessionSupported} の対応判定タイムアウト既定値[ms]。 */
export const DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS = 4000;

/** `promise` が `timeoutMs` 以内に解決しなければ `onTimeout` の値へフォールバックする。 */
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> =>
    new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(onTimeout), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(onTimeout);
            },
        );
    });

/**
 * 指定した WebXR セッションモード（`"immersive-ar"` / `"immersive-vr"` 等）にブラウザ/デバイスが
 * 対応しているかを判定する。{@link DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS} 以内に応答がない場合は
 * 非対応として扱う。
 *
 * @param mode 判定対象のセッションモード。
 * @param timeoutMs 対応判定のタイムアウト[ms]。既定値: {@link DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS}。
 */
export const isWebXrSessionSupported = async (
    mode: XRSessionMode,
    timeoutMs: number = DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS,
): Promise<boolean> => {
    try {
        if (typeof navigator === "undefined" || !("xr" in navigator)) return false;
        return await withTimeout(WebXRSessionManager.IsSessionSupportedAsync(mode), timeoutMs, false);
    } catch (err) {
        console.warn("[jpmap-terrain webxr] session support check failed:", err);
        return false;
    }
};
