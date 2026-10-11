---
name: バージョン更新
about: Version Update
title: 'バージョン更新 vX.Y.Z → vA.B.C'
labels: documentation
assignees: ''

---

## 概要

バージョンを更新する。

<!-- 更新するバージョンを記載（例: v0.3.5 → v0.3.6） -->
vX.Y.Z → vA.B.C

## 対象ファイル

<!-- バージョン表記を更新するファイル -->

- README.md
- package.json
- package-lock.json

## マージ後の作業

<!-- マージ後に必要な作業を記載 -->

- 新バージョンのタグを付ける
- タグの説明に、前のバージョンからの更新内容を短い文章でリストする
- タグを push すると `.github/workflows/publish.yml` が実行され、`npm-publish` Environment の手動承認待ちになるため、承認して npm 公開を完了させる
