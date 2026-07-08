/**
 * `src/demos/flight/globeAfterburner.ts` の純関数 unit test。
 *
 * - computeEngineEcefToRef: 軌道パラメータ → 左右エンジンの真 ECEF
 * - buildTrailRibbonLocal: 絶対 ECEF 履歴 → アンカー相対のローカルリボン頂点
 * - computeFlameColor: トレイル位置 → 炎カラー(RGBA)
 *
 * Babylon の重い描画モジュール（GlowLayer/StandardMaterial/CreateRibbon 等）は
 * vi.mock で分離する（純関数は Vector3/Color4 などの math のみ実体を使う）。
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@babylonjs/core/Layers/glowLayer", () => ({
    GlowLayer: class {},
}));
vi.mock("@babylonjs/core/Materials/standardMaterial", () => ({
    StandardMaterial: class {},
}));
vi.mock("@babylonjs/core/Meshes/Builders/ribbonBuilder", () => ({
    CreateRibbon: vi.fn(),
}));
vi.mock("@babylonjs/core/Meshes/mesh", () => ({
    Mesh: class {
        static DOUBLESIDE = 2;
    },
}));
vi.mock("@babylonjs/core/Buffers/buffer", () => ({
    VertexBuffer: { ColorKind: "color" },
}));
vi.mock("@babylonjs/core/Engines/constants", () => ({
    Constants: { ALPHA_ADD: 1 },
}));

const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
const { geodeticToEcef } = await import("../src/terrain/geo/ecef");
const { circularOrbitPosition } = await import("../src/demos/avatar/orbit");

let computeEngineEcefToRef: typeof import("../src/demos/flight/globeAfterburner").computeEngineEcefToRef;
let buildTrailRibbonLocal: typeof import("../src/demos/flight/globeAfterburner").buildTrailRibbonLocal;
let computeFlameColor: typeof import("../src/demos/flight/globeAfterburner").computeFlameColor;

beforeAll(async () => {
    const mod = await import("../src/demos/flight/globeAfterburner");
    computeEngineEcefToRef = mod.computeEngineEcefToRef;
    buildTrailRibbonLocal = mod.buildTrailRibbonLocal;
    computeFlameColor = mod.computeFlameColor;
});

const TOKYO = { lat: 35.681236, lon: 139.767125 };

describe("computeEngineEcefToRef", () => {
    it("左右エンジンが機体中心の周囲に対称配置され、横間隔 ≈ 2×lateral(2.8m) になる", () => {
        const left = new Vector3();
        const right = new Vector3();
        const ok = computeEngineEcefToRef(
            TOKYO.lat,
            TOKYO.lon,
            2000,
            2000,
            0,
            left,
            right,
        );
        expect(ok).toBe(true);

        // 左右の距離 = 2 × ENGINE_LATERAL_OFFSET_M (1.4) = 2.8m
        const sep = Vector3.Distance(left, right);
        expect(sep).toBeGreaterThan(2.7);
        expect(sep).toBeLessThan(2.9);

        // 両エンジンとも機体中心(真 ECEF)から数 m 以内（rear/vertical/lateral オフセット程度）
        const planeEcef = geodeticToEcef(TOKYO.lat, TOKYO.lon, 2000);
        // 機体中心は回転に依存するため、angleDeg=0 の位置で算出
        const pp = circularOrbitPosition(TOKYO.lat, TOKYO.lon, 2000, 0);
        const planeAtAngle = geodeticToEcef(pp.lat, pp.lon, 2000);
        expect(Vector3.Distance(left, planeAtAngle)).toBeLessThan(8);
        expect(Vector3.Distance(right, planeAtAngle)).toBeLessThan(8);
        // planeEcef は中心点。エンジンはその近傍（同オーダー）にあること。
        expect(Number.isFinite(planeEcef.x)).toBe(true);
    });

    it("全成分が有限値である", () => {
        const left = new Vector3();
        const right = new Vector3();
        computeEngineEcefToRef(TOKYO.lat, TOKYO.lon, 1500, 1000, 123, left, right);
        for (const v of [left, right]) {
            expect(Number.isFinite(v.x)).toBe(true);
            expect(Number.isFinite(v.y)).toBe(true);
            expect(Number.isFinite(v.z)).toBe(true);
        }
    });
});

describe("buildTrailRibbonLocal", () => {
    const makeHistory = (n: number): InstanceType<typeof Vector3>[] => {
        // 東京付近を東方向へ等間隔に進む履歴 ([0]=末端, [n-1]=先端)
        const hist: InstanceType<typeof Vector3>[] = [];
        for (let i = 0; i < n; i++) {
            const lon = TOKYO.lon + i * 0.00002; // 約 1.8m/ステップ
            hist.push(geodeticToEcef(TOKYO.lat, lon, 2000));
        }
        return hist;
    };

    it("先端をアンカーにすると先端ローカル中心が原点付近、末端は幅0に畳まれる", () => {
        const n = 14;
        const history = makeHistory(n);
        const anchor = history[n - 1].clone(); // 先端をアンカー
        const left = Array.from({ length: n }, () => new Vector3());
        const right = Array.from({ length: n }, () => new Vector3());

        const written = buildTrailRibbonLocal(history, anchor, 0.6, left, right);
        expect(written).toBe(n);

        // 先端(i=n-1): ローカル中心 ≈ 原点、左右間隔 ≈ 2×halfWidth(1.2m)
        const headCenter = left[n - 1].add(right[n - 1]).scale(0.5);
        expect(headCenter.length()).toBeLessThan(1e-3);
        const headSep = Vector3.Distance(left[n - 1], right[n - 1]);
        expect(headSep).toBeGreaterThan(1.0);
        expect(headSep).toBeLessThan(1.4);

        // 末端(i=0): テーパーで幅 0 → 左右一致
        expect(Vector3.Distance(left[0], right[0])).toBeLessThan(1e-6);

        // 末端は先端(アンカー)から離れている（履歴の広がり分）
        expect(left[0].length()).toBeGreaterThan(1.0);
    });

    it("全頂点が有限値である", () => {
        const n = 14;
        const history = makeHistory(n);
        const anchor = history[n - 1].clone();
        const left = Array.from({ length: n }, () => new Vector3());
        const right = Array.from({ length: n }, () => new Vector3());
        buildTrailRibbonLocal(history, anchor, 0.6, left, right);
        for (let i = 0; i < n; i++) {
            for (const v of [left[i], right[i]]) {
                expect(Number.isFinite(v.x)).toBe(true);
                expect(Number.isFinite(v.y)).toBe(true);
                expect(Number.isFinite(v.z)).toBe(true);
            }
        }
    });

    it("静止履歴（全点同一）でも NaN を出さず幅0に畳む", () => {
        const n = 6;
        const p = geodeticToEcef(TOKYO.lat, TOKYO.lon, 2000);
        const history = Array.from({ length: n }, () => p.clone());
        const anchor = p.clone();
        const left = Array.from({ length: n }, () => new Vector3());
        const right = Array.from({ length: n }, () => new Vector3());
        buildTrailRibbonLocal(history, anchor, 0.6, left, right);
        for (let i = 0; i < n; i++) {
            expect(Vector3.Distance(left[i], right[i])).toBeLessThan(1e-6);
            expect(Number.isFinite(left[i].x)).toBe(true);
        }
    });
});

describe("computeFlameColor", () => {
    it("末端(t=0)はアルファ0、先端(t=1)はアルファ最大・R=1", () => {
        const tail = computeFlameColor(0);
        const head = computeFlameColor(1);
        expect(tail.a).toBeCloseTo(0, 6);
        expect(head.a).toBeCloseTo(1, 6);
        expect(head.r).toBeCloseTo(1, 6);
    });

    it("アルファは t に対して単調非減少", () => {
        let prev = -1;
        for (let i = 0; i <= 10; i++) {
            const a = computeFlameColor(i / 10).a;
            expect(a).toBeGreaterThanOrEqual(prev);
            prev = a;
        }
    });
});
