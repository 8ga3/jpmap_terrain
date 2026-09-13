import { describe, expect, it } from "vitest";
import {
    extractBareSpecifiers,
    findExtensionlessSubpaths,
} from "../scripts/checkDistImports.mjs";

describe("checkDistImports", () => {
    describe("extractBareSpecifiers", () => {
        it("静的 import の specifier を取り出す", () => {
            const source =
                'import{Vector3}from"@babylonjs/core/Maths/math.vector.js";';
            expect(extractBareSpecifiers(source)).toEqual([
                "@babylonjs/core/Maths/math.vector.js",
            ]);
        });

        it("side-effect import の specifier を取り出す", () => {
            const source = 'import"@babylonjs/loaders/glTF/index.js";';
            expect(extractBareSpecifiers(source)).toEqual([
                "@babylonjs/loaders/glTF/index.js",
            ]);
        });

        it("動的 import の specifier を取り出す", () => {
            const source = 'await import("@babylonjs/loaders/OBJ/index.js");';
            expect(extractBareSpecifiers(source)).toEqual([
                "@babylonjs/loaders/OBJ/index.js",
            ]);
        });

        it("相対 import は対象外", () => {
            const source =
                'import{a}from"./chunk.mjs";import{b}from"../lib.mjs";';
            expect(extractBareSpecifiers(source)).toEqual([]);
        });

        it("URL スキームを持つ specifier は対象外", () => {
            const source = 'import"node:fs";import"https://example.com/m.js";';
            expect(extractBareSpecifiers(source)).toEqual([]);
        });

        it("同一 specifier は重複を除いて返す", () => {
            const source =
                'import{a}from"@babylonjs/core/scene.js";import{b}from"@babylonjs/core/scene.js";';
            expect(extractBareSpecifiers(source)).toEqual([
                "@babylonjs/core/scene.js",
            ]);
        });
    });

    describe("findExtensionlessSubpaths", () => {
        it("拡張子のないサブパスを検出する", () => {
            expect(
                findExtensionlessSubpaths([
                    "@babylonjs/core/Maths/math.vector",
                ]),
            ).toEqual(["@babylonjs/core/Maths/math.vector"]);
        });

        it("拡張子のあるサブパスは検出しない", () => {
            expect(
                findExtensionlessSubpaths([
                    "@babylonjs/core/Maths/math.vector.js",
                    "@babylonjs/loaders/glTF/index.js",
                ]),
            ).toEqual([]);
        });

        it("サブパスを持たないルート import は検出しない", () => {
            expect(
                findExtensionlessSubpaths(["@babylonjs/havok", "vitest"]),
            ).toEqual([]);
        });

        it("scope なしパッケージのサブパスも判定する", () => {
            expect(
                findExtensionlessSubpaths(["pkg/sub", "pkg/sub.js", "pkg"]),
            ).toEqual(["pkg/sub"]);
        });

        it("ドットを含むが拡張子ではないサブパスを検出する", () => {
            expect(
                findExtensionlessSubpaths([
                    "@babylonjs/core/Meshes/mesh.vertexData",
                ]),
            ).toEqual(["@babylonjs/core/Meshes/mesh.vertexData"]);
        });
    });
});
