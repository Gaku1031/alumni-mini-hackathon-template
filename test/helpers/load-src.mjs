/**
 * src/*.ts を型だけ落として読み込む。
 *
 * 単体のファイルなら data: URL に流し込めば済む（test/db.test.mjs がそうしている）が、
 * src/index.ts のように `./discord` を import しているものは相対パスの解決先が無くなる。
 * なので src/ をまるごと一時ディレクトリに .mjs として並べ直してから読む。
 * ビルド手順を足さずに、ソースそのものを動かすための最小限の仕掛け。
 *
 *   const worker = (await loadSrc("index.mjs")).default;
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../../src/", import.meta.url);

export async function loadSrc(entry) {
  const dir = mkdtempSync(join(tmpdir(), "bento-src-"));
  try {
    for (const file of readdirSync(fileURLToPath(SRC))) {
      // .d.ts は型だけなので落とすと空になる。読む必要も無い
      if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
      const source = stripTypeScriptTypes(readFileSync(new URL(file, SRC), "utf8"));
      // `from "./discord"` のままでは拡張子が無くて解決できない
      const code = source.replaceAll(/(from ")\.\/([\w-]+)"/g, '$1./$2.mjs"');
      writeFileSync(join(dir, file.replace(/\.ts$/, ".mjs")), code);
    }
    return await import(pathToFileURL(join(dir, entry)).href);
  } finally {
    // import が終われば読み込みは済んでいる。実体は残さない
    rmSync(dir, { recursive: true, force: true });
  }
}
