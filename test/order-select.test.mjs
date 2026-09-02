/**
 * `[頼む ▼]` からの注文。2人目以降が一文字も打たずに同じ品を頼めること。
 *
 *   node --test test/order-select.test.mjs
 *
 * wrangler は起動しない。署名は node:crypto、D1 は node:sqlite、
 * Discord API は fetch スタブ。src/index.ts の fetch をそのまま呼ぶ。
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createTestDb } from "./helpers/d1.mjs";
import { fakeCtx, installFetchStub } from "./helpers/fetch-stub.mjs";
import { loadSrc } from "./helpers/load-src.mjs";

const worker = (await loadSrc("index.mjs")).default;

// distinctItems だけは直に呼んで、セレクトの選択肢と突き合わせる
const DB_SOURCE = new URL("../src/db.ts", import.meta.url);
const stripped = stripTypeScriptTypes(readFileSync(DB_SOURCE, "utf8"));
const db = await import(`data:text/javascript,${encodeURIComponent(stripped)}`);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");

const env = (conn) => ({
  DISCORD_PUBLIC_KEY: publicKeyHex,
  DISCORD_BOT_TOKEN: "test-bot-token",
  DB: conn,
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

const EVENT_ID = "e1";
const MESSAGE_ID = "m1";

/** 集計メッセージを投稿済みのイベントと、すでに入っている注文を用意する */
async function seed(conn, { status = "open", orders = [] } = {}) {
  await conn
    .prepare(
      `insert into bento_events (id, guild_id, channel_id, message_id, title, status)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .bind(EVENT_ID, "g1", "c1", MESSAGE_ID, "9/15(月) お弁当", status)
    .run();

  for (const [index, order] of orders.entries()) {
    await conn
      .prepare(
        `insert into bento_orders
         (id, event_id, discord_user_id, display_name, item_name, price)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(`o${index + 1}`, EVENT_ID, order.userId, order.name, order.item, order.price)
      .run();
  }
}

/** セレクトを選んだときの interaction。value は `金額:品名` */
const select = (value, user = { id: "u2", username: "taro" }) => ({
  type: 3,
  guild_id: "g1",
  channel_id: "c1",
  message: { id: MESSAGE_ID },
  member: { user },
  data: { custom_id: "order_select", component_type: 3, values: [value] },
});

const allOrders = async (conn) =>
  (await conn.prepare("select * from bento_orders order by rowid").bind().all()).results;

/** PATCH されたメッセージの中身 */
function patched(stub) {
  const call = stub.calls.find((c) => c.method === "PATCH");
  assert.ok(call, "元メッセージが PATCH されていない");
  assert.match(call.url, new RegExp(`/channels/c1/messages/${MESSAGE_ID}$`));
  return JSON.parse(call.body);
}

const selectOptions = (body, customId) =>
  body.components
    .flatMap((row) => row.components)
    .find((component) => component.custom_id === customId)?.options ?? [];

test("AC-1: セレクトの選択肢が、既存注文の品名+金額の重複を除いた一覧と一致する", async () => {
  const conn = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    await seed(conn, {
      orders: [
        { userId: "u1", name: "gaku", item: "唐揚げ弁当", price: 650 },
        // 同じ品を頼んだ人は選択肢を増やさない
        { userId: "u2", name: "taro", item: "唐揚げ弁当", price: 650 },
        { userId: "u3", name: "hana", item: "のり弁", price: 480 },
        // 品名が同じでも金額が違えば別の選択肢
        { userId: "u4", name: "ken", item: "唐揚げ弁当", price: 700 },
      ],
    });

    // 何か1件注文して、貼り替えられたメッセージの選択肢を見る
    const mei = { id: "u5", username: "mei" };
    await worker.fetch(request(select("480:のり弁", mei)), env(conn), ctx);
    await ctx.settle();

    const options = selectOptions(patched(stub), "order_select");
    const items = await db.distinctItems(conn, EVENT_ID);
    const sorted = (list) => [...list].sort();

    assert.deepEqual(
      sorted(options.map((option) => option.value)),
      sorted(items.map((item) => `${item.price}:${item.item_name}`)),
      "選択肢が distinct な品の一覧と一致していない",
    );
    // 5人の注文から、重複を除いた3種類になっている
    assert.equal(options.length, 3);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-2: 選ぶと bento_orders に1件入り、品名と金額が選んだ品と一致する", async () => {
  const conn = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    await seed(conn, { orders: [{ userId: "u1", name: "gaku", item: "唐揚げ弁当", price: 650 }] });

    const res = await worker.fetch(request(select("650:唐揚げ弁当")), env(conn), ctx);
    await ctx.settle();

    // 押しただけなので、その場に吹き出しは出さない（元メッセージが書き換わる）
    assert.equal(res.status, 200);
    assert.equal((await res.json()).type, 6);

    const orders = await allOrders(conn);
    assert.equal(orders.length, 2);
    const added = orders[1];
    assert.equal(added.discord_user_id, "u2");
    assert.equal(added.display_name, "taro");
    assert.equal(added.item_name, "唐揚げ弁当");
    assert.equal(added.price, 650);
    assert.equal(added.event_id, EVENT_ID);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-3: 注文後に元メッセージが PATCH され、その品の人数が1増えている", async () => {
  const conn = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    await seed(conn, { orders: [{ userId: "u1", name: "gaku", item: "唐揚げ弁当", price: 650 }] });

    await worker.fetch(request(select("650:唐揚げ弁当")), env(conn), ctx);
    await ctx.settle();

    const description = patched(stub).embeds[0].description;
    assert.match(description, /唐揚げ弁当.*×2/, "×2 になっていない");
    assert.match(description, /gaku, taro/);
    assert.match(description, /弁当代 ¥1,300/);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-4: 注文済みの人が選び直すと行が増えず、注文内容が入れ替わる", async () => {
  const conn = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    await seed(conn, {
      orders: [
        { userId: "u1", name: "gaku", item: "唐揚げ弁当", price: 650 },
        { userId: "u2", name: "taro", item: "唐揚げ弁当", price: 650 },
        { userId: "u3", name: "hana", item: "のり弁", price: 480 },
      ],
    });

    await worker.fetch(request(select("480:のり弁")), env(conn), ctx);
    await ctx.settle();

    const orders = await allOrders(conn);
    assert.equal(orders.length, 3, "行が増えている");

    const taro = orders.filter((order) => order.discord_user_id === "u2");
    assert.equal(taro.length, 1);
    assert.equal(taro[0].item_name, "のり弁");
    assert.equal(taro[0].price, 480);

    const description = patched(stub).embeds[0].description;
    assert.match(description, /唐揚げ弁当.*×1.*gaku/);
    assert.match(description, /のり弁.*×2/);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-5: status='closed' のイベントでは選択が拒否される", async () => {
  const conn = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    await seed(conn, {
      status: "closed",
      orders: [{ userId: "u1", name: "gaku", item: "唐揚げ弁当", price: 650 }],
    });

    const res = await worker.fetch(request(select("650:唐揚げ弁当")), env(conn), ctx);
    const body = await res.json();
    await ctx.settle();

    // 本人にしか見えない断りを返す
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
    assert.match(body.data.content, /締め切/);

    assert.equal((await allOrders(conn)).length, 1, "締め切り後に注文が入っている");
    assert.equal(stub.calls.length, 0, "Discord API を叩いてしまっている");
  } finally {
    stub.restore();
    conn.close();
  }
});

test("知らないメッセージからの選択は無視する（注文もメッセージ更新もしない）", async () => {
  const conn = createTestDb();
  const stub = installFetchStub();
  const ctx = fakeCtx();
  try {
    await seed(conn, { orders: [{ userId: "u1", name: "gaku", item: "唐揚げ弁当", price: 650 }] });

    const interaction = select("650:唐揚げ弁当");
    interaction.message.id = "unknown";
    const body = await (await worker.fetch(request(interaction), env(conn), ctx)).json();
    await ctx.settle();

    assert.equal(body.type, 4);
    assert.equal((await allOrders(conn)).length, 1);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});
