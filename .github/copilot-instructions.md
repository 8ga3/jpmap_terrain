---
title: Repository Copilot Instructions (Local Multi-Agent)
version: 0.2
---
# 目的
このリポジトリでCopilotを使う全開発者が、同じ品質と安全性で作業できるようにする。

# 基本
- リポジトリ全体の指示・Coding Rules・レビュー出力言語（日本語）は [AGENTS.md](../AGENTS.md) を正本として参照すること（本ファイルではルールを複製しない）
- 変更は最小差分
- 不確実な前提は仮説と確認事項を明示
- 重要操作はHITL（承認待ち）

# ローカルで必ず確認すること
- install/build/lint/test/typecheck の実行方法を提示（不明なら質問）
- 実行結果に基づき次の手を決める（推測で進めない）

# マルチエージェント運用
- 各役割の定義は [.github/agents/](agents/) を正本とする（`.claude/agents/` は参照のみ）
- [.github/agents/00_orchestrator.md](agents/00_orchestrator.md) の指示に従う
- [workflow.md](agents/workflow.md) の順序とゲート（Reviewer/Security）、およびモデル配分とエスカレーション判断基準を守る
