# パッケージ仕様書

> **Issue**: [#81 パッケージ仕様設計](https://github.com/8ga3/jpmap_terrain/issues/81)
> **Parent Issue**: [#80 パッケージ化](https://github.com/8ga3/jpmap_terrain/issues/80)
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
| `altitude` | `number` | `2000` | 高度（メートル、Babylon.js Y 軸に対応） |
| `azimuth` | `number` | `0` | 方位角（度、Babylon.js camera alpha に対応） |
| `tilt` | `number` | `45` | チルト角（度、Babylon.js camera beta に対応） |
| `mapType` | `"standard" \| "photo"` | `"standard"` | 地図種類（標準地図 / 航空写真） |
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

  /** 現在の高度（get / set） */
  get altitude(): number;
  set altitude(value: number);

  /** カメラ方位角・度（get / set） */
  get azimuth(): number;
  set azimuth(value: number);

  /** カメラチルト角・度（get / set） */
  get tilt(): number;
  set tilt(value: number);

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

#### 3.3.5 mapType 変化イベント (Issue #149)

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

**`showSunShadows` 仕様 (Issue #39):**

- 既定 `false`（OFF）。OFF 時は `ShadowGenerator` を生成せず、GPU 負荷を発生させない。
- `true` を set すると `ShadowGenerator`（解像度 1024 / `usePercentageCloserFiltering=true` / `darkness=0.4`）を生成し、現時点でアクティブな地形タイルおよび以後追加されるタイルメッシュを caster / receiver として登録する。
- `false` に戻すと caster/receiver 設定を解除し `ShadowGenerator` を dispose する。
- 同値の再 set は no-op。`dispose()` 後の set も no-op。
- `dispose()` 時に `ShadowGenerator` は確実に解放される。
- URL クエリ `?showSunShadows=true|false` で初期値を制御できる（`true`/`false` 以外の値は無視）。

#### 3.3.7 マーカー (Issue #167)

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
- ビルボードは `BILLBOARDMODE_ALL` でカメラ常時追従。`renderingGroupId = 1` で最前面に描画する。
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

**`mapType` URL クエリ仕様 (Issue #149):**

- URL クエリ `?mapType=standard|photo` で初期値を上書きできる（デモ層）。
- 値は大小文字無視で受理する（例: `?mapType=Photo` も `"photo"` として解釈）。書き戻し時は小文字に正規化する。
- 不正値・欠落・URL 解析失敗時は `JPMAP_TERRAIN_DEFAULTS.mapType`（= `"standard"`）にフォールバックする（例外は投げない）。
- `viewer.mapType` の変化（UI 切替ボタン / プログラム set）は `onMapTypeChange` 経由でデモ層が `history.replaceState` により URL の `?mapType=` を更新する。パス（`/@lat,lon[,...]`）と他クエリ（`engine`, `dateTime` 等）・ハッシュは保持される。

#### 3.3.8 ポリゴン (Issue #169)

任意の点列を受け取り、地表または絶対標高に沿って **ポイント球体** と **ポリライン** を表示する API（基盤）。

##### 3.3.8.1 公開 API（基盤＋ポリライン＋垂線/ラベル＋壁: Issue #170 / #171 / #172）

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
  /** 各点からの垂線表示をポリゴン単位で ON/OFF (#171) */
  setVerticalsEnabled(id: string, enabled: boolean): void;
  /** ラベル表示をポリゴン単位で ON/OFF (#171) */
  setLabelsEnabled(id: string, enabled: boolean): void;
  /** 壁表示をポリゴン単位で ON/OFF (#172) */
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
  // #170 で実装
  pointColor?: string;     // CSS color (default "#ff0000")
  pointOpacity?: number;   // 0..1 (default 1)
  pointDiameter?: number;  // m (default 20)
  lineColor?: string;      // CSS color (default "#ff0000")
  lineOpacity?: number;    // 0..1 (default 1)
  lineWidth?: number;      // m (Tube radius, default 2)
  // #171 で実装
  dropLineColor?: string;     // CSS color (default "#ff0000")
  dropLineWidth?: number;     // m (Tube radius, default 1)
  dropLineOpacity?: number;   // 0..1 (default 1)
  labelColor?: string;        // CSS color (default "#000000")
  labelBackgroundColor?: string; // CSS color (default "transparent")
  labelFontSize?: number;     // px (default 14)
  // #172 で実装
  wallColor?: string;         // CSS color (default "#ff0000")
  wallOpacity?: number;       // 0..1 (default 0.3)
}

interface PolygonOptions {
  points: ReadonlyArray<PolygonPointOptions>; // 2 点以上
  altitudeMode?: AltitudeMode;                // default "terrain"
  /** `true` でポリラインの末尾と先頭を結んで閉じる。壁・垂線も同様に閉じられる (#172)。default false */
  closed?: boolean;
  /** ラベル（点ごと）。#171 で実装済み。`labels[i]` が文字列のときその点にラベルを描画する。 */
  labels?: ReadonlyArray<string>;
  style?: PolygonStyleOptions;
  enabled?: boolean;                          // default true
  /** 各点から地表へ落とす垂線の表示 (#171 実装済み)。default true */
  verticalsEnabled?: boolean;
  /** ラベルの表示 (#171 実装済み)。default true */
  labelsEnabled?: boolean;
  /** 隣接垂線間をつなぐ壁の表示 (#172 実装済み)。default true */
  wallsEnabled?: boolean;
}
```

**#170 範囲の仕様:**

- `points` の各点に対し、`altitudeMode === "absolute"` なら `altitude` をそのまま Y に採用する。`"terrain"` ならタイル標高 (m) を Y に採用し、`altitude` が指定されている場合は地表からのオフセットとして加算する。
- `terrain` モードで 1 点でも標高未解決の間は **ポリゴン全体を hide** し、`onTerrainUpdated` 後に自動表示する（例外は投げない）。
- 各点に直径 `style.pointDiameter` (m) の **球体メッシュ** を配置する（既定色 `#ff0000`、emissive、`renderingGroupId = 1`）。スケールはカメラ距離に応じて screen-stable に動的更新される。
- 隣接点間を **CreateTube**（`updatable: true`、半径 `style.lineWidth`）で結ぶ。`closed = true` のとき末尾→先頭も結ぶ。
- JAPAN_BOUNDS 外の点・`points.length < 2`・`absolute` で `altitude` 未指定の場合は `addPolygon` で throw（範囲外の点 index をメッセージに含める）。
- 同 id の重複追加は throw、`removePolygon` の未存在 id は `console.warn` + no-op。
- `dispose()` で全ポリゴンリソース（Mesh / Material / TransformNode）を解放する。
- **#171 実装済み**: 各点から地表（タイル標高、未解決時は Y=0 フォールバック）へ落とす垂線を **CreateTube**（updatable、半径 `style.dropLineWidth`）で描画。`labels[i]` が指定された点に DynamicTexture + ビルボード Plane でラベルを描画（`labelColor` / `labelBackgroundColor` / `labelFontSize` 反映）。`JpmapTerrain.setVerticalsEnabled(id, enabled)` / `setLabelsEnabled(id, enabled)` で表示切替が可能。`PolygonOptions.verticalsEnabled` / `labelsEnabled`（既定 true）で初期表示制御。
- **#172 実装済み**: 隣接する点間を上 row=頂点位置、下 row=地表 Y の Ribbon として 1 枚の **CreateRibbon**（`updatable: true`, `sideOrientation: DOUBLESIDE`）で壁表示。`closed=true` のときは上/下 row とも末尾に先頭頂点を append して閉じる。`style.wallColor` / `style.wallOpacity`（default `#ff0000` / `0.3`）を StandardMaterial の `emissiveColor` / `alpha` に反映し、半透明時は `needDepthPrePass=true` で z-fight を緩和する。`JpmapTerrain.setWallsEnabled(id, enabled)` で表示切替が可能。`PolygonOptions.wallsEnabled`（既定 true）で初期表示制御。`renderingGroupId=1` はポリライン・垂線・球・ラベルと同一。
- **#173 で実装予定**: `updatePolygon`、点単位編集 API（`insertPoint` / `removePoint` / `updatePoint` / `replacePoints`）、デモ拡張、視覚回帰テスト。

##### 3.3.8.2 ポリゴン点編集 API（Issue #173）

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
  /** 指定 index の頂点を削除する。残り 2 点未満になる場合は throw。 */
  removePolygonPoint(id: string, index: number): PolygonHandle;
  /** 指定 index の頂点を部分更新する。partial 未指定フィールドは現状維持。 */
  updatePolygonPoint(id: string, index: number, partial: PolygonPointPartial): PolygonHandle;
  /** 全頂点を置き換える。`points.length < 2` は throw。 */
  replacePolygonPoints(id: string, points: ReadonlyArray<PolygonPointOptions>): PolygonHandle;
}
```

**バリデーション:**

- 共通: dispose 後 / 未存在 id は throw。
- `insertPolygonPoint`: `index` が `[0, points.length]` の範囲外なら `RangeError`。`lat/lon` が JAPAN_BOUNDS 外なら throw。`altitudeMode === "absolute"` で `altitude` 未指定なら throw。
- `removePolygonPoint`: 削除後の点数が 2 点未満になる場合は throw。`index` が範囲外なら `RangeError`。
- `updatePolygonPoint`: `index` が範囲外なら `RangeError`。`lat`/`lon` の partial が指定されたとき、現状値とのマージ結果に対し JAPAN_BOUNDS 検査を行う。`altitudeMode === "absolute"` のとき `altitude` を `undefined` にしても現状値は維持されるため throw しない（明示的に書き換える場合のみ partial に含める）。
- `replacePolygonPoints`: `points.length < 2` は throw。各点の JAPAN_BOUNDS / `absolute` モードの altitude 必須は `addPolygon` と同じ規則で検査する。

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
}

/** `JpmapTerrain.onCameraChange` リスナー */
type CameraChangeListener = (event: CameraChangeEvent) => void;

/** `JpmapTerrain.onMapTypeChange` リスナー (Issue #149) */
type MapTypeChangeListener = (mapType: MapType) => void;
```

```typescript
import type {
  CameraChangeEvent,
  CameraChangeListener,
  MapType,
  MapTypeChangeListener,
  // ポリゴン (Issue #170)
  AltitudeMode,
  PolygonPointOptions,
  PolygonPointPartial,
  PolygonStyleOptions,
  PolygonOptions,
  PolygonUpdate,
  PolygonHandle,
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

## 4. 後日実装

### 4.1 追加パラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `projection` | `"perspective" \| "orthographic"` | 射影投影 / 平行投影の切り替え |
| `fov` | `number` | 視野角（度） |

### 4.2 追加 API

§3.3.7 でマーカー基本機能（CRUD + enable/disable）が正式仕様化された (Issue #167)。
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

> マーカー（旧 `addImageMarker` / `addLabel`）は §3.3.7 の `addMarker` に統合された (Issue #167)。
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
│   ├── createScene.ts
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
