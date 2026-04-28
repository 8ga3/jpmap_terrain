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
    fontSize?: number;      // px (default 14)
    color?: string;         // CSS color (default "#ffffff")
    backgroundColor?: string; // CSS color (default "rgba(0,0,0,0.6)")
    lineHeight?: number;    // 倍率 (default 1.2)
  };
  line?: {
    color?: string;  // default "#ffffff"
    width?: number;  // m (default 1.5)
    height?: number; // m (default 200)
  };
  enabled?: boolean; // default true
}
```

**仕様:**

- `icon` と `text` は **少なくとも片方が必須**。両方指定時は **上=text、下=icon** の順で線の上にスタックする。
- ビルボードは `BILLBOARDMODE_ALL` でカメラ常時追従。`renderingGroupId = 1` で最前面に描画する。
- 表示位置の高さは「タイル表面の標高 + `line.height`」。標高未取得地点では描画を保留し、対応するタイルロード後（`onTerrainUpdated`）に自動で表示する（例外は投げない）。
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
