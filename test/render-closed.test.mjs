/**
 * 集金フェーズの集計メッセージ描画の自己チェック。
 *
 *   node --test test/render-closed.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Node が .ts を直接 import できるようになるのは v22.18 から。
// ビルド手順を足したくないので、型だけ落として読み込む。
const strip = (name) =>
  stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"));
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

// data: URL には相対 import が無い。render.ts が呼ぶ "./split" を data: URL に差し替える
const splitUrl = moduleUrl(strip("split"));
const { splitShared } = await import(splitUrl);
const { renderClosed } = await import(
  moduleUrl(strip("render").replace('"./split"', JSON.stringify(splitUrl)))
);

const order = (name, item, price, paid = 0) => ({
  id: `o-${name}`,
  display_name: name,
  item_name: item,
  price,
  paid,
});

/** 図2 と同じ6人。gaku, taro, hana, kenta が支払い済み */
const six = () => [
  order("gaku", "唐揚げ弁当", 650, 1),
  order("taro", "唐揚げ弁当", 650, 1),
  order("jiro", "のり弁", 480),
  order("hana", "唐揚げ弁当", 650, 1),
  order("saki", "のり弁", 480),
  order("kenta", "幕の内", 820, 1),
];

const delivery = [{ label: "配送料", amount: 500 }];
const closed = (sharedCosts = delivery) => ({ title: "9/15(月) お弁当", shared_costs: sharedCosts });

const description = (body) => body.embeds[0].description;
const customIds = (body) =>
  body.components.flatMap((row) => row.components.map((c) => c.custom_id));

test("各行に 弁当代 + 割前 = 送る金額 が出る", () => {
  const lines = description(renderClosed(closed(), six())).split("\n");
  assert.equal(lines[0], "🍱 唐揚げ弁当  ¥650 + ¥84 = **¥734**  ×3  gaku, taro, hana");
  assert.equal(lines[1], "🍱 のり弁  ¥480 + ¥84 = **¥564**  ×2  jiro, saki");
  assert.equal(lines[2], "🍱 幕の内  ¥820 + ¥84 = **¥904**  ×1  kenta");
});

test("送る金額が splitShared の結果と一致する", () => {
  const orders = six();
  const { payments } = splitShared(delivery, orders);
  const text = description(renderClosed(closed(), orders));
  for (const payment of payments) {
    assert.ok(
      text.includes(`= **¥${payment.total.toLocaleString("en-US")}**`),
      `${payment.display_name} の ¥${payment.total} が出ていない`,
    );
  }
});

test("合計行に弁当代・共通費用・総額が出て、内訳のラベルが付く", () => {
  const text = description(renderClosed(closed(), six()));
  assert.ok(text.includes("弁当代 ¥3,730 ＋ 配送料 ¥500 = ¥4,230"));
  assert.ok(text.includes("配送料は6人で均等割 → ¥84（端数切り上げ・余り¥4は幹事）"));
});

test("共通費用が複数行なら全部のラベルが出る", () => {
  const costs = [
    { label: "配送料", amount: 500 },
    { label: "API代", amount: 300 },
  ];
  const text = description(renderClosed(closed(costs), six()));
  assert.ok(text.includes("弁当代 ¥3,730 ＋ 配送料 ¥500 ＋ API代 ¥300 = ¥4,530"));
  assert.ok(text.includes("共通費用は6人で均等割 → ¥134"));
});

test("共通費用が無ければ均等割の行は出ない", () => {
  const text = description(renderClosed(closed([]), six()));
  assert.ok(text.includes("弁当代 ¥3,730"));
  assert.ok(!text.includes("均等割"));
  assert.ok(text.includes("🍱 唐揚げ弁当  ¥650 + ¥0 = **¥650**"));
});

test("集金の進捗が 支払い済み/全人数 で出て、未払い者が名前で並ぶ", () => {
  const text = description(renderClosed(closed(), six()));
  assert.ok(text.includes("💰 集金 4/6"));
  assert.ok(text.includes("未払い: jiro, saki"));
});

test("全員払い終わったら未払いの列挙は出ない", () => {
  const orders = six().map((o) => ({ ...o, paid: 1 }));
  const text = description(renderClosed(closed(), orders));
  assert.ok(text.includes("💰 集金 6/6"));
  assert.ok(text.includes("全員支払い済み"));
  assert.ok(!text.includes("未払い:"));
});

test("メンションは一切入らない", () => {
  const body = renderClosed(closed(), six(), "https://paypay.me/xxxx");
  const json = JSON.stringify(body);
  assert.ok(!json.includes("@here"));
  assert.ok(!json.includes("@everyone"));
  assert.ok(!/<@!?\d/.test(json));
  assert.ok(!json.includes("<@"));
});

test("paypay_url があれば送金先が出る", () => {
  const text = description(renderClosed(closed(), six(), "https://paypay.me/xxxx"));
  assert.ok(text.includes("送金先 → https://paypay.me/xxxx"));
});

test("paypay_url が無ければ送金先の行ごと出ない", () => {
  for (const url of [null, undefined]) {
    assert.ok(!description(renderClosed(closed(), six(), url)).includes("送金先"));
  }
});

test("components は [支払った] [未払いに戻す ▼] の2つだけ", () => {
  const body = renderClosed(closed(), six());
  assert.deepEqual(customIds(body), ["paid", "unpaid_select"]);
  // 注文フェーズのボタンは1つも残らない
  for (const id of ["order_select", "cancel_select", "new_item", "close"]) {
    assert.ok(!customIds(body).includes(id));
  }
});

test("誰も払っていなければ [未払いに戻す ▼] は出ない", () => {
  const orders = six().map((o) => ({ ...o, paid: 0 }));
  assert.deepEqual(customIds(renderClosed(closed(), orders)), ["paid"]);
});

test("セレクトの選択肢は25件を超えず、label は100文字に収まる", () => {
  const many = Array.from({ length: 30 }, (_, i) => order(`u${i}`, "あ".repeat(200), 500, 1));
  const select = renderClosed(closed(), many)
    .components.flatMap((row) => row.components)
    .find((c) => c.custom_id === "unpaid_select");
  assert.equal(select.options.length, 25);
  for (const option of select.options) assert.ok(option.label.length <= 100);
});

test("注文0件でも落ちない", () => {
  const body = renderClosed(closed(), []);
  assert.ok(description(body).includes("注文はありません"));
  assert.ok(description(body).includes("💰 集金 0/0"));
  assert.deepEqual(customIds(body), ["paid"]);
});
