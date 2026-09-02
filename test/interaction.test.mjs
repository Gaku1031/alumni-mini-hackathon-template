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
import { writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const URL_ = "http://127.0.0.1:8787";

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

before(async () => {
  writeFileSync(".dev.vars", `DISCORD_PUBLIC_KEY=${publicKeyHex}\nDISCORD_BOT_TOKEN=dummy\n`);
  dev = spawn("npx", ["wrangler", "dev", "--port", "8787"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(URL_);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("wrangler dev が起動しなかった");
});

after(() => dev?.kill());

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
