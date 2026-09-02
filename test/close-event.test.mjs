/**
 * `[締め切る]` の自己チェック。Modal を開くところから、
 * 金額の確定・集金メッセージへの貼り替え・@here の通知までを通しで動かす。
 *
 *   node --test test/close-event.test.mjs
 *
 * D1 はインメモリ、Discord API は fetch スタブ。wrangler は起動しない。
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createTestDb } from "./helpers/d1.mjs";
import { fakeCtx, installFetchStub } from "./helpers/fetch-stub.mjs";
import { load } from "./helpers/load-ts.mjs";

const worker = (await load("index")).default;
const db = await load("db");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");

/** 集計メッセージの id。ボタンから来る interaction はこれを持っている */
const MESSAGE_ID = "555";

/** Discord と同じ形（署名対象は timestamp + 生ボディ）で worker に投げる */
async function post(interaction, env, ctx) {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const req = new Request("https://bento.example.com/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body,
  });
  return worker.fetch(req, env, ctx);
}

/** 図1 と同じ形の、注文が2件入った open なイベント */
async function setup() {
  const conn = createTestDb();
  const eventId = await db.createEvent(conn, {
    guildId: "g1",
    channelId: "c1",
    title: "9/15(月) お弁当",
  });
  await db.setMessageId(conn, eventId, MESSAGE_ID);
  for (const [name, item, price] of [
    ["gaku", "唐揚げ弁当", 650],
    ["taro", "のり弁", 480],
  ]) {
    await db.addOrder(conn, {
      eventId,
      discordUserId: `u-${name}`,
      displayName: name,
      itemName: item,
      price,
    });
  }
  const env = { DB: conn, DISCORD_PUBLIC_KEY: PUBLIC_KEY, DISCORD_BOT_TOKEN: "token" };
  return { conn, eventId, env };
}

/** `[締め切る]` を押したときの MESSAGE_COMPONENT */
const clickClose = { type: 3, data: { custom_id: "close" }, message: { id: MESSAGE_ID } };

/**
 * Modal を開いてから、その custom_id 宛に入力を送り返す（本物と同じ往復）。
 * waitUntil に載った続きが終わるまで待って、Discord へ飛んだ呼び出しを返す。
 */
async function close(env, input) {
  const opened = await (await post(clickClose, env, fakeCtx())).json();
  const submit = {
    type: 5,
    data: {
      custom_id: opened.data.custom_id,
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: "shared_costs", value: input }],
        },
      ],
    },
  };

  const stub = installFetchStub([{ body: { id: "m-notify" } }]);
  const ctx = fakeCtx();
  try {
    const res = await post(submit, env, ctx);
    await ctx.settle();
    return { res, calls: stub.calls };
  } finally {
    stub.restore();
  }
}

/** JSON に戻す前の生の値。'[]' のままかどうかを見るのに使う */
const SELECT_SHARED = "select shared_costs from bento_events where id = ?";
const rawSharedCosts = (conn, id) => conn.prepare(SELECT_SHARED).bind(id).first("shared_costs");

test("[締め切る] は共通費用の Modal を返すだけで、まだ締め切らない", async () => {
  const { conn, eventId, env } = await setup();
  const res = await post(clickClose, env, fakeCtx());
  const body = await res.json();

  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, `close_modal:${MESSAGE_ID}`);
  const input = body.data.components[0].components[0];
  assert.equal(input.type, 4);
  assert.equal(input.style, 2, "複数行で受けるので PARAGRAPH");
  assert.equal(input.required, false, "共通費用が無い会もある");

  // 窓を開いただけ。ここで status が変わると、閉じただけで締まってしまう
  assert.equal((await db.getEvent(conn, eventId)).status, "open");
  conn.close();
});

test("2行の共通費用が JSON で保存され、status が closed になる", async () => {
  const { conn, eventId, env } = await setup();
  const { res } = await close(env, "配送料 500\nAPI代 300");

  assert.deepEqual(await res.json(), { type: 5 }, "3秒に入らないので deferred で返す");
  const event = await db.getEvent(conn, eventId);
  assert.equal(event.status, "closed");
  assert.deepEqual(event.shared_costs, [
    { label: "配送料", amount: 500 },
    { label: "API代", amount: 300 },
  ]);
  conn.close();
});

test("空欄でも締め切れる（shared_costs は '[]' のまま）", async () => {
  const { conn, eventId, env } = await setup();
  const { calls } = await close(env, "");

  const event = await db.getEvent(conn, eventId);
  assert.equal(event.status, "closed");
  assert.equal(await rawSharedCosts(conn, eventId), "[]");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "貼り替えは行われる");
  conn.close();
});

test("金額として読めない行は無視され、他の行は保存される", async () => {
  const { conn, eventId, env } = await setup();
  await close(env, "配送料 500\nあとで聞く\n\nAPI代 300");

  assert.deepEqual((await db.getEvent(conn, eventId)).shared_costs, [
    { label: "配送料", amount: 500 },
    { label: "API代", amount: 300 },
  ]);
  conn.close();
});

test("元メッセージが集金フェーズの内容に貼り替わる", async () => {
  const { conn, env } = await setup();
  const { calls } = await close(env, "配送料 500");

  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "PATCH が飛んでいない");
  assert.ok(patch.url.endsWith(`/channels/c1/messages/${MESSAGE_ID}`), patch.url);

  // 650 と 480 の2人。配送料 ¥500 を均等割して ¥250 ずつ乗る
  const body = JSON.parse(patch.body);
  const { description } = body.embeds[0];
  assert.match(description, /弁当代 ¥1,130 ＋ 配送料 ¥500 = ¥1,630/);
  assert.match(description, /¥650 \+ ¥250 = \*\*¥900\*\*/);
  assert.match(description, /¥480 \+ ¥250 = \*\*¥730\*\*/);
  assert.equal(body.components[0].components[0].label, "支払った");
  conn.close();
});

test("@here の通知は1回だけ（2回目の締め切りでは投稿しない）", async () => {
  const { conn, eventId, env } = await setup();
  const first = await close(env, "配送料 500");

  const posts = first.calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith("/channels/c1/messages"), posts[0].url);
  const notice = JSON.parse(posts[0].body);
  assert.match(notice.content, /@here/);
  assert.match(notice.content, /9\/15\(月\) お弁当/);
  assert.deepEqual(notice.allowed_mentions, { parse: ["everyone"] });

  // もう一度同じ操作をしても、鳴るのは1回きり。金額も上書きされない
  const second = await close(env, "配送料 9999");
  assert.equal(second.calls.filter((call) => call.method === "POST").length, 0);
  assert.deepEqual((await db.getEvent(conn, eventId)).shared_costs, [
    { label: "配送料", amount: 500 },
  ]);
  conn.close();
});
