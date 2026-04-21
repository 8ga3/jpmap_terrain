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

## レビュー観点（要約）

- 仕様整合性: 仕様と実装が矛盾していないか
- 型・静的品質: 安易な any 導入や未使用コードがないか
- 変更影響: 画面/API/ドキュメントの影響が明示されているか

詳細は `AGENTS.md` を参照してください。
