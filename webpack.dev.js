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
        hot: true,
        historyApiFallback: {
            disableDotRule: true,
            // デモ識別子付きパス（/viewer@..., /timelapse@...）を該当HTMLにrewrite (Issue #155)
            // パース側は `.html` 付きの旧形式 URL も許容しているため、rewrite も両形式・末尾スラッシュ任意で対応する。
            rewrites: [
                { from: /^\/viewer(?:@.*)?\/?$/, to: '/viewer.html' },
                { from: /^\/viewer\.html(?:@.*)?\/?$/, to: '/viewer.html' },
                { from: /^\/timelapse(?:@.*)?\/?$/, to: '/timelapse.html' },
                { from: /^\/timelapse\.html(?:@.*)?\/?$/, to: '/timelapse.html' },
            ],
        },
        // publicPath: '/',
        open: false,
        // host: '0.0.0.0', // enable to access from other devices on the network
        // https: true // enable when HTTPS is needed (like in WebXR)
    },
});