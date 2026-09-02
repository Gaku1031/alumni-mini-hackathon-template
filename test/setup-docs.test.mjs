/**
 * セットアップ手順と secret の置き場所の自己チェック。
 *
 *   node --test test/setup-docs.test.mjs
 *
 * README どおりに進めた人が詰まる箇所（手順の順序、ローカル/リモートの D1、
 * secret を wrangler.jsonc に書いてしまう事故）をここで止める。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const trim = (line) => line.trim();

const SECRETS = ["DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN"];

/** `KEY=value` の行だけを拾う。`#` から始まる行はコメント */
function parseEnvExample(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
    if (m) entries.push([m[1], m[2].trim()]);
  }
  return entries;
}

/** JSONC から行コメントを落とす。文字列の中の `//`（URL）は残す */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

const wrangler = JSON.parse(stripJsonComments(read("wrangler.jsonc")));
const readme = read("README.md");

test(".dev.vars.example は Worker の secret 2つだけを並べ、実値を持たない", () => {
  const entries = parseEnvExample(read(".dev.vars.example"));
  assert.deepEqual(
    entries.map(([name]) => name),
    SECRETS,
    ".dev.vars.example に並べるのは Worker が使う secret だけ",
  );
  for (const [name, value] of entries) {
    assert.equal(value, "", `${name} に実値が書かれている。雛形に値を入れない`);
  }
});

test("wrangler.jsonc の vars に secret を書いていない", () => {
  const vars = wrangler.vars ?? {};
  for (const name of SECRETS) {
    assert.equal(name in vars, false, `${name} が vars にある。vars は平文で公開される`);
  }
  // 平文で埋め込む書き方が別の場所に紛れ込んでいないか
  const raw = read("wrangler.jsonc");
  for (const name of SECRETS) {
    const embedded = new RegExp(`"${name}"\\s*:`);
    assert.doesNotMatch(raw, embedded, `${name} は secret。設定ファイルに書かない`);
  }
});

// 手元に .dev.vars があること自体は正しい（README どおりならある。テストも一時的に書く）。
// 問題なのはそれがリポジトリに入ってしまうことなので、git の追跡対象かどうかで見る
test(".dev.vars は gitignore されていて、リポジトリに入っていない", () => {
  const ignored = read(".gitignore").split("\n").map(trim);
  assert.ok(ignored.includes(".dev.vars"), ".gitignore に .dev.vars が無い");

  const tracked = execFileSync("git", ["ls-files", "--", ".dev.vars"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  assert.equal(tracked, "", ".dev.vars が git の追跡対象になっている");
});

test("README にローカルと本番、両方のマイグレーション手順がある", () => {
  assert.match(readme, /npm run db:apply\b/, "ローカルへの適用が書かれていない");
  assert.match(readme, /npm run db:apply:remote\b/, "本番への適用が書かれていない");
  assert.match(readme, /別の\s*DB|別物/, "ローカルとリモートが別 DB だと書かれていない");
});

test("README の手順が deploy → Endpoint URL 登録 → マイグレーションの順に並ぶ", () => {
  const deploy = readme.indexOf("npm run deploy");
  const endpoint = readme.indexOf("INTERACTIONS ENDPOINT URL");
  const migrate = readme.indexOf("npm run db:apply:remote");

  assert.ok(deploy >= 0, "npm run deploy が無い");
  assert.ok(endpoint >= 0, "INTERACTIONS ENDPOINT URL の登録手順が無い");
  assert.ok(migrate >= 0, "npm run db:apply:remote が無い");
  assert.ok(deploy < endpoint, "URL を確定させる deploy が Endpoint 登録より後にある");
  assert.ok(endpoint < migrate, "マイグレーションが Endpoint 登録より前にある");
});

test("wrangler.jsonc に binding 名 DB の D1 がある", () => {
  const d1 = wrangler.d1_databases ?? [];
  assert.ok(Array.isArray(d1) && d1.length > 0, "d1_databases が無い");
  const db = d1.find((entry) => entry.binding === "DB");
  assert.ok(db, "binding 名 DB の D1 が無い。コードは env.DB を触る");
  assert.equal(db.migrations_dir, "migrations", "migrations_dir が migrations でない");
});
