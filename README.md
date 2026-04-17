# jpmap_terrain

地理院タイルの標高データをもとに、Babylon.js で 3D 地形表現を構築するためのフロントエンドプロジェクトです。

## 概要

- 目的: 標高タイルを使った地形可視化の実装と検証
- 技術スタック: TypeScript / Babylon.js / Webpack / Playwright / Jest
- バージョン: 0.0.1（開発初期）

## クイックスタート

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
| `npm run lint` | ESLint 実行 |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run test:visuals` | Visual Regression Test 実行 |
| `npm run test:visuals -- --update-snapshots` | Visual テスト基準画像の更新 |
| `npm run test:unit` | ユニットテスト（Jest） |

### デバッグ

- ブラウザの開発者ツールで source map を利用してデバッグ可能
- VS Code では `Launch to integrated browser` で統合デバッグ可能
- 開発/テストビルド時は `window.scene` からシーン参照可能

## テスト

### Visual Regression Test

```shell
npm run test:visuals -- --update-snapshots
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
