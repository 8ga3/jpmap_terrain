# デモサイト配信用 Docker 環境

`jpmap_terrain` のデモサイト（`npm run build` の成果物 `dist/`）を、Nginx コンテナで配信するための Docker 構成。

`spec/demos.md`「静的CDNへのデプロイ」節の Nginx 設定例と同じ内容（[nginx.conf](nginx.conf)）を使用しており、Docker上（`nginx:alpine`）で実際に動作検証済み。デモ識別子付きの短縮URL（例: `/viewer`, `/viewer/@35.68,139.76`）が `viewer.html` へ正しく解決される。

## ファイル構成

| ファイル | 役割 |
|---|---|
| [Dockerfile](Dockerfile) | `dist/` と `nginx.conf` を `nginx:alpine` に組み込むビルド定義 |
| [nginx.conf](nginx.conf) | デモ識別子付きパスのリライト設定（`spec/demos.md` と同一） |
| [compose.yaml](compose.yaml) | ビルド・起動用の Docker Compose 定義（ポート `8080`） |

## 前提

- Docker（Compose V2 プラグイン込み）がインストールされていること。
- リポジトリルートで `npm run build` を実行し、`dist/` が生成済みであること（Dockerfile が `dist/` をイメージに組み込むため、ビルド前に必ず実行する）。

## ローカルでの動作確認

```shell
# 1. リポジトリルートでデモサイトをビルドする
cd /path/to/jpmap_terrain
npm run build

# 2. docker/ ディレクトリでイメージをビルドしてコンテナを起動する
cd docker
docker compose up -d --build

# 3. 動作確認
curl -I http://localhost:8080/
curl -I http://localhost:8080/viewer
curl -I http://localhost:8080/viewer.html
curl -I "http://localhost:8080/viewer/@35.681236,139.767125"
```

いずれも `HTTP/1.1 200 OK` になれば成功。ブラウザで `http://localhost:8080/` を開き、ポータルから各デモへ遷移できることも確認する。

停止・削除:

```shell
docker compose down
```

コンテンツを更新した場合は、`npm run build` → `docker compose up -d --build` で再ビルド・再起動する。

## Raspberry Pi 5（arm64）で動かす場合

`nginx:alpine` はマルチアーキ対応イメージのため、`docker/` 配下の構成はそのまま Raspberry Pi 5（arm64）上でも利用できる。開発機が Apple Silicon Mac（arm64）の場合、Raspberry Pi 5 と **同じ CPU アーキテクチャ**なので、クロスビルド（`buildx --platform`）なしで作った標準のイメージがそのまま動く。

### 方法A: Raspberry Pi 5 上でビルドする（最も簡単）

1. リポジトリ（または少なくとも `dist/` と `docker/`）を Raspberry Pi 5 に転送する（`git clone` や `scp` 等）。
   - Node.js 環境がある場合は Pi 上で `npm run build` を実行して `dist/` を作る。
   - ない場合は、開発機で `npm run build` した後の `dist/` フォルダだけを転送してもよい（`docker/` と同じ階層に配置すること）。
2. Raspberry Pi 5 上で:
   ```shell
   cd docker
   docker compose up -d --build
   ```
3. `http://<Raspberry PiのIP>:8080/` にアクセスして確認する。

### 方法B: 開発機（Mac）でビルドしたイメージを転送する

Mac（Apple Silicon）と Raspberry Pi 5 は同じ arm64 のため、`docker save` / `docker load` でイメージをそのまま持ち運べる。

```shell
# 開発機（Mac）側
npm run build
cd docker
docker compose build
docker save jpmap-terrain-demo:local | gzip > jpmap-terrain-demo.tar.gz
scp jpmap-terrain-demo.tar.gz pi@<Raspberry PiのIP>:~/

# Raspberry Pi 5 側
docker load < jpmap-terrain-demo.tar.gz
docker run -d --name jpmap-terrain-demo -p 8080:80 --restart unless-stopped jpmap-terrain-demo:local
```

### 参考: 異なるCPUアーキテクチャの開発機からビルドする場合

開発機が amd64（Intel/AMD）の場合は、`docker buildx` でクロスビルドする。

```shell
docker buildx build --platform linux/arm64 -f docker/Dockerfile -t jpmap-terrain-demo:arm64 --load ..
```

## WebXR (VR/AR) 実機検証用トンネル

Meta Quest 3・Androidスマホ（ARCore）等のブラウザは WebXR
（`immersive-vr`/`immersive-ar` いずれも）の利用にセキュアコンテキスト
（HTTPS または `localhost`）を要求するため、上記の `compose.yaml`（プレーン HTTP
配信）だけでは実機ブラウザから viewer（VR）・diorama（AR）デモの
VR/ARボタンが表示されない。

[compose.webxr-tunnel.yaml](compose.webxr-tunnel.yaml) は、Cloudflare の quick
tunnel（アカウント登録不要。起動のたびに一時的な `https://*.trycloudflare.com`
URL を発行する）を `demo` サービスと同じ Docker ネットワーク上で起動するための
オプション構成。実機での VR/AR 動作確認のときだけ、`compose.yaml` と併用する。

```shell
# 1. 先に demo サービスを起動しておく（未起動なら）
docker compose -f compose.yaml up -d --build

# 2. WebXR 検証用トンネルを起動する
docker compose -f compose.webxr-tunnel.yaml up -d

# 3. 発行された https://*.trycloudflare.com URL を確認する
docker compose -f compose.webxr-tunnel.yaml logs -f

# ログが流れて探しづらい場合は、URL部分だけを抽出する
docker compose -f compose.webxr-tunnel.yaml logs \
  | grep -oE 'https://[A-Za-z0-9.-]+\.trycloudflare\.com'
```

ログに表示される `https://<random>.trycloudflare.com/viewer.html`（VR）や
`https://<random>.trycloudflare.com/diorama.html`（AR）を Meta Quest 3・
Androidスマホ等のブラウザで開く。URL は起動のたびに変わる（quick tunnel は
固定URLを提供しない、Cloudflare の SLA 対象外の機能）。

停止:

```shell
docker compose -f compose.webxr-tunnel.yaml down
```

常時運用の固定 HTTPS 配信が必要になった場合は、quick tunnel ではなく Caddy 等の
TLS 終端リバースプロキシの追加を検討すること。

## デモの追加・削除時の注意

`nginx.conf` のリライト対象デモ名一覧は、`vite.rewrites.ts` の `DEMO_NAMES`（および `spec/demos.md` の Nginx/Apache 設定例）と手動で同期させる必要がある（静的設定ファイルのため自動生成されない）。デモを追加・削除した場合は、この3箇所を合わせて更新すること。
