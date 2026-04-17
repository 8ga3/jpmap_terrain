---
title: Repository Copilot Instructions (Local Multi-Agent)
version: 0.1
---
# 目的
このリポジトリでCopilotを使う全開発者が、同じ品質と安全性で作業できるようにする。

# 基本
- 日本語行は補足であり、意味は英語行に合わせること
- リポジトリ全体の指示は [AGENTS.md](../AGENTS.md) を参照すること
- コードレビュー出力は、常に日本語で記述すること
- レビュー時は [AGENTS.md](../AGENTS.md) のCoding Rules チェック観点に従うこと
- 変更は最小差分
- 不確実な前提は仮説と確認事項を明示
- 重要操作はHITL（承認待ち）

# ローカルで必ず確認すること
- install/build/lint/test/typecheck の実行方法を提示（不明なら質問）
- 実行結果に基づき次の手を決める（推測で進めない）

# マルチエージェント運用
- .github/agents/00_orchestrator.md の指示に従う
- workflow.md の順序とゲート（Reviewer/Security）を守る
