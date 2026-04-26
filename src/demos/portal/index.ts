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
        href: "viewer.html",
    },
    {
        title: "タイムラプス（太陽の動きと陰影）",
        description:
            "24 時間を 1 分に圧縮して太陽位置・陰影をアニメーションし、アナログ時計で同期表示するショーケース。",
        href: "timelapse.html",
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

/** ポータル本体 HTML を組み立てる純粋関数（テスト用に export）。 */
export const buildPortalHtml = (
    demos: readonly DemoEntry[] = DEMO_LIST,
): string =>
    [
        '<h1>jpmap_terrain デモ</h1>',
        '<p class="lead">地理院タイルの標高データを使った 3D 地形可視化のデモ集です。今後デモを順次追加していきます。</p>',
        `<ul class="demos">${demos.map(renderCard).join("")}</ul>`,
        '<footer>Source: <a href="https://github.com/8ga3/jpmap_terrain">github.com/8ga3/jpmap_terrain</a></footer>',
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
