---
title: Local Multi-Agent Workflow (Agents-as-Tools)
description: Planner から Security までの各役割を単一コンテキストで切り替えながら進行する、ローカルマルチエージェント運用の標準フロー手順書。
version: 0.1
---
# 標準フロー
1) Planner
2) Architect（API/DB/仕様追加なら必須）
3) Coder
4) Tester
5) Reviewer
6) Security（重要変更なら必須）

# 実行形態（重要）
- 本プロジェクトは 3DCG（Babylon.js）を扱い、描画・地形生成の結果は**人間の目視確認が必須**である。
- そのため各役割は**自律的な並列サブエージェントには分割しない**。Orchestrator が単一コンテキストで役割を切り替えながら進行する（Copilot CLI / Claude Code 共通）。
- 描画に影響する変更では Tester 工程に目視確認ゲートを設ける（[40_tester.md](40_tester.md) 参照）。

# ルーティング規則
- 仕様が曖昧：Plannerで確認質問→確定後に進む
- 新規API/DB変更：Architectを必ず挟む
- 重要フロー変更：Testerでe2e優先
- 3DCG描画変更：Testerで `npm run test:visuals` 実行後、ユーザーの**目視確認（HITL）**を必須ゲートとする
- 外部連携/権限/機密：Securityを必ず挟む
- HITL条件：承認待ちで停止

# 成果物の受け渡し
- handoff_template.md を必ず添付
- 各工程のアウトプットは次工程がそのまま使える粒度にする

# テストスナップショットの取り扱い（重要）
- `npm run test:visuals` / `npm run test:visuals:update` が生成する Visual Regression Test のスナップショット画像（`tests/*.spec.ts-snapshots/`）は、地図の二次配布に抵触する恐れがあるため **リポジトリにコミットしない**。
- `.gitignore` で対象ディレクトリを除外設定し、ローカルではコミット対象外のまま基準画像として利用する。
- 新規にVisual Regression Testを追加する場合も、対応するスナップショット出力ディレクトリを `.gitignore` に追加すること。
- 説明・ドキュメント等のために地図画像を使用する場合は、著作権表記を必ず明記すること。

# Git一括実行ワークフロー（HITL）
実装が完了し、ユーザーの承認が得られた時点で、以下の操作を **まとめて一括実行** することを基本ルールとする。ステップごとに都度承認を求めない。

1. ブランチ作成
2. コミット
3. プッシュ
4. PR作成

## 例外・優先順位
- ユーザーから個別の指示（例:「コミットだけにして」「pushは保留」「ブランチは既存のものを使う」など）があった場合は、デフォルトの一括実行よりも **常にユーザー指示が優先** される。
- 一括実行の対象は上記4操作に限定する。以下は引き続き **個別にHITL承認を要する**:
  - force push / 履歴改変（`git push --force`, `git reset --hard` など）
  - PRのマージ、ブランチ削除
  - `00_orchestrator.md` の安全ルールに該当する破壊的操作

## 推奨コマンド例
```shell
git switch -c <branch>
git add <paths>
git commit -m "<type>(<scope>): <subject> (#<issue>)"
git push -u origin <branch>
gh pr create \
  --base main \
  --fill \
  --assignee "@me" \
  --reviewer "@copilot" \
  --label "<label>" \
  --body "Closes #<issue>"
```

# Issue作成ルール
Issueを作成する際は、以下のオプションを必ず付与する。

- `--assignee "@me"` を指定する。
- 内容に応じた適切な `--label` を1つ以上付与する。

必要に応じて任意で `--parent` オプションによりParent Issueを設定できる（後述）。明記は必須ではない。

## 利用可能なlabel
最新のlabel一覧は以下で取得する。
```shell
gh label ls
```

代表的なlabelの使い分け（2026-04時点）:

| label | 用途 |
|---|---|
| `feature` | 新機能の追加 |
| `bug` | 不具合修正 |
| `documentation` | ドキュメント・仕様書の追加/更新 |
| `dependencies` | 依存パッケージ更新 |
| `javascript` | JS/TSコードの変更 |
| `question` | 確認・調査タスク |
| `help wanted` | 支援を募る |
| `good first issue` | 初心者向け |

## コマンド例
```shell
gh issue create \
  --title "<title>" \
  --body-file <path> \
  --assignee "@me" \
  --label "<label>"
```

## 親子Issueの設定（--parent オプション）
GitHub CLIの `--parent` オプションを利用して、Issue作成時に任意でParent Issueを設定できる。上記の必須オプション（`--assignee` / `--label` 等）に追加して指定する。
```shell
gh issue create \
  --title "<title>" \
  --body-file <path> \
  --assignee "@me" \
  --label "<label>" \
  --parent <PARENT-ISSUE-NUMBER>
```

# PR作成ルール
PRを作成する際は、以下のオプションを必ず付与する。

- `--assignee "@me"` を指定する。
- `--reviewer "@copilot"` を指定する。
- 変更内容に応じた適切な `--label` を1つ以上付与する（`gh label ls` で確認）。
- 関連Issueがある場合はbodyに `Closes #<issue>` を記載する。

# PR作成後のフロー
PR作成後は以下のルールに従う。

- レビューコメントが付いたら、ユーザーの承認を得たうえで対応すること。
- すべてのレビューコメントには **必ず返信** すること（対応済み／対応不要の判断理由を含める）。
- レビュー指摘は誤っている場合もあるため、内容を鵜呑みにせず **慎重に判断** すること。
  - 仕様・既存コード・テスト結果と照合し、必要に応じて根拠を添えて反証する。
  - 不明確な指摘はユーザーに確認してから対応方針を決める。
