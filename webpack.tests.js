const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const path = require('path');
const fs = require('fs');

// App directory
const appDirectory = fs.realpathSync(process.cwd());

module.exports = merge(common, {
    mode: 'development',
    devtool: 'inline-source-map',
    devServer: {
        static: path.resolve(appDirectory, "public"),
        compress: true,
        historyApiFallback: {
            disableDotRule: true,
            // デモ識別子付きパス（/viewer/@..., /timelapse/@...）を該当HTMLにrewrite (Issue #157)
            // dev-server と同じ挙動を E2E テスト用サーバでも再現する。
            rewrites: [
                { from: /^\/viewer(?:\/@.*)?\/?$/, to: '/viewer.html' },
                { from: /^\/viewer\.html(?:\/?@.*)?\/?$/, to: '/viewer.html' },
                { from: /^\/timelapse(?:\/@.*)?\/?$/, to: '/timelapse.html' },
                { from: /^\/timelapse\.html(?:\/?@.*)?\/?$/, to: '/timelapse.html' },
            ],
        },
        webSocketServer: false
    },
});