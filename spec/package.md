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

### 3.4 利用例

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
| `dateTime` | `Date \| null` | 日時指定（太陽位置シミュレーション） |
| `autoSunPosition` | `boolean` | 時刻による太陽位置の自動計算 |

### 4.2 追加 API

```typescript
interface JpmapTerrain {
  // --- マーカー ---
  /** 任意地点に画像マーカーを追加する */
  addImageMarker(id: string, options: {
    lat: number;
    lon: number;
    imageUrl: string;
    width?: number;
    height?: number;
  }): void;
  /** マーカーの表示・非表示を切り替える */
  setMarkerVisible(id: string, visible: boolean): void;
  /** マーカーを削除する */
  removeMarker(id: string): void;

  // --- テキストラベル ---
  /** 任意地点にテキストラベルを追加する */
  addLabel(id: string, options: {
    lat: number;
    lon: number;
    text: string;
    fontSize?: number;
    color?: string;
  }): void;
  /** ラベルの表示・非表示を切り替える */
  setLabelVisible(id: string, visible: boolean): void;
  /** ラベルを削除する */
  removeLabel(id: string): void;

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

  // --- 日時 ---
  /** 日時を取得・設定する */
  dateTime: Date | null;
  /** 太陽位置の自動計算を取得・設定する */
  autoSunPosition: boolean;
}
```

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
