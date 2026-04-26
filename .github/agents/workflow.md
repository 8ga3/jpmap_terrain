---
title: Local Multi-Agent Workflow (Agents-as-Tools)
version: 0.1
---
# 標準フロー
1) Planner
2) Architect（API/DB/仕様追加なら必須）
3) Coder
4) Tester
5) Reviewer
6) Security（重要変更なら必須）

# ルーティング規則
- 仕様が曖昧：Plannerで確認質問→確定後に進む
- 新規API/DB変更：Architectを必ず挟む
- 重要フロー変更：Testerでe2e優先
- 外部連携/権限/機密：Securityを必ず挟む
- HITL条件：承認待ちで停止

# 成果物の受け渡し
- handoff_template.md を必ず添付
- 各工程のアウトプットは次工程がそのまま使える粒度にする

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
- Parent Issueが指定されている場合は、`gh sub-issue` 拡張で親子関係を設定する（後述）。

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

## 親子Issueの設定（gh sub-issue）
`yahsan2/gh-sub-issue` 拡張を利用して親子関係を設定する。
```shell
# gh sub-issue add <親イシュー番号> <子イシュー番号>
gh sub-issue add <parent> <child>
```
Issue本文の `Parent: #<n>` 記載だけでなく、上記コマンドで明示的に親子関係を登録すること。

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
