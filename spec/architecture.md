# jpmap_terrain アーキテクチャ（C4 モデル）

本ドキュメントは C4 モデル（L1〜L3）で jpmap_terrain の構造を説明します。

> 図は [Mermaid C4 記法](https://mermaid.js.org/syntax/c4.html) で記述しています。

---

## L1 – System Context

システム全体とその外部関係者・外部システムを示します。

```mermaid
C4Context
  title jpmap_terrain - System Context
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

  Person(user, "ユーザー", "ブラウザでデモを操作する人")

  System(jpmap, "jpmap_terrain", "地理院標高タイルから 3D 地形を<br/>生成・表示する Web アプリ<br/>(デモ群 + npm パッケージ)")

  System_Ext(gsi, "地理院タイル API", "標高タイル・地図画像タイルを<br/>提供する外部 REST API")
  System_Ext(browser, "Web ブラウザ", "WebGPU / WebGL2 レンダリング環境を提供")

  Rel_R(user, jpmap, "", "HTTPS")
  Rel_R(jpmap, gsi, "", "HTTPS / Fetch")
  Rel_D(jpmap, browser, "", "WebGPU / WebGL2")
```

---

## L2 – Container

jpmap_terrain 内部の主要コンテナ（デプロイ・ビルド単位）を示します。

> デモ 11 本は `splitChunks` でコードを共有するため、独立コンテナではなく  
> **Demo Apps グループ** としてまとめます。

```mermaid
C4Container
  title jpmap_terrain - Container
  UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")

  Person(user, "ユーザー")

  System_Ext(gsi, "地理院タイル API")

  Container_Boundary(web, "jpmap_terrain (Web アプリ)") {

    Container(portal, "Demo Portal", "HTML / TS", "デモ一覧ページ (/index.html)。<br/>Babylon.js を読み込まない軽量ページ")

    Container(demos, "Demo Apps (11 デモ)", "HTML / TS / Babylon.js", "viewer / timelapse / polygon / circle /<br/>distance / plan / model / avatar /<br/>avatar-controller / boids / flight")

    Container(lib, "JpmapTerrain Lib", "TypeScript / ESM", "公開 API 層 (src/lib)。<br/>npm パッケージとして配布可能")
    Container(terrain, "Terrain Core", "TypeScript / Babylon.js", "地形生成・タイル管理・UI 等の<br/>内部実装 (src/terrain)")
  }

  Rel_D(user, portal, "", "HTTPS")
  Rel_D(user, demos, "", "HTTPS")
  Rel_D(demos, lib, "", "ESM import")
  Rel_D(lib, terrain, "", "ESM import")
  Rel_R(terrain, gsi, "", "Fetch API")
```

---

## L3 – Component（Terrain Core）

Terrain Core（`src/terrain/`）内の主要コンポーネントを示します。
関心の異なる3つの図に分けて記述します。

### L3a – Tile Pipeline

タイル取得・地形生成のデータフローを示します。

```mermaid
C4Component
  title jpmap_terrain - Component: Tile Pipeline (L3a)
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

  Container_Boundary(lib_b, "JpmapTerrain Lib (src/lib)") {
    Component(jpmapTerrain, "JpmapTerrain", "TypeScript class", "公開 API のエントリポイント。各コンポーネントを組み合わせる")
  }

  Container_Boundary(terrain_b, "Terrain Core (src/terrain)") {
    Component(tileManager,    "TileManager",        "TypeScript",              "表示範囲の標高タイルを管理・更新する")
    Component(tileCache,      "TileCache",          "TypeScript",              "取得済みタイルのキャッシュ")
    Component(tileStitching,  "TileStitching",      "TypeScript",              "隣接タイルの継ぎ目処理")
    Component(elevationWorker,"ElevationWorkerPool","TypeScript / Web Worker", "標高計算を Worker で並列処理")
    Component(gsiTile,        "GsiTile",            "TypeScript",              "地理院タイル URL 生成・フェッチ")
    Component(meshPool,       "MeshPool",           "TypeScript",              "Mesh の再利用プール")
  }

  Rel_D(jpmapTerrain,  tileManager,     "タイル更新を指示")
  Rel_D(tileManager,   tileCache,       "キャッシュを参照・更新")
  Rel_D(tileManager,   tileStitching,   "タイル継ぎ目を補正")
  Rel_D(tileManager,   gsiTile,         "タイルデータを取得")
  Rel_D(tileManager,   meshPool,        "Mesh を再利用")
  Rel_D(tileManager,   elevationWorker, "標高計算をオフロード")
```

### L3b-1 – Overlay Features

JpmapTerrain が制御する地図オーバーレイ描画系コンポーネントを示します。

```mermaid
C4Component
  title jpmap_terrain - Component: Overlay Features (L3b-1)
  UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")

  Container_Boundary(lib_b, "JpmapTerrain Lib (src/lib)") {
    Component(jpmapTerrain, "JpmapTerrain", "TypeScript class", "公開 API のエントリポイント")
  }

  Container_Boundary(terrain_b, "Terrain Core (src/terrain)") {
    Component(modelManager,   "ModelManager",   "TypeScript", "3D モデルの読み込み・配置・アニメーション")
    Component(polygonManager, "PolygonManager", "TypeScript", "ポリゴン・ポリラインの描画管理")
    Component(circleManager,  "CircleManager",  "TypeScript", "円形オブジェクトの描画管理")
    Component(markerManager,  "MarkerManager",  "TypeScript", "マーカー (ピン等) の管理")
  }

  Rel_D(jpmapTerrain, modelManager,   "")
  Rel_D(jpmapTerrain, polygonManager, "")
  Rel_D(jpmapTerrain, circleManager,  "")
  Rel_D(jpmapTerrain, markerManager,  "")
```

### L3b-2 – Scene & UI

JpmapTerrain が制御するシーン環境・カメラ・UI 系コンポーネントを示します。

```mermaid
C4Component
  title jpmap_terrain - Component: Scene & UI (L3b-2)
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

  Container_Boundary(lib_b, "JpmapTerrain Lib (src/lib)") {
    Component(jpmapTerrain, "JpmapTerrain", "TypeScript class", "公開 API のエントリポイント")
  }

  Container_Boundary(terrain_b, "Terrain Core (src/terrain)") {
    Component(sunPosition,    "SunPosition",    "TypeScript", "太陽位置・陰影計算")
    Component(urlState,       "UrlState",       "TypeScript", "カメラ状態と URL の双方向同期")
    Component(cameraCollision,"CameraCollision","TypeScript", "地形とカメラの衝突処理")
    Component(skybox,         "Skybox",         "TypeScript", "天球の描画")
    Component(controlPanel,   "ControlPanel",   "TypeScript", "共通 UI コントロールパネル")
  }

  Rel_D(jpmapTerrain, sunPosition,    "")
  Rel_D(jpmapTerrain, urlState,       "")
  Rel_D(jpmapTerrain, cameraCollision,"")
  Rel_D(jpmapTerrain, skybox,         "")
  Rel_D(jpmapTerrain, controlPanel,   "")
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
