/**
 * src/*.ts を型だけ落として読み込む。相対 import も先に畳んで差し込むので、
 * index.ts のように他のモジュールを使うファイルもそのまま動かせる。
 *
 *   const worker = (await load("index")).default;
 *
 * Node が .ts を直接 import できるようになるのは v22.18 から。
 * ビルド手順を足したくないので data: URL で読ませている。
 */

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const SRC = new URL("../../src/", import.meta.url);

/** 同じモジュールは同じ URL にする（2回 import しても実体は1つ） */
const urls = new Map();

function urlOf(name) {
  const cached = urls.get(name);
  if (cached) return cached;

  const source = readFileSync(new URL(`${name}.ts`, SRC), "utf8");
  const code = stripTypeScriptTypes(source).replace(
    /from "\.\/([\w-]+)"/g,
    (_, dep) => `from "${urlOf(dep)}"`,
  );
  const url = `data:text/javascript,${encodeURIComponent(code)}`;
  urls.set(name, url);
  return url;
}

export const load = (name) => import(urlOf(name));
