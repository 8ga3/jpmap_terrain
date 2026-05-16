# デモ一覧とポータル仕様

`jpmap_terrain` の開発デモは複数のエントリポイントを持ち、`/`（ポータル）から各デモへ遷移できます。
本ドキュメントはデモポータルの方針・URL 規約・新規デモの追加手順をまとめます。

## デモ一覧（2026-05 時点）

| デモ | URL | エントリ | 説明 |
|---|---|---|---|
| デモポータル | `/` （`index.html`） | `src/demos/portal/index.ts` | デモ一覧へのリンク集 |
| 3D 地形ビューア | `/viewer.html` | `src/demos/viewer/index.ts` | 既存の 3D 地形可視化（`/@lat,lon` URL ・カメラ・地図種別連動） |
| タイムラプス | `/timelapse.html` | `src/demos/timelapse/index.ts` | 24 時間を 1 分に圧縮した太陽位置・陰影アニメ＋アナログ時計オーバーレイ |
| ポリゴン | `/polygon.html` | `src/demos/polygon/index.ts` | `JpmapTerrain` のポリゴン公開 API（terrain / absolute / closed の 3 種・点編集 API）の動作確認 |
| サークル | `/circle.html` | `src/demos/circle/index.ts` | `JpmapTerrain` のサークル公開 API（terrain / absolute / custom-segments の 3 種・updateCircle デモ）の動作確認 (#201 / #206) |
| 距離計測 | `/distance.html` | `src/demos/distance/index.ts` | 地形クリックで頂点を追加し、辺ごとに水平距離・高低差を表示する。`onTerrainClick` (#183) / `onPolygonPoint*` (#184) / `edgeLabels` (#185) の統合動作確認デモ (#186) |
| Plan Viewer | `/plan.html` | `src/demos/plan/index.ts` | QGroundControl の `.plan` ファイルをドラッグ&ドロップで表示するビューア。ウェイポイント・ジオフェンス・ラリーポイントを描画 |
| 3Dモデル | `/model.html` | `src/demos/model/index.ts` | 地面クリックで 3D モデル（human.glb/obj/stl）を配置・移動するデモ。方位変更・座標表示・カメラ移動・フォーマット切替。Model API (#243 / #247) の動作確認 |
| アバターアニメーション #01 | `/avatar.html` | `src/demos/avatar/index.ts` | 3D アバター（`human_walk.glb`）が地形に沿って円軌道を移動するアニメーションデモ。地面クリックで軌道中心を変更、半径・速度スライダー、アニメーション開始/停止トグル。Model API + `playModelAnimation` (#250) の動作確認 |
| Boids フロッキング | `/boids.html` | `src/demos/boids/index.ts` | Boids アルゴリズム（分離・整列・結合）による群衆シミュレーション。高尾山山頂付近の矩形リージョン内で複数のアバターが自律的に歩き回る。アバター数スライダー・一時停止・リスタート。Model API + Polygon API (#251) の動作確認 |
| フライトデモ | `/flight.html` | `src/demos/flight/index.ts` | 飛行機（`plane.glb`）が上空を円軌道で旋回し、Follow カメラで追跡するデモ。外部カメラ frustum API による地形タイル更新。3D/2D/Follow のカメラモード切替。Model API + 外部カメラ連携 API (#245) の動作確認 |

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

### circle (`/circle.html`)

`JpmapTerrain` のサークル公開 API（§3.3.9）の動作確認デモ（#201 / #206）。

**デモ構成（3 サークル）:**

| id | altitudeMode | 概要 |
|---|---|---|
| `yomiuri-terrain` | `terrain` | 地表追従円（半径 300m、altitude=50m、赤色） |
| `yomiuri-absolute` | `absolute` | 絶対標高円（半径 200m、altitude=400m、青色） |
| `yomiuri-custom` | `absolute` | カスタムセグメント円（半径 150m、altitude=300m、segments=16、黄色） |

**コントロール:** 各サークルの enabled / point / line / wall / label トグルと、`updateCircle` による半径・中心・スタイル変更のデモ UI を右パネルに配置する。

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式および `?lat=&lon=` クエリ形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

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

### plan (`/plan.html`)

QGroundControl の `.plan` ファイルをドラッグ&ドロップでマップ上に表示するビューア（#38）。編集機能は持たない。

**ファイル入力:** デスクトップからのドラッグ&ドロップ。再ドロップ時は前回表示をクリアし新しい Plan のみ表示する。

**ウェイポイント（Mission）:**

- パスライン（`addPolygon`, `altitudeMode: "absolute"`, `closed: false`）で描画。
- 各頂点ラベル: `#番号\n高度 m`（1 始まり、スキップ MAV_CMD は数えない）。
- エッジラベル: `水平距離\n高度差`。
- 対応 MAV_CMD: `NAV_WAYPOINT`(16) / `NAV_LAND`(21) / `NAV_TAKEOFF`(22)。その他はスキップ。
- 高度はホームポジションからの相対高度として絶対高度に変換。

**ジオフェンス:**

- ポリゴン: `addPolygon`（`closed: true`, `altitudeMode: "absolute"`）。ホーム高度 +10m で描画（遠方タイル未ロード時も即時表示のため）。ラベルなし。
- 円: `addCircle`（`altitudeMode: "absolute"`, `pointEnabled: false`, `label: null`）。ホーム高度 +10m で描画。壁付き。

**ラリーポイント:**

- 1 点ポリゴン（`addPolygon`）でマーカー表示。ラベルは `R番号`。

**URL:** `engine` / カメラ系は他デモと共通（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### model (`/model.html`)

`JpmapTerrain` の 3D モデル公開 API（§3.3.x）の動作確認デモ（#243 / #244）。

**初期状態:** 東京駅（lat: 35.681236, lon: 139.767125）に `assets/human.glb` を `altitudeMode: "terrain"` で配置。

**操作:**

| 操作 | 効果 |
|---|---|
| 地面クリック | クリック地点に 3D モデルを移動（カメラから 5km 以内、地面のみ） |
| 方位スライダー | 3D モデルの Y 軸回転（0–360°） |
| 「モデル位置へ移動」ボタン | カメラを 3D モデルの緯度・経度に `flyTo` |

**表示:** 右パネルに緯度・経度・方位を表示。方位変更用スライダーと移動ボタンを配置。

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式および `?lat=&lon=` クエリ形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

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

### avatar (`/avatar.html`)

3D アバター（`assets/human_walk.glb`）が地形に沿って円軌道を移動するアニメーションデモ（#250）。`JpmapTerrain` の Model 公開 API と `playModelAnimation` を使用する。

**仕様:**

- 東京駅（35.681236, 139.767125）に初期配置
- 地面クリックでクリック地点を中心とする円軌道の中心を移動（カメラから 5000m 以内）
- 歩行アニメーション（`rig-action`）を再生しながら毎フレーム円周上を移動
- 進行方向に向きを自動回転（接線方向 = `angleDeg + 90°`）
- 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
- モデルスケール: 50 倍

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| 半径スライダー | 円軌道の半径 (m) を変更（既定 200m） |
| 速度スライダー | 角速度 (°/秒) を変更（既定 20°/秒） |
| 開始/停止ボタン | アニメーション再生のトグル |
| 中心へ移動ボタン | カメラを軌道中心に移動 |

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### boids (`/boids.html`)

Boids アルゴリズム（Craig Reynolds, 1987）による群衆シミュレーションデモ（#251）。高尾山山頂付近の矩形リージョン内で複数のアバター（`assets/human_walk.glb`）が分離・整列・結合の 3 ルールに従い自律的に歩き回る。

**仕様:**

- 高尾山山頂（35.6251, 139.2436）を中心とした矩形リージョン（約 300m × 300m）
- リージョン境界を Polygon API（`addPolygon`, `closed: true`）で可視化
- 複数のアバターを Model API（`addModel` / `updateModel` / `playModelAnimation`）で配置・更新
- Boids の 3 ルール:
  - **分離 (Separation)**: 近すぎる仲間から離れる
  - **整列 (Alignment)**: 近隣の仲間と進行方向を揃える
  - **結合 (Cohesion)**: 近隣の仲間の重心に向かう
- 歩行アニメーション（`rig-action`）を再生
- 進行方向に向きを自動回転
- 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
- 地形の高度による速度影響・転落はなし
- アバターはリージョン境界から出られない（境界回避力を適用）
- モデルスケール: 25 倍

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| アバター数スライダー | アバター数を動的に変更（1〜50 体、既定 20 体） |
| 一時停止 / 再開ボタン | シミュレーションの一時停止 / 再開トグル |
| リスタートボタン | アバターを初期位置にリセットし再スタート |
| リージョン中心へ移動ボタン | カメラをリージョン中心に移動 |

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### flight (`/flight.html`)

飛行機（`assets/plane.glb`）が上空を円軌道で旋回し、Follow カメラで追跡するデモ（#245）。`JpmapTerrain` の外部カメラ連携 API（§3.3.14）と Model API（§3.3.13）を使用する。

**仕様:**

- 東京駅（35.681236, 139.767125）上空に初期配置
- 地面クリックでクリック地点を中心とする円軌道の中心を移動（カメラから 20000m 以内）
- 毎フレーム円周上を移動し、進行方向に自動回転（接線方向）
- `altitudeMode: "absolute"` で絶対標高指定
- Follow モード時は FreeCamera を飛行機の後方上方に配置し、外部 frustum API でタイル更新
- 3D/2D モード時は通常の ArcRotateCamera を使用

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| 緯度・経度表示 | 現在の円軌道中心座標 |
| 半径スライダー | 円軌道の半径 (m) を変更（既定 2000m、500–10000m） |
| 速度スライダー | 飛行速度 (m/s) を変更（既定 100m/s、100–340m/s） |
| 高度スライダー | 飛行高度 (m) を変更（既定 2000m、100–10000m） |
| 停止/再開ボタン | アニメーション再生のトグル |
| 移動ボタン | カメラを軌道中心に移動 |
| カメラモードボタン | 3D / 2D / Follow の切替 |
| Follow 距離・高度 Offset | Follow カメラの飛行機からの距離と高度オフセット（ドラッグ/ホイールで操作） |
| LOD bias スライダー | Follow モード時のタイル粒度調整（0–4、大きいほど粗い） |

**Follow カメラ操作:**

| 操作 | 効果 |
|---|---|
| 左右ドラッグ | カメラの水平回転（飛行機を中心に周回） |
| 上下ドラッグ | カメラの高度オフセット変更 |
| マウスホイール | カメラの距離変更 |

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。
