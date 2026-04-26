const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const path = require('path');
const fs = require('fs');
const { demoAtPathRewrites } = require('./webpack.rewrites.js');

// App directory
const appDirectory = fs.realpathSync(process.cwd());

module.exports = merge(common, {
    mode: 'development',
    devtool: 'inline-source-map',
    devServer: {
        static: path.resolve(appDirectory, "public"),
        compress: true,
        hot: true,
        historyApiFallback: {
            disableDotRule: true,
            // デモ識別子付きパス（/viewer/@..., /timelapse/@...）を該当HTMLにrewrite (Issue #155)
            // Google Maps 互換のため `/<demo>/@lat,lon,...` 形式を採用。
            // rewrite 定義は dev / E2E (webpack.tests.js) で共有 (Issue #157)。
            rewrites: demoAtPathRewrites,
        },
        open: false,
        // host: '0.0.0.0', // enable to access from other devices on the network
        // https: true // enable when HTTPS is needed (like in WebXR)
    },
});