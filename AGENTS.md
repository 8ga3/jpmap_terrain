# AGENTS.md

AIエージェントと開発者が、このリポジトリで迷わず実装・レビュー・検証するための運用ガイド。

## 参照先

- プロジェクト全体概要: [README.md](README.md)
- 機能ドキュメント入口: [spec/README.md](spec/README.md)
- 開発フロー（Issue → ブランチ → PR → マージ）の詳細: [spec/development.md](spec/development.md)

## 概要

- プロジェクト名: jpmap_terrain
- 種別: Webアプリ
- 概要: 地理院タイルの標高タイルからTerrain作成（Frontend: Babylon.js / TypeScript）
- リポジトリ構成（主要）:
  - /: Babylon.js フロントエンド
  - spec/: 設計・仕様ドキュメント

## Commands

### lint

```shell
npm run lint
```

### Visual Regression Test

```shell
npm run test:visuals
```

### Unit Test

```shell
npm run test:unit
```

## Coding Rules

参照先だけでなく、レビューで確認する観点を以下に固定する。

### 規約参照先

- 実装規約: [AGENTS.md](AGENTS.md)
- lint/typecheck 設定: [package.json](package.json)

### AIレビュー出力言語

- Copilot などの AI エージェントがレビュー結果を出力する際は、日本語で記述すること。
- レビューコメントは、本ファイルの Coding Rules に記載したチェック観点に沿って、日本語で簡潔かつ具体的に記録すること。
- .github/copilot-instructions.md は英語行を正本とし、日本語行は補足として同義を維持すること。

### レビュー時チェック観点

1. 仕様整合性
   - 変更内容が仕様書と矛盾していないこと（必要に応じて docs 配下と照合）。

2. 型・静的品質
   - TypeScript 前提で any の安易な導入を避けること。
   - TypeScript typecheck を通過すること。
   - 未使用import、未使用変数、デバッグログを残さないこと。

3. 変更影響の明示
   - API・型・挙動が変わる修正では、影響範囲（画面/API/ドキュメント）をPR説明に明記すること。

## Definition of Done（実装完了条件）

以下をすべて満たしたら実装完了とする。

1. テスト実行
   - 定義済みのテストがある場合は実行し、成功すること。

2. lint / typecheck
   - 最低限、対象領域で lint または typecheck を実行し成功すること。
   - 変更時は `npm run lint` および `npm run typecheck` を実行すること。

3. Coding Rules 観点でのAIレビュー実施
   - 本ファイルの Coding Rules に記載したチェック観点でAIレビューを実施し、指摘の要否を記録すること。

4. 修正が入った場合の再実行
   - レビューや手戻りで修正が入った場合、テストと lint/typecheck を再実行すること。
   - 再実行後に再度AIレビューを行い、差分が完了条件を満たすことを確認すること。
