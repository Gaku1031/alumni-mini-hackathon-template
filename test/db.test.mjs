/**
 * D1 アクセス層の自己チェック。node:sqlite の上で src/db.ts をそのまま動かす。
 *
 *   node --test test/db.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createTestDb } from "./helpers/d1.mjs";

const SOURCE = new URL("../src/db.ts", import.meta.url);

// Node が .ts を直接 import できるようになるのは v22.18 から。
// ビルド手順を足したくないので、型だけ落として読み込む。
const stripped = stripTypeScriptTypes(readFileSync(SOURCE, "utf8"));
const db = await import(`data:text/javascript,${encodeURIComponent(stripped)}`);

const newEvent = (conn, over = {}) =>
  db.createEvent(conn, {
    guildId: "g1",
    channelId: "c1",
    title: "9/15(月) お弁当",
    menuUrl: "https://tenpo.example.com/bento",
    ...over,
  });

const order = (eventId, over = {}) => ({
  eventId,
  discordUserId: "u1",
  displayName: "gaku",
  itemName: "唐揚げ弁当",
  price: 650,
  ...over,
});

test("migrations を当てた env.DB 互換オブジェクトが立つ", async () => {
  const conn = createTestDb();
  const row = await conn.prepare("select count(*) as n from bento_orders").bind().first();
  assert.equal(row.n, 0);
  assert.equal(await conn.prepare("select 1 as one").bind().first("one"), 1);
  conn.close();
});

test("createEvent した内容を getEvent がそのまま返す", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);
  const event = await db.getEvent(conn, id);

  assert.equal(event.id, id);
  assert.equal(event.guild_id, "g1");
  assert.equal(event.channel_id, "c1");
  assert.equal(event.title, "9/15(月) お弁当");
  assert.equal(event.menu_url, "https://tenpo.example.com/bento");
  assert.equal(event.status, "open");
  assert.equal(event.message_id, null);
  conn.close();
});

test("shared_costs は配列にパースされて返る", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);
  assert.deepEqual((await db.getEvent(conn, id)).shared_costs, []);

  await db.closeEvent(conn, id, [{ label: "配送料", amount: 500 }]);
  const closed = await db.getEvent(conn, id);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.shared_costs, [{ label: "配送料", amount: 500 }]);
  conn.close();
});

test("無いイベントは null", async () => {
  const conn = createTestDb();
  assert.equal(await db.getEvent(conn, "nope"), null);
  conn.close();
});

test("setMessageId で集計メッセージの id を書き戻せる", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);
  await db.setMessageId(conn, id, "m1");
  assert.equal((await db.getEvent(conn, id)).message_id, "m1");
  conn.close();
});

test("同じ人が2回頼んでも落ちず、重複として返る", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);

  const first = await db.addOrder(conn, order(id));
  assert.equal(first.ok, true);

  const second = await db.addOrder(conn, order(id, { itemName: "のり弁", price: 480 }));
  assert.deepEqual(second, { ok: false, reason: "duplicate" });

  const orders = await db.listOrders(conn, id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].item_name, "唐揚げ弁当");
  conn.close();
});

test("別のイベントなら同じ人でも頼める", async () => {
  const conn = createTestDb();
  const a = await newEvent(conn);
  const b = await newEvent(conn);
  assert.equal((await db.addOrder(conn, order(a))).ok, true);
  assert.equal((await db.addOrder(conn, order(b))).ok, true);
  conn.close();
});

test("listOrders は注文順に返り、paid は 0/1", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);
  await db.addOrder(conn, order(id));
  await db.addOrder(conn, order(id, { discordUserId: "u2", displayName: "taro" }));

  const orders = await db.listOrders(conn, id);
  assert.equal(orders.length, 2);
  assert.equal(orders[0].display_name, "gaku");
  assert.equal(orders[1].display_name, "taro");
  assert.equal(orders[0].paid, 0);

  await db.setPaid(conn, orders[0].id, true);
  assert.equal((await db.listOrders(conn, id))[0].paid, 1);

  await db.setPaid(conn, orders[0].id, false);
  assert.equal((await db.listOrders(conn, id))[0].paid, 0);
  conn.close();
});

test("deleteOrder は消せたかどうかを返す", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);
  const added = await db.addOrder(conn, order(id));

  assert.equal(await db.deleteOrder(conn, added.id), true);
  assert.equal(await db.deleteOrder(conn, added.id), false);
  assert.equal((await db.listOrders(conn, id)).length, 0);
  conn.close();
});

test("distinctItems は品名と金額の重複を除いて返す", async () => {
  const conn = createTestDb();
  const id = await newEvent(conn);
  const other = await newEvent(conn);

  await db.addOrder(conn, order(id));
  await db.addOrder(conn, order(id, { discordUserId: "u2", displayName: "taro" }));
  await db.addOrder(conn, order(id, { discordUserId: "u3", itemName: "のり弁", price: 480 }));
  // 同じ品名でも金額が違えば別の選択肢
  await db.addOrder(conn, order(id, { discordUserId: "u4", price: 700 }));
  // 他のイベントの注文は混ざらない
  await db.addOrder(conn, order(other, { itemName: "幕の内", price: 820 }));

  const items = await db.distinctItems(conn, id);
  const plain = items.map((item) => ({ item_name: item.item_name, price: item.price }));
  assert.deepEqual(plain, [
    { item_name: "のり弁", price: 480 },
    { item_name: "唐揚げ弁当", price: 650 },
    { item_name: "唐揚げ弁当", price: 700 },
  ]);
  conn.close();
});

test("paypay_url は未設定なら null、入れれば上書きできる", async () => {
  const conn = createTestDb();
  assert.equal(await db.getPaypayUrl(conn, "g1"), null);

  await db.setPaypayUrl(conn, "g1", "https://paypay.me/xxxx");
  assert.equal(await db.getPaypayUrl(conn, "g1"), "https://paypay.me/xxxx");

  await db.setPaypayUrl(conn, "g1", "https://paypay.me/yyyy");
  assert.equal(await db.getPaypayUrl(conn, "g1"), "https://paypay.me/yyyy");
  conn.close();
});

test("SQL に値を文字列で埋め込んでいる箇所が無い", () => {
  const raw = readFileSync(SOURCE, "utf8");

  // SQL は全部テンプレートリテラル。式が埋まっていたらアウト
  const literals = [...raw.matchAll(/`[^`]*`/g)].map(([literal]) => literal);
  const sql = literals.filter((literal) => /\b(select|insert|update|delete)\b/i.test(literal));
  assert.ok(sql.length >= 10, "SQL リテラルを見つけられていない");
  for (const literal of sql) {
    assert.ok(!literal.includes("${"), `SQL に式が埋まっている: ${literal}`);
  }

  // prepare() に渡すのはその定数だけ。連結も式も通さない
  const args = [...raw.matchAll(/\.prepare\(([^)]*)\)/g)].map(([, arg]) => arg);
  assert.equal(args.length, sql.length, "prepare の数と SQL の数が合わない");
  for (const arg of args) {
    assert.match(arg, /^[A-Z][A-Z0-9_]*$/, "prepare() の引数は SQL 定数のみ");
  }
});
