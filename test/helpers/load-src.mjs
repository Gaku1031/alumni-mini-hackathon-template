/**
 * src/*.ts を型だけ落として読み込む。
 *
 *   const { handleInteraction } = await loadSrc("index");
 *   const worker = (await loadSrc("index.mjs")).default;
 *
 * 1ファイルで完結する db.ts や discord.ts は data: URL に流し込めば読めるが、
 * index.ts は ./db や ./discord を import するので相対パスが解ける場所が要る。
 * 一時ディレクトリに .mjs として書き出し、import 先だけ書き換えて読む。
 * ビルド手順は増やさない（テストの中だけの話にする）。
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = new URL("../../src/", import.meta.url);

/** 書き出しは1回だけ。同じファイルを import すれば同じモジュールになる */
let dir;

function build() {
  const out = mkdtempSync(join(tmpdir(), "bento-src-"));
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const source = stripTypeScriptTypes(readFileSync(new URL(file, SRC), "utf8"));
    // `from "./db"` は Node では解決できない。拡張子を足す
    const code = source.replace(/(from\s+")(\.\/[\w-]+)(")/g, "$1$2.mjs$3");
    writeFileSync(join(out, file.replace(/\.ts$/, ".mjs")), code);
  }
  return out;
}

export function loadSrc(entry) {
  dir ??= build();
  // "index" でも "index.mjs" でも受け付ける
  const file = entry.endsWith(".mjs") ? entry : `${entry}.mjs`;
  return import(pathToFileURL(join(dir, file)).href);
}
