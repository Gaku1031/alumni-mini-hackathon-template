/**
 * 集金フェーズの `[支払った]` / `[未払いに戻す ▼]` の自己チェック。
 * 署名検証は interaction.test.mjs が見ているので、ここは通ったあとの
 * handleInteraction を直接叩く。D1 は node:sqlite、Discord API は fetch スタブ。
 *
 *   node --test test/payment.test.mjs
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
const GUILD_ID = "g-1";

const MEMBERS = [
  { nick: "gaku", user: { id: "u-1", username: "gaku_1031" } },
  { nick: "はな", user: { id: "u-2", username: "hana_x" } },
  { nick: "たろう", user: { id: "u-3", username: "taro" } },
];

/** 3人が注文した状態で締め切り済みのイベントを作る */
async function setup({ sharedCosts = [{ label: "配送料", amount: 500 }] } = {}) {
  const conn = createTestDb();
  const eventId = await db.createEvent(conn, {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    title: "9/15(月) お弁当",
    menuUrl: null,
  });
  await db.setMessageId(conn, eventId, MESSAGE_ID);
  for (const [index, member] of MEMBERS.entries()) {
    await db.addOrder(conn, {
      eventId,
      discordUserId: member.user.id,
      displayName: member.nick,
      itemName: index === 0 ? "唐揚げ弁当" : "のり弁",
      price: index === 0 ? 650 : 480,
    });
  }
  await db.closeEvent(conn, eventId, sharedCosts);
  return { conn, eventId, env: { DB: conn, DISCORD_BOT_TOKEN: TOKEN } };
}

/** [支払った] を押した */
const paidPress = (member = MEMBERS[0]) => ({
  type: 3,
  guild_id: GUILD_ID,
  data: { custom_id: "paid", component_type: 2 },
  message: { id: MESSAGE_ID },
  member,
});

/** [未払いに戻す ▼] で1件選んだ */
const unpaidSelect = (orderId, member = MEMBERS[0]) => ({
  type: 3,
  guild_id: GUILD_ID,
  data: { custom_id: "unpaid_select", component_type: 3, values: [orderId] },
  message: { id: MESSAGE_ID },
  member,
});

/** 押してから waitUntil の続き（PATCH）が終わるまで待つ */
async function press(interaction, env) {
  const ctx = fakeCtx();
  const res = await handleInteraction(interaction, env, ctx);
  await ctx.settle();
  return res;
}

const paidStates = async (conn, eventId) =>
  Object.fromEntries(
    (await db.listOrders(conn, eventId)).map((order) => [order.discord_user_id, order.paid]),
  );

/** ephemeral な返事（本人にしか見えない type:4 + flags:64）か */
async function assertEphemeral(res, pattern) {
  const body = await res.json();
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, pattern);
}

/** 直近の PATCH の中身 */
function lastPatch(stub) {
  const call = stub.calls.at(-1);
  assert.equal(call.method, "PATCH");
  assert.equal(
    call.url,
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
  );
  return JSON.parse(call.body);
}

test("AC-1: [支払った] で押した本人の注文だけ paid が 1 になる", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const res = await press(paidPress(MEMBERS[1]), env);

    // 集計メッセージ自体を貼り替えるので、本人向けの返事は出さない
    assert.deepEqual(await res.json(), { type: 6 });
    assert.deepEqual(await paidStates(conn, eventId), { "u-1": 0, "u-2": 1, "u-3": 0 });
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-2: 注文していない人が押すと ephemeral で返り、DB は動かない", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const before = await paidStates(conn, eventId);
    const stranger = { nick: "よそ者", user: { id: "u-9", username: "guest" } };
    const res = await press(paidPress(stranger), env);

    await assertEphemeral(res, /頼んでいない/);
    assert.deepEqual(await paidStates(conn, eventId), before);
    // 何も変わっていないのでメッセージも貼り替えない
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-3: [未払いに戻す ▼] に支払い済みの人が並び、他人の分を 0 に戻せる", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    await press(paidPress(MEMBERS[1]), env);

    // 支払った人だけが選択肢に出る
    const components = lastPatch(stub).components.flatMap((row) => row.components);
    const select = components.find((c) => c.custom_id === "unpaid_select");
    assert.deepEqual(
      select.options.map((option) => option.label),
      ["はな / のり弁 ¥647"],
    );

    // 押すのは別人（u-1）。齟齬を直すためのものなので他人でも戻せる
    const res = await press(unpaidSelect(select.options[0].value, MEMBERS[0]), env);

    assert.deepEqual(await res.json(), { type: 6 });
    assert.deepEqual(await paidStates(conn, eventId), { "u-1": 0, "u-2": 0, "u-3": 0 });
    // 誰も払っていない状態に戻ったので、戻す先が無くなりセレクトも消える
    const rows = lastPatch(stub).components;
    assert.deepEqual(
      rows.flatMap((row) => row.components.map((c) => c.custom_id)),
      ["paid"],
    );
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-4: 押すたびに元メッセージが PATCH され、集金 n/m と未払い者が最新になる", async () => {
  const { conn, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    await press(paidPress(MEMBERS[0]), env);
    assert.equal(stub.calls.length, 1);
    let description = lastPatch(stub).embeds[0].description;
    assert.match(description, /集金 1\/3/);
    assert.match(description, /未払い: はな, たろう/);
    assert.doesNotMatch(description, /未払い:.*gaku/);

    await press(paidPress(MEMBERS[1]), env);
    assert.equal(stub.calls.length, 2);
    description = lastPatch(stub).embeds[0].description;
    assert.match(description, /集金 2\/3/);
    assert.match(description, /未払い: たろう/);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-5: 全員が支払うと未払いの列挙が消えて 集金 3/3 になる", async () => {
  const { conn, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    for (const member of MEMBERS) await press(paidPress(member), env);

    const { description } = lastPatch(stub).embeds[0];
    assert.match(description, /集金 3\/3/);
    assert.doesNotMatch(description, /未払い:/);
    assert.match(description, /全員支払い済み/);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("AC-6: すでに支払い済みの人がもう一度押しても壊れない", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    await press(paidPress(MEMBERS[0]), env);
    const res = await press(paidPress(MEMBERS[0]), env);

    assert.deepEqual(await res.json(), { type: 6 });
    assert.deepEqual(await paidStates(conn, eventId), { "u-1": 1, "u-2": 0, "u-3": 0 });
    assert.match(lastPatch(stub).embeds[0].description, /集金 1\/3/);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("送金先が設定されていれば集計メッセージに出る", async () => {
  const { conn, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    await db.setPaypayUrl(conn, GUILD_ID, "https://paypay.me/gaku");
    await press(paidPress(MEMBERS[0]), env);

    assert.match(lastPatch(stub).embeds[0].description, /送金先 → https:\/\/paypay\.me\/gaku/);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("このイベントに無い注文 id を選んでも何も動かない", async () => {
  const { conn, eventId, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const before = await paidStates(conn, eventId);
    const res = await press(unpaidSelect("no-such-order"), env);

    await assertEphemeral(res, /見つかりません/);
    assert.deepEqual(await paidStates(conn, eventId), before);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});

test("知らないメッセージ（イベントが無い）は ephemeral で止まる", async () => {
  const { conn, env } = await setup();
  const stub = installFetchStub([{ body: { id: MESSAGE_ID } }]);
  try {
    const interaction = paidPress();
    interaction.message.id = "m-999";
    const res = await press(interaction, env);

    await assertEphemeral(res, /見つかりません/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    conn.close();
  }
});
