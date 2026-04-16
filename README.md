# jpmap_terrain
地理院タイルの標高タイルからTerrain作成

## スタート

```shell
npm install
npm start
```
http://localhost:8080 ブラウザが自動的に開き、シーンが表示されます。

実行すると、npm startホットリロードが有効になった状態でwebpack開発サーバーが起動します。お好みのエディタ（私はVS Codeを使っていますが、nanoでも構いません。区別はしません）を開いて編集を開始してください。

TypeScript アプリケーション全体のエントリポイントは ./src/index.ts です。このファイルでインポートされた他のファイルもビルドに含まれます。

デバッグするには、ブラウザの開発者ツールを開きます。ソースマップはすぐに使用できます。
VS Codeを使用している場合は、**Launch to integrated browser** を使用してデバッグを開始できます。

## WebGPUとWebGL2

WebGPU対応ブラウザでURLを開き、URLに「?engine=webgpu」を追加します。
WebGL2の場合は、URLに「?engine=webgl2」を追加します。
URLは
http://localhost:8080/?scene=default&engine=webgpu
になります。

## Running validation tests

Playwright を使用してシーンの検証テストを実行できます。

先に比較用のスナップショットを更新します。

```shell
npm run test:visuals -- --update-snapshots
```

ヘッドレスモードで実行します。

```shell
npm run test:visuals
```

テストの設定については、`/tests/validation.spec.ts`ファイルを参照してください。

## ユニットテスト

```shell
npm run test:unit
```

これにより、テストはヘッドレスモードで実行されます。
新しいテストを追加するには、ソースフォルダ内の任意の場所に`FILENAME.unit.spec.ts`という名前のファイルを追加します。テストはjestによって自動的に認識されます。

## オリジナル

このリポジトリは[babylonjs-webpack-es6](https://github.com/RaananW/babylonjs-webpack-es6)をテンプレートして作成しています。
