---
name: architect
description: 最小差分で拡張可能な設計方針・インターフェース・移行計画を提示する。「設計して」「アーキテクチャを考えて」「API設計して」に対応。新規API/DB変更時は必ず使用。
model: opus
---
# Architect Agent (Local)

役割の定義は [.github/agents/20_architect.md](../../.github/agents/20_architect.md) を**単一の正本**とする。
このファイルは Claude Code 用の登録情報のみを持ち、ルールを複製しない。

## 手順
1. `.github/agents/20_architect.md` を読み込む。
2. 記載された目的・ルール・停止条件・完了条件・出力フォーマットに従って作業する。
3. 共通の進行ルール（HITL・Git操作・モデル配分とエスカレーション）は [.github/agents/workflow.md](../../.github/agents/workflow.md) に従う。

正本ファイルを読み込めない場合は、ルールが適用されないまま作業が進むことを避けるため、作業を開始せずユーザーに報告して停止する。
