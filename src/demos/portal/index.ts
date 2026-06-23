/**
 * デモポータル (Issue #147)
 *
 * `jpmap_terrain` の各デモへのリンクを表示する純粋な静的ポータル。
 * Babylon.js は読み込まないため、ライブラリ側 (`src/lib/**`) の依存は持たない。
 *
 * 追加デモは `DEMO_LIST` に項目を増やすことで一覧へ反映できる。
 * 並びは配列順。`href` は webpack の HtmlWebpackPlugin が出力する HTML ファイル名と一致させる。
 */

interface DemoEntry {
    /** カードに表示するタイトル */
    title: string;
    /** 説明文（1〜2行を推奨） */
    description: string;
    /** デモへの相対 URL */
    href: string;
}

const DEMO_LIST: readonly DemoEntry[] = [
    {
        title: "3D 地形ビューア",
        description:
            "地理院タイルの標高データから 3D 地形を表示する基本デモ。緯度経度・カメラ向き・地図種別を URL で指定できます。",
        href: "viewer",
    },
    {
        title: "タイムラプス（太陽の動きと陰影）",
        description:
            "24 時間を 1 分に圧縮して太陽位置・陰影をアニメーションし、アナログ時計で同期表示するショーケース。",
        href: "timelapse",
    },
    {
        title: "ポリゴン",
        description:
            "PolygonManager 公開 API の動作確認デモ。terrain / absolute / closed の 3 種類のポリラインを表示し、enabled トグルで切替できます。",
        href: "polygon",
    },
    {
        title: "距離計測",
        description:
            "地形クリックで点を追加し、辺ごとの水平距離と高低差を表示するデモ。追加 / 削除 / 編集モードで頂点を動的に編集できます。",
        href: "distance",
    },
    {
        title: "サークル",
        description:
            "CircleManager 公開 API の動作確認デモ。terrain / absolute / カスタムセグメントの 3 種類の円を表示し、enabled や半径・スタイルの動的更新ができます。",
        href: "circle",
    },
    {
        title: "Plan Viewer",
        description:
            "QGroundControl の Plan ファイル（.plan）をドラッグ&ドロップでマップ上に表示するビューア。ウェイポイント・ジオフェンス・ラリーポイントを描画します。",
        href: "plan",
    },
    {
        title: "3Dモデル",
        description:
            "地面クリックで 3D モデル（human.glb）を配置・移動するデモ。方位変更やモデル位置へのカメラ移動が可能です。",
        href: "model",
    },
    {
        title: "アバターアニメーション #01",
        description:
            "歩行アニメーション付き 3D モデルがクリック地点を中心に円軌道で地形に沿って移動するデモ。半径・速度の調整が可能です。",
        href: "avatar",
    },
    {
        title: "アバターアニメーション #02（Game Controller）",
        description:
            "キーボード（矢印キー / WASD）・Game Controller・Virtual Joystick でアバターを地形上で操作するデモ。地面クリックでスポーン位置を変更できます。",
        href: "avatar-controller",
    },
    {
        title: "Boids フロッキング",
        description:
            "Boids アルゴリズム（分離・整列・結合）で複数のアバターが群衆行動するデモ。アバター数の変更やシミュレーションの一時停止・リスタートが可能です。",
        href: "boids",
    },
    {
        title: "フライト（飛行機フォロー）",
        description:
            "飛行機が上空を大きな半径で高速旋回し、FollowCamera で追跡するデモ。3D / 2D / Follow のカメラモード切替が可能です。",
        href: "flight",
    },
    {
        title: "Artillery Game（大砲対戦）",
        description:
            "ターン制の対戦ゲーム。角度と火力を調整して砲弾を発射し、相手の大砲に命中させよう。Havok 物理エンジンでバウンド・転がりを再現。",
        href: "artillery",
    },
    {
        title: "Geospatial Globe（低レベル診断・開発者向け）",
        description:
            "GeospatialCamera + ECEF 楕円体 + floating origin のグローブ地形コア（GlobeScene）を JpmapTerrain を介さず直接起動する診断デモ。floatingOrigin/LOD/タイル数の表示や ?snap=off 比較など内部状態の実機確認に使います。右ドラッグ=回転 / ホイール=ズーム。",
        href: "geospatial",
    },
];

const PORTAL_MOUNT_ID = "root";

/**
 * テキスト中の `&` `<` `>` `"` `'` をエスケープする。
 * デモ定義は本ファイル内のリテラルだが、将来 URL パラメータ等から渡す余地を残すため明示的に処理する。
 */
const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const renderCard = (demo: DemoEntry): string =>
    `<li class="demo-card"><a href="${escapeHtml(demo.href)}"><h2>${escapeHtml(
        demo.title,
    )}</h2><p>${escapeHtml(demo.description)}</p></a></li>`;

/**
 * 国土地理院タイル等の出典表記（Issue #417）。
 * 各項目はプレーンテキストとして `escapeHtml` を通して出力し、
 * URL は明示的にリンク化する。
 */
const ATTRIBUTIONS: readonly string[] = [
    "国土地理院発行 2.5万分1地形図",
    "The bathymetric contours are derived from those contained within the GEBCO Digital Atlas, published by the BODC on behalf of IOC and IHO (2003) (https://www.gebco.net) 海上保安庁許可第292502号（水路業務法第25条に基づく類似刊行物）",
    'Shoreline data is derived from: United States. National Imagery and Mapping Agency. "Vector Map Level 0 (VMAP0)." Bethesda, MD: Denver, CO: The Agency; USGS Information Services, 1997.',
];

/**
 * テキストを `escapeHtml` した上で、含まれる http(s) URL を `<a>` リンクへ変換する。
 * リンク化対象の URL は属性値としても安全になるよう、エスケープ後の文字列に対して処理する。
 */
const linkifyAttribution = (text: string): string => {
    const escaped = escapeHtml(text);
    // URL に続く末尾の閉じ括弧・句読点（`)` `.` `,`）はリンクへ含めない。
    return escaped.replace(
        /https?:\/\/[^\s<>"')]+/g,
        (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
    );
};

const renderAttributions = (attributions: readonly string[]): string =>
    [
        '<section class="attribution" aria-label="出典">',
        "<h2>出典</h2>",
        `<ul>${attributions
            .map((text) => `<li>${linkifyAttribution(text)}</li>`)
            .join("")}</ul>`,
        "</section>",
    ].join("");

/** ポータル本体 HTML を組み立てる純粋関数（テスト用に export）。 */
export const buildPortalHtml = (
    demos: readonly DemoEntry[] = DEMO_LIST,
    attributions: readonly string[] = ATTRIBUTIONS,
): string =>
    [
        '<h1>jpmap_terrain デモ</h1>',
        '<p class="lead">地理院タイルの標高データを使った 3D 地形可視化のデモ集です。今後デモを順次追加していきます。</p>',
        `<ul class="demos">${demos.map(renderCard).join("")}</ul>`,
        '<footer>',
        renderAttributions(attributions),
        '<p class="source">Source: <a href="https://github.com/8ga3/jpmap_terrain">github.com/8ga3/jpmap_terrain</a></p>',
        '</footer>',
    ].join("");

const start = (): void => {
    const mount = document.getElementById(PORTAL_MOUNT_ID);
    if (!mount) {
        // テンプレート側で `#root` は常に存在するが、jest 等では存在しないためガードする。
        return;
    }
    mount.innerHTML = buildPortalHtml();
};

if (
    typeof document !== "undefined" &&
    document.getElementById(PORTAL_MOUNT_ID) !== null
) {
    start();
}
