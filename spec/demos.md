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

### distance (`/distance.html`)

クリック / ドラッグでポリラインを編集し、頂点ごとの `lat / lon / altitude` と各辺の水平距離・高低差を実時間で表示する距離計測デモ（#186）。`onTerrainClick` (#183) / `onPolygonPoint*` (#184) / `edgeLabels` (#185) の統合動作確認を兼ねる。

**URL:** `engine` に加えて、viewer / timelapse と同様にカメラ初期位置の指定（`/@lat,lon[,...]` のパス形式、および `?lat=&lon=` 等のクエリ形式）と `?mapType=standard|photo` を受け付ける（実装上 `parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

**操作モード（右上ツールバーで排他切替）:**

| モード | 操作 | 効果 |
|---|---|---|
| `add`（既定） | 地形クリック | クリック地点に `altitude = 地表 + 100 m` の頂点を末尾追加。カーソルは矢印 + 「+」記号。 |
| `remove` | 頂点クリック | 当該頂点を削除（残点 0/1 も許容）。頂点 hover 時のみ矢印 + 「−」記号カーソル。 |
| `edit` | 頂点ドラッグ | 頂点の `lat/lon` を更新。`Shift+ドラッグ`で高度（`altitude`）を更新（地表より下にはクランプ）。頂点 hover 時のみ `move` / `ns-resize` カーソル。 |
| 「クリア」ボタン | — | 全頂点を削除する。 |

**表示:**

- 各頂点に `lat / lon / altitude(m)` をラベル表示（`labels`）。
- 各辺の中点に `水平距離(m or km) / 高低差(m, 符号付き)` をラベル表示（`edgeLabels`）。1 km 未満は `m`、それ以上は小数 2 桁の `km` で整形する。
- ポリライン本体・球体頂点・各点からの垂線・隣接垂線間の壁を全表示（壁・垂線は地表を貫通して Y=0 まで伸び、半透明壁は地形に対して深度オクルードされる #186）。

**実装メモ:**

- 水平距離は `haversineDistanceMeters`（WGS84 平均半径）で算出。浮動小数誤差で `h` が 1 を僅かに超えるケース（対蹠点付近）に備え、`h` を `[0, 1]` にクランプしてから `Math.atan2` に渡す。
- 編集モードのドラッグ時は `pointermove` ごとに `removePolygon` → `addPolygon` を行うと負荷が高いため、`requestAnimationFrame` で 1 フレーム 1 回に集約する。`dragEnd` で保留中の rAF を即時 flush し、最終位置が確実に反映されるようにする (#191)。

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
