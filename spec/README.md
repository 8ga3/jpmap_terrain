# 機能ドキュメント

`jpmap_terrain` の仕様関連ドキュメント入口です。

## 目的

地理院タイルの標高データを利用した地形可視化の実装方針と、開発時に守るべき前提を明確化します。

## 現在の対象範囲

- Babylon.js + TypeScript によるフロントエンド実装
- WebGPU / WebGL2 を含む描画エンジンの切り替え実行
- Visual Regression Test / Unit Test の品質確認

## 参照ドキュメント

- 開発フロー: `spec/development.md`
- デモ一覧とポータル仕様: `spec/demos.md`
- アーキテクチャ（C4 モデル）: `spec/architecture.md`
- 地形表示API仕様（`JpmapTerrain`）: `spec/terrain-api.md`
- ジオラマ表示API仕様（`JpmapDiorama`）: `spec/diorama-api.md`
- リポジトリ運用ガイド: `AGENTS.md`
- プロジェクト概要: `README.md`

## 今後の詳細化予定

- 地形生成ロジック（入力タイル形式、変換手順、出力形状）
- パフォーマンス方針（LOD、描画負荷、メモリ管理）
- ブラウザ互換性とフォールバック戦略
