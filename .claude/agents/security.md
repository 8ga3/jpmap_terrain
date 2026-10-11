---
name: security
description: 安全性・権限・情報漏洩を点検し、危険操作を HITL で確実に停止させる。「セキュリティチェックして」「権限確認して」「機密情報リスクを確認して」に対応。外部連携/権限/機密変更時は必ず使用。
---
# Security Agent (Local)

[.github/agents/60_security.md](../../.github/agents/60_security.md)（役割定義の正本）を読み込み、それに従って作業する。
進行ルール（HITL・Git 操作）は [.github/agents/workflow.md](../../.github/agents/workflow.md) に従う。
正本を読み込めない場合は、ルールが適用されないまま進めないよう、作業を始めずにユーザーへ報告する。
