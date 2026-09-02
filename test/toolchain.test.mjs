/**
 * ツールチェーンの自己チェック。
 * Lint は Biome に一本化する方針と、依存を増やさない方針を機械的に確かめる。
 *
 * node --test test/toolchain.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const biome = JSON.parse(readFileSync("biome.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

test("Biome の書式はスペース2・ダブルクォート・行幅100", () => {
  assert.equal(biome.formatter.indentStyle, "space");
  assert.equal(biome.formatter.indentWidth, 2);
  assert.equal(biome.formatter.lineWidth, 100);
  assert.equal(biome.javascript.formatter.quoteStyle, "double");
});

test("ESLint と Prettier を入れていない", () => {
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const scripts = Object.values(pkg.scripts ?? {}).join(" ");
  for (const banned of ["eslint", "prettier"]) {
    assert.ok(
      !names.some((n) => n.includes(banned)),
      `${banned} が package.json の依存に入っている`,
    );
    assert.ok(!scripts.includes(banned), `${banned} が npm scripts に入っている`);
  }
});

// Worker は外部ライブラリ無しで動かす。ここが空でなくなったら軽さ優先の方針が崩れている
test("外部ライブラリを足していない（dependencies が空）", () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

// devDependencies も増えたら気付けるようにする。足すときはここを更新して意図を残す
test("devDependencies は Biome・TypeScript・wrangler の3つだけ", () => {
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), [
    "@biomejs/biome",
    "typescript",
    "wrangler",
  ]);
});

test("check / check:fix / typecheck が定義されている", () => {
  assert.equal(pkg.scripts.check, "biome check .");
  assert.equal(pkg.scripts["check:fix"], "biome check --write .");
  assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
});
