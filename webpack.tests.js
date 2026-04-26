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
        historyApiFallback: {
            disableDotRule: true,
            // デモ識別子付きパス（/viewer/@..., /timelapse/@...）を該当HTMLにrewrite (Issue #157)。
            // dev / E2E で同一定義を共有することで両者の乖離を防ぐ。
            rewrites: demoAtPathRewrites,
        },
        webSocketServer: false
    },
});