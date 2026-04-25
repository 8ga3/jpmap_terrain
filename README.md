# jpmap_terrain

地理院タイルの標高データをもとに、Babylon.js で 3D 地形表現を構築するためのフロントエンドプロジェクトです。

## 概要

- 目的: 標高タイルを使った地形可視化の実装と検証
- 技術スタック: TypeScript / Babylon.js / Webpack / Playwright / Jest
- バージョン: 0.0.1（開発初期）

## npm パッケージとしての利用

`jpmap-terrain` は ESM / `.d.ts` 同梱の npm パッケージとして配布されます（`@babylonjs/core` は `peerDependency`）。
任意の DOM 要素にマウントするだけで 3D 地形ビューアを埋め込めます。

### インストール

```shell
npm install jpmap-terrain @babylonjs/core
# 必要に応じて
npm install @babylonjs/loaders @babylonjs/materials
```

### 利用例

```html
<div id="terrain-viewer" style="width: 800px; height: 600px;"></div>
<script type="module">
  import { JpmapTerrain } from "jpmap-terrain";

  const container = document.getElementById("terrain-viewer");
  if (!container) {
    throw new Error('Element with id "terrain-viewer" was not found.');
  }

  const viewer = await JpmapTerrain.create(container, {
    engine: "webgpu",      // "webgpu" | "webgl2"
    lat: 35.681236,
    lon: 139.767125,
    altitude: 2000,
    azimuth: 0,
    tilt: 45,
    mapType: "standard",   // "standard" | "photo"
  });

  // プログラムで富士山に移動
  await viewer.flyTo({
    lat: 35.3606,
    lon: 138.7274,
    altitude: 8000,
    duration: 2000,
  });

  // UI 制御
  viewer.showCompass = false;

  // 破棄
  viewer.dispose();
</script>
```

公開 API の詳細は [`spec/package.md`](spec/package.md) を参照してください。

## クイックスタート（デモ開発）

```shell
npm install
npm start
```

`http://localhost:8080` が自動的に開き、開発サーバーがホットリロード付きで起動します。

## 実行モード（WebGPU / WebGL2）

`engine` クエリパラメータでエンジンを切り替えられます。

- WebGPU: `http://localhost:8080/?scene=default&engine=webgpu`
- WebGL2: `http://localhost:8080/?scene=default&engine=webgl2`

`webgpu` 指定時に未対応ブラウザの場合は WebGL にフォールバックします。

## 開発ガイド

### エントリポイント

- アプリ開始点: `src/index.ts`
- シーン生成インターフェース: `src/createScene.ts`
- 既定シーン実装: `src/scenes/default.ts`

### 主要ディレクトリ

```text
.
├─ src/                  # アプリ本体（TypeScript）
│  ├─ index.ts           # 起動処理とエンジン選択
│  ├─ createScene.ts     # シーン生成インターフェース
│  └─ scenes/default.ts  # デフォルトシーン
├─ tests/                # Playwright の Visual Regression Test
├─ spec/                 # 仕様・開発フロー文書
└─ webpack*.js           # ビルド設定
```

### 開発コマンド

| コマンド | 説明 |
| --- | --- |
| `npm start` | 開発サーバー起動（ホットリロード） |
| `npm run build:dev` | 開発ビルド（typecheck 実行後に bundle） |
| `npm run build` | 本番ビルド（typecheck 実行後に最適化 build） |
| `npm run build:lib` | ライブラリビルド（`dist/` に ESM + `.d.ts` 出力） |
| `npm run lint` | ESLint 実行 |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run test:visuals` | Visual Regression Test 実行 |
| `npm run test:visuals:update` | Visual テスト基準画像の強制更新（画面表示変更時のみ） |
| `npm run test:unit` | ユニットテスト（Jest） |

### デバッグ

- ブラウザの開発者ツールで source map を利用してデバッグ可能
- VS Code では `Launch to integrated browser` で統合デバッグ可能
- 開発/テストビルド時は `window.scene` からシーン参照可能

## テスト

### Visual Regression Test

通常は `npm run test:visuals` のみを実行します。
`npm run test:visuals:update` は毎回実行するものではなく、UIや描画結果に意図した変更が入ったときに、開発者が基準画像を更新するために実行します。


**UIや描画結果に意図した変更が入ったときのみ実行**

```shell
npm run test:visuals:update
```

> **Note:** Playwright 1.59+ では `--update-snapshots` のデフォルトが `missing`（不足分のみ追加）に変更されました。既存スナップショットを上書きするには `--update-snapshots=all` が必要です。`test:visuals:update` スクリプトはこのオプションを使用します。

**通常の実行**

```shell
npm run test:visuals
```

設定ファイルは `tests/validation.spec.ts` です。

### ユニットテスト

```shell
npm run test:unit
```

テストファイルは `*.unit.spec.ts` 命名で自動検出されます。

## 品質基準

このリポジトリでは、実装完了時に以下を満たすことを推奨します。

- 定義済みテストを実行し、成功していること
- `npm run lint` と `npm run typecheck` が成功すること
- 仕様整合性、型品質、変更影響をレビューで確認すること

詳細は `AGENTS.md` を参照してください。

## ドキュメント

- 機能仕様入口: `spec/README.md`
- 開発フロー: `spec/development.md`
- 運用ガイド: `AGENTS.md`

## ライセンス

Apache-2.0

## 参考

- Babylon.js: https://doc.babylonjs.com/
- 地理院地図: https://maps.gsi.go.jp/
- Template: https://github.com/RaananW/babylonjs-webpack-es6
