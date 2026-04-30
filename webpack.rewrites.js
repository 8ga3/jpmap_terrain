/**
 * webpack-dev-server 用 historyApiFallback.rewrites の共有定義 (Issue #157)。
 * dev (`webpack.dev.js`) と E2E テスト (`webpack.tests.js`) で同一の
 * SPA fallback ルーティングを使うために単一ソース化している。
 *
 * デモ識別子付きパス（/viewer/@..., /timelapse/@...）と、`.html` 付きの
 * 旧形式 URL も許容する（パース側 `src/terrain/urlState.ts` の挙動に合わせる）。
 */
module.exports = {
    demoAtPathRewrites: [
        { from: /^\/viewer(?:\/@.*)?\/?$/, to: '/viewer.html' },
        { from: /^\/viewer\.html(?:\/?@.*)?\/?$/, to: '/viewer.html' },
        { from: /^\/timelapse(?:\/@.*)?\/?$/, to: '/timelapse.html' },
        { from: /^\/timelapse\.html(?:\/?@.*)?\/?$/, to: '/timelapse.html' },
        { from: /^\/polygon(?:\/@.*)?\/?$/, to: '/polygon.html' },
        { from: /^\/polygon\.html(?:\/?@.*)?\/?$/, to: '/polygon.html' },
        { from: /^\/distance(?:\/@.*)?\/?$/, to: '/distance.html' },
        { from: /^\/distance\.html(?:\/?@.*)?\/?$/, to: '/distance.html' },
    ],
};
