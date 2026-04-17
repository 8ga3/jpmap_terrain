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
