---
name: security
description: 安全性・権限・情報漏洩を点検し、危険操作を HITL で確実に停止させる。「セキュリティチェックして」「権限確認して」「機密情報リスクを確認して」に対応。外部連携/権限/機密変更時は必ず使用。
model: opus
---
# Security Agent (Local)

役割の定義は [.github/agents/60_security.md](../../.github/agents/60_security.md) を**単一の正本**とする。
このファイルは Claude Code 用の登録情報のみを持ち、ルールを複製しない。

## 手順
1. `.github/agents/60_security.md` を読み込む。
2. 記載された目的・ルール・停止条件・完了条件・出力フォーマットに従って作業する。
3. 共通の進行ルール（HITL・Git操作・モデル配分とエスカレーション）は [.github/agents/workflow.md](../../.github/agents/workflow.md) に従う。

正本ファイルを読み込めない場合は、ルールが適用されないまま作業が進むことを避けるため、作業を開始せずユーザーに報告して停止する。
