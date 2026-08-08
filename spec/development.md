# 開発フロー

このドキュメントは、`jpmap_terrain` における日常的な実装作業の進め方を定義します。

## 基本フロー

1. Issue を作成し、目的・背景・完了条件を明確化する
2. ブランチを作成して実装する
3. ローカルで lint / typecheck / test を実行する
4. Pull Request を作成し、影響範囲を記載する
5. レビュー対応後に再度検証し、マージする

## 実装前の確認

- 仕様変更を伴う場合は、関連ドキュメントを更新対象に含める
- 変更が API / 型 / 挙動に及ぶ場合、PR本文に影響範囲を明記する

## Node / npm のバージョン固定

**リポジトリ直下の `.tool-versions` が Node バージョンの唯一の正本**である。

- ローカル: [asdf](https://asdf-vm.com/) がカレントディレクトリの `.tool-versions` を自動的に参照する。初回のみ `asdf install` を実行する。
- CI: `ci.yml` / `deploy.yml` の `actions/setup-node` が `node-version-file: '.tool-versions'` で同じバージョンを解決する。

**なぜ固定が必要か**: `package-lock.json` の生成結果は **npm のバージョンによって変わる**。npm は optional な依存（`@rolldown/binding-wasm32-wasi` など）の peerDependencies をどこまで lock に記録するかがバージョンごとに異なる。そのため CI と異なる npm で `npm install` すると、CI 側の `npm ci` が `Missing: <pkg> from lock file` で失敗する。

そのため以下を守ること。

- 依存関係を更新して `package-lock.json` を再生成する際は、必ず `.tool-versions` で指定された Node / npm を使うこと。作業前に `node -v` / `npm -v` で確認する。
- Node のバージョンを更新する場合は `.tool-versions` を変更し、同じコミットで `npm install` を実行して `package-lock.json` を再生成すること。
- 上記は `scripts/checkToolVersions.mjs` により機械的に検知する（`npm run lint` および `package-lock.json` をステージした際の pre-commit フックから実行される）。
- `.tool-versions` には **`nodejs` の1行のみを記述し、コメント行を追加しない**こと。`actions/setup-node` は正規表現 `^(?:node(js)?\s+)?v?(?<version>[^\s]+)$` で行を走査するため、空白を含まない単独トークンの行（例: `#memo`）があるとそれをバージョンとして誤解釈する。`nodejs` 以外のツールはローカルの `~/.tool-versions`（グローバル設定）側で管理する。

> 補足: 過去に「CIがx64・開発機がmacOS arm64」というCPUアーキテクチャの差が原因と推測していたが、実際にはアーキテクチャは無関係だった。同一の npm バージョンを使えば、macOS arm64 と Linux x64 で生成される `package-lock.json` はバイト単位で一致する。

## CI による自動検証

`.github/workflows/ci.yml` により、`pull_request` および `main` への push を対象に以下を自動実行する。

1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run test:unit`
5. `npm run build`

**背景**: 以前は `.github/workflows/deploy.yml`（タグpush時のみ実行）以外にCIが存在せず、依存関係更新PRがマージされた時点で `package-lock.json` が壊れていても、次にリリースタグを打つまで誰も気づけなかった（詳細は #580 参照）。`ci.yml` により、PRの時点・`main` マージ直後に `npm ci` の整合性を含めて自動検証されるため、**手動での事前確認を毎回覚えておく必要はない**。

- `npm run test:visuals`（Playwright Visual Regression Test）はスナップショットが `-darwin.png` 命名でmacOS専用のため、Linux上のCIには含めていない。引き続き開発者がローカル（macOS）で手動実行する。

## リリース（Netlifyデプロイ & npm公開）

タグpushをトリガーに、以下2つのワークフローが**独立して**実行される。

- `.github/workflows/deploy.yml`: Netlifyへのデモデプロイ。**全タグ**が対象（`push.tags: ['**']` を使用。`'*'` では `/` を含むタグ（例: `release/v1`）にマッチしないため `'**'` を採用している）。認証情報はNetlifyの長期トークン（`secrets.NETLIFY_AUTH_TOKEN`）。
- `.github/workflows/publish.yml`: npmレジストリへの公開。**`vX.Y.Z` 形式のタグのみ**が対象（`push.tags: ['v*.*.*']`）。npm公開はNetlifyデプロイより影響が大きい（一度公開すると原則取り消せない）ため、対象タグを限定している。認証は npmの [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)（OIDC）方式を採用しており、長期トークンをGitHub Secretsに保持しない。

両ワークフローは同じタグpushイベントで並行してトリガーされ、互いに依存関係はない（一方が失敗してももう一方には影響しない）。

npm公開（`publish.yml`）は `npm-publish` という GitHub Environment に紐付けており、以下の保護ルールを設定している。

- **Required reviewers**: ジョブが実際に `npm publish` を実行する前に、手動承認が必要（誤って想定外のタグをpushした場合の防御）。
- **Deployment branch policy**: `v*.*.*` 形式のタグからのみ実行を許可（ワークフロー側の `on.push.tags` と二重に制限）。

- **必ず `main` ブランチにマージされたコミットに対してのみタグを付けること。**
  - Gitのタグはブランチと独立した参照であるため、CIのトリガー設定上は `main` 以外のブランチ（feature branch等）のコミットにタグを付けてpushした場合も、そのコミット内容がそのままNetlify本番環境へのデプロイおよびnpm公開の対象になってしまう。
  - このリスクはCI側のガードでは完全に防げず（`npm-publish` Environmentの手動承認が最後の防波堤にはなる）、**運用ルールとして開発者が遵守する**ことで担保する。
- タグを付ける前に、対象コミットで `ci.yml` が成功していることを確認する（`main` へのマージ時に自動実行されているはずだが、念のため [Actions](https://github.com/8ga3/jpmap_terrain/actions/workflows/ci.yml) タブで確認する）。
- `package.json` の `prepack` スクリプトが `npm publish` の直前に自動で `clean:lib` → `build:lib` を実行するため、CI上でも同様にライブラリ成果物のみが公開される。
- リリース手順（`vX.Y.Z` は対象バージョンに置き換える。例: `v0.3.1`）:
  1. 対象の変更（バージョン更新PRを含む）が `main` にマージされていることを確認する
  2. `main` を最新化する（`git switch main && git pull`）
  3. `main` の最新コミットにタグを付ける（`git tag vX.Y.Z`）
  4. タグをpushする（`git push origin vX.Y.Z`）— Netlifyへのデモデプロイ（`deploy.yml`）とnpm公開ワークフロー（`publish.yml`）が自動的にトリガーされる
  5. [Actions](https://github.com/8ga3/jpmap_terrain/actions/workflows/publish.yml) タブで `publish.yml` の実行を確認し、`npm-publish` Environmentの承認待ち状態になったら内容を確認のうえ承認する
  6. `npm view jpmap-terrain version` や `npm install jpmap-terrain` で、公開したバージョンが正しく取得できることを確認する

自動化前に手動で公開作業を行う必要がある場合（例: ワークフロー自体に不具合があり緊急対応が必要な場合）は、以下の手順で行う。

- **npm公開はタグが指すコミットから行うこと（`git switch --detach vX.Y.Z` でチェックアウトする）。** `git checkout vX.Y.Z` は同名ブランチが存在すると branch checkout になり得るため、確実に detached HEAD にする `git switch --detach` を使う。タグとコミットの一致を確実にするため意図的にこの状態で作業する。
- `git status` が clean であることを確認したうえで `npm pack --dry-run` を実行し、tarballの中身（`dist/index.mjs` / `dist/index.d.mts` 等のライブラリ成果物 ＋ `README.md` / `LICENSE.md` / `package.json` のみであること）を確認する。
- 問題なければ `npm publish` を実行する（事前に `npm whoami` でログイン状態を確認しておく）。
- 作業後は `git switch main` で `main` ブランチに戻る（detached HEAD状態を解除する）。

## ローカル実行コマンド

```shell
npm start
npm run lint
npm run typecheck
npm run test:unit
npm run test:visuals
```

Visual Regression Test の基準更新が必要な場合:

- `npm run test:visuals:update` は毎回実行しない
- 画面表示（UI/描画結果）に意図した変更がある場合にのみ、開発者が基準画像を更新する

```shell
npm run test:visuals:update
```

## Definition of Done

以下をすべて満たした状態を完了とします。

1. 定義済みテストが成功している
2. `npm run lint` と `npm run typecheck` が成功している
3. コーディングルール観点でレビュー済みである
4. 手戻り修正が入った場合、再度 lint / typecheck / test を実行済みである

## 手動テスト: Geolocation（現在地ボタン）

現在地が日本の対応エリア（JAPAN_BOUNDS: lat 20〜46, lon 122〜154）外の場合にトースト通知が表示されることを確認する手順。

### Chrome DevTools で位置情報をオーバーライド

1. DevTools を開く（F12）
2. 右上の `⋮` → **More tools** → **Sensors**
3. **Location** を `Other…` に変更
4. 範囲外の座標を入力（例: `Latitude: 0`, `Longitude: 0`）
5. アプリ上の「現在地を表示」ボタンをクリック
6. 画面下部中央に「現在地は対応エリア外のため、最も近い地点を表示します」のトーストが約3秒間表示されることを確認

### コンソールから直接確認（開発ビルドのみ）

```js
showToast("テストメッセージ")
```

> 開発ビルドでは `window.showToast` が公開されており、コンソールから直接呼び出せます。

## レビュー観点（要約）

- 仕様整合性: 仕様と実装が矛盾していないか
- 型・静的品質: 安易な any 導入や未使用コードがないか
- 変更影響: 画面/API/ドキュメントの影響が明示されているか

詳細は `AGENTS.md` を参照してください。

## 既知の問題・ワークアラウンド

### URL 更新 debounce 遅延

**現象**: ドラッグ後にリロードするとカメラ位置がずれる。

**原因（推定）**: Babylon.js の `ArcRotateCamera` はドラッグ終了直後（pointerup）の時点では
内部状態の確定が完了していない可能性がある。`onBeforeRenderObservable` を通じて取得する
`camera.position` / `camera.target` が、直後のフレームで古い値を返すケースが確認されている。

**ワークアラウンド**:
- `src/demos/viewer/index.ts` の `createUrlUpdater` の debounce を **1000ms** に設定している。
  500ms 以下では地図の場所によって再現することが確認されている。
- pointerup 時に `onCameraInteractionEnd` コールバックで `_notifyIfChanged(force=true)` を
  呼び出すことで、epsilon 比較による取りこぼしを補完している（`jpmapTerrain.ts`）。

**今後の対応**:
- Babylon.js 側のバグである可能性がある。バージョンアップ後に 1000ms 未満で動作するか検証を推奨する。
- `timelapse` などの他のデモで同様の問題が発生した場合は debounce を揃えて調整する。

