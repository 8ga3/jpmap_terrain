# jpmap_terrain デモサイト（dist/）配信用イメージ。
#
# `npm run build` の成果物（リポジトリルートの `dist/`）を nginx で配信する。
# ビルドコンテキストはリポジトリルート（`compose.yaml` 側で `context: ..` を指定）。
# nginx:alpine はマルチアーキ対応（amd64/arm64）のため、Raspberry Pi 5（arm64）
# 上でも同じ Dockerfile でネイティブビルド・実行できる。
FROM nginx:alpine

# デモ識別子付きパス（/viewer, /viewer/@lat,lon,... 等）を実体 HTML へ書き換える
# 設定。spec/demos.md の「自前 Nginx」設定例と同一（Docker上で動作検証済み）。
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# ビルド済み静的サイト本体。ビルド前に必ず `npm run build` を実行しておくこと。
COPY dist/ /usr/share/nginx/html/
