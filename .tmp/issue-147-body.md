## 概要

24 時間を 1 分に圧縮したタイムラプスデモを追加する。`JpmapTerrain` の太陽位置・陰影アニメーションをループ再生し、画面オーバーレイのアナログ時計（時針・分針・秒針）が同期して回転する様子を表示する。あわせて、複数デモを束ねるデモポータルを整備し、今後デモを追加しやすい構成にする。

## 背景・目的

- これまで `/` 直下に viewer デモが 1 つだけ存在していた。今後デモを増やすため、共通の入口（ポータル）と多エントリ webpack 構成へ拡張する。
- 太陽位置・陰影が時刻に追従することは Issue #35 / #39 で実装済みだが、視覚的にダイナミクスを伝えるショーケースが無かった。タイムラプス＋アナログ時計オーバーレイで体感的な訴求を行う。

## 作業完了の定義

- [ ] `/`（ポータル）/ `/viewer.html`（既存 viewer）/ `/timelapse.html`（新規タイムラプス）が表示される。
- [ ] タイムラプスは既定で 24h を 60s に圧縮し、`?paused`, `?speed=`, `?start=` で制御可能。
- [ ] アナログ時計オーバーレイが太陽位置の simulated time と同期して回転する。
- [ ] `pointer-events:none` で操作を阻害しない。
- [ ] `npm run lint` / `npm run typecheck` / `npm run test:unit` がグリーン。
- [ ] `npm run test:visuals` の既存ケースが（URL `/viewer.html` 化後も）グリーン。
- [ ] `spec/demos.md` でデモポータル方針と追加手順を文書化。
- [ ] `README.md` にポータル/各デモへのリンクを追加。
- [ ] `src/lib/**`（公開ライブラリ層）は変更しない。

## 補足

- 関連: Issue #35（太陽位置）, #39（影描画）, #143（dateTime URL）, #149（mapType URL）
- 影響範囲:
  - `src/demos/**`（新規）
  - `src/index.ts` → `src/demos/viewer/index.ts` へ移設
  - `public/*.html` 追加
  - `webpack.common.js` を多エントリ + 複数 HtmlWebpackPlugin 化
  - `tests/validation.spec.ts` の URL を `/viewer.html` に更新
  - `spec/demos.md`, `README.md`
- リスク:
  - VR スナップショットの URL 変更に伴う差分（描画内容は同一なので原則維持）
  - 多エントリ化での `splitChunks` 整合（既存 cacheGroups は維持し、各 HtmlWebpackPlugin に `chunks` を明示）
