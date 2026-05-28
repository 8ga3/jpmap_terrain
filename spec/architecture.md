# jpmap_terrain アーキテクチャ（C4 モデル）

本ドキュメントは C4 モデル（L1〜L3）で jpmap_terrain の構造を説明します。

> 図は [Mermaid C4 記法](https://mermaid.js.org/syntax/c4.html) で記述しています。

---

## L1 – System Context

システム全体とその外部関係者・外部システムを示します。

```mermaid
C4Context
  title jpmap_terrain - System Context

  Person(user, "ユーザー", "ブラウザでデモを操作する人")

  System(jpmap, "jpmap_terrain", "地理院標高タイルから 3D 地形を生成・表示する Web アプリ (デモ群 + npm パッケージ)")

  System_Ext(gsi, "地理院タイル API", "標高タイル・地図画像タイルを提供する外部 REST API")
  System_Ext(browser, "Web ブラウザ", "WebGPU / WebGL2 レンダリング環境を提供")

  Rel(user, jpmap, "デモページにアクセスし操作する", "HTTPS")
  Rel(jpmap, gsi, "標高・地図タイルを取得する", "HTTPS / Fetch")
  Rel(jpmap, browser, "3D シーンをレンダリングする", "WebGPU / WebGL2")
```

---

## L2 – Container

jpmap_terrain 内部の主要コンテナ（デプロイ・ビルド単位）を示します。

> デモ 11 本は `splitChunks` でコードを共有するため、独立コンテナではなく  
> **Demo Apps グループ** としてまとめます。

```mermaid
C4Container
  title jpmap_terrain - Container

  Person(user, "ユーザー")

  System_Ext(gsi, "地理院タイル API")

  Container_Boundary(web, "jpmap_terrain (Web アプリ)") {

    Container(portal, "Demo Portal", "HTML / TS", "デモ一覧ページ (/index.html)。Babylon.js を読み込まない軽量ページ")

    Container(demos, "Demo Apps (11 デモ)", "HTML / TS / Babylon.js", "viewer / timelapse / polygon / circle / distance / plan / model / avatar / avatar-controller / boids / flight")

    Container(lib, "JpmapTerrain Lib", "TypeScript / ESM", "公開 API 層 (src/lib)。npm パッケージとして配布可能")
    Container(terrain, "Terrain Core", "TypeScript / Babylon.js", "地形生成・タイル管理・UI 等の内部実装 (src/terrain)")
  }

  Rel(user, portal, "デモ一覧を閲覧する", "HTTPS")
  Rel(user, demos, "各デモを操作する", "HTTPS")
  Rel(demos, lib, "JpmapTerrain 公開 API を呼び出す", "ESM import")
  Rel(lib, terrain, "内部実装に委譲する", "ESM import")
  Rel(terrain, gsi, "標高・地図タイルを取得する", "Fetch API")
```

---

## L3 – Component（Terrain Core）

Terrain Core（`src/terrain/`）内の主要コンポーネントと、各デモとの対応を示します。

```mermaid
C4Component
  title jpmap_terrain - Component (Terrain Core)

  Container_Boundary(lib_b, "JpmapTerrain Lib (src/lib)") {
    Component(jpmapTerrain, "JpmapTerrain", "TypeScript class", "公開 API のエントリポイント。各コンポーネントを組み合わせる")
  }

  Container_Boundary(terrain_b, "Terrain Core (src/terrain)") {
    Component(tileManager,    "TileManager",        "TypeScript",              "表示範囲の標高タイルを管理・更新する")
    Component(tileCache,      "TileCache",          "TypeScript",              "取得済みタイルのキャッシュ")
    Component(tileStitching,  "TileStitching",      "TypeScript",              "隣接タイルの継ぎ目処理")
    Component(elevationWorker,"ElevationWorkerPool","TypeScript / Web Worker", "標高計算を Worker で並列処理")
    Component(modelManager,   "ModelManager",       "TypeScript",              "3D モデルの読み込み・配置・アニメーション")
    Component(polygonManager, "PolygonManager",     "TypeScript",              "ポリゴン・ポリラインの描画管理")
    Component(circleManager,  "CircleManager",      "TypeScript",              "円形オブジェクトの描画管理")
    Component(markerManager,  "MarkerManager",      "TypeScript",              "マーカー (ピン等) の管理")
    Component(sunPosition,    "SunPosition",        "TypeScript",              "太陽位置・陰影計算")
    Component(urlState,       "UrlState",           "TypeScript",              "カメラ状態と URL の双方向同期")
    Component(cameraCollision,"CameraCollision",    "TypeScript",              "地形とカメラの衝突処理")
    Component(skybox,         "Skybox",             "TypeScript",              "天球の描画")
    Component(gsiTile,        "GsiTile",            "TypeScript",              "地理院タイル URL 生成・フェッチ")
    Component(meshPool,       "MeshPool",           "TypeScript",              "Mesh の再利用プール")
    Component(controlPanel,   "ControlPanel",       "TypeScript",              "共通 UI コントロールパネル")
  }

  Rel(jpmapTerrain, tileManager,     "タイル更新を指示")
  Rel(jpmapTerrain, modelManager,    "モデル操作 API を提供")
  Rel(jpmapTerrain, polygonManager,  "ポリゴン操作 API を提供")
  Rel(jpmapTerrain, circleManager,   "サークル操作 API を提供")
  Rel(jpmapTerrain, markerManager,   "マーカー操作 API を提供")
  Rel(jpmapTerrain, sunPosition,     "太陽位置・日時を制御")
  Rel(jpmapTerrain, urlState,        "URL 状態を同期")
  Rel(tileManager,  tileCache,       "キャッシュを参照・更新")
  Rel(tileManager,  tileStitching,   "タイル継ぎ目を補正")
  Rel(tileManager,  gsiTile,         "タイルデータを取得")
  Rel(tileManager,  meshPool,        "Mesh を再利用")
  Rel(tileManager,  elevationWorker, "標高計算をオフロード")
```

---

## デモ × コンポーネント 対応表

各デモが主に利用する Terrain Core コンポーネントをまとめます。

| デモ               | TileManager | ModelManager | PolygonManager | CircleManager | SunPosition | UrlState |
|:-------------------|:-----------:|:------------:|:--------------:|:-------------:|:-----------:|:--------:|
| 3D 地形ビューア    |     ✅      |              |                |               |     ✅      |    ✅    |
| タイムラプス       |     ✅      |              |                |               |     ✅      |    ✅    |
| ポリゴン           |     ✅      |              |       ✅       |               |             |    ✅    |
| サークル           |     ✅      |              |                |      ✅       |             |    ✅    |
| 距離計測           |     ✅      |              |       ✅       |               |             |    ✅    |
| Plan Viewer        |     ✅      |              |       ✅       |               |             |    ✅    |
| 3D モデル          |     ✅      |      ✅      |                |               |             |    ✅    |
| アバター #01       |     ✅      |      ✅      |                |               |             |    ✅    |
| アバター #02       |     ✅      |      ✅      |                |               |             |    ✅    |
| Boids フロッキング |     ✅      |      ✅      |       ✅       |               |             |          |
| フライトデモ       |     ✅      |      ✅      |                |               |             |    ✅    |
