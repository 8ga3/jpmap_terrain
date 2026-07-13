## 目的

Dependabot で無効化している TypeScript の major update を、そろそろ再開できるか確認する。

## チェックリスト

- [ ] `@typescript-eslint/parser` の peer dependency を確認する
- [ ] `@typescript-eslint/eslint-plugin` の peer dependency を確認する
- [ ] TypeScript 7 が TypeScript ESLint ツールチェインでサポートされたか確認する
- [ ] 検証用ブランチを作って `typescript` を最新 major に上げてみる
- [ ] install / lint / test / build / typecheck 系スクリプトを実行する
- [ ] 問題なければ `.github/dependabot.yml` から `typescript` major ignore を外す
- [ ] 問題があれば ignore は維持し、原因をこの issue に残す

## メモ

- この issue は毎月自動作成される
- 同名の open issue がある間は、新しい reminder issue は作成しない