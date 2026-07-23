/**
 * 箱庭ジオラマの側面壁・底面（土台）の生成。
 *
 * 地形メッシュ（上面）単体だと平面な布のように浮いて見え、水平（基準面）が
 * 把握しにくい。実物のジオラマ模型（切り出した地層ブロック）のように、外周
 * （正方形の4辺を巡る閉曲線）から一定深さ下へ側面壁を張り、底面で閉じることで
 * 解決する。上面メッシュ（`dioramaGrid`/`dioramaTerrain`）とは別の `Mesh`・別材質
 * （土色）として構築する想定の、純粋なジオメトリ生成関数。外周点列の形状に依存
 * しないため、正方形に限らず任意の凸多角形の外周で動作するが、底面中心は原点
 * `(0, baseY, 0)` に固定して扇形分割するため、**外周が原点を内包する凸多角形**
 * （中心が原点にある正方形/正多角形等）であることが前提となる（下記
 * `buildDioramaSkirtGeometry` のコメントも参照）。
 */
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";

/** 側面壁・底面のジオメトリ（Babylon `VertexData` へそのまま渡せる形）。 */
export interface DioramaSkirtGeometry {
    positions: Float32Array;
    indices: Uint32Array;
    normals: Float32Array;
    /** 頂点カラー（RGBA、マテリアルの拡散色に乗算される）。側面壁の高さ方向グラデーション用。 */
    colors: Float32Array;
}

/** 側面壁の上端に使う頂点（ローカル平面座標 + 標高）。 */
export interface DioramaSkirtRingPoint {
    x: number;
    y: number;
    z: number;
}

/**
 * 側面壁の頂点カラー乗算値（マテリアルの拡散色 = 土色に対する乗算率）。
 * 上端（地表に近い側）を明るく強調し、下端はこれより大きく暗くすることで、実物の
 * ジオラマ模型の「切り出した地層」のように、壁の上ほど明るく・下ほど暗いメリハリの
 * あるグラデーションを頂点カラーとして明示的に付与する。
 *
 * @remarks
 * 側面壁は正方形の外周に沿ってほぼ鉛直に立つため、シーンの照明（方向光がほぼ真上
 * からで側面には強く当たらない・`HemisphericLight`も垂直面には中間程度の寄与しか
 * しない）のもとでは、乗算率1（土色そのまま）でも実際の描画結果はかなり暗く沈む
 * （実機/デスクトップで確認）。頂点カラーはライティング計算前の拡散色
 * （`baseColor.rgb *= vColor.rgb`、Babylon既定シェーダー）に乗算されるため、
 * 1を超える値を与えるとライティング後の明るさも比例して底上げされる。
 * 上端を1より十分大きくすることで、暗い側面壁の中でも上端が明確に浮き上がって
 * 見えるようにしている。
 */
const WALL_TOP_COLOR_MULTIPLIER = 2.6;
const WALL_BOTTOM_COLOR_MULTIPLIER = 0.35;
/** 底面（外周・中心）の頂点カラー乗算値。グラデーションの対象外のため常に1（土色そのまま）。 */
const BOTTOM_FACE_COLOR_MULTIPLIER = 1;

/** 頂点カラー配列の該当インデックスへ乗算値（RGBA、アルファは常に1）を書き込む。 */
const setVertexColor = (colors: Float32Array, index: number, multiplier: number): void => {
    colors[index * 4] = multiplier;
    colors[index * 4 + 1] = multiplier;
    colors[index * 4 + 2] = multiplier;
    colors[index * 4 + 3] = 1;
};

/**
 * 外周の頂点列（`dioramaGrid.extractGridPerimeterIndices` が返す順、時計回り）と
 * 底面の高さ (`baseY`) から、側面壁 + 底面（中心からの扇形）のジオメトリを構築する。
 *
 * 頂点レイアウト: `[0..n-1]` = 側面壁の上端（外周と同位置）、
 * `[n..2n-1]` = 側面壁の下端（同 x,z・y=baseY、側面壁の三角形専用）、
 * `[2n..3n-1]` = 底面の外周（側面壁下端と同じ x,z・y=baseY だが底面の三角形専用の
 * 別頂点。下記コメント参照）、`[3n]` = 底面中心。
 *
 * 側面壁下端と底面外周を同一頂点として共有すると、法線計算（`ComputeNormals` に
 * よる頂点法線の平均化＝スムーズシェーディング）の際に、側面壁（起伏に応じて向きが
 * 変わる法線）と底面（常に同じ向きの法線）が同じ頂点でブレンドされてしまい、
 * 壁と底面の境界が滲んで見える・底面に扇形三角形の分割線に沿った対角線状の
 * 濃淡筋が浮き出る問題があった（実機/デスクトップ双方で確認）。頂点を分離することで、
 * 底面は完全な平面のため各三角形の面法線が厳密に揃い、平均しても変化しない＝
 * 結果的に均一なフラットシェーディングになる（`convertToFlatShadedMesh` のような
 * 強制的な面法線再計算は不要）。壁の角（隣り合う辺の間で法線が滑らかに繋がる部分）は
 * 従来通り残る（意図した見た目のため、あえてそのまま）。
 *
 * 側面壁の「上ほど明るく下ほど暗い」グラデーションは、法線・ライティングに依存しない
 * 頂点カラー（{@link WALL_TOP_COLOR_MULTIPLIER}/{@link WALL_BOTTOM_COLOR_MULTIPLIER}）
 * として明示的に付与する。
 *
 * @remarks
 * 底面中心は `outerRing` から算出せず、常に原点 `(0, baseY, 0)` に固定して外周からの
 * 扇形分割を行う。そのため `outerRing` は**原点を内包する凸多角形**（中心が原点に
 * ある正方形/正多角形等）であることが前提となる。原点を内包しない外周を渡すと、
 * 底面の扇形三角形が自己交差し破綻する。
 */
export const buildDioramaSkirtGeometry = (
    outerRing: readonly DioramaSkirtRingPoint[],
    baseY: number,
): DioramaSkirtGeometry => {
    const n = outerRing.length;
    if (n < 3) {
        throw new RangeError(`outerRing must have >= 3 points (got ${n})`);
    }

    const vertexCount = n * 3 + 1;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 4);
    for (let i = 0; i < n; i++) {
        const p = outerRing[i];
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
        setVertexColor(colors, i, WALL_TOP_COLOR_MULTIPLIER);
        // 側面壁の下端（壁の三角形専用）。
        positions[(n + i) * 3] = p.x;
        positions[(n + i) * 3 + 1] = baseY;
        positions[(n + i) * 3 + 2] = p.z;
        setVertexColor(colors, n + i, WALL_BOTTOM_COLOR_MULTIPLIER);
        // 底面の外周（座標は側面壁下端と同一だが、底面の三角形専用の別頂点）。
        positions[(2 * n + i) * 3] = p.x;
        positions[(2 * n + i) * 3 + 1] = baseY;
        positions[(2 * n + i) * 3 + 2] = p.z;
        setVertexColor(colors, 2 * n + i, BOTTOM_FACE_COLOR_MULTIPLIER);
    }
    const bottomCenterIndex = n * 3;
    positions[bottomCenterIndex * 3] = 0;
    positions[bottomCenterIndex * 3 + 1] = baseY;
    positions[bottomCenterIndex * 3 + 2] = 0;
    setVertexColor(colors, bottomCenterIndex, BOTTOM_FACE_COLOR_MULTIPLIER);

    const indices: number[] = [];
    // 側面壁（1segmentにつき四角形1枚=三角形2枚）。
    for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const top0 = i;
        const top1 = next;
        const bot0 = n + i;
        const bot1 = n + next;
        indices.push(top0, bot0, bot1);
        indices.push(top0, bot1, top1);
    }
    // 底面（外周から中心への扇形。側面壁とは別頂点[2n..3n-1]を使う）。
    // 頂点順は法線が真上（0,1,0）を向くようにする。物理的には底面の法線は
    // 真下（外向き）が正しいが、シーンの `HemisphericLight` は既定で
    // `groundColor`（下向き面が受け取る色）が黒のため、真下向きの法線にすると
    // 底面が方向光・環境光ともに一切当たらず真っ黒になってしまう（見た目として
    // 不自然）。既存の見た目（上面・側面壁と同程度に明るい土色）を保つため、
    // あえて上面と同じ向きの法線にする。頂点分離済みのため、これでも壁側の法線と
    // 混ざることはなく、底面全体は一様なフラットシェーディングのまま保たれる。
    for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const rim0 = 2 * n + i;
        const rim1 = 2 * n + next;
        indices.push(bottomCenterIndex, rim1, rim0);
    }

    const uintIndices = new Uint32Array(indices);
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, uintIndices, normals);

    return { positions, indices: uintIndices, normals, colors };
};
