import type { ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

/**
 * SPA fallback ルーティング定義。
 *
 * デモ識別子付きパス（/viewer/@..., /timelapse/@...）を該当 HTML へ書き換える
 * dev サーバーミドルウェア。dev (`vite.config.ts`) と E2E テスト
 * (`vite.tests.config.ts`) で同一の定義を共有し、両者の乖離を防ぐ。
 */
export interface DemoRewrite {
    from: RegExp;
    to: string;
}

/** rewrite 対象のデモ名一覧（portal は `/` = index.html のため対象外）。
 * 単一の正本として扱うため `as const` で型を `readonly` タプルにする。
 * ただし `as const` は型レベルの保護のみで、実行時の変更（`push` 等を
 * type-unsafe に呼び出した場合）までは防げない点に注意。 */
export const DEMO_NAMES = [
    "viewer",
    "timelapse",
    "polygon",
    "distance",
    "circle",
    "plan",
    "gpx",
    "model",
    "avatar",
    "avatar-controller",
    "boids",
    "flight",
    "artillery",
    "geospatial",
    "zoomloop",
    "roiorbit",
    "diorama",
] as const;

export const demoAtPathRewrites: DemoRewrite[] = DEMO_NAMES.map((name) => ({
    // `/<name>` 単体、または `/<name>/` 以降の任意のパス（`/<name>/@...` を含む）にマッチさせる。
    // `buildStaticRedirectsFile()` が生成する `/<name>/*`（任意の配下パス）と同等の振る舞いにし、
    // vite preview と静的 CDN で挙動が一致するようにする（例: `/viewer/foo` も両方で 200）。
    from: new RegExp(`^/${name}(?:/.*)?$`),
    to: `/${name}.html`,
}));

/** 生成する静的リダイレクト定義ファイル名（Netlify / Cloudflare Pages 共通書式）。 */
export const STATIC_REDIRECTS_FILENAME = "_redirects";

/**
 * Netlify / Cloudflare Pages が読む `_redirects` ファイルの内容を生成する。
 *
 * `demoAtPathRewrites` と同じ「デモ識別子付きパス → `<name>.html`」の対応を、
 * サーバーサイド実行環境を持たない静的 CDN 配信でも再現するために使う。
 * ビルド成果物（`dist/_redirects`）に含め、`vite dev`/`vite preview` と
 * 同じ URL 規約を Netlify・Cloudflare Pages 上でも成立させる。
 *
 * 各デモ名につき2行出力する。
 * - `/<name>` 単体（末尾スラッシュや `/@...` を伴わないアクセス）
 * - `/<name>/*` （`/<name>/@lat,lon,...` 等、配下のパスすべて）
 */
export const buildStaticRedirectsFile = (
    demoNames: readonly string[] = DEMO_NAMES,
): string =>
    `${demoNames
        .flatMap((name) => [
            `/${name} /${name}.html 200`,
            `/${name}/* /${name}.html 200`,
        ])
        .join("\n")}\n`;

/** リクエスト URL をデモ識別子付きパスから該当 HTML パスへ書き換える共通ハンドラ。 */
function rewriteMiddleware(
    req: Connect.IncomingMessage,
    _res: ServerResponse,
    next: Connect.NextFunction,
): void {
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
}

/**
 * `demoAtPathRewrites` を Vite の dev サーバー / preview サーバーの
 * ミドルウェアとして適用するプラグイン。
 * Vite 標準の HTML/transform ミドルウェアより前に挿入し、リクエスト URL を
 * 該当 HTML に書き換える。
 *
 * `dist/` を静的サーバーで配信する場合（`vite preview` 以外）は、ここで
 * 定義したリライトルールと同等の設定をホスティング側（Nginx/リバースプロキシ等）
 * にも用意する必要がある。
 */
export function demoRewritePlugin(): Plugin {
    return {
        name: "jpmap-demo-spa-rewrite",
        configureServer(server) {
            // URL 書き換えは Vite 標準の HTML 変換・SPA fallback より「前」に
            // 実行する必要があるため、pre ミドルウェアとして登録する
            // （`return () => {}` で登録すると post になり書き換えが間に合わない）。
            server.middlewares.use(rewriteMiddleware);
        },
        configurePreviewServer(server) {
            // `vite preview`（`dist/` のビルド成果物配信）でも dev と同じ
            // リライトを適用し、`npm run build` → `npm run preview` で
            // `/viewer` 等の短縮 URL が 404 にならないようにする。
            server.middlewares.use(rewriteMiddleware);
        },
        generateBundle() {
            // `vite build` の成果物（`dist/`）に Netlify / Cloudflare Pages 互換の
            // `_redirects` を同梱し、サーバーサイド実行環境がない静的 CDN 配信でも
            // 同じ URL 規約を成立させる（他プラットフォームは spec/demos.md 参照）。
            this.emitFile({
                type: "asset",
                fileName: STATIC_REDIRECTS_FILENAME,
                source: buildStaticRedirectsFile(),
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
