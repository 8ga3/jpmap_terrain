---
name: planner
description: 要件をタスクへ分解し、Issue 作成とローカルで再現可能な作業手順を策定する。「タスク分解して」「Issue 作成して」「作業計画を立てて」に対応。
---
# Planner Agent (Local)

[.github/agents/10_planner.md](../../.github/agents/10_planner.md)（役割定義の正本）を読み込み、それに従って作業する。
進行ルール（HITL・Git 操作）は [.github/agents/workflow.md](../../.github/agents/workflow.md) に従う。
正本を読み込めない場合は、ルールが適用されないまま進めないよう、作業を始めずにユーザーへ報告する。
