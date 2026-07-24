# ジオラマ表示API仕様書（`JpmapDiorama`）

> **ステータス**: 確定（Issue [#569](https://github.com/8ga3/jpmap_terrain/issues/569) 対応。[#570](https://github.com/8ga3/jpmap_terrain/issues/570)〜[#573](https://github.com/8ga3/jpmap_terrain/issues/573) で実装・移行・ドキュメント整備が完了）

---

## 1. 概要

現在 `src/demos/diorama/` にデモ専用実装として存在する「箱庭ジオラマビューア」を、`JpmapTerrain`（`spec/terrain-api.md`）と対をなす**独立した第2の公開API** `JpmapDiorama` としてパッケージ化する。標準WebブラウザとWebXR (`immersive-ar`) セッションの双方で、任意のホストアプリケーションからマウントポイント（DOM要素）を指定して高パフォーマンスに埋め込めるようにする。

`JpmapTerrain` には依存しない（実寸大ECEF楕円体 + floating originを使う`GlobeScene`ではなく、正方形グリッド + 実世界DEM/タイル取得 + 縮小スケールという独立実装のため。理由は `src/terrain/diorama/dioramaTerrain.ts` 冒頭コメント参照）。

## 2. 設計方針（3点）

1. **地形コアは現状維持、状態保持者をlib層へ集約**: `src/terrain/diorama/*`（グリッド生成・DEMサンプリング・テクスチャ合成・地形メッシュ構築）はほぼそのまま再利用する。`src/demos/diorama/*` にある「共有状態保持者」（`DioramaViewController` / `DioramaOrientationController` / `DioramaTileModeController`）の責務を新規公開クラス `JpmapDiorama`（`src/lib/jpmapDiorama.ts`）へ集約し、mount〜dispose・入力集約・AR統合を1つの公開APIにまとめる。
2. **内蔵コントロールと低レベルAPIの二層構成**: 既存デモの挙動（キーボード＋タッチHUD常時有効、AR中は専用HUD＋XRコントローラー）は `enableDefaultControls`（既定 `true`）でそのまま踏襲する。一方、host アプリが独自の入力・UIから操作したいケース（例: host側が独自のXR UIを持つ、ゲームパッドを直接扱いたい等）向けに、`feedPanZoomAxes` / `feedOrientationAxes` / `cycleTileMode` という低レベル連続入力APIを常に公開する。
3. **段階移行・挙動不変**: 既存デモ（`src/demos/diorama/index.ts`）は新APIを呼ぶだけの薄いラッパーに置き換える。外部から見た挙動（見た目・操作感・URL）は変えず、Visual Regression Test（`npm run test:visuals`）とユーザー目視確認（HITL）で担保する。

## 3. 変更概要（実施済み）

| 種別 | パス | 内容 |
|---|---|---|
| 新規 | `src/lib/jpmapDiorama.ts` | `JpmapDiorama` クラス本体（`JpmapTerrain.create()` と同様、`static async create()` で生成） |
| 新規 | `src/lib/types.ts`（追記） | Diorama関連の公開型（Options/Event/Listener等）を追加 |
| 移動 | `src/demos/diorama/dioramaViewController.ts` 他、状態保持者3ファイル | `src/lib/internal/diorama/` 配下へ移動し `JpmapDiorama` から利用（ロジック自体は変更していない） |
| 縮小 | `src/demos/diorama/index.ts` | 新API呼び出しのみに置き換え済み（`#root` へのマウント・`?engine=` クエリ解決等デモ固有処理のみが残る） |
| 変更 | `src/lib.ts` | `JpmapDiorama` と関連型のexportを追加 |
| 新規 | `spec/diorama-api.md`（本ファイル） | 公開API仕様 |

`src/demos/diorama/dioramaArControlHud.ts` / `dioramaArControls.ts` / `dioramaControllerMapping.ts` / `dioramaKeyboardControls.ts` / `dioramaTouchControls.ts` / `webXrArSession.ts` / `dioramaHorizontalDirection.ts` は、内蔵コントロール実装として同様に `src/lib/internal/diorama/` へ移動済み（`enableDefaultControls: true` 時にのみ `JpmapDiorama` 内部から生成される）。

## 4. 代替案（最大2）

- **代替案A（不採用）: `JpmapTerrain` にジオラマ表示モードとして統合する**（例: `viewMode: "diorama"`）。
  却下理由: 既存実装は意図的に独立（ECEF floating origin不使用、実寸メートル座標系、AR特有の`reverse-Z`無効化・カメラ制約）である旨が `dioramaTerrain.ts`/`index.ts` 冒頭コメントに明記されている。`JpmapTerrain` の既存の巨大なAPI（マーカー/ポリゴン/サークル/モデル/日照等）との混在は複雑性を増すだけで、独立実装を保つ既存方針に反する。
- **代替案B（不採用、将来再検討の余地あり）: 状態保持者群を `src/demos/diorama/` に残し、`JpmapDiorama` はそれらをre-exportするだけの薄いファサードにする**。
  却下理由: `src/demos/` はデモ専用ディレクトリという既存の構成規約（[spec/architecture.md](architecture.md) L2: Demo Apps は `lib`/`terrain` に依存する一方向、逆向きの依存は無い）に反し、npmパッケージ配布物（`tsdown` ビルド対象）にデモ専用コードが混入するリスクがある。移行コストを最小化したい場合の一時退避先としてCoder工程開始時に再検討してよい。

## 5. インターフェース（API / 型）

### 5.1 マウントポイント指定型

```typescript
import { JpmapDiorama } from "jpmap-terrain";

const diorama = await JpmapDiorama.create(document.getElementById("diorama")!, {
  center: { lat: 35.3436, lon: 138.7203 },
  footprintHalfSizeM: 800,
  tableRadiusM: 0.35,
  tileMode: "std",
  engine: "webgl2", // 既定。AR実機（Meta Quest Browser等）互換性を優先し JpmapTerrain の既定 "webgpu" とは異なる
});
```

### 5.2 初期パラメータ

| パラメータ | 型 | デフォルト値 | 説明 |
|---|---|---|---|
| `center` | `{ lat: number; lon: number }` | （必須） | 実世界の中心（測地座標） |
| `footprintHalfSizeM` | `number` | `800` | 実世界フットプリントの半辺長[m] |
| `tableRadiusM` | `number` | `0.35` | 卓上表示半径[m]（手元サイズ） |
| `tileMode` | `"std" \| "photo" \| "wireframe"` | `"std"` | タイル種別（標準地図/写真/ワイヤーフレーム） |
| `engine` | `"webgpu" \| "webgl2"` | `"webgl2"` | 描画エンジン。AR実機互換性を優先した既定値（`dioramaTerrain.ts`/`index.ts` 既存コメント参照） |
| `gridSegments` | `number` | `48` | 正方形グリッドの1辺あたりの分割数 |
| `demZoom` | `number` | 自動算出 | 標高取得ズーム（省略時 `footprintHalfSizeM` から自動算出） |
| `textureZoom` | `number` | 自動算出 | テクスチャ取得ズーム（省略時 `footprintHalfSizeM` から自動算出） |
| `heightScaleFactor` | `number` | `1` | 標高の垂直誇張倍率 |
| `baseDepthRatio` | `number` | `0.15` | 側面壁（土台）の深さ比率 |
| `enableDefaultControls` | `boolean` | `true` | `true`: キーボード（デスクトップ）＋常時表示タッチHUDを内蔵。`false`: 内蔵UIなし、`feedPanZoomAxes`等の低レベルAPIのみで操作（host独自UI向け） |
| `showArButton` | `boolean` | `true` | WebXR ARボタンを表示するか。AR (`immersive-ar`) 非対応環境では機能検出後に自動非表示（既存挙動） |

### 5.3 API & プロパティ

#### 5.3.1 表示（中心・フットプリント）

```typescript
interface JpmapDiorama {
  /** 現在の実世界中心（読み取り専用スナップショット）。 */
  get center(): DioramaCenter;
  /** 現在のフットプリントの半辺長[m]（読み取り専用スナップショット）。 */
  get footprintHalfSizeM(): number;

  /** 中心を変更する（地形の再構築を伴う非同期処理）。 */
  setCenter(lat: number, lon: number): Promise<void>;
  /** フットプリントの半辺長[m]を変更する（地形の再構築を伴う非同期処理）。 */
  setFootprintHalfSize(halfSizeM: number): Promise<void>;
  /**
   * 中心・フットプリント半辺長の一方または両方を1回の再構築にまとめて適用する。
   * 個別に呼ぶより低遅延（`dioramaTerrain.ts` の `setView` と同じ設計意図）。
   */
  setView(patch: { center?: DioramaCenter; footprintHalfSizeM?: number }): Promise<void>;
  /** 中心・フットプリント半辺長が変化した後に発火する。 */
  onViewChange(listener: JpmapDioramaViewChangeListener): () => void;
}
```

#### 5.3.2 タイル種別

```typescript
interface JpmapDiorama {
  /** 現在のタイル種別（読み取り専用スナップショット）。 */
  get tileMode(): DioramaTileMode;
  /** タイル種別を明示的に変更する。 */
  setTileMode(tileMode: DioramaTileMode): Promise<void>;
  /** 巡回順序（std→photo→wireframe→std…）で次のタイル種別へ切り替える。 */
  cycleTileMode(): void;
  /** タイル種別が変化した後に発火する。 */
  onTileModeChange(listener: DioramaTileModeChangeListener): () => void;
}
```

#### 5.3.3 向き・高さ

同期的に反映される（DEM/テクスチャの再取得を伴わないため）get/set プロパティとして提供する。

```typescript
interface JpmapDiorama {
  /** 箱庭全体の回転角・度（get / set）。 */
  get rotationDeg(): number;
  set rotationDeg(value: number);
  /** 箱庭の設置高さオフセット[m]（get / set）。 */
  get heightOffsetM(): number;
  set heightOffsetM(value: number);
}
```

#### 5.3.4 低レベル連続入力API

`enableDefaultControls: false` の場合、または内蔵UIに加えて独自入力（ゲームパッド等）を併用したい場合に、host アプリが毎フレーム呼ぶ。既存の `DioramaViewController.feedAxes` / `DioramaOrientationController.feedAxes` と同じ軸表現を踏襲する。

```typescript
interface JpmapDiorama {
  /** パン軸・ズーム軸（[-1,1]）を1フレーム分適用する。 */
  feedPanZoomAxes(panAxes: { x: number; y: number }, zoomAxisY: number, dtSeconds: number): void;
  /** 回転軸・左右トリガー値（[0,1]）を1フレーム分適用する。 */
  feedOrientationAxes(
    rotationAxisX: number,
    leftTriggerValue: number,
    rightTriggerValue: number,
    dtSeconds: number,
  ): void;
}
```

#### 5.3.5 WebXR AR

```typescript
interface JpmapDiorama {
  /** WebXR (`immersive-ar`) にブラウザ/デバイスが対応しているかを判定する。 */
  isArSupported(): Promise<boolean>;
  /** 現在のARセッション状態（読み取り専用スナップショット）。 */
  get arState(): DioramaArState; // "unsupported" | "inactive" | "active"
  /** ARセッションへ突入する（`isArSupported()` が `false` の場合は reject）。 */
  enterAr(): Promise<void>;
  /** ARセッションから退出する（非AR中は no-op）。 */
  exitAr(): Promise<void>;
  /** ARセッション状態が変化した後に発火する。 */
  onArStateChange(listener: DioramaArStateChangeListener): () => void;
}
```

#### 5.3.6 破棄・リサイズ

```typescript
interface JpmapDiorama {
  /** シーン・イベントリスナー・DOM要素（HUD/ARボタン）を破棄する。冪等（2回以上呼んでも安全）。 */
  dispose(): void;
  /**
   * リサイズを通知し Engine を再計測する。内部は `ResizeObserver` でマウント要素の
   * サイズ変化に自動追従するため、通常は手動呼び出し不要（host側で明示的な
   * 再計測タイミングが必要な場合のみ使用）。
   */
  resize(): void;
}
```

### 5.4 型定義

```typescript
/** ジオラマ表示の中心（測地座標）。 */
export interface DioramaCenter {
  lat: number;
  lon: number;
}

/** ジオラマのタイル種別。 */
export type DioramaTileMode = "std" | "photo" | "wireframe";

/** WebXR ARセッションの状態。 */
export type DioramaArState = "unsupported" | "inactive" | "active";

export interface JpmapDioramaOptions {
  center: DioramaCenter;
  footprintHalfSizeM?: number;
  tableRadiusM?: number;
  tileMode?: DioramaTileMode;
  engine?: EngineType;
  gridSegments?: number;
  demZoom?: number;
  textureZoom?: number;
  heightScaleFactor?: number;
  baseDepthRatio?: number;
  enableDefaultControls?: boolean;
  showArButton?: boolean;
}

export interface JpmapDioramaViewChangeEvent {
  center: DioramaCenter;
  footprintHalfSizeM: number;
}
export type JpmapDioramaViewChangeListener = (event: JpmapDioramaViewChangeEvent) => void;
export type DioramaTileModeChangeListener = (tileMode: DioramaTileMode) => void;
export type DioramaArStateChangeListener = (state: DioramaArState) => void;
```

### 5.5 利用例

```typescript
import { JpmapDiorama } from "jpmap-terrain";

const diorama = await JpmapDiorama.create(document.getElementById("diorama")!, {
  center: { lat: 35.3436, lon: 138.7203 },
  footprintHalfSizeM: 800,
  tableRadiusM: 0.35,
});

diorama.onArStateChange((state) => {
  console.info(`[my-app] diorama AR state changed: ${state}`);
});

// タイル種別を写真に切り替える
await diorama.setTileMode("photo");

// AR対応環境ならARボタンを使わずプログラムから突入することもできる
if (await diorama.isArSupported()) {
  await diorama.enterAr();
}
```

## 6. 互換性・移行

- **破壊的変更なし**（新規追加API）。既存デモURL `/diorama.html` の挙動・見た目は変えていない（各段階で Visual Regression Test・ユーザー目視確認により担保）。
- 移行は以下のIssueに分割して実施し、すべて完了している。
  1. [#570](https://github.com/8ga3/jpmap_terrain/issues/570) 状態保持者・入力コントロール群の `src/lib/internal/diorama/` への移動（ロジック不変、import path更新のみ）
  2. [#571](https://github.com/8ga3/jpmap_terrain/issues/571) 型定義追加（`src/lib/types.ts`）+ `JpmapDiorama` 実装 + `src/lib.ts` エクスポート追加
  3. [#572](https://github.com/8ga3/jpmap_terrain/issues/572) 既存デモ (`src/demos/diorama/index.ts`) の新API移行
  4. [#573](https://github.com/8ga3/jpmap_terrain/issues/573) ドキュメント更新（本ファイル・`spec/demos.md`・`README.md`）
- 各Issueに対応するPRで `npm run lint` / `npm run typecheck` / `npm run test:unit` / `npm run test:visuals` を通過させている。
- 既存ユニットテスト（`tests/diorama*.unit.spec.ts`）はモジュール移動に伴い import path を更新した。テストケース自体（純粋関数のロジック検証）は変更していないものが大半。`JpmapDiorama` クラス本体の公開APIユニットテストは `tests/jpmapDiorama.unit.spec.ts` に追加している。
- 3DCG描画・AR実機挙動に関わる変更のため、各段階でユーザーの目視確認（HITL）を必須ゲートとして実施済み。

## 7. 観測性（ログ）

- 既存の `measureAsync`（`dioramaPerfLog.ts`、DEM/テクスチャ取得等の非同期処理時間計測）を `JpmapDiorama` 経由でも継続する。
- `console.*` 出力は AGENTS.md のログ出力言語ルールに従い英語 + `[jpmap-terrain diorama]` プレフィックスに統一している（デモ内メッセージは `[jpmap-terrain diorama demo]`、ライブラリ本体からの出力は `[jpmap-terrain diorama]` とし、デモ固有の残存コードのみ `demo` サフィックスを維持する）。
- `enterAr()` / `exitAr()` の失敗（`WebXRSessionManager` 例外等）は reject し、host アプリ側でハンドリングできる（既存コードの `console.error` 握りつぶしのみで終わらせない）。

## 8. 制約事項

- `JpmapDiorama` は `JpmapTerrain` と同一ページに共存可能だが、両者間の連携（例: globe表示からジオラマへの遷移アニメーション）は本Issueの範囲外。
- カメラ（`ArcRotateCamera`）は既定でAPI内部が生成・制御する。host側が独自カメラを持ち込むケースは後日実装（§9参照）。
- 床検出（hit-test）によるAR実世界テーブル高さの自動推定は対象外（既存デモと同じ固定値 `AR_TABLE_HEIGHT_M` を踏襲）。

## 9. 後日実装

- host側カメラの持ち込み（`attachDefaultCamera: false` 等のオプション）
- `JpmapTerrain`⇄`JpmapDiorama` 間の連携（地点選択からのジオラマ起動等）
- マーカー・ポリゴン等のオーバーレイ機能のジオラマ対応（`JpmapTerrain` 同等機能）
