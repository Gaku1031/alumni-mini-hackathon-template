/**
 * `[新しく入力]` → 品名・金額の Modal → 注文登録の自己チェック。
 * 署名検証は interaction.test.mjs が見ているので、ここは通ったあとの
 * handleInteraction を直接叩く。D1 は node:sqlite、Discord API は fetch スタブ。
 *
 *   node --test test/order-new.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "./helpers/d1.mjs";
import { fakeCtx, installFetchStub } from "./helpers/fetch-stub.mjs";
import { loadSrc } from "./helpers/load-src.mjs";

const { handleInteraction } = await loadSrc("index");
const db = await loadSrc("db");

const TOKEN = "test-bot-token";
const MESSAGE_ID = "m-100";
const CHANNEL_ID = "c-1";

/** 集計メッセージまで投稿済みのイベントを1件作る */
async function setup(over = {}) {
  const conn = createTestDb();
  const eventId = await db.createEvent(conn, {
    guildId: "g-1",
    channelId: CHANNEL_ID,
    title: "9/15(月) お弁当",
    menuUrl: null,
  });
  await db.setMessageId(conn, eventId, MESSAGE_ID);
  if (over.closed) await db.closeEvent(conn, eventId, []);
  return { conn, eventId, env: { DB: conn, DISCORD_BOT_TOKEN: TOKEN } };
}

/** [新しく入力] を押した */
const buttonPress = () => ({
  type: 3,
  data: { custom_id: "new_item", component_type: 2 },
  message: { id: MESSAGE_ID },
  member: { nick: "gaku", user: { id: "u-1", username: "gaku_1031" } },
});

/** Modal を送信した */
const modalSubmit = (itemName, price, member) => ({
  type: 5,
  data: {
    custom_id: `new_item:${MESSAGE_ID}`,
    components: [
      { type: 1, components: [{ type: 4, custom_id: "item_name", value: itemName }] },
      { type: 1, components: [{ type: 4, custom_id: "price", value: price }] },
    ],
  },
  message: { id: MESSAGE_ID },
  member: member ?? { nick: "gaku", user: { id: "u-1", username: "gaku_1031" } },
});

const countOrders = async (conn, eventId) => (await db.listOrders(conn, eventId)).length;

/** ephemeral な返事（本人にしか見えない type:4 + flags:64）か */
async function assertEphemeral(res, pattern) {
  const body = await res.json();
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, pattern);
}

test("AC-1: [新しく入力] に品名・金額の2欄を持つ Modal を返す", async () => {
  const { conn, env } = await setup();
  try {
    const res = await handleInteraction(buttonPress(), env, fakeCtx());
    const body = await res.json();

    assert.equal(body.type, 9); // MODAL
    // 送信された Modal には message が付いてこない。元メッセージは custom_id で持ち回る
    assert.equal(body.data.custom_id, `new_item:${MESSAGE_ID}`);

    const fields = body.data.components.flatMap((row) => row.components);
    assert.deepEqual(
      fields.map((field) => field.custom_id),
      ["item_name", "price"],
    );
    for (const field of fields) {
      assert.equal(field.type, 4); // TEXT_INPUT
      assert.equal(field.required, true);
      assert.ok(field.label.length > 0);
    }
  } finally {
    conn.close();
  }
});

test("AC-2: Modal 送信で1件入り、user id と表示名は member から取る", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const ctx = fakeCtx();
    const res = await handleInteraction(modalSubmit("唐揚げ弁当", "650"), env, ctx);
    await ctx.settle();

    // 集計メッセージ自体を貼り替えるので、本人向けの返事は出さない
    assert.deepEqual(await res.json(), { type: 6 });

    const orders = await db.listOrders(conn, eventId);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].discord_user_id, "u-1");
    assert.equal(orders[0].display_name, "gaku");
    assert.equal(orders[0].item_name, "唐揚げ弁当");
    assert.equal(orders[0].price, 650);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-2: ニックネームが無ければ global_name → username の順で拾う", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const ctx = fakeCtx();
    const member = { nick: null, user: { id: "u-2", username: "hana_x", global_name: "はな" } };
    await handleInteraction(modalSubmit("のり弁", "480", member), env, ctx);
    await ctx.settle();

    const [order] = await db.listOrders(conn, eventId);
    assert.equal(order.discord_user_id, "u-2");
    assert.equal(order.display_name, "はな");
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-3: 注文後に元メッセージが PATCH され、新しい行が入っている", async () => {
  const { conn, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const ctx = fakeCtx();
    await handleInteraction(modalSubmit("唐揚げ弁当", "650"), env, ctx);
    await ctx.settle();

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.method, "PATCH");
    assert.equal(
      call.url,
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
    );

    const { embeds, components } = JSON.parse(call.body);
    const { description } = embeds[0];
    assert.match(description, /唐揚げ弁当/);
    assert.match(description, /¥650/);
    assert.match(description, /gaku/);
    assert.match(description, /弁当代 ¥650/);
    // 入った品がそのまま次の人の選択肢になる
    const customIds = components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(customIds.includes("order_select"));
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-4: 同じ人が2回送っても行は増えず、本人にだけ知らせる", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const first = fakeCtx();
    await handleInteraction(modalSubmit("唐揚げ弁当", "650"), env, first);
    await first.settle();

    const second = fakeCtx();
    const res = await handleInteraction(modalSubmit("のり弁", "480"), env, second);
    await second.settle();

    await assertEphemeral(res, /すでに頼んでいます/);
    assert.equal(await countOrders(conn, eventId), 1);
    // 断ったのでメッセージも貼り替えない（PATCH は1回目の分だけ）
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-5: 金額が数字として読めなければ ephemeral エラーで、行は増えない", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    for (const price of ["たかい", "", "六百五十", "-", "650円くらい"]) {
      const ctx = fakeCtx();
      const res = await handleInteraction(modalSubmit("唐揚げ弁当", price), env, ctx);
      await ctx.settle();
      await assertEphemeral(res, /金額は数字で/);
    }
    assert.equal(await countOrders(conn, eventId), 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});

// 金額のバリデーションはしない（桁違いは集計メッセージに出るので人間が気づく）。
// 弾くのは「数値として解釈できない」ものだけ
test("AC-5: 「¥1,200」「１２００円」は読める。高い金額も弾かない", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    for (const [index, price] of ["¥1,200", "１２００円", "82000"].entries()) {
      const ctx = fakeCtx();
      const member = { nick: `u${index}`, user: { id: `u-${index}`, username: `u${index}` } };
      await handleInteraction(modalSubmit("特上弁当", price, member), env, ctx);
      await ctx.settle();
    }
    const prices = (await db.listOrders(conn, eventId)).map((order) => order.price);
    assert.deepEqual(prices, [1200, 1200, 82000]);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-6: 締め切り済みのイベントには入らない", async () => {
  const { conn, eventId, env } = await setup({ closed: true });
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const ctx = fakeCtx();
    const res = await handleInteraction(modalSubmit("唐揚げ弁当", "650"), env, ctx);
    await ctx.settle();

    await assertEphemeral(res, /締め切/);
    assert.equal(await countOrders(conn, eventId), 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("知らないメッセージ（イベントが無い）は ephemeral で止まる", async () => {
  const { conn, env } = await setup();
  const stub = installFetchStub([{ body: { id: "x" } }]);
  try {
    const ctx = fakeCtx();
    const submit = modalSubmit("唐揚げ弁当", "650");
    submit.data.custom_id = "new_item:m-999";
    const res = await handleInteraction(submit, env, ctx);
    await ctx.settle();

    await assertEphemeral(res, /見つかりません/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("品名が空白だけなら入らない", async () => {
  const { conn, eventId, env } = await setup();
  try {
    const ctx = fakeCtx();
    const res = await handleInteraction(modalSubmit("   ", "650"), env, ctx);
    await ctx.settle();

    await assertEphemeral(res, /品名/);
    assert.equal(await countOrders(conn, eventId), 0);
  } finally {
    conn.close();
  }
});
