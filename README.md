# jpmap_terrain

地理院タイルの標高データをもとに、Babylon.js で 3D 地形表現を構築するためのフロントエンドプロジェクトです。

## 概要

- 目的: 標高タイルを使った地形可視化の実装と検証
- 技術スタック: TypeScript / Babylon.js / Vite（デモ）/ tsup（ライブラリ）/ Playwright / Vitest
- バージョン: 0.3.1

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

公開 API の詳細は [`spec/terrain-api.md`](spec/terrain-api.md) を参照してください。

### JpmapDiorama（箱庭ジオラマ表示）

`JpmapDiorama` は `JpmapTerrain` とは独立した第2の公開APIで、地形を手元サイズの正方形「箱庭」として表示します。標準WebブラウザとWebXR (`immersive-ar`) セッションの双方に対応します。

```html
<div id="diorama" style="width: 800px; height: 600px;"></div>
<script type="module">
  import { JpmapDiorama } from "jpmap-terrain";

  const mount = document.getElementById("diorama");
  if (!mount) {
    throw new Error('Element with id "diorama" was not found.');
  }

  const diorama = await JpmapDiorama.create(mount, {
    center: { lat: 35.3436, lon: 138.7203 },
    footprintHalfSizeM: 800,
    tableRadiusM: 0.35,
  });

  // タイル種別を写真に切り替える
  await diorama.setTileMode("photo");

  // AR (immersive-ar) 対応環境ならセッションへ突入
  if (await diorama.isArSupported()) {
    await diorama.enterAr();
  }

  // 破棄
  diorama.dispose();
</script>
```

公開 API の詳細は [`spec/diorama-api.md`](spec/diorama-api.md) を参照してください。

## クイックスタート（デモ開発）

```shell
npm install
npm start
```

`http://localhost:8080` が自動的に開き、開発サーバーがホットリロード付きで起動します。

> Node のバージョンはリポジトリ直下の `.tool-versions` で固定しています（[asdf](https://asdf-vm.com/) 利用時は自動で切り替わります。初回のみ `asdf install` を実行してください）。`package-lock.json` の生成結果は npm のバージョンに依存するため、依存関係を更新する際は必ずこのバージョンを使用してください（詳細は [`spec/development.md`](spec/development.md) を参照）。

## デモポータル

`http://localhost:8080/`（`/index.html`）はデモ一覧ポータルになっています。各デモへは以下から個別にもアクセスできます。

| デモ | URL | 説明 |
|---|---|---|
| 3D 地形ビューア | `/viewer` | 既存の地理院タイル 3D ビューア。緯度経度・カメラ向き・地図種別を URL で指定可能。 |
| タイムラプス | `/timelapse` | 24 時間を 1 分に圧縮し、太陽位置・陰影をアニメーション表示（アナログ時計オーバーレイ付き）。 |
| ズームループ | `/zoomloop` | 指定した2地点間をカメラがクォータニオンで滑らかに往復ズームし続けるプロモーション用デモ。写真ボタン以外の画面操作は無効。 |
| 富士山頂周回 | `/roiorbit` | 富士山頂 ROI を中心にカメラが時計回りに周回し続けるプロモーション用デモ。写真ボタン以外の画面操作は無効。 |
| ポリゴン | `/polygon` | ポリゴン公開 API（terrain / absolute / closed）の動作確認。 |
| サークル | `/circle` | サークル公開 API（terrain / absolute / custom-segments）の動作確認。 |
| 距離計測 | `/distance` | 地形クリックで頂点を追加し、辺ごとに水平距離・高低差を表示。 |
| Plan Viewer | `/plan` | QGroundControl の `.plan` ファイルをドラッグ&ドロップで表示するビューア。 |
| GPX Viewer | `/gpx` | GPX (GPS eXchange Format) の `.gpx` ファイルをドラッグ&ドロップで表示するビューア。水平移動距離・標高差等の統計と標高-時間グラフを表示。 |
| 3D モデル | `/model` | 地面クリックで 3D モデルを配置・移動する Model API の動作確認。 |
| アバターアニメーション #01 | `/avatar` | 3D アバターが地形に沿って円軌道を移動するアニメーション。 |
| アバターアニメーション #02 | `/avatar-controller` | キーボード・Game Controller・Virtual Joystick でアバターを操作。 |
| Boids フロッキング | `/boids` | 分離・整列・結合による群衆シミュレーション。 |
| フライトデモ | `/flight` | 飛行機が円軌道で旋回し、Follow カメラで追跡。 |
| Artillery Game | `/artillery` | ターン制対戦ゲーム（Havok 物理で砲弾を再現）。 |
| Geospatial Globe | `/geospatial` | グローブ地形コアを直接起動する低レベル診断デモ（開発者向け）。 |
| 箱庭ジオラマ | `/diorama` | 地形を手元サイズの正方形「箱庭」として表示するWebXR (`immersive-ar`) 対応デモ。XRコントローラー/タッチHUD/キーボードで地図移動・拡大縮小・箱庭回転・高さ変更・タイル種別切替が可能。 |

各デモの詳細仕様・追加方針は [spec/demos.md](spec/demos.md) を参照してください。

## 実行モード（WebGPU / WebGL2）

`engine` クエリパラメータでエンジンを切り替えられます。

- WebGPU: `http://localhost:8080/viewer?scene=default&engine=webgpu`
- WebGL2: `http://localhost:8080/viewer?scene=default&engine=webgl2`

`webgpu` 指定時に未対応ブラウザの場合は WebGL2 にフォールバックします。

## URL フォーマット（緯度経度・エンジン・地図種類指定）

3D ビューアデモ（`src/demos/viewer/index.ts`）は、Google Maps 互換のパス形式 `/@緯度,経度` と `engine` / `mapType` クエリパラメータをサポートします。ここで説明するのは開発デモ用 URL の仕様であり、npm パッケージの公開 API（`EngineType` は `"webgpu" | "webgl2"`、`MapType` は `"standard" | "photo"`）とは別です。

### パス形式（カメラ位置）

**3D モード**

- 形式: `/@<lat>,<lon>,<altitude>,<azimuth>,<tilt>`
- `altitude`: カメラの注視点（地表点）からの距離（m）。範囲 50〜25,512,548
  - 値は **GeospatialCamera の `radius`**（注視点＝地表点からのカメラ距離）を表す。上限はカメラの最大 radius = planetRadius×4（= WGS84 長半径 × 4 ≈ 25,512,548m）に由来する。
- `azimuth`: 方位角（度）。0 = 北、時計回り正
- `tilt`: 仰角（度）。範囲 約5.7〜89（上限はカメラの upperBetaLimit ≈ 89°）
- 省略した場合は既定値（altitude=2000, azimuth=0, tilt=45）で補完されます

```
/@35.3606,138.7274,7411,0.00,45.00   ← 富士山山頂、注視点からの距離 7411m、真北向き
```

**2D モード（平行投影）**

- 2D モードでは altitude（注視点からの距離）の代わりに **Google Maps 互換のズームレベル**（`z` サフィックス付き）を使用します
- 形式: `/@<lat>,<lon>,<zoom>z`
- `zoom`: Web Mercator ズームレベル（小数 2 桁）。範囲 [5, 23]
- azimuth / tilt は 2D では固定のため URL に含みません
- ズームレベルは `canvasHeight × 156543 × cos(緯度) / (2^z × 2 × tan(fov/2))` で `camera.radius` に変換されます

```
/@35.3606,138.7274,14.50z            ← 富士山山頂、ズームレベル 14.5
```

- URL をコピーして貼り付けることで、ほぼ同等の表示を再現できます
- 2D モードでは平行投影のためカメラの altitude（注視点からの距離）は表示範囲に影響しないため、URL には含めません
- 3D モードの `/@lat,lon,altitude,...` 形式の URL を 2D モードで開いた場合、altitude はズームレベルに変換されて扱われます

**例:**

- `http://localhost:8080/viewer/@35.681236,139.767125?engine=webgpu`（東京駅・3D・WebGPU）
- `http://localhost:8080/viewer/@35.3606,138.7274?engine=webgl2`（富士山・3D・WebGL2）
- `http://localhost:8080/viewer/@35.681236,139.767125?engine=webgpu&mapType=photo`（東京駅・3D・航空写真）
- `http://localhost:8080/viewer/@35.3606,138.7274,14.50z?viewMode=2d`（富士山・2D・ズームレベル 14.5）

### `engine` パラメータ

以下は開発デモ URL の `engine` クエリパラメータに対する仕様です。

- `webgpu` / `webgl2` を指定できます
- `webgl` は URL クエリでのみ後方互換として受け付けられる別名で、内部的に `webgl2` に正規化されます
- 省略時は自動選択（WebGPU 利用可能なら WebGPU、未対応なら WebGL2 にフォールバック）
- npm パッケージの公開 API で指定できる `engine` は `"webgpu" | "webgl2"` です

### `mapType` パラメータ

- `standard`（標準地図）/ `photo`（航空写真）を指定できます（大小文字無視で受理、書き戻しは小文字）
- 省略・不正値・URL 解析失敗時は `standard` にフォールバックします
- 地図切替ボタン操作 / `viewer.mapType = ...` のいずれでも、URL のクエリ `?mapType=` が `history.replaceState` で更新されます（パス・他クエリ・ハッシュは保持）

### `viewMode` パラメータ

- `3d` / `2d` を指定できます（大小文字無視）
- 省略・不正値時は `3d` にフォールバックします
- 2D/3D 切替ボタン操作でも `?viewMode=` が更新されます

### 緯度経度の扱い

- 緯度経度は全球（緯度 -90〜90、経度 -180〜180）でクランプされます。globe（GeospatialCamera）バックエンドは地球全体を描画できるためです。
- カメラ移動に追従して URL のパスが自動更新されます（既存のクエリパラメータは保持）

### `lat` / `lon` クエリパラメータ

- パス形式 `/@<lat>,<lon>` の代わりに、`?lat=<lat>&lon=<lon>` クエリでも初期カメラ位置を指定できます
- パス形式（`/@...`）が存在する場合はそちらが優先されます
- altitude / azimuth / tilt は既定値で補完されます（クエリでは指定不可）
- 例: `http://localhost:8080/viewer?lat=35.681236&lon=139.767125`

実装の詳細は `src/demos/viewer/index.ts` および `src/terrain/urlState.ts` を参照してください。

## 開発ガイド

### エントリポイント

- デモポータル: `src/demos/portal/index.ts`
- 各デモエントリ: `src/demos/<デモ名>/index.ts`（portal を除く17デモの一覧は [デモポータル](#デモポータル) 参照）
- シーン境界契約（インターフェース）: `src/scenes/sceneContract.ts`
- グローブ地形シーン実装: `src/scenes/globe.ts`

### 主要ディレクトリ

```text
.
├─ src/                  # アプリ本体（TypeScript）
│  ├─ demos/             # 各デモエントリ（portal / viewer / timelapse 等、portal を含め全18件）
│  ├─ lib/               # 公開ライブラリ層（JpmapTerrain）
│  ├─ terrain/           # 地形・UI 実装
│  └─ scenes/            # シーン境界契約とグローブ地形シーン実装
├─ public/               # Vite のエントリ HTML（root。デモごとの *.html）
├─ assets/               # デモ用の3Dモデル・音声等の静的アセット
├─ examples/             # サンプルデータ（.plan / .gpx ファイル等）
├─ scripts/              # 開発補助スクリプト（checkNoIssueRefs 等）
├─ docker/               # デモサイト配信用 Docker 構成（docker/README.md 参照）
├─ tests/                # Playwright の Visual Regression Test と Unit テスト
├─ spec/                 # 仕様・開発フロー文書（demos.md を含む）
└─ vite.config.ts        # ビルド設定（vite.tests.config.ts / vite.rewrites.ts）
```

### 開発コマンド

| コマンド | 説明 |
| --- | --- |
| `npm start` | 開発サーバー起動（ホットリロード） |
| `npm run start:test` | Playwright 用の開発サーバー起動（`vite.tests.config.ts` 使用） |
| `npm run build:dev` | 開発ビルド（typecheck 実行後に bundle） |
| `npm run build` | 本番ビルド（typecheck 実行後に最適化 build） |
| `npm run build:lib` | ライブラリビルド（`dist/` に ESM + `.d.ts` 出力） |
| `npm run clean:lib` | ライブラリビルド成果物（`dist/`）の削除 |
| `npm run preview` | 本番ビルド成果物（`dist/`）のローカルプレビュー配信 |
| `npm run lint` | ESLint 実行（Issue番号直書きチェックを含む） |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run test:visuals` | Visual Regression Test 実行 |
| `npm run test:visuals:update` | Visual テスト基準画像の強制更新（画面表示変更時のみ） |
| `npm run test:unit` | ユニットテスト（Vitest） |

### Docker（デモサイト配信）

`docker/` に、`npm run build` の成果物 `dist/` を Nginx コンテナで配信するための Docker 構成があります。

```shell
npm run build
cd docker
docker compose up -d --build
```

`http://localhost:8080/` でデモポータルにアクセスできます。Raspberry Pi 5（arm64）での運用やデモ追加時の注意点など詳細は [docker/README.md](docker/README.md) を参照してください。

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
- Docker配信ガイド: `docker/README.md`

## ライセンス

Apache-2.0

## 参考

- Babylon.js: https://doc.babylonjs.com/
- 地理院地図: https://maps.gsi.go.jp/
- Template: https://github.com/RaananW/babylonjs-webpack-es6
