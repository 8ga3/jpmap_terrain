# 開発フロー

このドキュメントは、`jpmap_terrain` における日常的な実装作業の進め方を定義します。

## 基本フロー

1. Issue を作成し、目的・背景・完了条件を明確化する
2. ブランチを作成して実装する
3. ローカルで lint / typecheck / test を実行する
4. Pull Request を作成し、影響範囲を記載する
5. レビュー対応後に再度検証し、マージする

## 実装前の確認

- 仕様変更を伴う場合は、関連ドキュメントを更新対象に含める
- 変更が API / 型 / 挙動に及ぶ場合、PR本文に影響範囲を明記する

## ローカル実行コマンド

```shell
npm start
npm run lint
npm run typecheck
npm run test:unit
npm run test:visuals
```

Visual Regression Test の基準更新が必要な場合:

- `npm run test:visuals:update` は毎回実行しない
- 画面表示（UI/描画結果）に意図した変更がある場合にのみ、開発者が基準画像を更新する

```shell
npm run test:visuals:update
```

## Definition of Done

以下をすべて満たした状態を完了とします。

1. 定義済みテストが成功している
2. `npm run lint` と `npm run typecheck` が成功している
3. コーディングルール観点でレビュー済みである
4. 手戻り修正が入った場合、再度 lint / typecheck / test を実行済みである

## 手動テスト: Geolocation（現在地ボタン）

現在地が日本の対応エリア（JAPAN_BOUNDS: lat 20〜46, lon 122〜154）外の場合にトースト通知が表示されることを確認する手順。

### Chrome DevTools で位置情報をオーバーライド

1. DevTools を開く（F12）
2. 右上の `⋮` → **More tools** → **Sensors**
3. **Location** を `Other…` に変更
4. 範囲外の座標を入力（例: `Latitude: 0`, `Longitude: 0`）
5. アプリ上の「現在地を表示」ボタンをクリック
6. 画面下部中央に「現在地は対応エリア外のため、最も近い地点を表示します」のトーストが約3秒間表示されることを確認

### コンソールから直接確認（開発ビルドのみ）

```js
showToast("テストメッセージ")
```

> 開発ビルドでは `window.showToast` が公開されており、コンソールから直接呼び出せます。

## レビュー観点（要約）

- 仕様整合性: 仕様と実装が矛盾していないか
- 型・静的品質: 安易な any 導入や未使用コードがないか
- 変更影響: 画面/API/ドキュメントの影響が明示されているか

詳細は `AGENTS.md` を参照してください。

## 既知の問題・ワークアラウンド

### URL 更新 debounce 遅延 (Issue #225)

**現象**: ドラッグ後にリロードするとカメラ位置がずれる。

**原因（推定）**: Babylon.js の `ArcRotateCamera` はドラッグ終了直後（pointerup）の時点では
内部状態の確定が完了していない可能性がある。`onBeforeRenderObservable` を通じて取得する
`camera.position` / `camera.target` が、直後のフレームで古い値を返すケースが確認されている。

**ワークアラウンド**:
- `src/demos/viewer/index.ts` の `createUrlUpdater` の debounce を **1000ms** に設定している。
  500ms 以下では地図の場所によって再現することが確認されている。
- pointerup 時に `onCameraInteractionEnd` コールバックで `_notifyIfChanged(force=true)` を
  呼び出すことで、epsilon 比較による取りこぼしを補完している（`jpmapTerrain.ts`）。

**今後の対応**:
- Babylon.js 側のバグである可能性がある。バージョンアップ後に 1000ms 未満で動作するか検証を推奨する。
- `timelapse` などの他のデモで同様の問題が発生した場合は debounce を揃えて調整する。

