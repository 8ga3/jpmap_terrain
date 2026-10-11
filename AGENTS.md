# AGENTS.md

AIエージェントと開発者が、このリポジトリで実装・レビュー・検証するための運用ガイド。

## 参照先

- プロジェクト概要: [README.md](README.md)
- 機能ドキュメント: [spec/README.md](spec/README.md)
- 開発フロー（Issue → ブランチ → PR → マージ）: [spec/development.md](spec/development.md)
- マルチエージェント運用フロー: [.github/agents/workflow.md](.github/agents/workflow.md)（各役割の定義は [.github/agents/](.github/agents/) 配下）

## 概要

- 地理院タイルの標高タイルから Terrain を作成する Web アプリ（Babylon.js / TypeScript）
- リポジトリ構成: `/` がフロントエンド、`spec/` が設計・仕様ドキュメント

## Commands

```shell
npm run lint          # biome + 各種 check スクリプト
npm run typecheck
npm run test:unit
npm run test:visuals  # Visual Regression Test
```

依存関係を更新するときは、`.tool-versions` で固定した Node / npm を使う（`node -v && npm -v` で確認してから `npm install`）。npm のバージョンが CI と違うと `package-lock.json` が食い違い、CI の `npm ci` が失敗するため。詳細は [spec/development.md](spec/development.md)。

## Coding Rules

### ログ出力言語

`console.*` に渡すメッセージは英語で書き、先頭に `[module]` 形式のプレフィックスを付ける（例: `[tileCache] failed to load tile ...`）。コード内コメントや UI テキストは日本語でよい。

### `@babylonjs/*` のサブパス import

拡張子 `.js` まで書く（例: `@babylonjs/core/Maths/math.vector.js`）。ディレクトリを指す場合は `index.js` まで書く（例: `@babylonjs/loaders/glTF/index.js`）。サブパスのないルート import（例: `@babylonjs/havok`）は対象外。

`@babylonjs/core` は `"type": "module"` だが `exports` を持たないため、Node.js はサブパスをファイルパスとして解決し、拡張子なしでは `ERR_MODULE_NOT_FOUND` になる。
bundler は拡張子を補うのでデモのビルドや Unit test では気付けず、tsdown は import 文をそのまま `dist` に残すため、1 箇所でも漏れると Node.js から直接 import できない成果物になる。
`npm run check:dist-imports` で検知する（CI の `Build library` 直後と `prepack` で実行）。

### 正本とドリフト防止

- ルールの正本は本ファイル。役割ごとの定義は [.github/agents/](.github/agents/) が正本で、衝突した場合は本ファイルを優先する。
- 各ツールの入口ファイルはルールを複製せず、正本へのリンクだけを持つ。これにより Copilot CLI と Claude Code の運用が一致する。
  - 対象: [.github/copilot-instructions.md](.github/copilot-instructions.md) / [CLAUDE.md](CLAUDE.md) / [.claude/agents/](.claude/agents/) / [.claude/skills/orchestrator/](.claude/skills/orchestrator/)
- ルールを変更するときは正本だけを編集する。複製は時間とともに片側だけ更新されてずれるため、`npm run check:agent-docs`（`npm run lint` に含まれる）で検知する。

### レビュー時チェック観点

レビュー結果は日本語で、以下の観点に沿って具体的に書く。

1. 仕様整合性: 変更内容が `spec/` 配下の仕様と矛盾しない。
2. 型・静的品質: 安易な `any` を入れない。typecheck を通す。未使用 import・未使用変数・デバッグログを残さない。上記「ログ出力言語」「`@babylonjs/*` のサブパス import」に従う。
3. 変更影響の明示: API・型・挙動が変わる場合、影響範囲（画面 / API / ドキュメント）を PR 説明に書く。

## GitHub CLI

Issue・PR 作成時の必須オプションは [workflow.md](.github/agents/workflow.md) の「Issue / PR 作成ルール」に従う。

### 画像・動画の添付

Issue・PR・コメントにスクリーンショットや動画を載せるときは `--attach` を使う（gh v2.99.0 以降）。

- 対象: `gh issue create` / `gh issue edit` / `gh issue comment` / `gh pr create` / `gh pr edit` / `gh pr comment`
- 繰り返し指定で複数添付できる（1 コマンド最大 50 ファイル、同じファイルの重複指定は不可）。
- alt text は `'<file>#<alt text>'` で指定する。省略するとファイル名になる。
- 本文中で添付ファイルを Markdown の画像記法で参照している箇所は、アップロード先の URL に置き換わる。本文で参照していないファイルは本文末尾に追加される。
- サイズ上限: 画像・GIF は 10 MB、動画は Free プラン 10 MB / 有料プラン 100 MB。
- 地図画像を載せる場合は著作権表記を添える（[workflow.md](.github/agents/workflow.md) の「テストスナップショットの取り扱い」）。

```shell
gh issue create --title "..." --body "..." --attach './capture.png#地形の描画結果'
gh pr comment 13 --attach ./before.png --attach ./after.png
```

### stacked pull requests

ある PR のブランチの上に次の PR を作るときは、GitHub の stacked pull requests にする。一番下の PR のマージ先は `main`、その上の PR のマージ先は 1 つ下の PR のブランチになる。詳細は [GitHub Docs](https://docs.github.com/ja/pull-requests/get-started/about-stacked-prs)。

GitHub CLI 本体ではなく `gh stack` 拡張機能で扱う（`gh pr --help` には出てこない）。

```shell
gh extension install github/gh-stack   # gh 2.0 以降、Git 2.36 以降
gh skill install github/gh-stack       # エージェント用スキル（任意）
```

- `gh stack view`: スタックの PR の並びと状態を見る
- `gh stack checkout <PR の URL>`: Web で作ったスタックをローカルに取り込む
- `gh stack link <下のブランチ> <上のブランチ>`: 作成済みの PR をスタックにする
- `gh stack sync`: 取得・載せ直し・push をまとめて行う。載せ直したときは `--force-with-lease` で push するため、ローカルにしかない変更がないか先に確かめる。

`gh stack` に数字を渡すと、まずスタック番号として扱われ、該当がなければ PR 番号として扱われる。別のスタックを操作しないよう、数字ではなく URL かブランチ名で指定する。

スタックの PR は `gh pr merge` ではマージできないため `gh stack merge` を使う（スタック全体がまとめてマージされ、すべて成功するかどれもマージされないか）。履歴を一直線に保つため rebase マージにする。対象のスタックをチェックアウトしてから実行する。

```shell
gh stack checkout https://github.com/<owner>/<repo>/pull/<番号>   # 一番上の PR
gh stack view                                                     # 対象のスタックか確かめる
gh stack merge --rebase --yes
```

下の PR がマージされると、GitHub が上の PR のマージ先を付け替えてブランチを載せ直す（リモートのブランチが書き換わる）。続けて作業する前にローカルを合わせる。

`gh stack sync` の force push と `gh stack merge` は、[workflow.md](.github/agents/workflow.md) の「Git 操作（HITL）」で個別承認が必要な操作に当たる。

## Definition of Done

以下をすべて満たしたら実装完了とする。未達の項目があるまま完了と報告しない。

1. `npm run lint` / `npm run typecheck` / `npm run test:unit` が成功する。
2. 描画・地形生成に影響する変更では、[40_tester.md](.github/agents/40_tester.md) の目視確認ゲートを通過している。
3. 上記「レビュー時チェック観点」で AI レビューを行い、指摘の要否を記録している。
4. レビューや手戻りで修正が入った場合は、1〜3 をやり直している。
