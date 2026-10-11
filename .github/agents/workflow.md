---
title: Local Multi-Agent Workflow (Agents-as-Tools)
description: Planner から Security までの各役割を単一コンテキストで切り替えながら進行する、ローカルマルチエージェント運用の標準フロー手順書。
version: 0.3
---
## 標準フロー

1. Planner — 仕様が曖昧なら確認質問を出し、確定してから進む
2. Architect — 新規 API・型・データ構造・仕様の追加/変更があるとき
3. Coder
4. Tester — 重要フローの変更は e2e を優先。描画・地形生成の変更は目視確認ゲートを通す（[40_tester.md](40_tester.md)）
5. Reviewer
6. Security — 外部連携・権限・機密情報に関わるとき

役割間の受け渡しには [handoff_template.md](handoff_template.md) を使い、次工程がそのまま使える粒度にする。

## 実行形態

描画・地形生成の結果は人間の目視確認が必要なため、各役割を自律的な並列サブエージェントには分割しない。Orchestrator が単一コンテキストで役割を切り替えながら進行する（Copilot CLI / Claude Code 共通）。

## HITL 停止条件

以下はユーザーの承認を得るまで停止する。いずれも自動判断では取り返しがつかない副作用を持つため、包括的な事前承認では通さず、操作ごとに承認を得る。

- データ削除・大量更新、破壊的マイグレーション
- 権限変更、認証・認可の方針変更
- 外部送信（メール / Slack / 外部 API）
- 本番設定変更、Secrets・鍵の取り扱い
- 破壊的 Git 操作: force push・履歴改変（`git push --force`、`git reset --hard`、`gh stack sync` の載せ直しなど）、PR のマージ（`gh stack merge` を含む）、ブランチ削除

## テストスナップショットの取り扱い

- `npm run test:visuals` / `npm run test:visuals:update` が生成するスナップショット画像（`tests/*.spec.ts-snapshots/`）は、地図の二次配布に抵触する恐れがあるためコミットしない。`.gitignore` で除外し、ローカルの基準画像としてのみ使う。
- Visual Regression Test を追加するときは、そのスナップショット出力ディレクトリも `.gitignore` に追加する。
- 説明・ドキュメントで地図画像を使うときは著作権表記を明記する。

## Git 操作（HITL）

実装が完了してユーザーの承認を得たら、ブランチ作成・コミット・push・PR 作成をまとめて実行する（ステップごとに承認を求めない）。ユーザーから個別の指示（「コミットだけ」「push は保留」など）があればそちらを優先する。上記「HITL 停止条件」の破壊的 Git 操作は対象外で、個別に承認を得る。

```shell
git switch -c <branch>
git add <paths>
git commit -m "<type>(<scope>): <subject> (#<issue>)"
git push -u origin <branch>
gh pr create --base main --fill --assignee "@me" --reviewer "@copilot" --label "<label>" --body "Closes #<issue>"
```

## Issue / PR 作成ルール

- Issue・PR とも `--assignee "@me"` と、内容に応じた `--label` を 1 つ以上付ける。label は `gh label ls` で確認する（主に `feature` / `bug` / `documentation` / `dependencies` / `javascript` / `question`）。
- Issue のテンプレートは [.github/ISSUE_TEMPLATE/](../ISSUE_TEMPLATE/) から内容に合うものを選ぶ。親 Issue がある場合は `--parent <番号>` で親子関係を設定できる（任意）。
- PR は `--reviewer "@copilot"` を付け、関連 Issue があれば本文に `Closes #<issue>` を書く。
- 画像・動画の添付と stacked pull requests は [AGENTS.md](../../AGENTS.md) の「GitHub CLI」を参照する。

```shell
gh issue create --title "<title>" --body-file <path> --assignee "@me" --label "<label>" [--parent <番号>]
```

## PR 作成後

- レビューコメントへの対応は、ユーザーの承認を得てから行う。
- すべてのレビューコメントに返信する（対応した内容、または対応不要と判断した理由）。
- 指摘が誤っている場合もあるため、仕様・既存コード・テスト結果と照合して判断する。根拠があれば反証し、不明確な指摘はユーザーに確認する。
