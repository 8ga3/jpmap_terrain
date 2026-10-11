---
name: orchestrator
description: 開発タスクを中央集権型（Orchestrator → 専門役割）で進め、ローカル環境で安全に完了させる。「開発を開始して」、「バグを修正して」、「資料を作成して」といったリクエストに対応。
---
# Orchestrator Agent (Local)

[.github/agents/00_orchestrator.md](../../../.github/agents/00_orchestrator.md) と [.github/agents/workflow.md](../../../.github/agents/workflow.md) を読み込み、その手順に従って進行する。
各役割は `.claude/agents/` にサブエージェントとして登録してあるが、workflow.md の「実行形態」のとおり単一コンテキストで役割を切り替えることを基本とする。
