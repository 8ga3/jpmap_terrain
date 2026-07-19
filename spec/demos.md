# デモ一覧とポータル仕様

`jpmap_terrain` の開発デモは複数のエントリポイントを持ち、`/`（ポータル）から各デモへ遷移できます。
本ドキュメントはデモポータルの方針・URL 規約・新規デモの追加手順をまとめます。

## デモ一覧

| デモ | URL | エントリ | 説明 |
|---|---|---|---|
| デモポータル | `/` （`index.html`） | `src/demos/portal/index.ts` | デモ一覧へのリンク集 |
| 3D 地形ビューア | `/viewer.html` | `src/demos/viewer/index.ts` | 既存の 3D 地形可視化（`/@lat,lon` URL ・カメラ・地図種別連動） |
| タイムラプス | `/timelapse.html` | `src/demos/timelapse/index.ts` | 24 時間を 1 分に圧縮した太陽位置・陰影アニメ＋アナログ時計オーバーレイ |
| ズームループ | `/zoomloop.html` | `src/demos/zoomloop/index.ts` | 指定した2地点間をカメラがクォータニオンで滑らかに往復ズームし続けるプロモーション用デモ。片道の移動時間・端点静止時間はコード内定数で調整。写真ボタン以外の画面操作（ドラッグ・ホイール・コンパス・ズームボタン・現在地・視点切替）を無効化 |
| 富士山頂周回 | `/roiorbit.html` | `src/demos/roiorbit/index.ts` | 富士山頂 ROI を中心にカメラが固定半径・時計回りで周回し続けるプロモーション用デモ。半径・高度・角速度はコード内定数で調整。写真ボタン以外の画面操作を無効化 |
| ポリゴン | `/polygon.html` | `src/demos/polygon/index.ts` | `JpmapTerrain` のポリゴン公開 API（terrain / absolute / closed の 3 種・点編集 API）の動作確認 |
| サークル | `/circle.html` | `src/demos/circle/index.ts` | `JpmapTerrain` のサークル公開 API（terrain / absolute / custom-segments の 3 種・updateCircle デモ）の動作確認 |
| 距離計測 | `/distance.html` | `src/demos/distance/index.ts` | 地形クリックで頂点を追加し、辺ごとに水平距離・高低差を表示する。`onTerrainClick` / `onPolygonPoint*` / `edgeLabels` の統合動作確認デモ |
| Plan Viewer | `/plan.html` | `src/demos/plan/index.ts` | QGroundControl の `.plan` ファイルをドラッグ&ドロップで表示するビューア。ウェイポイント・ジオフェンス・ラリーポイントを描画 |
| GPX Viewer | `/gpx.html` | `src/demos/gpx/index.ts` | GPX (GPS eXchange Format) の `.gpx` ファイルをドラッグ&ドロップで表示するビューア。トラック（軌跡）・ウェイポイントを描画し、水平移動距離・標高差等の統計と標高-時間グラフを表示 |
| 3Dモデル | `/model.html` | `src/demos/model/index.ts` | 地面クリックで 3D モデル（human.glb/obj/stl）を配置・移動するデモ。方位変更・座標表示・カメラ移動・フォーマット切替。Model API の動作確認 |
| アバターアニメーション #01 | `/avatar.html` | `src/demos/avatar/index.ts` | 3D アバター（`human_walk.glb`）が地形に沿って円軌道を移動するアニメーションデモ。地面クリックで軌道中心を変更、半径・速度スライダー、アニメーション開始/停止トグル。Model API と `playModelAnimation` の動作確認 |
| アバターアニメーション #02（Game Controller） | `/avatar-controller.html` | `src/demos/avatar-controller/index.ts` | キーボード（矢印キー / WASD）・Game Controller・Virtual Joystick で 3D アバターを地形上で操作するデモ。地面クリックでスポーン位置変更、速度スライダー、カメラ方位に応じた入力補正。Model API、Gamepad API、DOM ベース Virtual Joystick の動作確認 |
| Boids フロッキング | `/boids.html` | `src/demos/boids/index.ts` | Boids アルゴリズム（分離・整列・結合）による群衆シミュレーション。高尾山山頂付近の矩形リージョン内で複数のアバターが自律的に歩き回る。アバター数スライダー・一時停止・リスタート。Model API と Polygon API の動作確認 |
| フライトデモ | `/flight.html` | `src/demos/flight/index.ts` | 飛行機（`plane.glb`）が上空を円軌道で旋回し、Follow カメラで追跡するデモ。外部カメラ frustum API による地形タイル更新。3D/2D/Follow のカメラモード切替。Model API と外部カメラ連携 API の動作確認 |
| Artillery Game | `/artillery.html` | `src/demos/artillery/index.ts` | ターン制対戦ゲーム（紅 vs 青）。仰角・方位・火力を設定して砲弾を発射し相手に命中させる。Havok 物理で砲弾の重力・地形バウンドを再現 |
| Geospatial Globe（低レベル診断） | `/geospatial.html` | `src/demos/geospatial/index.ts` | グローブ地形コア `GlobeScene`（GeospatialCamera + ECEF + floating origin）を `JpmapTerrain` を介さず直接起動する開発者向け診断デモ。floatingOrigin/LOD/タイル数の表示・`?snap=off` 比較・`window.scene`/`window.camera` 露出で内部状態を実機確認する |

## 設計方針

- **公開ライブラリ層 (`src/lib/**`) は変更しない**。デモ層 (`src/demos/**`) は `JpmapTerrain` の公開 API 経由で機能を組み立てる。
  - 例外: `geospatial` デモのみ、グローブ地形コア `scenes/globe.ts` の `GlobeScene` を直接起動する低レベル診断デモであり、公開 API では露出しない内部状態（floatingOrigin / LOD / タイル数）の確認を目的とする。同じ `GlobeScene` は `JpmapTerrain` も `GlobeSceneAdapter` 経由で利用するため、エンジン実装の重複はない。
- 各デモは独立した Vite エントリ。`public/<name>.html` を追加し、`vite.config.ts` の `HTML_ENTRIES` に登録すればビルド対象になる（エントリ HTML は `root` = `public/` に集約）。
- デモ間で共通する Babylon.js 部分は `manualChunks` の `babylonBundle` / `webgpu-shaders` / `webgl-shaders` 等に分割され、複数デモで共有される。

## URL リライトと dist 配信時の注意

- 上表の URL（`/viewer.html` 等）は `dist/` に実体として出力される静的ファイル名であり、常にこの形式でアクセスできる。
- ポータルのカードや `createUrlUpdater`（`src/terrain/urlState.ts`）が生成する `/<name>` や `/<name>/@lat,lon,...` という拡張子なしの見た目の URL は、静的ファイルとしては存在しない。これらは `vite.rewrites.ts` の `demoRewritePlugin`（`demoAtPathRewrites`）が担うサーバー側リライトによって `/<name>.html` へ書き換えられて初めて解決する。
- このリライトは以下の場合のみ有効になる。
  - `npm run start` / `npm run start:test`（Vite dev サーバー、`configureServer` フック）
  - `npm run preview`（`vite preview`。`dist/` のビルド成果物を配信する際は必ずこちらを使う。`configurePreviewServer` フック）
- `dist/` を `vite preview` 以外の静的サーバー（Nginx、他の `serve` 系ツール等）で配信する場合、上記リライトは適用されない。拡張子なしの短縮 URL（例: `/viewer`）へ直接遷移すると 404 になる（`/viewer.html` は直接開ける）。この場合は `vite.rewrites.ts` の `demoAtPathRewrites` と同等の書き換えルールをホスティング側の設定（リバースプロキシ／リライトルール）に追加すること。
- ポータルは Babylon.js を読み込まない軽量ページ。バンドルサイズ最小化のため `JpmapTerrain` を import しない。

### 静的 CDN へのデプロイ（サーバー実行環境なし）

`npm run start` / `npm run preview` の Node ミドルウェアによるリライトは、サーバー実行環境を持たない静的 CDN（Netlify / Cloudflare Pages 等）にはそのまま持ち込めない。そのため `vite build` 時に `vite.rewrites.ts` の `demoRewritePlugin`（`generateBundle` フック）が **Netlify / Cloudflare Pages 共通書式の `dist/_redirects`** を自動生成し、`demoAtPathRewrites` と同じ「`/<name>` および `/<name>/*` → `/<name>.html`」の対応をビルド成果物に同梱する。

- 生成ロジック: `buildStaticRedirectsFile()`（`vite.rewrites.ts`）。`DEMO_NAMES` を単一の正本とし、dev/preview のリライトと内容が乖離しないようにしている。
- **Netlify / Cloudflare Pages**: `dist/` をそのままデプロイするだけで `_redirects` が有効になる。追加設定不要。
- **Vercel**: `_redirects` を解釈しないため、同等のルールを `vercel.json` の `rewrites` として別途用意する必要がある。
- **AWS S3 + CloudFront**: オブジェクトストレージ単体ではパス書き換えができないため、CloudFront Function（viewer request）等のエッジ側の軽量処理で同等のリライトを行う必要がある。
- **GitHub Pages**: リライト機能自体がなく `_redirects` は効果を持たない。`404.html` を使ったクライアント側リダイレクトのハック以外に手段がなく非推奨。
- **自前 Apache/Nginx**: `_redirects` は使えないため、`.htaccess` の `RewriteRule` や `nginx.conf` の `rewrite` ディレクティブで `demoAtPathRewrites` と同じルールを個別に用意する（設定例は下記）。

#### 自前 Nginx / Apache の設定例

`vite.rewrites.ts` の `DEMO_NAMES` と対応させる。デモを追加/削除した場合は、この設定例も合わせて更新すること（静的設定ファイルのため自動生成されない）。

```
viewer, timelapse, polygon, distance, circle, plan, gpx, model,
avatar, avatar-controller, boids, flight, artillery, geospatial,
zoomloop, roiorbit
```

**Nginx**（`server` ブロック内、`root` は `dist/` を指す。Docker上の `nginx:alpine` + 実際の `dist/` で動作確認済み）:

```nginx
server {
    listen 80;
    server_name example.com;
    root /path/to/dist;
    index index.html;

    location / {
        # デモ識別子付きパス（/viewer, /viewer/@lat,lon,...）を実体HTMLへ書き換える。
        # demoAtPathRewrites（vite.rewrites.ts）と同じデモ名一覧を維持すること。
        # ※ location の正規表現キャプチャ（外側の $1）を rewrite 側でそのまま
        #   参照すると空になるケースがあるため、rewrite 自体に捕捉グループを
        #   持たせる（location / 直下にまとめて置く）。
        rewrite ^/(viewer|timelapse|polygon|distance|circle|plan|gpx|model|avatar|avatar-controller|boids|flight|artillery|geospatial|zoomloop|roiorbit)(?:/.*)?$ /$1.html last;
        try_files $uri $uri/ =404;
    }
}
```

**Apache**（`.htaccess` または `<Directory>` 内、`mod_rewrite` 有効化が前提。Docker上の `httpd:alpine` + 実際の `dist/` で動作確認済み）:

```apacheconf
RewriteEngine On
RewriteBase /

# 実ファイル（<name>.html 本体やアセット）は書き換えず素通しする。
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
# デモ識別子付きパス（/viewer, /viewer/@lat,lon,...）を実体HTMLへ書き換える。
# demoAtPathRewrites（vite.rewrites.ts）と同じデモ名一覧を維持すること。
RewriteRule ^(viewer|timelapse|polygon|distance|circle|plan|gpx|model|avatar|avatar-controller|boids|flight|artillery|geospatial|zoomloop|roiorbit)(/.*)?$ /$1.html [L]
```

すぐ試せる Docker 構成（上記 Nginx 設定を組み込んだ `Dockerfile` / `compose.yaml`）を [docker/README.md](../docker/README.md) に用意している。Raspberry Pi 5（arm64）等の自宅サーバーで動かす手順もそちらに記載している。

### レスポンシブ / タッチ操作対応

- 全デモの HTML（`public/*.html`）に `<meta name="viewport" content="width=device-width, ...">` を付与し、モバイルでの等倍表示を保証する。すべてのページに `viewport-fit=cover` を付与し、Babylon.js を読み込むデモ（ポータル `index.html` 以外のすべて）にはさらに `maximum-scale=1` を付与する（ポータル `index.html` は軽量ページのため `maximum-scale=1` を付与せず、ページズームを許可する）。
  - **注意（アクセシビリティ）**: `maximum-scale=1` はユーザーのページズーム（ピンチズーム）を無効化するため、低視力ユーザー等のアクセシビリティに影響する。地図/3D キャンバス自体のピンチズーム（地形・モデルの拡大縮小）とブラウザのページズームが競合するのを避けるための意図的な指定だが、将来 UI 文字サイズの調整等で見直す際は、この制約（ページズーム不可）を踏まえて判断すること。
- 操作 UI（`src/terrain/controlPanel.ts`）は固定 px で生成するが、`@media (pointer: coarse)` のスタイルを注入し、**タッチ端末でのみ** タップ領域（最小 44px）・文字サイズ・配置余白を拡大する。マウス/トラックパッド（fine pointer）では従来の見た目を維持するため、ビジュアル回帰テスト（`tests/validation.spec.ts`）への影響はない。
- タッチパネルのパン（`src/scenes/globe.ts` の独自シングルタッチパン）は、接地中のタッチポインタ位置（`touchPoints`）で 2 本指以上を検出し、ピンチ中はシングルタッチパンを無効化する。これにより `GeospatialCamera` のピンチズームとシングルタッチパンの同時発火を防ぐ（マウス操作は従来どおり）。
- **2 本指ジェスチャ（`src/scenes/globe.ts`）**: GeospatialCamera 組み込みの multi-touch パン（= 2 本指ドラッグでの tilt 回転）を無効化（`multiTouchPanning=false`／`multiTouchPanAndZoom=false`、`pinchZoom` は温存）し、独自のジェスチャ処理に置き換える。割り当ては指の間隔（spread）で切り替える:
  - ピンチイン/アウト（間隔変化）→ ズーム（GeospatialCamera 側で処理）。
  - 間隔が広い（`>= TWO_FINGER_TILT_SPREAD_PX`）→ 平行移動で pan、指のひねり（twist）で方位回転（yaw）。
  - 間隔が狭い（`< TWO_FINGER_TILT_SPREAD_PX`）→ 縦移動で tilt（pitch、`limits` でクランプ）。
  - モードは最初の 2 本指 move 時に間隔で確定し、指を離す（2 本未満になる）まで維持する。途中で間隔がしきい値を跨いでもモードを切り替えない（誤切替防止）。
  - 感度・しきい値は `TWO_FINGER_TILT_SPREAD_PX` / `TWO_FINGER_TILT_SENS` / `TWO_FINGER_YAW_SENS` で調整可能。動作確認は iOS Safari / Android Chrome 実機で行う。
- 残課題: タッチパッドの 2 本指スクロール→パンのマッピングは、マウスホイールズームとの判別がハードウェア依存のため未実装。実機（Mac トラックパッド）での挙動確認を経て方針決定する。
- **ブラウザ既定ジェスチャの抑止**: 操作ボタン（`.cp-btn` / `.cp-compass`）に `touch-action: manipulation` を付与し、iOS Safari のダブルタップズームを抑止する（タップは従来どおり機能）。viewer ページ（`public/viewer.html`）の `html, body` に `touch-action: none; overscroll-behavior: none;` を付与する。さらに、`touch-action` だけでは Android Chrome 等のオーバースクロール（2 本指スワイプによる自動スクロール）や画面端スワイプの戻る/進むナビゲーションが残るため、地図キャンバスの `touchmove` を `{ passive: false }` で捕捉し `preventDefault()` する（`src/lib/jpmapTerrain.ts`。Babylon はポインタイベントで操作を処理するためジェスチャ実装には影響しない）。
- **現在地（Geolocation）**: `navigator.geolocation.getCurrentPosition` はセキュアコンテキスト（HTTPS、または `localhost`）でのみ動作する。LAN の IP に対する `http://` の dev サーバではブラウザがブロックするため、スマホ実機では取得できない（本番/`localhost` では動作）。仕様であり実装上の不具合ではない。
- **スケールバー幅の上限制御**: スケールバーは右下に右寄せ配置され、`snapScale` が常に切り上げるためバー幅が基準（100px）の最大 2.5 倍程度まで広がりうる。狭い画面ではバーが左へ伸びて左下の地図切替ボタン（写真/標準）へ被るため、`pickScaleWithin(metersPerPx, basePx, maxBarPx)`（`src/terrain/controlPanel.ts`）で画面幅から求めた `maxBarPx` を超えない範囲のきれいな値を選ぶ（超える場合は 1 段階小さいスケールへ下げる）。`maxBarPx` は「行の右端 − 地図切替ボタンの右端 − 安全マージン − バー以外の固定要素幅（地理院タイル＋ラベル＋gap）」として `src/scenes/globeSceneController.ts` で算出する。広い画面では従来の `snapScale` と同一値となり、デスクトップ表示は不変。
- **言語宣言**: 各デモの `<html lang="ja">` を宣言し、Chrome の自動翻訳プロンプトを抑止する（中身が日本語のため）。将来的な多言語切り替え（UI テキストの i18n / `locale` オプション）は別課題。


## URL 規約

### 共通

- `?engine=webgpu|webgl|webgl2`: 描画エンジン指定（`webgl` は `webgl2` に正規化、未指定は自動）。

### viewer (`/viewer.html`)

- `/@<lat>,<lon>[,<altitude>,<azimuth>,<tilt>]` のパス形式でカメラ初期値を指定可能。
- `?mapType=standard|photo`、`?dateTime=<ISO8601>`、`?autoSunPosition=true|false`、`?showSunShadows=true|false`。
- 詳細は [README.md](../README.md) の「URL フォーマット」節を参照。

#### WebXR (VR) 対応（PoC）

- 画面左上に、WebXR (`immersive-vr`) に対応したブラウザ/デバイス（例: Meta Quest 3）でのみ
  「VR」ボタンが表示される。非対応環境では機能検出後にボタンを表示しない。
- **実機で動作させるにはセキュアコンテキスト（HTTPS または `localhost`）が必須**
  （WebXR の仕様上の制約）。`docker/` 配下でのローカル配信は既定でプレーン HTTP のため、
  実機検証には `docker/compose.webxr-tunnel.yaml`（Cloudflare quick tunnel、詳細は
  [docker/README.md](../docker/README.md) 参照）等で HTTPS 化すること。
- 描画エンジンは **WebGL2 を使うこと**（`?engine=webgl2`）。既定の自動選択（WebGPU 優先）は
  実機（Meta Quest Browser）で `enterXRAsync` が失敗し VR に入れない事例を確認している。
  これは本 PoC のバグではなく、**Meta Quest Browser（スタンドアロン）が現時点で
  WebGPU+WebXR(VR) の組み合わせに未対応**というプラットフォーム側の制約による
  （2025年12月時点、AirLink 経由の Windows Chrome Canary では動作報告あり。将来の
  ブラウザ更新で対応される可能性がある）。そのため本 PoC では VR 突入時に描画エンジンを
  自動的に強制切り替えすることはせず、`?engine=webgl2` の手動指定に委ねる方針とした。
- ボタン押下で WebXR セッションを開始し、コントローラーで以下を操作できる。
  - 左スティック: 地図平面移動（パン）
  - 右スティック: 高度（ズーム）。ここでの高度は地表からの高さ（既定 150m、
    `?vrHoverHeight=<meters>` で調整可能）であり、海抜高度ではない。
  - B/Y ボタン（右手 = B、左手 = Y、どちらも xr-standard マッピングの `buttons[5]`）:
    VR セッションを終了する（没入中は画面上の 2D ボタンに触れられないため）。当初は
    グリップ（squeeze）ボタンを使っていたが、コントローラーを握る動作で誤操作が
    多いとの実機フィードバックを受けて変更した。
- 実装は `src/demos/viewer/webXrVrSession.ts`（Babylon.js `WebXRDefaultExperience` のセットアップ・
  カメラリグの ECEF 位置同期・地形 LOD 追従）と `src/demos/viewer/webXrControllerMapping.ts`
  （スティック入力→パン/ズーム移動量への変換、DOM/Babylon 非依存の純粋関数）に分かれている。
- **z-fighting 対策**: WebXR カメラはブラウザ提供の `XRView.projectionMatrix` を直接使う実装のため
  `engine.useReverseDepthBuffer`（デスクトップで z-fighting 対策に使っている reverse-Z）の
  恩恵を受けられない。さらに、実際にレンダリングへ反映される近遠クリップは
  `camera.minZ`/`camera.maxZ` ではなく **`WebXRSessionManager.updateRenderState({ depthNear,
  depthFar })`（WebXR 標準 API）でのみ変更できる**（`camera.minZ`/`maxZ` を設定するだけでは
  実描画に一切反映されない。当初この理解が誤っており実質何も変わっていなかった）。
  `updateRenderState` を、地平線距離ベースのより狭い範囲を返す `computeVrCameraClipPlanes`
  （`webXrControllerMapping.ts`）の結果で間引きつつ動的に呼び出している（デスクトップの
  `GeospatialClippingBehavior` をそのまま流用すると常に far clip が惑星半径の1割≒638km に
  なり、低高度で背景の地球楕円体球と地形タイルが z-fighting する不具合を実機検証で確認・
  修正した）。
- **タイル LOD（過剰な詳細度要求・タイル境界の不整合）対策**: タイル LOD の SSE 評価は
  desktop 側 `GeospatialCamera`（`globe-camera`）の `fov` を参照するが、Babylon 既定の
  fov（約46°）は Meta Quest 3 実機の実際の視野角（約90〜100°）よりかなり狭く、この不一致が
  LOD 判定を過剰に高精細にし、可視範囲内のタイル数が上限を超えて欠ける・低ズームレベルで
  隣接タイルの LOD 不整合（本来ギャップを隠すためのスカート形状が可視化される）の一因に
  なっていた（実機検証で確認）。毎フレーム `xr.baseExperience.camera.fov`
  （ブラウザの実 FOV を反映、Babylon が自動更新）を `globe-camera` へ同期して緩和している。
  加えて、`lodBias` 算出用の実効半径にも下限（400m、`resolveVrLodEffectiveRadiusM`）を
  設けている。
- **現状はデモ層に閉じた PoC**であり、`JpmapTerrain` の公開 API ではない内部アクセサ
  （`__debugScene` 等）に依存している。`flight` / `roiorbit` デモが用いる「外部カメラで
  地形 LOD を駆動する」既存パターンを踏襲したもので、動作が安定した段階でライブラリ公開 API
  への昇格を検討する。
- 既知の制限: VR 中は 2D のコンパス UI が非表示になり、方位（東西南北）の手がかりがない
  （follow-up 課題）。

### timelapse (`/timelapse.html`)

| パラメータ | 型 | 既定値 | 説明 |
|---|---|---|---|
| `start` | ISO 8601 | 当日 0 時 UTC | シミュレーション開始時刻（UTC として扱う） |
| `speed` | 数値（秒） | `60` | 24 時間ぶんを実時間で何秒に圧縮するか。0 以下/非数値は 60 にフォールバック |
| `paused` | （無値）/ `true` | `false` | 一時停止（テスト用）。`paused=false` または `paused=0` は走行 |
| `showSunShadows` | `true` / `false` | `true` | 太陽影描画。`false` で OFF（描画負荷軽減） |
| `engine` / カメラ系 | viewer と同じ | — | `parseCameraStateFromUrl` を共用 |

実装上、タイムラプス側では `autoSunPosition` を強制 OFF にし、`viewer.dateTime` を `requestAnimationFrame` ループで更新します（`UPDATE_INTERVAL_MS = 200ms` で setter 連打を抑制）。アナログ時計と時刻ラベルは画面下部中央に縦積みで配置し、表示は日本標準時（JST = UTC+9）を使用します。

### circle (`/circle.html`)

`JpmapTerrain` のサークル公開 API（§3.3.9）の動作確認デモ。

**デモ構成（3 サークル）:**

| id | altitudeMode | 概要 |
|---|---|---|
| `yomiuri-terrain` | `terrain` | 地表追従円（半径 300m、altitude=50m、赤色） |
| `yomiuri-absolute` | `absolute` | 絶対標高円（半径 200m、altitude=400m、青色） |
| `yomiuri-custom` | `absolute` | カスタムセグメント円（半径 150m、altitude=300m、segments=16、黄色） |

**コントロール:** 各サークルの enabled / point / line / wall / label トグルと、`updateCircle` による半径・中心・スタイル変更のデモ UI を右パネルに配置する。

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式および `?lat=&lon=` クエリ形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### distance (`/distance.html`)

クリック / ドラッグでポリラインを編集し、頂点ごとの `lat / lon / altitude` と各辺の水平距離・高低差を実時間で表示する距離計測デモ。`onTerrainClick` / `onPolygonPoint*` / `edgeLabels` の統合動作確認を兼ねる。

**URL:** `engine` に加えて、viewer / timelapse と同様にカメラ初期位置の指定（`/@lat,lon[,...]` のパス形式、および `?lat=&lon=` 等のクエリ形式）と `?mapType=standard|photo` を受け付ける（実装上 `parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

**操作モード（右上ツールバーで排他切替）:**

| モード | 操作 | 効果 |
|---|---|---|
| `add`（既定） | 地形クリック | クリック地点に `altitude = 地表 + 100 m` の頂点を末尾追加。カーソルは矢印 + 「+」記号。 |
| `remove` | 頂点クリック | 当該頂点を削除（残点 0/1 も許容）。頂点 hover 時のみ矢印 + 「−」記号カーソル。 |
| `edit` | 頂点ドラッグ | 頂点の `lat/lon` を更新。`Shift+ドラッグ`で高度（`altitude`）を更新（地表より下にはクランプ）。頂点 hover 時のみ `move` / `ns-resize` カーソル。 |
| 「クリア」ボタン | — | 全頂点を削除する。 |

**表示:**

- 各頂点に `lat / lon / altitude(m)` をラベル表示（`labels`）。
- 各辺の中点に `水平距離(m or km) / 高低差(m, 符号付き)` をラベル表示（`edgeLabels`）。1 km 未満は `m`、それ以上は小数 2 桁の `km` で整形する。
- ポリライン本体・球体頂点・各点からの垂線・隣接垂線間の壁を全表示（壁・垂線は地表を貫通して Y=0 まで伸び、半透明壁は地形に対して深度オクルードされる）。

**実装メモ:**

- 水平距離は `haversineDistanceMeters`（WGS84 平均半径）で算出。浮動小数誤差で `h` が 1 を僅かに超えるケース（対蹠点付近）に備え、`h` を `[0, 1]` にクランプしてから `Math.atan2` に渡す。
- 編集モードのドラッグ時は `pointermove` ごとに `removePolygon` → `addPolygon` を行うと負荷が高いため、`requestAnimationFrame` で 1 フレーム 1 回に集約する。`dragEnd` で保留中の rAF を即時 flush し、最終位置が確実に反映されるようにする。

### plan (`/plan.html`)

QGroundControl の `.plan` ファイルをドラッグ&ドロップでマップ上に表示するビューア。編集機能は持たない。

**ファイル入力:** デスクトップからのドラッグ&ドロップ。再ドロップ時は前回表示をクリアし新しい Plan のみ表示する。

**ウェイポイント（Mission）:**

- パスライン（`addPolygon`, `altitudeMode: "absolute"`, `closed: false`）で描画。
- 各頂点ラベル: `#番号\n高度 m`（1 始まり、スキップ MAV_CMD は数えない）。
- エッジラベル: `水平距離\n高度差`。
- 対応 MAV_CMD: `NAV_WAYPOINT`(16) / `NAV_LAND`(21) / `NAV_TAKEOFF`(22)。その他はスキップ。
- 高度はホームポジションからの相対高度として絶対高度に変換。

**ジオフェンス:**

- ポリゴン: `addPolygon`（`closed: true`, `altitudeMode: "absolute"`）。ホーム高度 +10m で描画（遠方タイル未ロード時も即時表示のため）。ラベルなし。
- 円: `addCircle`（`altitudeMode: "absolute"`, `pointEnabled: false`, `label: null`）。ホーム高度 +10m で描画。壁付き。

**ラリーポイント:**

- 1 点ポリゴン（`addPolygon`）でマーカー表示。ラベルは `R番号`。

**URL:** `engine` / カメラ系は他デモと共通（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### gpx (`/gpx.html`)

GPX (GPS eXchange Format) の `.gpx` ファイルをドラッグ&ドロップでマップ上に表示するビューア。編集機能は持たない。

**ファイル入力:** デスクトップからのドラッグ&ドロップ。再ドロップ時は前回表示をクリアし新しい GPX のみ表示する。

**トラック（軌跡）:**

- パスライン（`addPolygon`, `altitudeMode: "absolute"`, `closed: false`）で描画。頂点球体マーカー/垂線/壁/点ラベルは無効化し、線のみのポリラインとして描画する。
- 大量の点（数千点規模）を含み得るため、描画点数は `MAX_RENDER_POINTS_PER_SEGMENT` まで間引く（統計値の計算には間引き前の全点データを使う）。
- トラック始点・終点のみ、Plan Viewer のホームポジション相当の単点マーカー（開始=緑・終了=赤）で強調表示する。
- 複数トラックを含む GPX はトラックごとに色分けして描画する。

**ウェイポイント:** 1 点ポリゴン（`addPolygon`）でマーカー表示。ラベルは `<name>`（無ければ `WPT <連番>`、1 始まり）。

**統計パネル（画面右上）:** トラック名・水平移動距離（`水平移動距離:`、複数トラックは合計も表示）・標高差（↑登り／↓下り、標高レンジ）・トラックポイント数・ウェイポイント数を表示。トラック/ウェイポイントの表示切替ボタン付き。

**標高-時間グラフ（画面下部）:**

- Canvas 2D（外部ライブラリ非依存）で標高（縦軸）と記録時刻（横軸）の折れ線＋線より下側の半透明塗りつぶしを表示。
- `<trkpt><time>` を持つ GPX のみ対象（時刻情報がなければパネルごと非表示）。
- GPX 上の時刻は UTC で記録されているため、表示時のみ JST（UTC+9固定）に変換する（GPX ファイル自体は変更しない）。
- パネルの位置・幅は、左下（写真ボタン）・右下（ズームボタン列・スケールバー）の操作 UI と実測して重ならないよう動的に調整する。狭幅時は時間軸ラベルが重ならないよう目盛り数を自動的に減らす。

**URL:** `engine` / カメラ系は他デモと共通（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### model (`/model.html`)

`JpmapTerrain` の 3D モデル公開 API（§3.3.x）の動作確認デモ。

**初期状態:** 東京駅（lat: 35.681236, lon: 139.767125）に `assets/human.glb` を `altitudeMode: "terrain"` で配置。

**操作:**

| 操作 | 効果 |
|---|---|
| 地面クリック | クリック地点に 3D モデルを移動（カメラから 5km 以内、地面のみ） |
| 方位スライダー | 3D モデルの Y 軸回転（0–360°） |
| 「モデル位置へ移動」ボタン | カメラを 3D モデルの緯度・経度に `flyTo` |

**表示:** 右パネルに緯度・経度・方位を表示。方位変更用スライダーと移動ボタンを配置。

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式および `?lat=&lon=` クエリ形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

## 新規デモの追加手順

1. `src/demos/<name>/index.ts` を新規作成し、エントリ起動コードを実装する。
   - DOM のマウントポイント `#root` を取得。
   - 必要なら `JpmapTerrain.create(mount, opts)` を呼び出す。
   - `process.env.NODE_ENV !== "production"` のときは `window.scene` / `window.viewer` を露出する（Playwright 互換）。
2. `public/<name>.html` を新規作成（`#root` 要素と
   `<script type="module" src="/src/demos/<name>/index.ts"></script>` を含む）。
   - エントリ HTML は Vite の `root`（`public/`）に集約している。
3. `vite.config.ts` の `HTML_ENTRIES` に `"<name>"` を追記する。
   - デモ識別子付きパス（`/<name>/@...`）の SPA fallback が必要な場合は、
     `vite.rewrites.ts` の `DEMO_NAMES` にも追記する。
4. `src/demos/portal/index.ts` の `DEMO_LIST` に項目を追加する。
5. `npm run build:dev` で `dist/<name>.html` が生成されることを確認。
6. ユニットテストを `tests/<name>.unit.spec.ts` に追加する（純粋関数を分離して書きやすくする）。
7. 必要であれば Playwright VR テストを `tests/validation.spec.ts` に追加する（決定論化が必要：`?paused=true&start=...`）。

## 互換性メモ

- 既存の VR スナップショット（`tests/validation.spec.ts-snapshots/`）は viewer の URL 変更（`/?scene=default` → `/viewer.html?scene=default`）後も同一の描画結果のため流用可能。
- `manualChunks`（`vite.config.ts`）で共有依存（Babylon.js / シェーダー）を分割している。

### avatar (`/avatar.html`)

3D アバター（`assets/human_walk.glb`）が地形に沿って円軌道を移動するアニメーションデモ。`JpmapTerrain` の Model 公開 API と `playModelAnimation` を使用する。

**仕様:**

- 東京駅（35.681236, 139.767125）に初期配置
- 地面クリックでクリック地点を中心とする円軌道の中心を移動（カメラから 5000m 以内）
- 歩行アニメーション（`rig-action`）を再生しながら毎フレーム円周上を移動
- 進行方向に向きを自動回転（接線方向 = `angleDeg + 90°`）
- 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
- モデルスケール: 50 倍

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| 半径スライダー | 円軌道の半径 (m) を変更（既定 200m） |
| 速度スライダー | 角速度 (°/秒) を変更（既定 20°/秒） |
| 開始/停止ボタン | アニメーション再生のトグル |
| 中心へ移動ボタン | カメラを軌道中心に移動 |

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### avatar-controller (`/avatar-controller.html`)

3D アバター（`assets/human_walk.glb`）をキーボード / Game Controller / Virtual Joystick で地形上を操作するデモ。`JpmapTerrain` の Model 公開 API・`playModelAnimation` と Babylon の `GamepadManager` を組み合わせる。

**仕様:**

- 東京駅（35.681236, 139.767125）に初期配置
- 地面クリックでアバターを当該地点にスポーン（カメラから 5000m 以内）
- 入力 3 系統を合成（最大値採用）し、画面（カメラ）方位に従って回転してから移動量に変換
  - **キーボード**: 矢印キー / `WASD`
  - **Game Controller**: 左スティック（Babylon `GamepadManager`、左スティック Y は反転し北 = +1 に揃える）
  - **Virtual Joystick**: 画面左下に常時表示する DOM ベースの自作ジョイスティック（操作可能領域は本体に限定）
- 移動中は歩行アニメーション（`rig-action`）を再生／停止で停止
- 進行方向に向きを自動回転（`movementHeading`）
- 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
- モデルスケール: 50 倍

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| 速度スライダー | 移動速度 (m/s) を変更（既定 10m/s、1–50m/s） |
| 現在位置へ移動ボタン | カメラをアバターの緯度・経度に `flyTo` |

**Virtual Joystick:**

- 画面左下（写真ボタンの右隣）に常時表示。
- Pointer Events ベースで実装し、`setPointerCapture` により他要素への横取りを防止。
- 親オーバーレイは `pointer-events: none`、ジョイスティック本体のみ `pointer-events: auto`。これにより地面クリック等の他操作と両立する。

**実装メモ:**

- 純粋関数（`keyboardVector` / `applyDeadzone` / `combineInputs` / `stepPosition` / `movementHeading` / `rotateByAzimuth` / `moveVectorMagnitude`）を `movement.ts` に分離し、`tests/avatarController.unit.spec.ts` で網羅的にテスト。
- 方位規約は本プロジェクト共通（北 = 0°・反時計回り正、ArcRotateCamera の alpha 由来）に従い、画面入力 `(vx, vy)` をワールド `(east, north)` に揃えるため `rotateByAzimuth` 内部で `-azimuthDeg` 回転する。
- ウィンドウ blur 時にキーが押しっぱなしになるのを防ぐため、`window.blur` で `pressedKeys.clear()` を行う。

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### boids (`/boids.html`)

Boids アルゴリズム（Craig Reynolds, 1987）による群衆シミュレーションデモ。高尾山山頂付近の矩形リージョン内で複数のアバター（`assets/human_walk.glb`）が分離・整列・結合の 3 ルールに従い自律的に歩き回る。

**仕様:**

- 高尾山山頂（35.6251, 139.2436）を中心とした矩形リージョン（約 300m × 300m）
- リージョン境界を Polygon API（`addPolygon`, `closed: true`）で可視化
- 複数のアバターを Model API（`addModel` / `updateModel` / `playModelAnimation`）で配置・更新
- Boids の 3 ルール:
  - **分離 (Separation)**: 近すぎる仲間から離れる
  - **整列 (Alignment)**: 近隣の仲間と進行方向を揃える
  - **結合 (Cohesion)**: 近隣の仲間の重心に向かう
- 歩行アニメーション（`rig-action`）を再生
- 進行方向に向きを自動回転
- 地形追従（`altitudeMode: "terrain"`, `gravity: true`）
- 地形の高度による速度影響・転落はなし
- アバターはリージョン境界から出られない（境界回避力を適用）
- モデルスケール: 25 倍

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| アバター数スライダー | アバター数を動的に変更（1〜50 体、既定 20 体） |
| 一時停止 / 再開ボタン | シミュレーションの一時停止 / 再開トグル |
| リスタートボタン | アバターを初期位置にリセットし再スタート |
| リージョン中心へ移動ボタン | カメラをリージョン中心に移動 |

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### flight (`/flight.html`)

飛行機（`assets/plane.glb`）が上空を円軌道で旋回し、Follow カメラで追跡するデモ。`JpmapTerrain` の外部カメラ連携 API（§3.3.14）と Model API（§3.3.13）を使用する。

**仕様:**

- 東京駅（35.681236, 139.767125）上空に初期配置
- 地面クリックでクリック地点を中心とする円軌道の中心を移動（カメラから 20000m 以内）
- 毎フレーム円周上を移動し、進行方向に自動回転（接線方向）
- `altitudeMode: "absolute"` で絶対標高指定
- Follow モード時は FreeCamera を飛行機の後方上方に配置し、外部 frustum API でタイル更新
- 3D/2D モード時は通常の ArcRotateCamera を使用

**コントロール（右上パネル）:**

| UI | 操作 |
|---|---|
| 緯度・経度表示 | 現在の円軌道中心座標 |
| 半径スライダー | 円軌道の半径 (m) を変更（既定 2000m、500–10000m） |
| 速度スライダー | 飛行速度 (m/s) を変更（既定 100m/s、100–340m/s） |
| 高度スライダー | 飛行高度 (m) を変更（既定 2000m、100–10000m） |
| 停止/再開ボタン | アニメーション再生のトグル |
| 移動ボタン | カメラを軌道中心に移動 |
| カメラモードボタン | 3D / 2D / Follow の切替 |
| Follow 距離・高度 Offset | Follow カメラの飛行機からの距離と高度オフセット（ドラッグ/ホイールで操作） |
| LOD bias スライダー | Follow モード時のタイル粒度調整（0–4、大きいほど粗い） |

**Follow カメラ操作:**

| 操作 | 効果 |
|---|---|
| 左右ドラッグ | カメラの水平回転（飛行機を中心に周回） |
| 上下ドラッグ | カメラの高度オフセット変更 |
| マウスホイール | カメラの距離変更 |

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。

### artillery (`/artillery.html`)

[Artillery Game](https://en.wikipedia.org/wiki/Artillery_game) に似たターン制対戦ゲームデモ。紅組 vs 青組で仰角・方位・火力を設定して砲弾を発射し、相手の大砲に命中させるゲーム。Havok 物理エンジンで砲弾の重力・地形バウンドを再現する（大きいスケールでも気持ちよく飛ぶようデフォルメ重力を採用）。

**仕様:**

- 紅組（Red）vs 青組（Blue）の 1 vs 1 ターン制
- 攻撃ターンで Angle（仰角: 5°–85°）・Heading（方位: ±45°）・Power（火力: 1–100%）を設定し発射
- 砲弾は Havok 物理で飛行（デフォルメ重力 Y=-180、初速 200–600）
- 命中時は ParticleSystem による爆発エフェクトを表示
- 命中した側の大砲はリスポーン（位置リセット）
- 紅・青それぞれの命中数をスコア表示
- 命中しなかった砲弾は寿命到達で消滅（メッシュプールで再利用）

**ステージ:**

- 箱根（芦ノ湖周辺）の起伏のある地形（場所は動作テストで最終決定）
- 紅組は西側、青組は東側に配置

**コントロール（ボトムバー）:**

| UI | 操作 |
|---|---|
| スコア表示（トップ中央） | RED / BLUE のスコア。現在ターン側を強調表示 |
| Angle スライダー | 仰角 5°–85°（既定 45°） |
| Heading スライダー | 方位 ±45°（既定 0°、正面基準） |
| Power スライダー | 火力 1–100%（既定 50%） |
| FIRE ボタン | 砲弾を発射 |
| ↺ ボタン | ゲームをリセット |

> 戦場を中央へ固定するためマップのパン操作を無効化（`enablePan: false`）し、現在地（📍）ボタン・2D/3D 切替ボタンは非表示にしている。

**砲弾飛行（Havok 物理）:**

- Havok 物理エンジン（`@babylonjs/havok`）を使用。重力・地形コリジョン・バウンドはすべて Havok が計算
- 砲弾 = 動的 SPHERE 剛体（質量1、反発0.6、摩擦0.4）。発射時に `setLinearVelocity` で初速を付与
- 地形コリジョン = `terrainCollider.ts` がプレイエリアの可視地形をサンプリングした不可視の静的メッシュボディ（反発0.5、摩擦0.6）
  - 地形タイル（`tile-ground-*`）はストリーミングで動的更新されるため、専用のコリジョンメッシュを 1 枚生成してストリーミングから分離
  - 衝突法線込みで計算されるため斜面でも自然なバウンド
- デフォルメ重力（Y=-180）で大きい表示スケールでも気持ちよく飛ぶ
- 物理ボディは発射ごとに生成・破棄（状態リセット漏れを防ぐ）。メッシュはプールで再利用
- 砲弾寿命: 8 秒後に自動消滅

**URL:** `engine` に加えてカメラ初期位置（`/@lat,lon[,...]` のパス形式）と `?mapType=standard|photo` を受け付ける（`parseCameraStateFromUrl` / `parseMapTypeFromUrl` を共用）。
