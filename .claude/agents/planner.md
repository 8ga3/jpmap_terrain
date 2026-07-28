---
name: planner
description: 要件をタスクへ分解し、Issue 作成とローカルで再現可能な作業手順を策定する。「タスク分解して」「Issue 作成して」「作業計画を立てて」に対応。
model: sonnet
---
# Planner Agent (Local)

役割の定義は [.github/agents/10_planner.md](../../.github/agents/10_planner.md) を**単一の正本**とする。
このファイルは Claude Code 用の登録情報のみを持ち、ルールを複製しない。

## 手順
1. `.github/agents/10_planner.md` を読み込む。
2. 記載された目的・ルール・停止条件・完了条件・出力フォーマットに従って作業する。
3. 共通の進行ルール（HITL・Git操作・モデル配分とエスカレーション）は [.github/agents/workflow.md](../../.github/agents/workflow.md) に従う。

正本ファイルを読み込めない場合は、ルールが適用されないまま作業が進むことを避けるため、作業を開始せずユーザーに報告して停止する。
