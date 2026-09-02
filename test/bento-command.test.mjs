/**
 * `/bento` → Modal → イベント作成 → 集計メッセージ投稿 の一直線。
 *
 *   node --test test/bento-command.test.mjs
 *
 * wrangler は起動しない。署名は node:crypto で本物を作り、D1 は node:sqlite、
 * Discord API は fetch スタブ。src/index.ts の fetch をそのまま呼ぶ。
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createTestDb } from "./helpers/d1.mjs";
import { fakeCtx, installFetchStub } from "./helpers/fetch-stub.mjs";
import { loadSrc } from "./helpers/load-src.mjs";

const worker = (await loadSrc("index.mjs")).default;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// spki の先頭12バイトはヘッダ。Discord の Public Key と同じ生の32バイトにする
const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");

const env = (db) => ({
  DISCORD_PUBLIC_KEY: publicKeyHex,
  DISCORD_BOT_TOKEN: "test-bot-token",
  DB: db,
});

/** Discord と同じ形で署名した POST を組み立てる */
function request(interaction) {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://bento.example.workers.dev/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
      "x-signature-timestamp": timestamp,
    },
    body,
  });
}

const command = { type: 2, guild_id: "g1", channel_id: "c1", data: { name: "bento" } };

/** Modal 送信。Discord は入力を action row の入れ子で返してくる */
const submit = (title = "9/15(月) お弁当", menuUrl = "https://tenpo.example.com/bento") => ({
  type: 5,
  guild_id: "g1",
  channel_id: "c1",
  data: {
    custom_id: "create_event",
    components: [
      { components: [{ type: 4, custom_id: "title", value: title }] },
      { components: [{ type: 4, custom_id: "menu_url", value: menuUrl }] },
    ],
  },
});

const allEvents = (db) => db.prepare("select * from bento_events").all();

test("AC-1: /bento に Modal(type:9) を返す", async () => {
  const db = createTestDb();
  try {
    const res = await worker.fetch(request(command), env(db), fakeCtx());
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.type, 9);
    assert.equal(body.data.custom_id, "create_event");

    // タイトルとメニューURLの2欄。テキスト欄は1つずつ action row に入る
    const fields = body.data.components.flatMap((row) => row.components);
    assert.deepEqual(
      fields.map((field) => field.custom_id),
      ["title", "menu_url"],
    );
    assert.equal(fields[0].required, true);
  } finally {
    db.close();
  }
});

test("AC-2: Modal 送信で bento_events が1件できて status が open になる", async () => {
  const db = createTestDb();
  const stub = installFetchStub([{ body: { id: "111222333" } }]);
  const ctx = fakeCtx();
  try {
    await worker.fetch(request(submit()), env(db), ctx);
    await ctx.settle();

    const { results } = await allEvents(db);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "open");
    assert.equal(results[0].title, "9/15(月) お弁当");
    assert.equal(results[0].menu_url, "https://tenpo.example.com/bento");
    assert.equal(results[0].guild_id, "g1");
    assert.equal(results[0].channel_id, "c1");
  } finally {
    stub.restore();
    db.close();
  }
});

test("AC-3: 投稿した集計メッセージの message_id が保存される", async () => {
  const db = createTestDb();
  const stub = installFetchStub([{ body: { id: "111222333" } }]);
  const ctx = fakeCtx();
  try {
    await worker.fetch(request(submit()), env(db), ctx);
    await ctx.settle();

    const post = stub.calls.find((call) => call.method === "POST");
    assert.ok(post, "チャンネルへの投稿が行われていない");
    assert.match(post.url, /\/channels\/c1\/messages$/);

    // 空の集計メッセージ。まだ誰も頼んでいないので [頼む ▼] は出さない
    const posted = JSON.parse(post.body);
    assert.match(posted.embeds[0].title, /9\/15\(月\) お弁当/);
    assert.match(posted.embeds[0].description, /まだ注文はありません/);
    const customIds = posted.components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(customIds.includes("new_item"));
    assert.ok(!customIds.includes("order_select"));

    const { results } = await allEvents(db);
    assert.equal(results[0].message_id, "111222333");
  } finally {
    stub.restore();
    db.close();
  }
});

test("AC-4: タイトルが空なら ephemeral エラーを返し、イベントを作らない", async () => {
  const db = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    // Modal 側の required は空白だけの入力を素通りさせる
    const res = await worker.fetch(request(submit("   ")), env(db), ctx);
    const body = await res.json();
    await ctx.settle();

    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64, "本人にしか見えない応答になっていない");
    assert.equal(stub.calls.length, 0, "Discord API を叩いてしまっている");

    const { results } = await allEvents(db);
    assert.equal(results.length, 0);
  } finally {
    stub.restore();
    db.close();
  }
});

test("AC-5: Discord API の完了を待たずに応答を返す（3秒制約）", async () => {
  const db = createTestDb();
  const ctx = fakeCtx();
  const original = globalThis.fetch;

  // 投稿を握ったまま返さない。ハンドラが待っていればここでテストが固まる
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    await held;
    return new Response(JSON.stringify({ id: "777" }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const res = await worker.fetch(request(submit()), env(db), ctx);
    const body = await res.json();

    assert.equal(res.status, 200);
    // 即時応答(4) でも deferred(5) でもよい。待たずに返っていることが条件
    assert.ok(body.type === 4 || body.type === 5, `応答の type が ${body.type}`);

    const before = await allEvents(db);
    assert.equal(before.results[0]?.message_id ?? null, null, "応答前に投稿を待っている");

    release();
    await ctx.settle();

    const after = await allEvents(db);
    assert.equal(after.results[0].message_id, "777");
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});

test("署名が不正なら 401（イベントは作られない）", async () => {
  const db = createTestDb();
  const ctx = fakeCtx();
  try {
    const body = JSON.stringify(submit());
    const res = await worker.fetch(
      new Request("https://bento.example.workers.dev/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": "00".repeat(64),
          "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body,
      }),
      env(db),
      ctx,
    );

    assert.equal(res.status, 401);
    const { results } = await allEvents(db);
    assert.equal(results.length, 0);
  } finally {
    db.close();
  }
});
