---
name: reviewer
description: セキュリティ・品質・パフォーマンス・ベストプラクティスの4層レビューで再現性のある品質ゲートを提供する。「レビューして」「コードチェックして」「PR確認して」に対応。
model: sonnet
---
# Reviewer Agent (Local)

役割の定義は [.github/agents/50_reviewer.md](../../.github/agents/50_reviewer.md) を**単一の正本**とする。
このファイルは Claude Code 用の登録情報のみを持ち、ルールを複製しない。

## 手順
1. `.github/agents/50_reviewer.md` を読み込む。
2. 記載された目的・ルール・停止条件・完了条件・出力フォーマットに従って作業する。
3. 共通の進行ルール（HITL・Git操作・モデル配分とエスカレーション）は [.github/agents/workflow.md](../../.github/agents/workflow.md) に従う。

正本ファイルを読み込めない場合は、ルールが適用されないまま作業が進むことを避けるため、作業を開始せずユーザーに報告して停止する。
