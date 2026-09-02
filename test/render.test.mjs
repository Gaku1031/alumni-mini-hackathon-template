/**
 * 注文フェーズの集計メッセージ描画の自己チェック。
 *
 *   node --test test/render.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Node が .ts を直接 import できるようになるのは v22.18 から。
// ビルド手順を足したくないので、型だけ落として読み込む。
const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/render.ts", import.meta.url), "utf8"),
);
const { renderOpen } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const event = { title: "9/15(月) お弁当", menu_url: null };

const order = (name, item, price) => ({
  id: `o-${name}-${item}`,
  display_name: name,
  item_name: item,
  price,
});

const six = () => [
  order("gaku", "唐揚げ弁当", 650),
  order("taro", "唐揚げ弁当", 650),
  order("jiro", "のり弁", 480),
  order("hana", "唐揚げ弁当", 650),
  order("saki", "のり弁", 480),
  order("kenta", "幕の内", 820),
];

/** components を平らにして custom_id を並べる */
const customIds = (body) =>
  body.components.flatMap((row) => row.components.map((c) => c.custom_id));

const selectOf = (body, customId) =>
  body.components.flatMap((row) => row.components).find((c) => c.custom_id === customId);

const description = (body) => body.embeds[0].description;

test("同じ品は1行にまとまり、×人数 と注文者名が並ぶ", () => {
  const lines = description(renderOpen(event, six())).split("\n");
  // 最初に注文された順。唐揚げ弁当 → のり弁 → 幕の内
  assert.equal(lines[0], "🍱 唐揚げ弁当  ¥650  ×3  gaku, taro, hana");
  assert.equal(lines[1], "🍱 のり弁  ¥480  ×2  jiro, saki");
  assert.equal(lines[2], "🍱 幕の内  ¥820  ×1  kenta");
});

test("同じ品名でも金額が違えば別の行になる", () => {
  const body = renderOpen(event, [order("gaku", "のり弁", 480), order("taro", "のり弁", 520)]);
  const lines = description(body).split("\n");
  assert.equal(lines[0], "🍱 のり弁  ¥480  ×1  gaku");
  assert.equal(lines[1], "🍱 のり弁  ¥520  ×1  taro");
});

test("弁当代の合計が全注文の price 合計と一致する", () => {
  const orders = six();
  const total = orders.reduce((sum, o) => sum + o.price, 0);
  assert.equal(total, 650 * 3 + 480 * 2 + 820);
  assert.ok(description(renderOpen(event, orders)).includes("弁当代 ¥3,730"));
});

test("注文0件なら弁当代は¥0", () => {
  assert.ok(description(renderOpen(event, [])).includes("弁当代 ¥0"));
});

test("注文0件のとき [頼む ▼] は出ず、[新しく入力] は出る", () => {
  const ids = customIds(renderOpen(event, []));
  assert.ok(!ids.includes("order_select"));
  assert.ok(!ids.includes("cancel_select"));
  assert.ok(ids.includes("new_item"));
});

test("注文1件以上なら4つのコンポーネントが揃う", () => {
  const ids = customIds(renderOpen(event, six()));
  assert.deepEqual(ids.sort(), ["cancel_select", "close", "new_item", "order_select"]);
});

test("セレクトはそれぞれ単独の行に入る", () => {
  const body = renderOpen(event, six());
  for (const row of body.components) {
    const hasSelect = row.components.some((c) => c.type === 3);
    if (hasSelect) assert.equal(row.components.length, 1);
  }
});

test("menu_url が null ならメニュー行が出ない", () => {
  assert.ok(!description(renderOpen(event, six())).includes("メニュー"));
});

test("menu_url があれば URL が出る", () => {
  const url = "https://tenpo.example.com/bento";
  const body = renderOpen({ title: "お弁当", menu_url: url }, six());
  assert.ok(description(body).includes(`📎 メニュー: ${url}`));
});

test("選択肢は25件を超えない", () => {
  // 品も注文者も30通り。どちらのセレクトも切り詰められる
  const many = Array.from({ length: 30 }, (_, i) => order(`u${i}`, `弁当${i}`, 500 + i));
  const body = renderOpen(event, many);
  assert.equal(selectOf(body, "order_select").options.length, 25);
  assert.equal(selectOf(body, "cancel_select").options.length, 25);
});

test("[頼む ▼] の選択肢は品ごとに1つで、値から品名と金額を戻せる", () => {
  const options = selectOf(renderOpen(event, six()), "order_select").options;
  assert.equal(options.length, 3);
  assert.equal(options[0].label, "唐揚げ弁当 ¥650");
  const [price, ...rest] = options[0].value.split(":");
  assert.equal(Number(price), 650);
  assert.equal(rest.join(":"), "唐揚げ弁当");
});

test("[取り消す ▼] の値は注文の id", () => {
  const options = selectOf(renderOpen(event, six()), "cancel_select").options;
  assert.equal(options.length, 6);
  assert.equal(options[0].value, six()[0].id);
});

test("長い品名でも label と value が100文字を超えない", () => {
  const long = { ...order("gaku", "あ".repeat(200), 650), id: crypto.randomUUID() };
  const body = renderOpen(event, [long]);
  for (const select of ["order_select", "cancel_select"]) {
    for (const option of selectOf(body, select).options) {
      assert.ok(option.label.length <= 100);
      assert.ok(option.value.length <= 100);
    }
  }
});
