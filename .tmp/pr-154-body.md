<!-- Copilot Code Review: Follow .github/copilot-instructions.md. -->
<!-- Copilot Code Review: Follow AGENTS.md. -->
<!-- Copilot Code Review: Write all review comments in Japanese. -->

## 概要

複数デモを束ねるデモポータル（`/`）と、24 時間を 1 分に圧縮したタイムラプスデモ（`/timelapse.html`）を追加します。タイムラプスデモは太陽位置・陰影アニメーションを `JpmapTerrain.dateTime` 駆動でループ再生し、画面下部中央に SVG アナログ時計（JST 表示）をオーバーレイします。今後デモを増やしやすくするため、webpack を多エントリ化（`portal` / `viewer` / `timelapse`）し、既存ビューアは `/viewer.html` に移設しました。

## 関連 Issue

Closes #147

## 変更内容

- 多エントリ webpack 構成
  - `webpack.common.js` を `ENTRY_DEFINITIONS` ベースに変更し、3 つの `HtmlWebpackPlugin` で `index.html` / `viewer.html` / `timelapse.html` を生成
  - `splitChunks` の `babylonBundle` / shaders / extensions は据え置き（viewer と timelapse で共有）
- ディレクトリ再編
  - `src/index.ts` → `src/demos/viewer/index.ts` に移設（中身は import パス調整のみ）
  - `public/index.html` → `public/viewer.html` に rename
- デモポータル（新規）
  - `src/demos/portal/index.ts`：Babylon.js を読み込まない軽量ポータル（424 KiB）。`DEMO_LIST` に追記するだけでデモ追加可能
  - `public/portal.html`：カードリスト型 UI のテンプレート
- タイムラプスデモ（新規）
  - `src/demos/timelapse/index.ts`：`autoSunPosition` 強制 OFF、`requestAnimationFrame` ループで `viewer.dateTime` を 200ms 間引き更新、`showSunShadows` 既定 ON
  - `src/demos/timelapse/timelapseClock.ts`：`computeSimulatedDate` / `parseTimelapseQuery` / `sanitizeTimelapseOptions` の純粋関数群
  - `src/demos/timelapse/clockOverlay.ts`：SVG アナログ時計（時針・分針・秒針が連続回転）。表示は **JST (UTC+9)**
  - `public/timelapse.html`：時計＋ラベルを画面下部中央に縦積み配置（flex `align-items:center` で中央揃え）
- URL 規約
  - timelapse: `?start=<ISO8601>` / `?speed=<秒>`（既定 60、24h を何秒に圧縮するか）/ `?paused`（テスト用）/ `?showSunShadows=true|false`
  - viewer は従来規約を維持（`/@lat,lon` 等）
- 公開ライブラリ層 (`src/lib/**`) は無変更
- Playwright VR テスト
  - `tests/validation.spec.ts` の URL を `/?scene=default` → `/viewer.html?scene=default` に更新（描画内容は同一のため既存スナップは流用可能）
- Unit テスト追加
  - `tests/timelapseClock.unit.spec.ts`：時刻計算・URL パース・境界値
  - `tests/clockOverlay.unit.spec.ts`：JST 角度計算・ラベル整形・DOM マウント
  - `tests/portal.unit.spec.ts`：ポータル HTML 生成と XSS エスケープ
  - `tests/index.unit.spec.ts`：import パスを `src/demos/viewer/index` に追従
- ドキュメント
  - `spec/demos.md`（新規）：デモポータル方針、URL 規約、新規デモ追加手順
  - `spec/README.md`：`spec/demos.md` への参照追加
  - `README.md`：デモポータル節追加、URL 例を `/viewer.html` に更新、ディレクトリツリー更新

## スクリーンショット

UI の追加: 画面下部中央のアナログ時計＋JST ラベル。ポータルはカード型のリンク一覧。

> ローカル確認手順は「動作確認方法」を参照してください（GitHub 上では添付なし）。

## 動作確認方法

```shell
npm install
npm start
```

- `http://localhost:8080/` … デモポータル（カードから各デモへ遷移）
- `http://localhost:8080/viewer.html?engine=webgpu` … 既存 3D ビューア
- `http://localhost:8080/timelapse.html` … タイムラプス（24h を 60s で再生、画面下部中央にアナログ時計／JST 表示）
  - 例: `?speed=120&start=2025-06-21T00:00:00Z` で 120 秒周期、`?paused` で停止

検証コマンド:

```shell
npm run typecheck
npm run lint
npm run test:unit       # 23 suites / 428 tests
npm run test:visuals    # 12 tests（viewer の URL 更新済み、スナップは流用）
```

## 確認事項

- [x] Copilot レビューを日本語で実施し、指摘を修正した（PR 作成時点では未実施。レビュー後対応）
- [x] `npm run test:visuals:update` は毎回実行していない
- [x] 画面表示の意図した変更がある場合のみ、開発者がスナップショットを更新した（今回は viewer の描画内容に変更がないため未更新）
