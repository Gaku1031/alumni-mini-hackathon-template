/**
 * 署名検証まわりの自己チェック。
 * Ed25519 の鍵を作って .dev.vars に流し込み、wrangler dev に実際に投げる。
 *
 *   node --test test/interaction.test.mjs
 *
 * 事前に `npm run dev` を別ターミナルで起動しておく（.dev.vars はこれが書く）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

/** 空きポートを OS に選ばせる。決め打つと他のツールとぶつかる */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let URL_;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");

/** Discord と同じ形で署名する: sign(timestamp + body) */
function signed(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  return {
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
}

let dev;
/** テスト用の鍵で .dev.vars を上書きするので、本物は退避して必ず戻す */
let savedDevVars = null;

before(async () => {
  if (existsSync(".dev.vars")) savedDevVars = readFileSync(".dev.vars");
  writeFileSync(".dev.vars", `DISCORD_PUBLIC_KEY=${publicKeyHex}\nDISCORD_BOT_TOKEN=dummy\n`);

  const port = await freePort();
  URL_ = `http://127.0.0.1:${port}`;
  dev = spawn("npx", ["wrangler", "dev", "--port", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    // ここで待つのは「起動したか」だけ。応答の中身は各テストで見る
    try {
      await fetch(URL_);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("wrangler dev が起動しなかった");
});

after(() => {
  dev?.kill();
  if (savedDevVars !== null) writeFileSync(".dev.vars", savedDevVars);
});

test("正しい署名の PING に PONG を返す", async () => {
  const body = JSON.stringify({ type: 1 });
  const res = await fetch(URL_, { method: "POST", headers: signed(body), body });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("署名が壊れていたら 401", async () => {
  const body = JSON.stringify({ type: 1 });
  const headers = signed(body);
  headers["x-signature-ed25519"] = "00".repeat(64);
  const res = await fetch(URL_, { method: "POST", headers, body });
  assert.equal(res.status, 401);
});

test("署名ヘッダが無ければ 401", async () => {
  const body = JSON.stringify({ type: 1 });
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(res.status, 401);
});

test("ボディを差し替えたら 401（署名対象は生ボディ）", async () => {
  const headers = signed(JSON.stringify({ type: 1 }));
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ type: 2 }) });
  assert.equal(res.status, 401);
});

// JSON として同じでもバイト列は違う。先に req.json() して詰め直した文字列で
// 検証していると、この署名は合わなくなって 401 に落ちる
test("空白入りのボディでも通る（検証は生ボディ文字列に対して行う）", async () => {
  const body = '{ "type" : 1 }';
  const res = await fetch(URL_, { method: "POST", headers: signed(body), body });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("POST 以外は 405", async () => {
  const res = await fetch(URL_, { method: "GET" });
  assert.equal(res.status, 405);
});

test("外部ライブラリを足していない（dependencies が空）", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {});
});
