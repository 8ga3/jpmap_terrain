const path = require("path");
const fs = require("fs");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
// const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

// App directory
const appDirectory = fs.realpathSync(process.cwd());

/**
 * 多エントリ構成 (Issue #147)
 * - portal: `/` (デモ一覧ポータル)
 * - viewer: `/viewer.html` (既存 3D ビューアデモ)
 * - timelapse: `/timelapse.html` (24h/60s タイムラプス + アナログ時計オーバーレイ)
 */
const ENTRY_DEFINITIONS = [
    {
        name: "portal",
        entry: "src/demos/portal/index.ts",
        template: "public/portal.html",
        filename: "index.html",
        title: "jpmap_terrain – デモポータル",
    },
    {
        name: "viewer",
        entry: "src/demos/viewer/index.ts",
        template: "public/viewer.html",
        filename: "viewer.html",
        title: "jpmap_terrain – 3D地形ビューア",
    },
    {
        name: "timelapse",
        entry: "src/demos/timelapse/index.ts",
        template: "public/timelapse.html",
        filename: "timelapse.html",
        title: "jpmap_terrain – タイムラプスデモ",
    },
    {
        name: "polygon",
        entry: "src/demos/polygon/index.ts",
        template: "public/polygon.html",
        filename: "polygon.html",
        title: "jpmap_terrain – ポリゴンデモ",
    },
];

const entry = Object.fromEntries(
    ENTRY_DEFINITIONS.map((d) => [d.name, path.resolve(appDirectory, d.entry)]),
);

module.exports = {
    entry,
    output: {
        filename: "js/[name].js",
        path: path.resolve("./dist/"),
        chunkFilename: "js/[name].[contenthash].js",
        // `/viewer/@...` などのデモ識別子付きパスでリロードされた場合でも、
        // HtmlWebpackPlugin が inject する script 等を絶対パス基準で解決させる (Issue #157)。
        publicPath: "/",
    },
    resolve: {
        extensions: [".ts", ".js"],
        fallback: {
            fs: false,
            path: false, // require.resolve("path-browserify")
        },
    },
    module: {
        rules: [
            {
                test: /\.m?js/,
            },
            {
                test: /\.(js|mjs|jsx|ts|tsx)$/,
                loader: "source-map-loader",
                enforce: "pre",
            },
            {
                test: /\.tsx?$/,
                loader: "ts-loader",
                // sideEffects: true
            },
            {
                test: /\.(glsl|vs|fs)$/,
                loader: "ts-shader-loader",
                exclude: /node_modules/,
            },
            {
                test: /\.(png|jpg|gif|env|glb|gltf|stl)$/i,
                use: [
                    {
                        loader: "url-loader",
                        options: {
                            limit: 8192,
                        },
                    },
                ],
            },
        ],
    },
    plugins: [
        // new BundleAnalyzerPlugin(),
        new CleanWebpackPlugin(),
        // 各エントリ用に HTML を生成。`chunks` で対象エントリだけを inject し、
        // `splitChunks` 由来の共通チャンクは HtmlWebpackPlugin が依存解決時に自動で含める。
        ...ENTRY_DEFINITIONS.map(
            (d) =>
                new HtmlWebpackPlugin({
                    inject: true,
                    template: path.resolve(appDirectory, d.template),
                    filename: d.filename,
                    chunks: [d.name],
                    title: d.title,
                }),
        ),
    ],
    optimization: {
        splitChunks: {
            cacheGroups: {
                webgpuShaders: {
                    name: "webgpu-shaders",
                    chunks: "all",
                    priority: 50,
                    enforce: true,
                    test: (module) => /\/ShadersWGSL\//.test(module.resource),
                },
                webglShaders: {
                    name: "webgl-shaders",
                    chunks: "all",
                    priority: 50,
                    enforce: true,
                    test: (module) => /\/Shaders\//.test(module.resource),
                },
                webgpuExtensions: {
                    name: "webgpu-extensions",
                    chunks: "all",
                    priority: 50,
                    enforce: true,
                    test: (module) => /\/WebGPU\//.test(module.resource),
                },
                babylonBundle: {
                    name: "babylonBundle",
                    chunks: "all",
                    priority: 30,
                    reuseExistingChunk: true,
                    test: (module) => /\/node_modules\/@babylonjs\//.test(module.resource),
                },
            },
        },
        usedExports: true,
        minimize: process.env.NODE_ENV === "production",
    },
};
