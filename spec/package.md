# パッケージ仕様書

> **ステータス**: Draft

---

## 1. 概要

`jpmap_terrain` を **npm パッケージ** として公開し、任意の Web アプリケーションからマウントポイント（DOM 要素）を指定して地理院タイルベースの3D地形ビューアを埋め込めるようにする。

## 2. パッケージ基本情報

| 項目 | 値 |
|---|---|
| パッケージ名 | `jpmap-terrain`（npm 公開時）|
| モジュール形式 | ESM のみ |
| Babylon.js | `peerDependency`（利用側が別途インストール） |
| 型定義 | 同梱（`.d.ts`） |
| ライセンス | Apache-2.0 |

## 3. 初期実装

### 3.1 マウントポイント指定型

利用側が任意の DOM 要素（`HTMLElement`）を指定し、そこにキャンバスと UI を描画する。

```typescript
import { JpmapTerrain } from "jpmap-terrain";

const viewer = await JpmapTerrain.create(document.getElementById("map")!, {
  engine: "webgpu",  // "webgpu" | "webgl2"
  lat: 35.681236,
  lon: 139.767125,
  altitude: 2000,
  azimuth: 0,        // camera alpha（度）
  tilt: 45,           // camera beta（度）
  mapType: "standard", // "standard" | "photo"
});
```

### 3.2 初期パラメータ

| パラメータ | 型 | デフォルト値 | 説明 |
|---|---|---|---|
| `engine` | `"webgpu" \| "webgl2"` | `"webgpu"` | 描画エンジン。WebGPU 非対応時は自動で WebGL2 にフォールバック |
| `lat` | `number` | `35.681236` | 緯度（Babylon.js Z 軸に対応） |
| `lon` | `number` | `139.767125` | 経度（Babylon.js X 軸に対応） |
| `altitude` | `number` | `2000` | カメラのワールド高度（メートル）。`camera.position.y = target.y + radius·cos(beta)` で算出される値であり、カメラの地表からの距離（radius）とは異なる。Babylon.js Y 軸に対応 |
| `azimuth` | `number` | `0` | 方位角（度、Babylon.js camera alpha に対応） |
| `tilt` | `number` | `45` | チルト角（度、Babylon.js camera beta に対応） |
| `mapType` | `"standard" \| "photo"` | `"standard"` | 地図種類（標準地図 / 航空写真） |
| `viewMode` | `"3d" \| "2d"` | `"3d"` | カメラ視点モード。`"2d"` は平行投影で `tilt = 0` 固定、tilt 操作無効 |
| `showViewModeButton` | `boolean` | `true` | ライブラリ内蔵の 3D/2D 切替ボタンを表示するか |
| `dateTime` | `Date \| null` | `null` | 太陽位置計算に使う日時。`null` の場合は内部の決定的なフォールバック時刻（夏至日本時間正午）を使用 |
| `autoSunPosition` | `boolean` | `false` | `true` で実時刻に追従して内部更新（60 秒周期）、`false` で `dateTime` を固定値として使用 |
| `showSunShadows` | `boolean` | `false` | 太陽 DirectionalLight による地形への影描画を有効化する。GPU 負荷が大きいため既定 OFF |

### 3.3 API & プロパティ

#### 3.3.1 位置・カメラ制御

すべてのプロパティは **get（読み取り）/ set（書き込み）両対応** である。
set すると即座にビューに反映される。

```typescript
interface JpmapTerrain {
  /** 現在の緯度（get / set） */
  get lat(): number;
  set lat(value: number);

  /** 現在の経度（get / set） */
  get lon(): number;
  set lon(value: number);

  /** 現在のカメラワールド高度 camera.position.y（get / set）。target.y + radius·cos(beta) */
  get altitude(): number;
  set altitude(value: number);

  /** カメラ方位角・度（get / set） */
  get azimuth(): number;
  set azimuth(value: number);

  /** カメラチルト角・度（get / set） */
  get tilt(): number;
  set tilt(value: number);

  /**
   * カメラ視点モード。
   * - `"3d"`: 透視投影（既定）。`tilt` 有効。
   * - `"2d"`: 平行投影。`tilt = 0` 固定、tilt 操作（setter / `flyTo` / Ctrl+ドラッグ / コンパスボタン）は無効。
   *   3D へ復帰すると、2D 切替直前の `tilt` が復元される。
   * - 同値の再 set は no-op。
   */
  get viewMode(): ViewMode;
  set viewMode(value: ViewMode);

  /**
   * 指定座標にカメラを移動する。
   * アニメーション付きで遷移する。
   */
  flyTo(options: {
    lat: number;
    lon: number;
    altitude?: number;
    azimuth?: number;
    tilt?: number;
    duration?: number;
  }): Promise<void>;
}
```

**読み取り例:**

```typescript
// 現在のカメラ位置を取得
const currentLat = viewer.lat;
const currentLon = viewer.lon;
const currentAlt = viewer.altitude;
console.log(`現在地: ${currentLat}, ${currentLon} 高度: ${currentAlt}m`);

// 現在のカメラ姿勢を取得
const heading = viewer.azimuth;
const pitch = viewer.tilt;
```

#### 3.3.2 UI コントロールの表示・非表示

すべてのプロパティは **get / set 両対応**。現在の表示状態を取得できる。

```typescript
interface JpmapTerrain {
  /** コンパスボタンの表示・非表示（get / set） */
  get showCompass(): boolean;
  set showCompass(value: boolean);

  /** ズームボタンの表示・非表示（get / set） */
  get showZoomButtons(): boolean;
  set showZoomButtons(value: boolean);

  /** スケールバーの表示・非表示（get / set） */
  get showScaleBar(): boolean;
  set showScaleBar(value: boolean);

  /** 地図種類切替ボタンの表示・非表示（get / set） */
  get showMapToggle(): boolean;
  set showMapToggle(value: boolean);

  /** 3D/2D 視点モード切替ボタンの表示・非表示（get / set） */
  get showViewModeButton(): boolean;
  set showViewModeButton(value: boolean);

  /** コピーライト（出典表記）の表示・非表示（get / set） */
  get showAttribution(): boolean;
  set showAttribution(value: boolean);
}
```

**読み取り例:**

```typescript
if (viewer.showCompass) {
  console.log("コンパス表示中");
}
```

#### 3.3.3 ライフサイクル

```typescript
interface JpmapTerrain {
  /** ビューアを破棄し、DOM 要素からキャンバスと UI を除去する */
  dispose(): void;

  /** リサイズを通知する（ResizeObserver を内蔵する場合は不要） */
  resize(): void;
}
```

#### 3.3.4 カメラ変化イベント

カメラ位置・姿勢（`lat` / `lon` / `altitude` / `azimuth` / `tilt`）の変化を購読する。

```typescript
interface JpmapTerrain {
  /**
   * カメラ変化リスナーを登録する。
   *
   * @param listener カメラ変化を受け取るリスナー
   * @returns 登録解除関数（unsubscribe）
   */
  onCameraChange(listener: CameraChangeListener): () => void;
}
```

**仕様:**

- 戻り値は登録解除関数。呼び出すと当該リスナーのみが解除される。
- **発火条件**: 値が変化したフレームのみ通知する（`epsilon = 1e-9` での比較）。
- **初回登録時は即時発火しない**（変化があった次回以降のみ）。
- 同一リスナーを複数回登録した場合は登録回数だけ呼ばれる。
- リスナーが throw した場合でも、内部で例外を捕捉して `console.error` でログ出力し、他リスナーの処理は継続する。
- `dispose()` 後に `onCameraChange` を呼び出した場合は登録されず、no-op の unsubscribe 関数を返す。

**利用例:**

```typescript
const unsubscribe = viewer.onCameraChange((e) => {
  console.log(`lat=${e.lat}, lon=${e.lon}, alt=${e.altitude}`);
  console.log(`azimuth=${e.azimuth}, tilt=${e.tilt}`);
});

// 解除
unsubscribe();
```

#### 3.3.5 mapType 変化イベント

地図種類（`mapType`）の変化を購読する。`onCameraChange` と対称な API。

```typescript
interface JpmapTerrain {
  /**
   * mapType 変化リスナーを登録する。
   *
   * @param listener mapType 変化を受け取るリスナー
   * @returns 登録解除関数（unsubscribe）
   */
  onMapTypeChange(listener: MapTypeChangeListener): () => void;
}
```

**仕様:**

- 戻り値は登録解除関数。呼び出すと当該リスナーのみが解除される。
- **発火条件**: `mapType` が実際に変化したタイミングのみ通知する（同値の再 set は通知しない）。UI の地図切替ボタン操作・プログラム経由の `viewer.mapType = ...` の双方で発火する。
- **初回登録時は即時発火しない**（変化があった次回以降のみ）。
- 同一リスナーを複数回登録した場合は登録回数だけ呼ばれる。
- リスナーが throw した場合でも、内部で例外を捕捉して `console.error` でログ出力し、他リスナーの処理は継続する。
- `dispose()` 後に `onMapTypeChange` を呼び出した場合は登録されず、no-op の unsubscribe 関数を返す。

**利用例:**

```typescript
const unsubscribe = viewer.onMapTypeChange((mapType) => {
  console.log(`mapType changed: ${mapType}`);
});
unsubscribe();
```

#### 3.3.5.1 viewMode 変化イベント

カメラ視点モード（`viewMode`）の変化を購読する。`onMapTypeChange` と対称な API。

```typescript
interface JpmapTerrain {
  /**
   * viewMode 変化リスナーを登録する。
   *
   * @param listener viewMode 変化を受け取るリスナー
   * @returns 登録解除関数（unsubscribe）
   */
  onViewModeChange(listener: ViewModeChangeListener): () => void;
}
```

**仕様:**

- 戻り値は登録解除関数。呼び出すと当該リスナーのみが解除される。
- **発火条件**: `viewMode` が実際に変化したタイミングのみ通知する（同値の再 set は通知しない）。UI の視点切替ボタン操作・プログラム経由の `viewer.viewMode = ...` の双方で発火する。
- **初回登録時は即時発火しない**（変化があった次回以降のみ）。
- リスナーが throw した場合でも、内部で例外を捕捉して `console.error` でログ出力し、他リスナーの処理は継続する。
- `dispose()` 後に `onViewModeChange` を呼び出した場合は登録されず、no-op の unsubscribe 関数を返す。

**2D モード時の制約:**

- `tilt` getter は常に `0` を返す。
- `tilt` setter / `flyTo({ tilt })` は `camera.beta` に反映されない（保存値だけ更新され、3D 復帰時に復元される）。
- Ctrl/Cmd + ドラッグの tilt 操作、コンパスボタンによる tilt リセットは無効。
- `lat` / `lon` / `altitude` / `azimuth` の操作は通常通り動作する。
- 3D → 2D 切替時は `camera.beta` が 0 にリセットされるため、`onCameraChange` は viewMode 変化単独でも `tilt` の差分により発火する。

#### 3.3.6 太陽位置（時間による明るさ変化）

`dateTime` / `autoSunPosition` は **get / set 両対応**。set すると即座にライト・Skybox・太陽メッシュへ反映される。

```typescript
interface JpmapTerrain {
  /**
   * 太陽位置計算に使う日時。`null` の場合は内部の決定的なフォールバック時刻
   * （夏至日本時間正午）を使用する。
   * `autoSunPosition=true` の間、getter は「最後に内部反映した実時刻」を返す。
   */
  get dateTime(): Date | null;
  set dateTime(value: Date | null);

  /**
   * `true`: 60 秒周期で実時刻に追従して内部更新する。
   * `false`（既定）: `dateTime` を固定値として使用する。
   */
  get autoSunPosition(): boolean;
  set autoSunPosition(value: boolean);

  /**
   * 太陽 DirectionalLight による地形への影描画を有効化するフラグ。既定 `false`（OFF）。
   * `true` のとき `ShadowGenerator` を内部生成し、地形タイル全体を caster / receiver に登録する。
   * `false` に戻すと `ShadowGenerator` は dispose され、GPU リソースを保持しない。
   */
  get showSunShadows(): boolean;
  set showSunShadows(value: boolean);
}
```

**仕様:**

- `Invalid Date` を setter / options に渡した場合は `console.warn` のうえ `null` 同等に倒す（例外は投げない）。
- `autoSunPosition` を `true` から `false` に切り替えた瞬間、保持していた `dateTime` 値（または `null`）で再計算する。
- `dispose()` 時に内部タイマーは確実に解放される。
- ビジュアルテストの決定性が必要な場面（Playwright 等）では、URL クエリ `?dateTime=<ISO8601 with Z>&autoSunPosition=false` を付与し、太陽位置を完全に固定すること。

**`showSunShadows` 仕様:**

- 既定 `false`（OFF）。OFF 時は `ShadowGenerator` を生成せず、GPU 負荷を発生させない。
- `true` を set すると `ShadowGenerator`（解像度 1024 / `usePercentageCloserFiltering=true` / `darkness=0.4`）を生成し、現時点でアクティブな地形タイルおよび以後追加されるタイルメッシュを caster / receiver として登録する。
- `false` に戻すと caster/receiver 設定を解除し `ShadowGenerator` を dispose する。
- 同値の再 set は no-op。`dispose()` 後の set も no-op。
- `dispose()` 時に `ShadowGenerator` は確実に解放される。
- URL クエリ `?showSunShadows=true|false` で初期値を制御できる（`true`/`false` 以外の値は無視）。

#### 3.3.7 マーカー

任意地点に、地表から垂直に伸びる線とその先のビルボード（アイコン＋改行テキスト）を表示する機能。

```typescript
interface JpmapTerrain {
  /** マーカー追加。同 id 重複は throw、icon/text 双方未指定は throw。 */
  addMarker(id: string, options: MarkerOptions): MarkerHandle;
  /** 取得。未存在は null */
  getMarker(id: string): MarkerHandle | null;
  /** 部分更新。未存在は throw */
  updateMarker(id: string, partial: MarkerUpdate): MarkerHandle;
  /** 削除。未存在は no-op + warn */
  removeMarker(id: string): void;
  /** enabled の薄いショートカット */
  setMarkerEnabled(id: string, enabled: boolean): void;
  /** 全 id を生成順で返す */
  listMarkers(): readonly string[];
}

interface MarkerOptions {
  lat: number;
  lon: number;
  icon?: { url: string; width?: number; height?: number };
  text?: {
    value: string;          // "\n" で改行
    fontSize?: number;      // フォントサイズ(px) (default 18)
    color?: string;         // CSS color (default "#000000")
    backgroundColor?: string; // CSS color (default "transparent")
    lineHeight?: number;    // 倍率 (default 1.2)
  };
  line?: {
    color?: string;  // CSS color (default "#000000")
    width?: number;  // m (default 4)
    height?: number; // m (default 500)。動的高さ計算が無効な場合のフォールバック値
  };
  enabled?: boolean; // default true
}
```

**仕様:**

- `icon` と `text` は **少なくとも片方が必須**。両方指定時は **上=text、下=icon** の順で線の上にスタックする。
- ビルボードは `BILLBOARDMODE_ALL` でカメラ常時追従。地形タイルと同じ `renderingGroupId = 0` で描画し、地形の深度バッファをそのまま共有する。これにより視線上の山などに正しくオクルードされる（自局所地表への埋没は「線の高さ」分のクリアランスで回避）。地形とマーカーの間に空でない中間 renderingGroup を挟むと、Babylon.js の既定動作（renderingGroup 間で深度バッファをクリアする）によりマーカー側が地形の深度を継承できなくなる点に注意（polygon/circle も同じ理由で全コンポーネントを renderingGroupId=0 に統一している。§3.3.8 参照）。
- 表示位置の高さは **「タイル表面の標高 + 線の高さ」**。線の高さはカメラ距離・仰角から
  動的に算出される値（`radius * 0.1 * clamp(sin(beta), 0.3, 1)` を 100m–10000m にクランプ）を採用し、
  カメラ距離が変わってもスクリーン上で安定した長さに見えるようにする。`line.height` は
  動的計算が利用できないテスト/フォールバック時の基準値として保持する。
  標高未取得地点では描画を保留し、対応するタイルロード後（`onTerrainUpdated`）に自動で表示する（例外は投げない）。
- `icon.url` は `http(s):` / `data:image/...` / 相対パスのみ許可。`javascript:` 等のスキームは Error。
- `lat`/`lon` が JAPAN_BOUNDS 外、`MarkerOptions` 不正属性の場合は Error。
- `addMarker` の戻り値および `getMarker` は read-only スナップショット（更新は必ず `updateMarker` 経由）。
- `dispose()` で全マーカーリソース（Mesh / Material / Texture）を解放する。
- マーカーは別機能（タイムラプス等）から内部的に利用可能。

**`mapType` URL クエリ仕様:**

- URL クエリ `?mapType=standard|photo` で初期値を上書きできる（デモ層）。
- 値は大小文字無視で受理する（例: `?mapType=Photo` も `"photo"` として解釈）。書き戻し時は小文字に正規化する。
- 不正値・欠落・URL 解析失敗時は `JPMAP_TERRAIN_DEFAULTS.mapType`（= `"standard"`）にフォールバックする（例外は投げない）。
- `viewer.mapType` の変化（UI 切替ボタン / プログラム set）は `onMapTypeChange` 経由でデモ層が `history.replaceState` により URL の `?mapType=` を更新する。パス（`/@lat,lon[,...]`）と他クエリ（`engine`, `dateTime` 等）・ハッシュは保持される。

**`viewMode` URL クエリ仕様:**

- URL クエリ `?viewMode=3d|2d` で初期値を上書きできる（デモ層）。
- 値は大小文字無視で受理する。書き戻し時は小文字に正規化する。
- 不正値・欠落・URL 解析失敗時は `JPMAP_TERRAIN_DEFAULTS.viewMode`（= `"3d"`）にフォールバックする。
- `viewer.viewMode` の変化は `onViewModeChange` 経由でデモ層が `history.replaceState` により URL の `?viewMode=` を更新する。パス・他クエリ・ハッシュは保持される。

**2D モードにおけるパス形式:**

- 3D モードのパス形式: `/@<lat>,<lon>,<altitude>,<azimuth>,<tilt>`
  - `altitude` はカメラの高さ（m）。範囲 [50, 25,512,548]。globe バックエンドにおける意味:
    - **GeospatialCamera の `radius`**（注視点＝地表点からのカメラ距離）。上限は globe の最大 radius = planetRadius×4 に由来する。
- 2D モードのパス形式: `/@<lat>,<lon>,<zoom>z`（Google Maps 互換）
  - `zoom` は Web Mercator ズームレベル（小数 2 桁）。範囲 [5, 23]
  - 2D では平行投影のためカメラの海抜高度は表示範囲に影響しないため、altitude の代わりにズームレベルを使用する
  - azimuth / tilt は 2D モードでは固定のため URL に含めない
  - ズームレベルと `camera.radius` の変換式:
    - `z = log₂(canvasHeight × 156543 × cos(φ) / (2 × radius × tan(fov/2)))`
    - `radius = canvasHeight × 156543 × cos(φ) / (2^z × 2 × tan(fov/2))`
  - URL コピー＆ペーストで同等の表示を再現できる
  - 例: `/@35.3606,138.7274,14.50z?viewMode=2d`（富士山をズームレベル 14.5 で表示）
- パーサーは `z` サフィックスの有無でズームレベルか海抜高度かを自動判別する（`CameraUrlState.zoomLevel` フィールドに格納）

#### 3.3.8 ポリゴン

任意の点列を受け取り、地表または絶対標高に沿って **ポイント球体** と **ポリライン** を表示する API（基盤）。

##### 3.3.8.1 公開 API（基盤＋ポリライン＋垂線/ラベル＋壁）

```typescript
interface JpmapTerrain {
  /** ポリゴン追加。同 id 重複は throw、points 2 未満は throw、JAPAN_BOUNDS 外は throw。 */
  addPolygon(id: string, options: PolygonOptions): PolygonHandle;
  /** 取得。未存在は null */
  getPolygon(id: string): PolygonHandle | null;
  /** 削除。未存在は no-op + warn */
  removePolygon(id: string): void;
  /** enabled の薄いショートカット */
  setPolygonEnabled(id: string, enabled: boolean): void;
  /** 各頂点の球体マーカー表示をポリゴン単位で ON/OFF */
  setPointsEnabled(id: string, enabled: boolean): void;
  /** 各点からの垂線表示をポリゴン単位で ON/OFF */
  setVerticalsEnabled(id: string, enabled: boolean): void;
  /** ラベル表示をポリゴン単位で ON/OFF */
  setLabelsEnabled(id: string, enabled: boolean): void;
  /** 壁表示をポリゴン単位で ON/OFF */
  setWallsEnabled(id: string, enabled: boolean): void;
  /** 全 id を生成順で返す */
  listPolygons(): readonly string[];
}

type AltitudeMode = "absolute" | "terrain";

interface PolygonPointOptions {
  lat: number;
  lon: number;
  /** `altitudeMode === "absolute"` のとき必須値 (m)。`"terrain"` のときは地表からのオフセット (m)、未指定時は 0 */
  altitude?: number;
}

interface PolygonStyleOptions {
  // 基本スタイル
  pointColor?: string;     // CSS color (default "#ff0000")
  pointOpacity?: number;   // 0..1 (default 1)
  pointDiameter?: number;  // m (default 20)
  lineColor?: string;      // CSS color (default "#ff0000")
  lineOpacity?: number;    // 0..1 (default 1)
  lineWidth?: number;      // m (Tube radius, default 2)
  /**
   * 線幅の基準。"world"（既定）は lineWidth を世界座標の Tube 半径として扱う（従来互換）。
   * "screen" は頂点ごとにカメラ距離を計算し、点/垂線と同じ距離比例スケールを線の全長に
   * わたって頂点単位で適用する。長い折れ線（GPXトラック等）で重心から離れた区間に
   * ズームインしても、画面上の太さがズーム位置によらず一定に保たれる。
   */
  lineWidthMode?: "world" | "screen"; // default "world"
  // 垂線・ラベルスタイル
  dropLineColor?: string;     // CSS color (default "#ff0000")
  dropLineWidth?: number;     // m (Tube radius, default 1)
  dropLineOpacity?: number;   // 0..1 (default 1)
  labelColor?: string;        // CSS color (default "#000000")
  labelBackgroundColor?: string; // CSS color (default "transparent")
  labelFontSize?: number;     // px (default 14)
  // 壁スタイル
  wallColor?: string;         // CSS color (default "#ff0000")
  wallOpacity?: number;       // 0..1 (default 0.3)
}

interface PolygonOptions {
  points: ReadonlyArray<PolygonPointOptions>; // 1 点以上。1 点のときは点・垂線・点ラベルのみ。
  altitudeMode?: AltitudeMode;                // default "terrain"
  /** `true` でポリラインの末尾と先頭を結んで閉じる。壁・垂線も同様に閉じられる。default false */
  closed?: boolean;
  /** ラベル（点ごと）。`labels[i]` が文字列のときその点にラベルを描画する。 */
  labels?: ReadonlyArray<string>;
  /**
   * 辺ラベル（隣接点間ごと）。`edgeLabels[i]` は `points[i]` → `points[i+1]` の中点に表示する。
   * `closed === true` のとき末尾要素 `edgeLabels[points.length-1]` は `points[points.length-1]` → `points[0]` のラベル。
   * `undefined` または範囲外の辺にはラベルを描画しない。
   */
  edgeLabels?: ReadonlyArray<string | undefined>;
  style?: PolygonStyleOptions;
  enabled?: boolean;                          // default true
  /** 各頂点の球体マーカーの表示。default true */
  pointsEnabled?: boolean;
  /** 各点から Y=0 まで伸びる垂線の表示。default true */
  verticalsEnabled?: boolean;
  /** ラベルの表示。default true */
  labelsEnabled?: boolean;
  /** 隣接垂線間をつなぐ壁の表示。default true */
  wallsEnabled?: boolean;
}
```

**ポリゴン基盤の仕様:**

- `points` の各点に対し、`altitudeMode === "absolute"` なら `altitude` をそのまま Y に採用する。`"terrain"` ならタイル標高 (m) を Y に採用し、`altitude` が指定されている場合は地表からのオフセットとして加算する。
- `terrain` モードで 1 点でも標高未解決の間は **ポリゴン全体を hide** し、`onTerrainUpdated` 後に自動表示する（例外は投げない）。
- 各点に直径 `style.pointDiameter` (m) の **球体メッシュ** を配置する（既定色 `#ff0000`、emissive、地表メッシュと同じ `renderingGroupId = 0` で描画し地形に正しくオクルードされる）。スケールはカメラ距離に応じて screen-stable に動的更新されるが、ワールド直径は 100m を上限にクランプする（無制限に拡大すると遠距離で球が地形を貫通し手前側がはみ出て見えるため）。`PolygonOptions.pointsEnabled`（既定 true）を `false` にすると球体メッシュ自体を生成しない（大量頂点のポリライン表示でメッシュ数を削減する用途）。`JpmapTerrain.setPointsEnabled(id, enabled)` で表示切替が可能。
- 隣接点間を **CreateTube**（`updatable: true`、半径 `style.lineWidth`）で結ぶ。`closed = true` のとき末尾→先頭も結ぶ。`style.lineWidthMode === "screen"` の場合は `radiusFunction` で頂点ごとにカメラ距離比例スケールを計算し、長い折れ線でもズーム位置によらず画面上の太さを一定に保つ（既定 `"world"` は全頂点の重心とカメラの距離から算出した単一スケールを一律適用する）。
- JAPAN_BOUNDS 外の点・`points.length < 1`・`absolute` で `altitude` 未指定の場合は `addPolygon` で throw（範囲外の点 index をメッセージに含める）。`points.length === 1` のときは辺（線 / 壁 / 辺ラベル）は存在せず、点・垂線・点ラベルのみ描画される。
- 同 id の重複追加は throw、`removePolygon` の未存在 id は `console.warn` + no-op。
- `dispose()` で全ポリゴンリソース（Mesh / Material / TransformNode）を解放する。
- **垂線・ラベルの仕様**: 各点から Y=0（グリッド原点面）まで伸びる垂線を **CreateTube**（updatable、半径 `style.dropLineWidth`）で描画する。垂線は地表を貫通して下るため、高高度点の接地を常に可視化できる。`labels[i]` が指定された点に DynamicTexture + ビルボード Plane でラベルを描画（`labelColor` / `labelBackgroundColor` / `labelFontSize` 反映）。`JpmapTerrain.setVerticalsEnabled(id, enabled)` / `setLabelsEnabled(id, enabled)` で表示切替が可能。`PolygonOptions.verticalsEnabled` / `labelsEnabled`（既定 true）で初期表示制御。
- **壁表示の仕様**: 隣接する点間を上 row=頂点位置、下 row=Y=0 の Ribbon として 1 枚の **CreateRibbon**（`updatable: true`, `sideOrientation: DOUBLESIDE`）で壁表示。下 row は垂線と同様に地表を貫通してグリッド原点面で接地させる。`closed=true` のときは上/下 row とも末尾に先頭頂点を append して閉じる。`style.wallColor` / `style.wallOpacity`（default `#ff0000` / `0.3`）を StandardMaterial の `emissiveColor` / `alpha` に反映し、半透明時は `needDepthPrePass=true` で z-fight を緩和する。`JpmapTerrain.setWallsEnabled(id, enabled)` で表示切替が可能。`PolygonOptions.wallsEnabled`（既定 true）で初期表示制御。壁・垂線・球・ポリライン（アウトライン）・ラベルは全て地表メッシュと同じ `renderingGroupId=0` で描画し、地表の深度バッファに対する深度テストで地中部分・地形より奥の部分を自然にオクルードする（以前はポリライン・ラベルを別グループにして常に地表より手前にしていたが、山などに正しく隠れてほしいという要望により撤回し、地形と同じ深度で扱う方式に統一した）。
- **辺ラベルの仕様**: `PolygonOptions.edgeLabels[i]` が文字列のとき、`points[i]` → `points[i+1]` の中点に DynamicTexture + ビルボード Plane（`polygon-${id}-edge-label-${i}`）でラベルを描画する。`closed === true` かつ `points.length >= 2` のとき配列長は `points.length` で末尾要素は `points[N-1]` → `points[0]` のラベル、それ以外（`closed === false` または `points.length < 2`）のとき配列長は `Math.max(0, points.length - 1)`（つまり 1 点ポリゴンでは 0）。`labels` と同じ `style.labelColor` / `labelBackgroundColor` / `labelFontSize` を共用し、`setLabelsEnabled(id, enabled)` の対象に含む。`distScale` 連動でビルボードがスクリーン安定する。`insertPolygonPoint` / `removePolygonPoint` は対応 index を点ラベルと同じ規則でシフトする（open ポリゴンの末尾頂点削除時は末尾の辺ラベルを除去）。`replacePolygonPoints` 後は `edgeLabels` を全 `undefined` で再構成する。`PolygonHandle.edgeLabels` は一度でも設定されていれば配列を返し、未指定のままなら `undefined`。
- **点編集 API の後日実装予定**: `updatePolygon`、点単位編集 API（`insertPoint` / `removePoint` / `updatePoint` / `replacePoints`）、デモ拡張、視覚回帰テスト。

##### 3.3.8.2 ポリゴン点編集 API

`addPolygon` 後のポリゴンに対し、頂点列を **動的に編集** する 4 API を提供する。`PolygonHandle` を都度返し、ハンドル経由で点列の現在値を確認できる。

```typescript
interface PolygonPointPartial {
  lat?: number;
  lon?: number;
  altitude?: number;
  /** 文字列: 当該 index にラベルを設定 / `null`: 当該 index のラベルを削除 / `undefined`: 現状維持 */
  label?: string | null;
}

interface JpmapTerrain {
  /** 指定 index に新しい頂点を挿入する。`index === points.length` で末尾追加。 */
  insertPolygonPoint(id: string, index: number, point: PolygonPointOptions): PolygonHandle;
  /** 指定 index の頂点を削除する。残り 1 点未満になる場合は throw。 */
  removePolygonPoint(id: string, index: number): PolygonHandle;
  /** 指定 index の頂点を部分更新する。partial 未指定フィールドは現状維持。 */
  updatePolygonPoint(id: string, index: number, partial: PolygonPointPartial): PolygonHandle;
  /** 全頂点を置き換える。`points.length < 1` は throw。 */
  replacePolygonPoints(id: string, points: ReadonlyArray<PolygonPointOptions>): PolygonHandle;
}
```

**バリデーション:**

- 共通: dispose 後 / 未存在 id は throw。
- `insertPolygonPoint`: `index` が `[0, points.length]` の範囲外なら `RangeError`。`lat/lon` が JAPAN_BOUNDS 外なら throw。`altitudeMode === "absolute"` で `altitude` 未指定なら throw。
- `removePolygonPoint`: 削除後の点数が 1 点未満になる場合は throw。`index` が範囲外なら `RangeError`。
- `updatePolygonPoint`: `index` が範囲外なら `RangeError`。`lat`/`lon` の partial が指定されたとき、現状値とのマージ結果に対し JAPAN_BOUNDS 検査を行う。`altitudeMode === "absolute"` のとき `altitude` を `undefined` にしても現状値は維持されるため throw しない（明示的に書き換える場合のみ partial に含める）。
- `replacePolygonPoints`: `points.length < 1` は throw。各点の JAPAN_BOUNDS / `absolute` モードの altitude 必須は `addPolygon` と同じ規則で検査する。

**差分更新の保証範囲:**

- `updatePolygonPoint` は **点数を変えない** 編集なので、ポリライン (`CreateTube`) と壁 (`CreateRibbon`) は dispose せず instance を更新する。球 / 垂線 / ラベルは index 単位で in-place 更新する（label のみ追加/削除のとき該当 mesh を生成 / dispose）。
- `insertPolygonPoint` / `removePolygonPoint` は **点数が変わる** ため、ポリライン・壁は dispose+再生成（Material は再 attach）して新しい頂点列を反映する。球・垂線・ラベルは差分のみ生成 / dispose する。
- `replacePolygonPoints` は全点を入れ替えるため、球・垂線・ラベルは全 dispose+再生成、ポリライン・壁も dispose+再生成となる。
- いずれの編集でも次フレームを待たずに位置が反映されるよう、`PolygonManager` は編集直後に `tickPolygon` を即時実行する。`lastWorldPoints` / `lastGroundYs` のキャッシュは点数が変わる編集ではクリアされる。

**labels の sparse 同期:**

- `PolygonHandle.labels` は **sparse 配列** として再構成される（`labels[i] === undefined` は当該 index にラベルなし）。
- `updatePolygonPoint(index, { label: "..." })` で当該 index にラベルが追加され、`updatePolygonPoint(index, { label: null })` で当該 index のラベルが削除される。
- `insertPolygonPoint` / `removePolygonPoint` は labels 配列の対応 index をシフトする（隣接ラベルとの整合を保つ）。
- `replacePolygonPoints` は新しい点数に合わせ labels を全 undefined で再構成する（明示的にラベルを再付与するには `updatePolygonPoint` を呼び出す）。

#### 3.3.9 サークル

中心点（緯度・経度）と半径 (m) を指定して円を地形上に描画する API。中心球 / 円周 Tube / 壁 Ribbon / 中心ラベルを組み合わせて描画する。

##### 3.3.9.1 公開 API

```typescript
interface JpmapTerrain {
  /** サークル追加。同 id 重複は throw、バリデーション失敗は throw */
  addCircle(id: string, options: CircleOptions): CircleHandle;
  /** 取得。未存在は null */
  getCircle(id: string): CircleHandle | null;
  /** 差分更新。未存在 id は throw */
  updateCircle(id: string, partial: CircleUpdate): CircleHandle;
  /** 削除。未存在は no-op + warn */
  removeCircle(id: string): void;
  /** enabled の薄いショートカット */
  setCircleEnabled(id: string, enabled: boolean): void;
  /** 中心球表示切替 */
  setCirclePointEnabled(id: string, enabled: boolean): void;
  /** 円周 Tube 表示切替 */
  setCircleLineEnabled(id: string, enabled: boolean): void;
  /** 壁 Ribbon 表示切替 */
  setCircleWallEnabled(id: string, enabled: boolean): void;
  /** 中心ラベル表示切替 */
  setCircleLabelEnabled(id: string, enabled: boolean): void;
  /** 全 id を生成順で返す */
  listCircles(): readonly string[];
}

type AltitudeMode = "absolute" | "terrain";

interface CircleCenterOptions {
  lat: number;
  lon: number;
  /** `altitudeMode === "absolute"` のとき必須 (m)。`"terrain"` のときは地表からのオフセット (m)、未指定時は 0 */
  altitude?: number;
}

interface CircleStyleOptions {
  // 中心球
  pointColor?: string;        // CSS color (default "#ff0000")
  pointDiameter?: number;     // m (default 20, distScale 適用)
  pointOpacity?: number;      // 0..1 (default 1)
  // 円周 Tube
  lineColor?: string;         // CSS color (default "#ff0000")
  lineWidth?: number;         // m (Tube 半径, default 2)
  lineOpacity?: number;       // 0..1 (default 1)
  lineWidthMode?: "world" | "screen"; // default "world"（PolygonStyleOptions と同義。頂点ごとの距離比例スケール）
  // 壁 Ribbon
  wallColor?: string;         // CSS color (default "#ff0000")
  wallOpacity?: number;       // 0..1 (default 0.3)
  // 中心ラベル
  labelColor?: string;            // CSS color (default "#000000")
  labelBackgroundColor?: string;  // CSS color (default "transparent")
  labelFontSize?: number;         // px (default 14)
}

interface CircleOptions {
  center: CircleCenterOptions;
  /** 半径 (m, world)。> 0 かつ 100000 以下 */
  radius: number;
  /** 円周分割数。既定 64。範囲 [8, 512] */
  segments?: number;
  altitudeMode?: AltitudeMode;    // default "terrain"
  /**
   * 中心ラベル文言。未指定時は「lat / lon / alt / radius」を自動生成。
   * 明示 string で上書き、null で非表示
   */
  label?: string | null;
  style?: CircleStyleOptions;
  enabled?: boolean;              // default true
  pointEnabled?: boolean;         // default true
  lineEnabled?: boolean;          // default true
  wallEnabled?: boolean;          // default true
  labelEnabled?: boolean;         // default true
}

type CircleUpdate = Partial<Pick<CircleOptions,
  | "center" | "radius" | "segments" | "altitudeMode"
  | "label" | "style" | "enabled"
  | "pointEnabled" | "lineEnabled" | "wallEnabled" | "labelEnabled">>;

interface CircleHandle {
  readonly id: string;
  readonly center: Readonly<CircleCenterOptions>;
  readonly radius: number;
  readonly segments: number;
  readonly altitudeMode: AltitudeMode;
  readonly label: string | null;
  readonly style: Readonly<Required<CircleStyleOptions>>;
  readonly enabled: boolean;
  readonly pointEnabled: boolean;
  readonly lineEnabled: boolean;
  readonly wallEnabled: boolean;
  readonly labelEnabled: boolean;
  /**
   * `terrain` モード時、中心点の地表標高が解決済みなら true。
   * 円は平面円として描画されるため、中心の標高のみが必要。
   * `absolute` モード時は常に true。
   */
  readonly elevationResolved: boolean;
}
```

**仕様:**

- `center.lat/lon` が JAPAN_BOUNDS 外、`radius <= 0` または `radius > 100000`、`segments < 8` または `segments > 512`、`altitudeMode === "absolute"` で `center.altitude` 未指定の場合は throw。
- 同 id の重複追加は throw。`removeCircle` の未存在 id は `console.warn` + no-op。`updateCircle` / `setCircle*Enabled` の未存在 id は throw。
- 円周点列は world 座標で `P_i = center + (radius × cos θ_i, 0, radius × sin θ_i)` として `segments` 等分に生成する（Mercator 楕円化回避）。
- `terrain` モードでは中心点の地表標高のみ解決し、その値 + `center.altitude` を全円周点に均一適用する（平面円）。標高未解決の間は全体を非表示にし、`onTerrainUpdated` 後に自動表示する。
- `absolute` モードでは `center.altitude` をそのまま Y に採用する。
- 各コンポーネントの `renderingGroupId`: 中心球 / 円周 Tube / 中心ラベル / 壁 Ribbon は全て `0`（地表と同グループで正しくオクルード）。`wallOpacity < 1`（半透明）の場合のみ `needDepthPrePass=true` で z-fight を緩和する。中心球はポリゴン頂点球と同じ実装（globePolygonManager 経由）のため、ワールド直径は 100m を上限にクランプする。
- `dispose()` で全 Circle リソース（Mesh / Material / TransformNode）を解放する。

**差分更新の保証範囲（updateCircle）:**

| 変更フィールド | 挙動 |
|---|---|
| `center` のみ | TransformNode 位置更新、メッシュ再生成なし |
| `radius` のみ | 円周点列再計算、Tube / Ribbon の path 差分更新 |
| `segments` 変更 | CircleNode を dispose + 再生成（path 長が変わるため） |
| `altitudeMode` 変更 | CircleNode を dispose + 再生成（標高解決リセット + 即時 tick） |
| `style`（空でない場合） | CircleNode を dispose + 再生成（Material 再構築） |
| `*Enabled` フラグ | `setEnabled` でメッシュ可視性切替 |
| `label` | CircleNode を dispose + 再生成（DynamicTexture 再構築） |

**利用例:**

```typescript
import { JpmapTerrain } from "jpmap-terrain";

const circle = viewer.addCircle("range-ring", {
  center: { lat: 35.6895, lon: 139.6917 },
  radius: 500,
  altitudeMode: "terrain",
  label: "500m 圏内",
  style: { lineColor: "#0000ff", wallOpacity: 0.2 },
});

// 半径を動的に変更
viewer.updateCircle("range-ring", { radius: 1000 });

// 壁を非表示
viewer.setCircleWallEnabled("range-ring", false);
```

#### 3.3.10 地形クリック通知

地形タイル上でのマウス／タッチによるクリックを購読するイベント API。距離計測など「クリックで地点を確定する」系デモの基盤。

```typescript
interface TerrainClickEvent {
  /** クリック地点の緯度（度） */
  readonly lat: number;
  /** クリック地点の経度（度） */
  readonly lon: number;
  /** クリック地点の標高 (m, 海抜) */
  readonly altitude: number;
  /** Babylon.js ワールド座標 */
  readonly world: { readonly x: number; readonly y: number; readonly z: number };
  /** 元の `PointerEvent`（修飾キー判定等のため） */
  readonly pointerEvent: PointerEvent;
}

type TerrainClickListener = (event: TerrainClickEvent) => void;

interface JpmapTerrain {
  /**
   * 地形タイル上でのクリックを購読する。
   * 戻り値は登録解除関数（複数回呼び出しても安全）。
   */
  onTerrainClick(listener: TerrainClickListener): () => void;
}
```

**仕様:**

- 主ボタン (`button === 0`) のクリックのみが対象。`Ctrl` / `Cmd` 併用クリックはカメラ操作（パン中心移動）扱いのため発火しない。
- `pointerdown` から `pointerup` までの移動量が **4 CSS px 以下** の場合のみ「クリック」とみなす。これを超えるとドラッグ扱いで発火しない。
- `tile-ground-*` メッシュへの `scene.pick` 結果が hit したときのみ発火する。`world` には picked point、`altitude` には picked point の Y 値を採用する。
- 同一リスナーを複数回登録した場合は登録回数分発火する。リスナーが throw しても他リスナーへ伝播せず `console.error` で握りつぶす。
- `dispose()` 後の `onTerrainClick` は no-op。返される解除関数も no-op で安全に呼べる。
- 登録解除関数は二重呼び出ししても throw しない。

**利用例:**

```typescript
// 地形クリックイベントを購読するシンプルな例
const unsubscribe = viewer.onTerrainClick((e) => {
  if (e.pointerEvent.shiftKey) return; // 修飾キーでアプリ独自挙動
  console.log(`clicked: ${e.lat.toFixed(6)}, ${e.lon.toFixed(6)} (${e.altitude.toFixed(1)} m)`);
});
// 後で解除
unsubscribe();
```

#### 3.3.11 ポリゴン頂点インタラクション

ポリゴンの頂点（球体メッシュ）に対する hover / click / drag を購読するイベント API。距離計測などのデモで頂点の編集 UI を構築するための基盤。

```typescript
interface PolygonPointPointerEvent {
  /** 対象ポリゴンの ID */
  readonly polygonId: string;
  /** 頂点インデックス（0 起点） */
  readonly index: number;
  /** 元の `PointerEvent` */
  readonly pointerEvent: PointerEvent;
}

interface PolygonPointDragEvent extends PolygonPointPointerEvent {
  /** ドラッグ中カーソル直下の地形交点の緯度（地形未ヒット時 `null`） */
  readonly lat: number | null;
  /** ドラッグ中カーソル直下の地形交点の経度（地形未ヒット時 `null`） */
  readonly lon: number | null;
  /** ドラッグ中カーソル直下の地形交点の標高 m（地形未ヒット時 `null`） */
  readonly groundAltitude: number | null;
  /** ドラッグ開始時の頂点高さを保つ水平面とカーソルレイの交点の緯度（交点なしで `null`） */
  readonly planeLat: number | null;
  /** ドラッグ開始時の頂点高さを保つ水平面とカーソルレイの交点の経度（交点なしで `null`） */
  readonly planeLon: number | null;
  /** ドラッグ開始時の頂点 (x, z) を通る垂直線とカーソルレイの最近接点の標高 m（交点なしで `null`） */
  readonly pointerAltitude: number | null;
}

type PolygonPointHoverListener = (
  event: PolygonPointPointerEvent | null,
) => void;
type PolygonPointClickListener = (event: PolygonPointPointerEvent) => void;
type PolygonPointDragListener = (event: PolygonPointDragEvent) => void;

interface JpmapTerrain {
  onPolygonPointHover(listener: PolygonPointHoverListener): () => void;
  onPolygonPointClick(listener: PolygonPointClickListener): () => void;
  onPolygonPointDragStart(listener: PolygonPointDragListener): () => void;
  onPolygonPointDrag(listener: PolygonPointDragListener): () => void;
  onPolygonPointDragEnd(listener: PolygonPointDragListener): () => void;
}
```

**仕様:**

- 対象は `polygon-${id}-point-${i}` メッシュ。`scene.pick` で hit したときのみ各イベントを発火する。
- **hover**: 頂点に入った瞬間および対象切替時に `PolygonPointPointerEvent` を、頂点から離れた瞬間に `null` を通知する。hover 中はキャンバスのカーソルを `pointer` に切り替え、hover 解除時に空文字へ戻す。リスナーが 1 件も無いときは hover 検出を行わずカーソル変更も発生しない。
- **click**: `pointerdown` した頂点上で `pointerup` し、かつ `pointerdown` から `pointerup` までの移動量が **3 CSS px 未満** のとき発火する。`Ctrl` / `Cmd` 併用時は従来どおりカメラ操作扱いのため発火しない。
- **dragStart / drag / dragEnd**: 頂点 `pointerdown` 後に 3 CSS px 以上移動した時点で `dragStart` を発火し、以降の `pointermove` ごとに `drag` を発火、`pointerup` または `pointercancel` / `lostpointercapture` で `dragEnd` を発火する。`drag` / `dragStart` / `dragEnd` の `lat` / `lon` / `groundAltitude` には現在のカーソル直下の地形交点を採用し、地形未ヒット時は `null`。
- 頂点ジェスチャ中は通常の地形クリックおよびカメラ操作は抑制される。
- リスナー未登録時は頂点メッシュの hit 判定 / カーソル変更コストも発生しない。
- 各リスナーが throw しても他リスナーへ伝播せず `console.error` で握りつぶす。
- `dispose()` 後の `onPolygonPoint*` は no-op。返される解除関数は二重呼び出ししても throw しない。

**利用例:**

```typescript
// 編集デモ: 頂点ドラッグで lat/lon、Shift+ドラッグで高度を更新する
viewer.addPolygon("line", {
  points: [{ lat: 35.68, lon: 139.76, altitude: 100 }],
  altitudeMode: "absolute",
});

viewer.onPolygonPointHover((e) => {
  // hover 切替時のみ通知される。e === null で hover 解除。
  if (e) console.log(`hovering ${e.polygonId}#${e.index}`);
});

let altitudeDragWithShift = false;
viewer.onPolygonPointDragStart((e) => {
  // Shift+ドラッグかどうかを保持
  altitudeDragWithShift = e.pointerEvent.shiftKey;
});

viewer.onPolygonPointDrag((e) => {
  if (altitudeDragWithShift && e.pointerAltitude !== null) {
    // 縦線とカーソルレイの最近接点 Y を採用（地表より下にはクランプ）
    viewer.updatePolygonPoint(e.polygonId, e.index, {
      altitude: Math.max(e.pointerAltitude, e.groundAltitude ?? 0),
    });
  } else if (e.planeLat !== null && e.planeLon !== null) {
    // 通常ドラッグ: 開始高さを保つ水平面とカーソルレイの交点を採用
    viewer.updatePolygonPoint(e.polygonId, e.index, {
      lat: e.planeLat, lon: e.planeLon,
    });
  }
});

viewer.onPolygonPointDragEnd(() => {
  altitudeDragWithShift = false;
});
```

#### 3.3.12 辺ラベル

`PolygonOptions.edgeLabels` で各辺の中点に文字列ラベルを表示する。距離計測デモのように動的に距離・高低差を反映する用途に使う。

**利用例:**

```typescript
import { JpmapTerrain } from "jpmap-terrain";

// 各辺に "水平距離 / 高低差" を表示する
const points = [
  { lat: 35.68, lon: 139.76, altitude: 100 },
  { lat: 35.69, lon: 139.77, altitude: 150 },
  { lat: 35.70, lon: 139.76, altitude: 120 },
];

// 水平距離 (m) を haversine 法で算出（ライブラリには含まれないので自前実装）。
const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const haversineMeters = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sLat = Math.sin(dLat / 2);
  const sLon = Math.sin(dLon / 2);
  const h = sLat * sLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLon * sLon;
  const hh = Math.min(1, Math.max(0, h)); // 対蹠点付近で NaN を避けるためクランプ
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(hh), Math.sqrt(1 - hh));
};

const formatEdge = (a: typeof points[number], b: typeof points[number]) => {
  const dist = haversineMeters(a, b);
  const distStr = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(2)} km`;
  const dAlt = (b.altitude ?? 0) - (a.altitude ?? 0);
  return `${distStr}\n${dAlt >= 0 ? "+" : ""}${dAlt.toFixed(0)} m`;
};

viewer.addPolygon("dist-line", {
  points,
  altitudeMode: "absolute",
  // 配列長は open: points.length - 1 / closed: points.length
  edgeLabels: [
    formatEdge(points[0], points[1]),
    formatEdge(points[1], points[2]),
  ],
});

// 動的更新は edgeLabels をリセットする `replacePolygonPoints` ではなく、
// `removePolygon` + `addPolygon` の rebuild が最も簡潔（distance デモも同方式）。
```

#### 3.3.13 3Dモデル

Babylon.js がサポートする 3D モデルファイル（glb / gltf / obj / stl）を地形上にロードして配置・操作する API。ローダーはファイル拡張子に応じて `@babylonjs/loaders` の glTF / OBJ / STL プラグインを動的ロードし、`addModel` 呼び出し時にインポートする。Marker / Polygon / Circle と同パターンの Manager + Handle 構成。

##### 3.3.13.1 公開 API

| メソッド | 戻り値 | 説明 |
|---|---|---|
| `addModel(id, options)` | `ModelHandle` | 3D モデルをロードして配置する。`id` 重複時は throw |
| `getModel(id)` | `ModelHandle \| null` | 指定 id のモデル情報を取得。存在しなければ `null` |
| `updateModel(id, partial)` | `ModelHandle` | 位置・回転・スケール等を部分更新 |
| `removeModel(id)` | `void` | モデルを削除。存在しなければ `console.warn` で no-op |
| `setModelEnabled(id, enabled)` | `void` | 表示 / 非表示を切替 |
| `listModels()` | `readonly string[]` | 登録済みモデルの id 一覧 |
| `playModelAnimation(id, name?)` | `void` | アニメーション再生。`name` 省略時は全アニメーションを同時再生。※ 同一ボーンを対象とする複数アニメーションを同時再生した場合、最後に評価されるアニメーションがボーン変換値を上書きするため意図しない結果になることがある。特定のアニメーションのみ再生したい場合は `name` を指定すること |
| `stopModelAnimation(id, name?)` | `void` | アニメーション停止 |

##### 3.3.13.2 ModelOptions

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `url` | `string` | (必須) | モデルファイルの URL（glb / gltf / obj / stl に対応） |
| `lat` | `number` | (必須) | 緯度 (度) |
| `lon` | `number` | (必須) | 経度 (度) |
| `altitude` | `number` | `0` | 高度 (m)。terrain 時は地表オフセット、absolute 時は海抜高度 |
| `altitudeMode` | `AltitudeMode` | `"terrain"` | `"terrain"`: 地表追従 / `"absolute"`: 絶対高度 |
| `rotation` | `ModelVector3` | `{x:0, y:0, z:0}` | 回転 (度)。Euler 角 |
| `scaling` | `ModelVector3` | `{x:1, y:1, z:1}` | スケール倍率 |
| `enabled` | `boolean` | `true` | 表示 / 非表示 |
| `gravity` | `boolean` | `true` | 地表追従。terrain モード時のみ有効 |

##### 3.3.13.3 ModelHandle

| プロパティ | 型 | 説明 |
|---|---|---|
| `id` | `string` | モデル ID |
| `url` | `string` | モデルファイル URL |
| `lat` / `lon` | `number` | 緯度・経度 |
| `altitude` | `number` | 高度 |
| `altitudeMode` | `AltitudeMode` | 高度モード |
| `rotation` | `Required<ModelVector3>` | 回転 (度) |
| `scaling` | `Required<ModelVector3>` | スケール倍率 |
| `enabled` | `boolean` | 表示状態 |
| `gravity` | `boolean` | 地表追従状態 |
| `loaded` | `boolean` | モデルロード完了フラグ |
| `elevationResolved` | `boolean` | 地表標高解決済みフラグ |
| `animationNames` | `readonly string[]` | モデルが持つアニメーション名一覧 |

##### 3.3.13.4 ModelUpdate

`url` を除く `ModelOptions` の全フィールドを `Partial` で受け付ける。未指定フィールドは現状維持。モデルファイルの差替えは `removeModel` → `addModel` で行う。

##### 3.3.13.5 利用例

```typescript
import { JpmapTerrain } from "jpmap-terrain";

const viewer = await JpmapTerrain.create(mount, { lat: 35.68, lon: 139.77 });

// 3D モデルを東京駅に配置
const handle = viewer.addModel("human", {
  url: "assets/human.glb",
  lat: 35.681236,
  lon: 139.767125,
  altitudeMode: "terrain",
  rotation: { y: 90 },
});

// 位置を更新
viewer.updateModel("human", { lat: 35.69, lon: 139.77 });

// アニメーション再生（名前を指定して特定のアニメーションを再生）
viewer.playModelAnimation("human", "walk");

// 向きを変える
viewer.updateModel("human", { rotation: { y: 180 } });

// 削除
viewer.removeModel("human");
```

#### 3.3.14 外部カメラ連携

Follow カメラなど Babylon.js の ArcRotateCamera 以外のカメラで地形タイルを更新するための API。

##### 3.3.14.1 公開 API

| メソッド | 戻り値 | 説明 |
|---|---|---|
| `refreshTerrainWithExternalFrustum(lat, lon, frustumPlanes, cameraPosition, lodBias?)` | `Promise<void>` | 外部カメラの frustum に基づいてタイルを更新する。内蔵 terrain camera の監視を使わず、指定した視錐台内のタイルを LOD 判定して読み込む |
| `detachTileCamera()` | `void` | 内蔵 terrain camera の自動タイル更新監視を停止する。Follow モードなど外部カメラ使用中に呼び出す |
| `attachTileCamera()` | `void` | 内蔵 terrain camera の自動タイル更新監視を再開する |
| `setExternalCompassDegrees(degrees)` | `void` | コンパス UI の回転角を外部から上書きする。`null` を渡すと通常の terrain camera 連動に戻る |

##### 3.3.14.2 refreshTerrainWithExternalFrustum パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `lat` | `number` | (必須) | タイル中心の緯度 (度) |
| `lon` | `number` | (必須) | タイル中心の経度 (度) |
| `frustumPlanes` | `{ normal: { x, y, z }; d: number }[]` | (必須) | 6 面の視錐台平面（Babylon.js の `Frustum.GetPlanesToRef` 形式）。**camera 相対**（原点 = `cameraPosition`、回転のみ・並進なし）で構築すること。外部カメラの実 view 行列（並進 ~6.4e6m の ECEF 絶対位置を含む）をそのまま projection と合成すると、Float32 演算の桁落ちで画面内の地物を視錐台外と誤判定する。必ず view 行列の並進行を 0 にしてから合成する（利用例参照） |
| `cameraPosition` | `{ x: number; y: number; z: number }` | (必須) | 外部カメラの真の ECEF 絶対位置（地心 ~6.4e6m スケール）。タイル LOD の SSE 距離計算、および `frustumPlanes` の camera 相対座標を実座標へ戻す際の原点に使用 |
| `lodBias` | `number` | `0` | タイル LOD レベルを下げるバイアス（0 = 通常、大きいほど粗いタイルを使用） |

##### 3.3.14.3 利用例

```typescript
import { JpmapTerrain } from "jpmap-terrain";
import { FreeCamera, Frustum, Matrix } from "@babylonjs/core";

const viewer = await JpmapTerrain.create(mount, { lat: 35.68, lon: 139.77 });

// 外部カメラ使用時は内蔵カメラのタイル監視を停止
viewer.detachTileCamera();

// コンパスを外部カメラの方位に同期
viewer.setExternalCompassDegrees(heading);

// 外部カメラの frustum でタイルを更新
// 重要: view 行列の並進行（外部カメラの実 ECEF 位置、~6.4e6m スケール）を含めたまま
// projection と合成すると、Float32 演算の桁落ちで画面内の地物を視錐台外と誤判定する。
// 並進行を 0 にした「camera 相対（回転のみ）」の行列で平面を作ること。
const viewMat = externalCamera.getViewMatrix().clone();
viewMat.setRowFromFloats(3, 0, 0, 0, 1); // 並進行を消し回転のみにする
const projMat = externalCamera.getProjectionMatrix();
const transform = viewMat.multiply(projMat);
const planes = Frustum.GetPlanes(transform);
const frustumPlanes = planes.map(p => ({
  normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
  d: p.d,
}));
const cameraPosition = externalCamera.globalPosition; // 真の ECEF 絶対位置

await viewer.refreshTerrainWithExternalFrustum(
  lat, lon, frustumPlanes, cameraPosition, 0
);

// 通常モードに復帰
viewer.attachTileCamera();
viewer.setExternalCompassDegrees(null);
```

### 3.4 型定義

`CameraChangeEvent` および `CameraChangeListener` は、`jpmap-terrain` から import 可能である（パッケージエントリで re-export 済み）。

```typescript
/** `JpmapTerrain.onCameraChange` のリスナー引数 */
interface CameraChangeEvent {
  readonly lat: number;
  readonly lon: number;
  readonly altitude: number;
  readonly azimuth: number;
  readonly tilt: number;
  /** 現在の視点モード。`"2d"` のとき `tilt` は常に `0`。 */
  readonly viewMode: ViewMode;
}

/** `JpmapTerrain.onCameraChange` リスナー */
type CameraChangeListener = (event: CameraChangeEvent) => void;

/** `JpmapTerrain.onMapTypeChange` リスナー */
type MapTypeChangeListener = (mapType: MapType) => void;

/** カメラ視点モード */
type ViewMode = "3d" | "2d";

/** `JpmapTerrain.onViewModeChange` リスナー */
type ViewModeChangeListener = (viewMode: ViewMode) => void;
```

```typescript
import type {
  CameraChangeEvent,
  CameraChangeListener,
  MapType,
  MapTypeChangeListener,
  ViewMode,
  ViewModeChangeListener,
  // ポリゴン
  AltitudeMode,
  PolygonPointOptions,
  PolygonPointPartial,
  PolygonStyleOptions,
  PolygonOptions,
  PolygonUpdate,
  PolygonHandle,
  // 地形クリック
  TerrainClickEvent,
  TerrainClickListener,
  // ポリゴン頂点インタラクション
  PolygonPointPointerEvent,
  PolygonPointDragEvent,
  PolygonPointHoverListener,
  PolygonPointClickListener,
  PolygonPointDragListener,
} from "jpmap-terrain";
```

### 3.5 利用例

```html
<div id="terrain-viewer" style="width: 800px; height: 600px;"></div>
<script type="module">
  import { JpmapTerrain } from "jpmap-terrain";

  const viewer = await JpmapTerrain.create(
    document.getElementById("terrain-viewer"),
    {
      lat: 36.2333,
      lon: 137.6167,
      altitude: 5000,
      mapType: "photo",
    }
  );

  // プログラムで富士山に移動
  await viewer.flyTo({
    lat: 35.3606,
    lon: 138.7274,
    altitude: 8000,
    duration: 2000,
  });

  // UI 制御
  viewer.showCompass = false;
</script>
```

### 3.6 WebXR ユーティリティ

`JpmapTerrain` クラスとは独立した named export として、WebXR (`immersive-ar` / `immersive-vr`)
対応のコントローラー/タッチ入力を扱うためのユーティリティ関数群を提供する。`JpmapTerrain` を
使わない独自の Babylon.js シーン実装（本リポジトリの `diorama` デモ等）からも利用できる。

- 配置: `src/lib/webxr/webXrSessionSupport.ts` / `src/lib/webxr/webXrStickInput.ts`
- 全て Babylon.js `Scene`/DOM に依存しない純粋関数（`isWebXrSessionSupported` のみ
  `@babylonjs/core` の `WebXRSessionManager` に依存。`@babylonjs/core` は既存の
  `peerDependencies`（§5.1）でカバー済みのため追加の依存関係は発生しない）

#### 3.6.1 セッション対応判定

```typescript
/** WebXRセッション対応チェックのタイムアウト既定値[ms]。 */
const DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS = 4000;

/**
 * 指定したWebXRセッションモード（"immersive-ar" | "immersive-vr"）にブラウザ/デバイスが
 * 対応しているかを判定する。タイムアウト時・エラー時は非対応(false)として扱う。
 */
function isWebXrSessionSupported(
  mode: XRSessionMode,
  timeoutMs?: number, // 既定値: DEFAULT_WEBXR_SUPPORT_CHECK_TIMEOUT_MS
): Promise<boolean>;
```

#### 3.6.2 コントローラー入力変換

スティック/トリガー入力を、地図移動（パン）・拡大縮小（ズーム）・回転・高さ変更の
移動量へ変換する純粋関数群。

| 関数 | 用途 |
|---|---|
| `applyStickDeadzone(value, deadzone)` | スティック入力のデッドゾーン処理 |
| `applyDPadGate(x, y)` | 2軸入力を十字ボタン相当の排他動作へ整形 |
| `computePanMetersFromStick(axes, dtSeconds, viewScaleM, ...)` | パン移動量[m]を算出（表示スケールに比例した速度） |
| `computeZoomFactorFromStick(axisY, dtSeconds, ...)` | ズームの乗算係数を算出 |
| `clampViewScaleM(scaleM, minM?, maxM?)` | 表示スケールを範囲内へクランプ |
| `computeRotationRadFromStick(axisX, dtSeconds, ...)` | 回転角[rad]を算出 |
| `computeHeightMetersFromTriggers(leftTriggerValue, rightTriggerValue, dtSeconds, ...)` | 高さ変更量[m]を算出 |
| `clampHeightOffsetM(offsetM, minM?, maxM?)` | 高さオフセットを範囲内へクランプ |
| `computeHeadingRadFromHorizontal(x, z)` / `rotateHorizontalUnitVector(vec, deltaRad)` | 水平単位ベクトルと向き角の相互変換 |
| `computePanAxesFromDirectionalInput(forwardAxis, rightAxis, forwardUnit, rightUnit)` | 前後・左右の方向入力をパン軸へ変換 |
| `snapHeadingRad(rawHeadingRad, previousSnappedHeadingRad, ...)` | ヒステリシス付き8方位スナップ |
| `computeHorizontalDisplacement(fromX, fromZ, toX, toZ)` | 2点間の単位ベクトル・距離を算出 |
| `isInsideDeadZone(distanceM, wasInsideDeadZone, deadZoneRadiusM, ...)` | ヒステリシス付きデッドゾーン判定 |
| `normalizeAngleRad(angleRad)` / `angleDeltaRad(a, b)` | 角度の正規化・最短差分算出 |

型: `StickAxes`（`{ x: number; y: number }`）、`HorizontalUnitVector`（`{ x: number; z: number }`）、
`PanFromStickOptions`。

#### 3.6.3 利用例

```typescript
import {
  isWebXrSessionSupported,
  applyStickDeadzone,
  computePanMetersFromStick,
  computeZoomFactorFromStick,
  clampViewScaleM,
} from "jpmap-terrain";

if (await isWebXrSessionSupported("immersive-ar")) {
  // ARボタンを表示する等
}

// 毎フレーム、スティック入力から地図移動量を算出する例
const { eastM, northM } = computePanMetersFromStick(
  { x: stickX, y: stickY },
  dtSeconds,
  currentViewScaleM,
);
const zoomFactor = computeZoomFactorFromStick(zoomAxisY, dtSeconds);
currentViewScaleM = clampViewScaleM(currentViewScaleM * zoomFactor);
```

## 4. 後日実装

### 4.1 追加パラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `fov` | `number` | 視野角（度） |

> `projection` は §3.2 の `viewMode` (`"3d"` / `"2d"`) として実装済み。

### 4.2 追加 API

§3.3.7 でマーカー基本機能（CRUD + enable/disable）が正式仕様化された。
本節では、後日実装予定の **3D モデル配置** のみ残す。

```typescript
interface JpmapTerrain {
  // --- 3Dモデル ---
  /** 任意地点に3Dモデルを配置する */
  addModel(id: string, options: {
    lat: number;
    lon: number;
    modelUrl: string;  // glTF, glb, obj, stl
    scale?: number;
    rotation?: { x?: number; y?: number; z?: number };
  }): Promise<void>;
  /** モデルの表示・非表示を切り替える */
  setModelVisible(id: string, visible: boolean): void;
  /** モデルを削除する */
  removeModel(id: string): void;
}
```

> マーカー（旧 `addImageMarker` / `addLabel`）は §3.3.7 の `addMarker` に統合された。
> 日時 (`dateTime` / `autoSunPosition`) は §3.3.5 で正式仕様化済み。

## 5. パッケージ構成

```
jpmap_terrain/
├── dist/                    # ビルド出力（npm publish 対象）
│   ├── index.js             # ESM エントリ
│   ├── index.d.ts           # 型定義
│   └── ...
├── src/
│   ├── index.ts             # 既存アプリ用エントリ（デモ用に残す）
│   ├── lib.ts               # パッケージ用エントリ（新規）
│   └── terrain/
└── package.json
```

### 5.1 package.json の主要変更

```jsonc
{
  "name": "jpmap-terrain",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "peerDependencies": {
    "@babylonjs/core": "^9.0.0",
    "@babylonjs/loaders": "^9.0.0",
    "@babylonjs/materials": "^9.0.0"
  }
}
```

## 6. WebGPU / WebGL2 フォールバック

```
WebGPU 指定 → WebGPU 対応チェック → 対応: WebGPU で起動
                                     → 非対応: WebGL2 で起動（コンソールに警告）
WebGL2 指定 → WebGL2 で起動
```

既存の `src/index.ts` のフォールバックロジックをそのまま活用する。

## 7. 制約事項

- 日本国内の範囲のみ対応（緯度 20°〜46°、経度 122°〜154°）
- 地理院タイルの利用規約に従うこと（出典表記が必要）
- ブラウザ要件: WebGL2 対応ブラウザ（Chrome 56+, Firefox 51+, Safari 15+, Edge 79+）

## 8. 用語対応表

| パッケージ API | Babylon.js 内部 | 説明 |
|---|---|---|
| `lat` | Z 軸 | 緯度 |
| `lon` | X 軸 | 経度 |
| `altitude` | Y 軸 / camera radius | 高度（メートル） |
| `azimuth` | camera alpha | 方位角（度、北=0、時計回り） |
| `tilt` | camera beta | チルト角（度、真下=0、水平=90） |
| `mapType` | タイルURL 切替 | 標準地図 / 航空写真 |
