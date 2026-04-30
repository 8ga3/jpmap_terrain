# デモ一覧とポータル仕様

`jpmap_terrain` の開発デモは複数のエントリポイントを持ち、`/`（ポータル）から各デモへ遷移できます。
本ドキュメントはデモポータルの方針・URL 規約・新規デモの追加手順をまとめます。

## デモ一覧（2026-04 時点）

| デモ | URL | エントリ | 説明 |
|---|---|---|---|
| デモポータル | `/` （`index.html`） | `src/demos/portal/index.ts` | デモ一覧へのリンク集 |
| 3D 地形ビューア | `/viewer.html` | `src/demos/viewer/index.ts` | 既存の 3D 地形可視化（`/@lat,lon` URL ・カメラ・地図種別連動） |
| タイムラプス | `/timelapse.html` | `src/demos/timelapse/index.ts` | 24 時間を 1 分に圧縮した太陽位置・陰影アニメ＋アナログ時計オーバーレイ |
| ポリゴン | `/polygon.html` | `src/demos/polygon/index.ts` | `JpmapTerrain` のポリゴン公開 API（terrain / absolute / closed の 3 種・点編集 API）の動作確認 |
| 距離計測 | `/distance.html` | `src/demos/distance/index.ts` | 地形クリックで頂点を追加し、辺ごとに水平距離・高低差を表示する。`onTerrainClick` (#183) / `onPolygonPoint*` (#184) / `edgeLabels` (#185) の統合動作確認デモ (#186) |

## 設計方針

- **公開ライブラリ層 (`src/lib/**`) は変更しない**。デモ層 (`src/demos/**`) は `JpmapTerrain` の公開 API 経由で機能を組み立てる。
- 各デモは独立した webpack エントリ。`webpack.common.js` の `ENTRY_DEFINITIONS` に追加すれば自動で HTML が生成される。
- デモ間で共通する Babylon.js 部分は `splitChunks` の `babylonBundle` / `webgpuShaders` / `webglShaders` 等に分割され、複数デモで共有される。
- ポータルは Babylon.js を読み込まない軽量ページ。バンドルサイズ最小化のため `JpmapTerrain` を import しない。

## URL 規約

### 共通

- `?engine=webgpu|webgl|webgl2`: 描画エンジン指定（`webgl` は `webgl2` に正規化、未指定は自動）。

### viewer (`/viewer.html`)

- `/@<lat>,<lon>[,<altitude>,<azimuth>,<tilt>]` のパス形式でカメラ初期値を指定可能。
- `?mapType=standard|photo`、`?dateTime=<ISO8601>`、`?autoSunPosition=true|false`、`?showSunShadows=true|false`。
- 詳細は [README.md](../README.md) の「URL フォーマット」節を参照。

### timelapse (`/timelapse.html`)

| パラメータ | 型 | 既定値 | 説明 |
|---|---|---|---|
| `start` | ISO 8601 | 当日 0 時 UTC | シミュレーション開始時刻（UTC として扱う） |
| `speed` | 数値（秒） | `60` | 24 時間ぶんを実時間で何秒に圧縮するか。0 以下/非数値は 60 にフォールバック |
| `paused` | （無値）/ `true` | `false` | 一時停止（テスト用）。`paused=false` または `paused=0` は走行 |
| `showSunShadows` | `true` / `false` | `true` | 太陽影描画。`false` で OFF（描画負荷軽減） |
| `engine` / カメラ系 | viewer と同じ | — | `parseCameraStateFromUrl` を共用 |

実装上、タイムラプス側では `autoSunPosition` を強制 OFF にし、`viewer.dateTime` を `requestAnimationFrame` ループで更新します（`UPDATE_INTERVAL_MS = 200ms` で setter 連打を抑制）。アナログ時計と時刻ラベルは画面下部中央に縦積みで配置し、表示は日本標準時（JST = UTC+9）を使用します。

## 新規デモの追加手順

1. `src/demos/<name>/index.ts` を新規作成し、エントリ起動コードを実装する。
   - DOM のマウントポイント `#root` を取得。
   - 必要なら `JpmapTerrain.create(mount, opts)` を呼び出す。
   - `process.env.NODE_ENV !== "production"` のときは `window.scene` / `window.viewer` を露出する（Playwright 互換）。
2. `public/<name>.html` を新規作成（`#root` 要素を含む）。
3. `webpack.common.js` の `ENTRY_DEFINITIONS` に追記する：
   ```js
   {
     name: "<name>",
     entry: "src/demos/<name>/index.ts",
     template: "public/<name>.html",
     filename: "<name>.html",
     title: "jpmap_terrain – <表示名>",
   }
   ```
4. `src/demos/portal/index.ts` の `DEMO_LIST` に項目を追加する。
5. `npm run build:dev` で `dist/<name>.html` が生成されることを確認。
6. ユニットテストを `tests/<name>.unit.spec.ts` に追加する（純粋関数を分離して書きやすくする）。
7. 必要であれば Playwright VR テストを `tests/validation.spec.ts` に追加する（決定論化が必要：`?paused=true&start=...`）。

## 互換性メモ

- 既存の VR スナップショット（`tests/validation.spec.ts-snapshots/`）は viewer の URL 変更（`/?scene=default` → `/viewer.html?scene=default`）後も同一の描画結果のため流用可能。
- `splitChunks.cacheGroups` は変更していないため、バンドル分割の方針は従来どおり。
