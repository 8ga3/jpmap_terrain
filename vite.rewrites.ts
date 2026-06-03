import type { Connect, Plugin } from "vite";

/**
 * SPA fallback ルーティング定義 (Issue #157 / #298)。
 *
 * webpack-dev-server の `historyApiFallback.rewrites`（旧 `webpack.rewrites.js`）を
 * Vite の `configureServer` ミドルウェアへ移植したもの。dev (`vite.config.ts`) と
 * E2E テスト (`vite.tests.config.ts`) で同一の定義を共有し、両者の乖離を防ぐ。
 *
 * デモ識別子付きパス（/viewer/@..., /timelapse/@...）と、`.html` 付きの
 * 旧形式 URL も許容する（パース側 `src/terrain/urlState.ts` の挙動に合わせる）。
 */
export interface DemoRewrite {
    from: RegExp;
    to: string;
}

/** rewrite 対象のデモ名一覧（portal は `/` = index.html のため対象外）。 */
const DEMO_NAMES = [
    "viewer",
    "timelapse",
    "polygon",
    "distance",
    "circle",
    "plan",
    "model",
    "avatar",
    "avatar-controller",
    "boids",
    "flight",
    "artillery",
];

export const demoAtPathRewrites: DemoRewrite[] = DEMO_NAMES.flatMap((name) => [
    { from: new RegExp(`^/${name}(?:/@.*)?/?$`), to: `/${name}.html` },
    { from: new RegExp(`^/${name}\\.html(?:/?@.*)?/?$`), to: `/${name}.html` },
]);

/**
 * `demoAtPathRewrites` を Vite dev サーバーのミドルウェアとして適用するプラグイン。
 * Vite 標準の HTML/transform ミドルウェアより前に挿入し、リクエスト URL を
 * 該当 HTML に書き換える。
 */
export function demoRewritePlugin(): Plugin {
    return {
        name: "jpmap-demo-spa-rewrite",
        configureServer(server) {
            // URL 書き換えは Vite 標準の HTML 変換・SPA fallback より「前」に
            // 実行する必要があるため、pre ミドルウェアとして登録する
            // （`return () => {}` で登録すると post になり書き換えが間に合わない）。
            server.middlewares.use((req: Connect.IncomingMessage, _res, next) => {
                if (!req.url) {
                    next();
                    return;
                }
                // クエリ・ハッシュを除いたパス部分のみを照合対象にする。
                const [pathname, rest] = splitUrl(req.url);
                const matched = demoAtPathRewrites.find((r) => r.from.test(pathname));
                if (matched) {
                    req.url = matched.to + (rest ?? "");
                }
                next();
            });
        },
    };
}

/** URL を「パス部分」と「`?`/`#` 以降」に分割する。 */
function splitUrl(url: string): [string, string | undefined] {
    const queryIdx = url.search(/[?#]/);
    if (queryIdx === -1) {
        return [url, undefined];
    }
    return [url.slice(0, queryIdx), url.slice(queryIdx)];
}
